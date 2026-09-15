// se-helper: the one door between Phosphor and the Secure Enclave.
//
// WHAT IT IS. A sidecar the Rust shell runs for one request at a time. It reads one JSON line
// on stdin, answers one JSON line on stdout, and exits. It has no network, no files, no state:
// the Secure Enclave key it uses arrives as an opaque blob in the request and leaves the same
// way. Everything it knows is in the request, so every call is auditable from the shell's side.
//
// WHY SWIFT AND NOT RUST. The Secure Enclave key that can live OUTSIDE the keychain is a
// CryptoKit feature (SecureEnclave.P256 with dataRepresentation), and CryptoKit has no C
// surface. The Security.framework C API can make an enclave key but cannot export it
// (SecKeyCopyExternalRepresentation answers "export not implemented"), and a permanent keychain
// key needs the keychain-access-groups entitlement, which an ad-hoc signed bundle cannot carry:
// the kernel kills the process at launch. Both were measured on an M5 running macOS 26.6 before
// this file was written. So: CryptoKit, and therefore Swift.
//
// WHAT THE ENCLAVE GIVES. The private key never exists outside the enclave, not even to this
// process. The blob on disk is that key wrapped under a device key the enclave alone holds, so
// a copy of the wallet file taken to another machine is a string of random bytes. The access
// control on the key is userPresence: every use makes the operating system ask the owner for
// Touch ID or the login password in a dialog no process can draw over, and without that answer
// the enclave refuses. That refusal is not policy, it is the hardware, and it is the property
// this helper exists to import into an app that is otherwise plain code.
//
// THE PROTOCOL. Requests: {"op":"probe"}, {"op":"create"},
// {"op":"unwrap","id":s,"keyBlob":b64,"ephemeralPublicKey":b64,"ciphertext":b64,"aad":b64,
//  "reason":s,"transportKey":b64}, {"op":"presence","reason":s}. Every answer has ok:true plus
// fields, or ok:false with an error code from the list at the bottom. Base64 everywhere. Nothing
// is logged.
//
// THE DATA KEY NEVER LEAVES HERE IN THE CLEAR. An unwrap answers with the data key sealed under
// the per-boot transport key the shell was given (AES-256-GCM, the request id as AAD), so the
// shell that relays the answer and the loopback hop it travels over both see ciphertext, and an
// answer cannot be replayed against a different request. Only the backend, which holds the other
// copy of the transport key from its stdin, can open it.
//
// THE WRAP IS DONE ELSEWHERE ON PURPOSE. Wrapping a data key needs only the enclave's public key
// (ephemeral ECDH, HKDF-SHA256, AES-256-GCM), so the Node side does it and the plaintext key
// never has to travel to this process at creation. Only the unwrap needs the enclave, so only
// the unwrap is here. The two sides must agree on every byte of the derivation; the constants
// are named below and mirrored in src/keystore/sewrap.ts, and a test round-trips between them.

import Foundation
import CryptoKit
import LocalAuthentication

let wrapInfo = Data("phosphor-vault-dek-wrap-v1".utf8)
let wrapSalt = Data("phosphor-vault".utf8)

struct Fail: Error { let code: String; let message: String }

func emit(_ obj: [String: Any]) -> Never {
  let data = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(0)
}
func fail(_ code: String, _ message: String) -> Never { emit(["ok": false, "error": code, "message": message]) }

func b64(_ req: [String: Any], _ key: String) throws -> Data {
  guard let s = req[key] as? String, let d = Data(base64Encoded: s) else {
    throw Fail(code: "bad_input", message: "\(key) must be base64")
  }
  return d
}

func accessControl() throws -> SecAccessControl {
  var err: Unmanaged<CFError>?
  guard let acl = SecAccessControlCreateWithFlags(
    nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &err)
  else { throw Fail(code: "crypto_failed", message: "access control: \(err!.takeRetainedValue())") }
  return acl
}

func biometryName(_ ctx: LAContext) -> String {
  switch ctx.biometryType {
  case .touchID: return "touchid"
  case .faceID: return "faceid"
  case .opticID: return "opticid"
  default: return "none"
  }
}

func probe() -> Never {
  let ctx = LAContext()
  var err: NSError?
  let can = ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err)
  emit([
    "ok": true,
    "secureEnclave": SecureEnclave.isAvailable,
    "canAuthenticate": can,
    "biometry": biometryName(ctx),
    "reason": err?.localizedDescription ?? "",
  ])
}

func create() throws -> Never {
  guard SecureEnclave.isAvailable else { throw Fail(code: "se_unavailable", message: "no Secure Enclave on this Mac") }
  let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: try accessControl())
  emit([
    "ok": true,
    "keyBlob": key.dataRepresentation.base64EncodedString(),
    "publicKey": key.publicKey.x963Representation.base64EncodedString(),
  ])
}

/* The mirror of sewrap.ts. Shared secret is the ECDH x-coordinate, the wrap key is
   HKDF-SHA256(secret, salt, info || ephemeralPub || enclavePub), and the box is AES-256-GCM with
   the caller's AAD, combined as nonce || ciphertext || tag. */
func unwrap(_ req: [String: Any]) throws -> Never {
  guard SecureEnclave.isAvailable else { throw Fail(code: "se_unavailable", message: "no Secure Enclave on this Mac") }
  let blob = try b64(req, "keyBlob")
  let ephRaw = try b64(req, "ephemeralPublicKey")
  let combined = try b64(req, "ciphertext")
  let aad = try b64(req, "aad")
  let transport = try b64(req, "transportKey")
  guard transport.count == 32 else { throw Fail(code: "bad_input", message: "transportKey must be 32 bytes") }
  guard let id = req["id"] as? String, !id.isEmpty else { throw Fail(code: "bad_input", message: "id is required") }
  let reason = (req["reason"] as? String) ?? "Phosphor needs your approval"
  let ctx = LAContext()
  ctx.localizedReason = reason
  ctx.localizedCancelTitle = "Cancel"
  let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: blob, authenticationContext: ctx)
  let eph = try P256.KeyAgreement.PublicKey(x963Representation: ephRaw)
  let secret: SharedSecret
  do {
    secret = try key.sharedSecretFromKeyAgreement(with: eph)
  } catch let e as NSError where e.domain == LAError.errorDomain {
    switch LAError.Code(rawValue: e.code) {
    case .userCancel, .appCancel, .systemCancel: throw Fail(code: "user_cancel", message: "cancelled")
    case .notInteractive: throw Fail(code: "interaction_required", message: "no user present")
    default: throw Fail(code: "auth_failed", message: e.localizedDescription)
    }
  }
  var info = wrapInfo
  info.append(ephRaw)
  info.append(key.publicKey.x963Representation)
  let wrapKey = secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: wrapSalt, sharedInfo: info, outputByteCount: 32)
  let box = try AES.GCM.SealedBox(combined: combined)
  let dek = try AES.GCM.open(box, using: wrapKey, authenticating: aad)
  let sealed = try AES.GCM.seal(dek, using: SymmetricKey(data: transport), authenticating: Data(id.utf8))
  emit(["ok": true, "id": id, "dekSealed": sealed.combined!.base64EncodedString()])
}

/* Touch ID with nothing to unwrap: the window asks for it to lift the frost. */
func presence(_ req: [String: Any]) -> Never {
  let reason = (req["reason"] as? String) ?? "Unlock Phosphor"
  let ctx = LAContext()
  ctx.localizedCancelTitle = "Cancel"
  let sem = DispatchSemaphore(value: 0)
  var result: (Bool, Error?) = (false, nil)
  ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, err in
    result = (ok, err); sem.signal()
  }
  sem.wait()
  if result.0 { emit(["ok": true]) }
  if let e = result.1 as NSError?, LAError.Code(rawValue: e.code) == .userCancel { fail("user_cancel", "cancelled") }
  fail("auth_failed", result.1?.localizedDescription ?? "not verified")
}

// Errors: bad_input, se_unavailable, user_cancel, interaction_required, auth_failed,
// crypto_failed. A wrong AAD or a foreign ciphertext surfaces as crypto_failed, never as a
// partial plaintext: AES-GCM authenticates before it decrypts.
guard let line = readLine(strippingNewline: true), let data = line.data(using: .utf8),
      let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let op = req["op"] as? String
else { fail("bad_input", "expected one JSON object with an op") }

do {
  switch op {
  case "probe": probe()
  case "create": try create()
  case "unwrap": try unwrap(req)
  case "presence": presence(req)
  default: fail("bad_input", "unknown op \(op)")
  }
} catch let f as Fail {
  fail(f.code, f.message)
} catch {
  fail("crypto_failed", "\(error)")
}
