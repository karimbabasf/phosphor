// se-helper: the one door between Phosphor and the Secure Enclave.
//
// WHAT IT IS. An XPC service inside the app bundle, at
// Contents/XPCServices/com.karimbabasf.phosphor.vault.xpc. launchd starts it on the first request
// and only the app that carries it can look it up: the name lives in that app's private XPC
// namespace, not in any global one. Each request is one JSON string in and one JSON string out.
// It has no network and no files. Its only state is what it keeps in its keychain home (below):
// the enclave keys, and one marker per wallet bound to Phosphor. Everything else it needs arrives
// in the request, so every call is auditable from the shell's side.
//
// WHY AN XPC SERVICE AND NOT A SIDECAR. Until 0.10.11 this was a plain executable in
// Contents/MacOS that read stdin. Any local process could run it, hand it the wallet's blob, its
// own transport key and its own "Phosphor:" reason, and one Touch ID gave it the twelve words
// (pen test, 2026-09-14). App-bound is not caller-bound. Here every connection is checked against
// a code signing requirement on the peer before a single message is delivered, see
// peerRequirement below, and running the binary by hand gets nothing: xpc_main refuses a process
// launchd did not start. The stdin door survives only in a development build compiled with
// PHOSPHOR_STDIO, which scripts/build-se-helper.sh writes outside the bundle and never ships, and
// which never reaches the keychain home whoever signs it.
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
// THE PROTOCOL. The XPC message is a dictionary with one string, "request", and the reply one
// string, "answer"; the development build reads the same JSON as one line on stdin and writes
// the answer as one line on stdout. Every answer has ok:true plus fields, or ok:false with an
// error code from the list at the bottom and a message for logs, which the app never shows.
// Base64 everywhere. Nothing is logged.
//   {"op":"probe"}                                      what this Mac and this build can do
//   {"op":"create","label"?}                            a fresh enclave key; no dialog
//   {"op":"unwrap","id","keyBlob","ephemeralPublicKey","ciphertext","aad","addresses","reason",
//    "transportKey"}                                    the data key, after one Touch ID
//   {"op":"commit","keyBlob","ephemeralPublicKey","ciphertext","aad","addresses"}
//                                                       binds that wallet file to its key; no dialog
//   {"op":"sweep","label"?}                             deletes keys no wallet uses; no dialog
//   {"op":"status","keyBlob"?, and the four wrap fields?}  the binding facts; no dialog
//   {"op":"presence","reason"}                          Touch ID with nothing to unwrap
// `addresses` is base64 of the canonical JSON of the file header's addresses. A `label` is a
// test's per-run tag prefix; the app never sends one.
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
import Security
#if !PHOSPHOR_STDIO
import XPC
#endif

let wrapInfo = Data("phosphor-vault-dek-wrap-v1".utf8)
let wrapSalt = Data("phosphor-vault".utf8)
let pinDomain = Data("phosphor-vault-pin-v1".utf8)

struct Fail: Error { let code: String; let message: String }

func failure(_ code: String, _ message: String) -> [String: Any] { ["ok": false, "error": code, "message": message] }

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

/* This code's own signature, or nil when it cannot be read. */
func ownSigning() -> [String: Any]? {
  var me: SecCode?
  var mine: SecStaticCode?
  var info: CFDictionary?
  guard SecCodeCopySelf([], &me) == errSecSuccess, let me,
        SecCodeCopyStaticCode(me, [], &mine) == errSecSuccess, let mine,
        SecCodeCopySigningInformation(mine, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess
  else { return nil }
  return info as? [String: Any]
}

func teamOf(_ signing: [String: Any]) -> String? {
  guard let team = signing[kSecCodeInfoTeamIdentifier as String] as? String, !team.isEmpty else { return nil }
  return team
}

func x963(_ key: SecKey) throws -> Data {
  var err: Unmanaged<CFError>?
  guard let pub = SecKeyCopyPublicKey(key), let data = SecKeyCopyExternalRepresentation(pub, &err) as Data? else {
    throw Fail(code: "crypto_failed", message: "public key: \(err?.takeRetainedValue().localizedDescription ?? "unknown")")
  }
  return data
}

/* THE PLATFORM: the keychain, the enclave and the clock, behind one seam, and everything after it
   is the rules. tests/unit/vault-service.test.ts runs those rules against a stand-in
   (tests/swift/VaultTestPlatform.swift) with no Touch ID and no keychain. The stand-in is compiled
   into that test's own binary only, with PHOSPHOR_TESTSEAM: no build script passes the flag, so a
   shipped service holds SystemPlatform and nothing else. */
struct KeychainStatus: Error { let status: OSStatus }
struct VaultKey { let tag: String; let created: Date? }
struct Marker { let pin: Data; let at: Date? }

protocol Platform {
  /// The Team ID this code is signed with, nil when it has none.
  func team() -> String?
  func enclaveAvailable() -> Bool
  func now() -> Date
  /// A permanent enclave key under `tag` in `group`, or with no group named (the development
  /// path). Its public half, X9.63.
  func makeKey(tag: String, group: String?) -> Result<Data, KeychainStatus>
  func keys(group: String) -> Result<[VaultKey], KeychainStatus>
  func deleteKey(tag: String, group: String) -> OSStatus
  /// Every marker in the group, by the tag of the key it binds.
  func markers(group: String) -> Result<[String: Marker], KeychainStatus>
  func addMarker(tag: String, body: Data, group: String) -> OSStatus
  /// ECDH inside the enclave against an ephemeral public key: the call that asks the owner.
  func agree(tag: String, group: String?, eph: Data, reason: String) throws -> (Data, Data)
  func makeBlob() throws -> (Data, Data)
  func agree(blob: Data, eph: Data, reason: String) throws -> (Data, Data)
}

struct SystemPlatform: Platform {
  func team() -> String? {
    #if PHOSPHOR_STDIO
    // The stdin door never reaches the keychain home, however it was signed: any local process
    // can run it, which is the whole reason the shipped service is an XPC service.
    return nil
    #else
    return ownSigning().flatMap(teamOf)
    #endif
  }

  func enclaveAvailable() -> Bool { SecureEnclave.isAvailable }

  func now() -> Date { Date() }

  /* For reads, adds and deletes, none of which may ever raise a dialog: one that would needs an
     interaction this context refuses, and fails with errSecInteractionNotAllowed instead. */
  func quiet() -> LAContext {
    let ctx = LAContext()
    ctx.interactionNotAllowed = true
    return ctx
  }

  func makeKey(tag: String, group: String?) -> Result<Data, KeychainStatus> {
    guard let acl = try? accessControl() else { return .failure(KeychainStatus(status: errSecParam)) }
    var priv: [String: Any] = [
      kSecAttrIsPermanent as String: true,
      kSecAttrApplicationTag as String: Data(tag.utf8),
      kSecAttrLabel as String: "Phosphor vault key",
      kSecAttrAccessControl as String: acl,
    ]
    if let group { priv[kSecAttrAccessGroup as String] = group }
    let attrs: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
      kSecUseDataProtectionKeychain as String: true,
      kSecPrivateKeyAttrs as String: priv,
    ]
    var err: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attrs as CFDictionary, &err) else {
      let code = err.map { CFErrorGetCode($0.takeRetainedValue()) } ?? Int(errSecParam)
      return .failure(KeychainStatus(status: OSStatus(truncatingIfNeeded: code)))
    }
    guard let pub = try? x963(key) else { return .failure(KeychainStatus(status: errSecParam)) }
    return .success(pub)
  }

  func keys(group: String) -> Result<[VaultKey], KeychainStatus> {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrAccessGroup as String: group,
      kSecUseDataProtectionKeychain as String: true,
      kSecUseAuthenticationContext as String: quiet(),
      kSecMatchLimit as String: kSecMatchLimitAll,
      kSecReturnAttributes as String: true,
    ]
    var found: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &found)
    if status == errSecItemNotFound { return .success([]) }
    guard status == errSecSuccess, let rows = found as? [[String: Any]] else { return .failure(KeychainStatus(status: status)) }
    return .success(rows.compactMap { row in
      guard let tag = (row[kSecAttrApplicationTag as String] as? Data).flatMap({ String(data: $0, encoding: .utf8) }) else { return nil }
      return VaultKey(tag: tag, created: row[kSecAttrCreationDate as String] as? Date)
    })
  }

  func deleteKey(tag: String, group: String) -> OSStatus {
    SecItemDelete([
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: Data(tag.utf8),
      kSecAttrAccessGroup as String: group,
      kSecUseDataProtectionKeychain as String: true,
      kSecUseAuthenticationContext as String: quiet(),
    ] as CFDictionary)
  }

  func markers(group: String) -> Result<[String: Marker], KeychainStatus> {
    let base: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: markerService,
      kSecAttrAccessGroup as String: group,
      kSecUseDataProtectionKeychain as String: true,
      kSecUseAuthenticationContext as String: quiet(),
    ]
    var listing = base
    listing[kSecMatchLimit as String] = kSecMatchLimitAll
    listing[kSecReturnAttributes as String] = true
    var found: CFTypeRef?
    let status = SecItemCopyMatching(listing as CFDictionary, &found)
    if status == errSecItemNotFound { return .success([:]) }
    guard status == errSecSuccess, let rows = found as? [[String: Any]] else { return .failure(KeychainStatus(status: status)) }
    var out: [String: Marker] = [:]
    for row in rows {
      // A marker with no readable account still marks the Mac bound: it is filed under "", which
      // names no key, so it opens nothing and refuses every blob.
      let tag = row[kSecAttrAccount as String] as? String ?? ""
      var one = base
      one[kSecAttrAccount as String] = tag
      one[kSecReturnData as String] = true
      var data: CFTypeRef?
      let read = SecItemCopyMatching(one as CFDictionary, &data)
      guard read == errSecSuccess else { return .failure(KeychainStatus(status: read)) }
      out[tag] = Marker(pin: pinIn(data as? Data), at: row[kSecAttrCreationDate as String] as? Date)
    }
    return .success(out)
  }

  func addMarker(tag: String, body: Data, group: String) -> OSStatus {
    SecItemAdd([
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: markerService,
      kSecAttrAccount as String: tag,
      kSecAttrLabel as String: "Phosphor vault marker",
      kSecAttrAccessGroup as String: group,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      kSecUseDataProtectionKeychain as String: true,
      kSecValueData as String: body,
    ] as CFDictionary, nil)
  }

  /* The keychain half of the unwrap: the enclave key is looked up by tag under an authentication
     context that carries the reason, ECDH runs against the ephemeral public key inside the enclave
     (SecKeyCopyKeyExchangeResult, which is the same x-coordinate CryptoKit's key agreement gives),
     and the rest of the derivation is the same code path as the blob half. */
  func agree(tag: String, group: String?, eph ephRaw: Data, reason: String) throws -> (Data, Data) {
    let ctx = LAContext()
    ctx.localizedReason = reason
    ctx.localizedCancelTitle = "Cancel"
    var query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: Data(tag.utf8),
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecUseDataProtectionKeychain as String: true,
      kSecUseAuthenticationContext as String: ctx,
      kSecReturnRef as String: true,
    ]
    if let group { query[kSecAttrAccessGroup as String] = group }
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess, let found = item else {
      throw Fail(code: status == errSecItemNotFound ? "crypto_failed" : "auth_failed", message: "keychain key \(status)")
    }
    let key = found as! SecKey
    let pubAttrs: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
      kSecAttrKeySizeInBits as String: 256,
    ]
    var err: Unmanaged<CFError>?
    guard let ephKey = SecKeyCreateWithData(ephRaw as CFData, pubAttrs as CFDictionary, &err) else {
      throw Fail(code: "bad_input", message: "ephemeral public key")
    }
    guard let secret = SecKeyCopyKeyExchangeResult(key, .ecdhKeyExchangeStandard, ephKey, [:] as CFDictionary, &err) as Data? else {
      let e = err?.takeRetainedValue() as Error?
      if let ns = e as NSError?, ns.domain == LAError.errorDomain, LAError.Code(rawValue: ns.code) == .userCancel {
        throw Fail(code: "user_cancel", message: "cancelled")
      }
      throw Fail(code: "auth_failed", message: e?.localizedDescription ?? "key exchange refused")
    }
    return (secret, try x963(key))
  }

  func makeBlob() throws -> (Data, Data) {
    let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: try accessControl())
    return (key.dataRepresentation, key.publicKey.x963Representation)
  }

  func agree(blob: Data, eph ephRaw: Data, reason: String) throws -> (Data, Data) {
    let ctx = LAContext()
    ctx.localizedReason = reason
    ctx.localizedCancelTitle = "Cancel"
    let key: SecureEnclave.P256.KeyAgreement.PrivateKey
    do {
      key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: blob, authenticationContext: ctx)
    } catch {
      // The blob is not one this enclave wrote: a wallet file carried over from another Mac.
      // Named apart from a wrap that will not open, so the window can offer Restore instead of
      // a Touch ID that can never work. Neither answer says anything about the key.
      throw Fail(code: "foreign_key", message: "this Secure Enclave did not make that key")
    }
    let eph = try P256.KeyAgreement.PublicKey(x963Representation: ephRaw)
    do {
      let secret = try key.sharedSecretFromKeyAgreement(with: eph)
      return (secret.withUnsafeBytes { Data($0) }, key.publicKey.x963Representation)
    } catch let e as NSError where e.domain == LAError.errorDomain {
      switch LAError.Code(rawValue: e.code) {
      case .userCancel, .appCancel, .systemCancel: throw Fail(code: "user_cancel", message: "cancelled")
      case .notInteractive: throw Fail(code: "interaction_required", message: "no user present")
      default: throw Fail(code: "auth_failed", message: e.localizedDescription)
      }
    }
  }
}

#if PHOSPHOR_TESTSEAM
let platform: Platform = TestPlatform()
#else
let platform: Platform = SystemPlatform()
#endif

/* TWO HOMES FOR THE KEY.

   The keychain home: a permanent enclave key in the data protection keychain, tagged, in the
   access group <team>.com.karimbabasf.phosphor.vault, which macOS opens only to code signed by
   that team with the vault's Developer ID provisioning profile (custody spike E3 and E4,
   2026-10-02). Another process cannot even ask for the key, so it cannot raise the Touch ID dialog
   in Phosphor's name. The group is named on every call, never left to the entitlement's first
   entry. A build with a Team ID has this home or makes nothing: create fails closed.

   The blob: CryptoKit's dataRepresentation, which needs no entitlement and is bound to this Mac's
   enclave but not to this app: any process running as the owner can load it and raise its own
   dialog. Only a build with no Team ID (ad hoc, and the development helper over stdin) still makes
   one, and a build with a home opens one only while nothing on this Mac is bound. The keyBlob
   names which home it came from by prefix, so the unwrap knows where to look and the window can
   say which binding is live. */
let keychainPrefix = "keychain:"
let keychainTagBase = "com.karimbabasf.phosphor.vault."
let markerService = "com.karimbabasf.phosphor.vault.marker"

/* How long a key no marker names may still be opened, and how long sweep leaves it alone: one
   create or bind flow (a queued request, then a Touch ID) with room to spare. Past it, only a
   marker opens a key. */
let freshWindow: TimeInterval = 600

func homeGroup() -> String? { platform.team().map { "\($0).com.karimbabasf.phosphor.vault" } }

/* A label is a test's per-run tag prefix. */
func validLabel(_ s: String) -> Bool {
  !s.isEmpty && s.unicodeScalars.count <= 40
    && s.unicodeScalars.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" }
}

/* keychainTagBase, an optional label and a dot, and an upper-case UUID: what create makes, and
   nothing else names a vault key. */
func validTag(_ tag: String) -> Bool {
  guard tag.hasPrefix(keychainTagBase) else { return false }
  let parts = tag.dropFirst(keychainTagBase.count).split(separator: ".", omittingEmptySubsequences: false)
  guard parts.count == 1 || (parts.count == 2 && validLabel(String(parts[0]))) else { return false }
  let id = Array(parts[parts.count - 1].unicodeScalars)
  guard id.count == 36 else { return false }
  for (at, c) in id.enumerated() {
    let ok = [8, 13, 18, 23].contains(at) ? c == "-" : ("0"..."9").contains(c) || ("A"..."F").contains(c)
    if !ok { return false }
  }
  return true
}

func tagOf(_ keyBlob: String) throws -> String {
  let tag = String(keyBlob.dropFirst(keychainPrefix.count))
  guard keyBlob.hasPrefix(keychainPrefix), validTag(tag) else { throw Fail(code: "bad_input", message: "keyBlob names no vault key") }
  return tag
}

func label(_ req: [String: Any]) throws -> String? {
  guard let raw = req["label"] else { return nil }
  guard let s = raw as? String, validLabel(s) else { throw Fail(code: "bad_input", message: "label must be 1 to 40 of a-z, 0-9 and -") }
  return s
}

/* What a pin is made of: a wallet file's wrap and header as Node sends them, decoded. */
struct Material { let eph: Data; let ciphertext: Data; let aad: Data; let addresses: Data }

func material(_ req: [String: Any]) throws -> Material {
  let m = Material(eph: try b64(req, "ephemeralPublicKey"), ciphertext: try b64(req, "ciphertext"), aad: try b64(req, "aad"), addresses: try b64(req, "addresses"))
  guard m.eph.count == 65, m.eph.first == 0x04 else { throw Fail(code: "bad_input", message: "ephemeralPublicKey must be X9.63, 65 bytes") }
  guard m.ciphertext.count == 12 + 32 + 16 else { throw Fail(code: "bad_input", message: "ciphertext must be a nonce, 32 bytes and a tag") }
  guard !m.aad.isEmpty, !m.addresses.isEmpty, m.aad.count <= 65_536, m.addresses.count <= 65_536 else {
    throw Fail(code: "bad_input", message: "aad and addresses must be present")
  }
  return m
}

/* THE PIN binds a wallet file to its key. Anyone can wrap a data key to the enclave's public key,
   which sits in the file's header, so a key alone cannot tell Phosphor's file from a substitute:
   the next Touch ID would open the substitute's wallet as the owner's, and deposits would follow
   it. The pin is SHA-256 over this domain, a zero byte, then each of the tag, the ephemeral public
   key, the wrapped data key, the AAD (the header without its addresses) and the header's addresses,
   each as a 4-byte big-endian length and its bytes. A substitute has its own ephemeral key and
   wrapped key, so its pin differs; the payload is held by the data key, which only the real wrap
   releases. Computed here only, at commit and at every check, so Node keeps no copy of the hash
   that could drift from this one. */
func pin(_ tag: String, _ m: Material) -> Data {
  var hash = SHA256()
  hash.update(data: pinDomain)
  hash.update(data: Data([0]))
  for part in [Data(tag.utf8), m.eph, m.ciphertext, m.aad, m.addresses] {
    let n = UInt32(part.count)
    hash.update(data: Data([UInt8(truncatingIfNeeded: n >> 24), UInt8(truncatingIfNeeded: n >> 16), UInt8(truncatingIfNeeded: n >> 8), UInt8(truncatingIfNeeded: n)]))
    hash.update(data: part)
  }
  return Data(hash.finalize())
}

func same(_ a: Data, _ b: Data) -> Bool {
  guard a.count == b.count else { return false }
  var diff: UInt8 = 0
  for (x, y) in zip(a, b) { diff |= x ^ y }
  return diff == 0
}

/* A marker's data: {"v":1,"pin":<base64>}. One that does not read as that has a pin nothing
   matches, so its key opens nothing and the Mac stays bound. */
func markerBody(_ pin: Data) -> Data {
  (try? JSONSerialization.data(withJSONObject: ["v": 1, "pin": pin.base64EncodedString()], options: [.sortedKeys])) ?? Data()
}

func pinIn(_ body: Data?) -> Data {
  guard let body, let doc = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
        doc["v"] as? Int == 1, let text = doc["pin"] as? String, let pin = Data(base64Encoded: text), pin.count == 32
  else { return Data() }
  return pin
}

func readMarkers(_ group: String) throws -> [String: Marker] {
  switch platform.markers(group: group) {
  case .success(let marks): return marks
  case .failure(let e): throw Fail(code: "keychain_unavailable", message: "the keychain home could not be read: \(e.status)")
  }
}

func readKeys(_ group: String) throws -> [VaultKey] {
  switch platform.keys(group: group) {
  case .success(let keys): return keys.filter { $0.tag.hasPrefix(keychainTagBase) }
  case .failure(let e): throw Fail(code: "keychain_unavailable", message: "the keychain home could not be read: \(e.status)")
  }
}

/* Made within the window, by the keychain's own creation date. A key whose date cannot be read,
   or is far in the future, is not fresh. */
func fresh(_ key: VaultKey?) -> Bool {
  guard let created = key?.created else { return false }
  let age = platform.now().timeIntervalSince(created)
  return age > -60 && age < freshWindow
}

func iso(_ date: Date?) -> Any { date.map { ISO8601DateFormatter().string(from: $0) } ?? NSNull() }

func probe() -> [String: Any] {
  let ctx = LAContext()
  var err: NSError?
  let can = ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err)
  var home = false
  if let group = homeGroup(), case .success = platform.markers(group: group) { home = true }
  return [
    "ok": true,
    "secureEnclave": platform.enclaveAvailable(),
    "canAuthenticate": can,
    "biometry": biometryName(ctx),
    "reason": err?.localizedDescription ?? "",
    "keychainHome": home,
  ]
}

func create(_ req: [String: Any]) throws -> [String: Any] {
  guard platform.enclaveAvailable() else { throw Fail(code: "se_unavailable", message: "no Secure Enclave on this Mac") }
  let tag = keychainTagBase + (try label(req).map { $0 + "." } ?? "") + UUID().uuidString
  if let group = homeGroup() {
    // No fallback: a build with a Team ID that cannot make the key in its home makes nothing.
    switch platform.makeKey(tag: tag, group: group) {
    case .success(let pub): return ["ok": true, "keyBlob": keychainPrefix + tag, "publicKey": pub.base64EncodedString(), "binding": "app"]
    case .failure(let e): throw Fail(code: "keychain_unavailable", message: "the keychain home refused a new key: \(e.status)")
    }
  }
  if case .success(let pub) = platform.makeKey(tag: tag, group: nil) {
    return ["ok": true, "keyBlob": keychainPrefix + tag, "publicKey": pub.base64EncodedString(), "binding": "app"]
  }
  let (blob, pub) = try platform.makeBlob()
  return ["ok": true, "keyBlob": blob.base64EncodedString(), "publicKey": pub.base64EncodedString(), "binding": "device"]
}

/* WHO MAY OPEN, on a build with a keychain home. Every check runs before any key is touched, so a
   refusal never puts a dialog in front of the owner:
   - a blob opens only while no marker exists on this Mac: binding one wallet retires every
     device-bound key file, copies included;
   - a key with a marker opens only the file committed for it, by the pin;
   - a key with no marker opens while nothing is bound, or within its first minutes (the proving
     touch of the flow that made it, before its commit). After that it is an orphan, and a file
     wrapped to an orphan's public key is exactly what a substitute looks like. */
func admit(tag: String?, group: String, _ req: [String: Any]) throws {
  let marks = try readMarkers(group)
  guard let tag else {
    if !marks.isEmpty { throw Fail(code: "blob_refused", message: "a device-bound key on a Mac that has bound a wallet to Phosphor") }
    return
  }
  let m = try material(req)
  if let mark = marks[tag] {
    if !same(mark.pin, pin(tag, m)) { throw Fail(code: "pin_mismatch", message: "this is not the wallet file committed for that key") }
    return
  }
  if marks.isEmpty { return }
  if !fresh(try readKeys(group).first { $0.tag == tag }) {
    throw Fail(code: "not_committed", message: "no marker names that key, and it is past its first minutes")
  }
}

/* The mirror of sewrap.ts. Shared secret is the ECDH x-coordinate, the wrap key is
   HKDF-SHA256(secret, salt, info || ephemeralPub || enclavePub), and the box is AES-256-GCM with
   the caller's AAD, combined as nonce || ciphertext || tag. */
func unwrap(_ req: [String: Any]) throws -> [String: Any] {
  guard platform.enclaveAvailable() else { throw Fail(code: "se_unavailable", message: "no Secure Enclave on this Mac") }
  let blobText = req["keyBlob"] as? String ?? ""
  let tag = blobText.hasPrefix(keychainPrefix) ? try tagOf(blobText) : nil
  let blob = tag == nil ? try b64(req, "keyBlob") : Data()
  let ephRaw = try b64(req, "ephemeralPublicKey")
  let combined = try b64(req, "ciphertext")
  let aad = try b64(req, "aad")
  let transport = try b64(req, "transportKey")
  guard transport.count == 32 else { throw Fail(code: "bad_input", message: "transportKey must be 32 bytes") }
  guard let id = req["id"] as? String, !id.isEmpty else { throw Fail(code: "bad_input", message: "id is required") }
  let reason = (req["reason"] as? String) ?? "Phosphor needs your approval"
  let group = homeGroup()
  if let group { try admit(tag: tag, group: group, req) }
  let secretBytes: Data
  let enclavePub: Data
  if let tag {
    (secretBytes, enclavePub) = try platform.agree(tag: tag, group: group, eph: ephRaw, reason: reason)
  } else {
    (secretBytes, enclavePub) = try platform.agree(blob: blob, eph: ephRaw, reason: reason)
  }
  var info = wrapInfo
  info.append(ephRaw)
  info.append(enclavePub)
  let wrapKey = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: secretBytes), salt: wrapSalt, info: info, outputByteCount: 32)
  let box = try AES.GCM.SealedBox(combined: combined)
  let dek = try AES.GCM.open(box, using: wrapKey, authenticating: aad)
  let sealed = try AES.GCM.seal(dek, using: SymmetricKey(data: transport), authenticating: Data(id.utf8))
  return ["ok": true, "id": id, "dekSealed": sealed.combined!.base64EncodedString()]
}

/* COMMIT binds a wallet file to its key: the marker for that key holds the file's pin. No dialog,
   because the touch that proved the file opens came first, as an unwrap inside the key's first
   minutes; this only writes down what was proven. Only a key made within the window can be
   committed, so no orphan is ever bound later, and a key's pin is written once. */
func commit(_ req: [String: Any]) throws -> [String: Any] {
  guard let group = homeGroup() else { throw Fail(code: "keychain_unavailable", message: "this build has no keychain home") }
  guard let blobText = req["keyBlob"] as? String, blobText.hasPrefix(keychainPrefix) else {
    throw Fail(code: "bad_input", message: "keyBlob must name a keychain key")
  }
  let tag = try tagOf(blobText)
  let want = pin(tag, try material(req))
  guard let key = try readKeys(group).first(where: { $0.tag == tag }) else { throw Fail(code: "no_key", message: "no such key in the keychain home") }
  guard fresh(key) else { throw Fail(code: "stale_key", message: "that key is past its first minutes and can no longer be committed") }
  func settled(_ marks: [String: Marker]) throws -> [String: Any]? {
    guard let mark = marks[tag] else { return nil }
    guard same(mark.pin, want) else { throw Fail(code: "marker_exists", message: "that key is committed to another file") }
    return ["ok": true, "keyBlob": blobText, "at": iso(mark.at)]
  }
  if let done = try settled(try readMarkers(group)) { return done }
  let status = platform.addMarker(tag: tag, body: markerBody(want), group: group)
  if status == errSecDuplicateItem, let done = try settled(try readMarkers(group)) { return done }
  guard status == errSecSuccess else { throw Fail(code: "keychain_unavailable", message: "the marker was not written: \(status)") }
  return ["ok": true, "keyBlob": blobText, "at": iso(platform.now())]
}

/* SWEEP deletes the keys no wallet can use: no marker names them and they are past the window,
   which is what a cancelled create or a crashed bind leaves. Never a marked key, never a marker,
   never a key outside the vault prefix, and nothing at all until something is bound. */
func sweep(_ req: [String: Any]) throws -> [String: Any] {
  guard let group = homeGroup() else { throw Fail(code: "keychain_unavailable", message: "this build has no keychain home") }
  let scope = keychainTagBase + (try label(req).map { $0 + "." } ?? "")
  let marks = try readMarkers(group)
  guard marks.keys.contains(where: { $0.hasPrefix(scope) }) else { throw Fail(code: "nothing_bound", message: "no marker in that scope, so nothing is swept") }
  var deleted = 0
  var kept = 0
  for key in try readKeys(group) where key.tag.hasPrefix(scope) {
    if marks[key.tag] != nil || fresh(key) {
      kept += 1
      continue
    }
    let status = platform.deleteKey(tag: key.tag, group: group)
    if status == errSecSuccess { deleted += 1 } else { kept += 1 }
  }
  return ["ok": true, "deleted": deleted, "kept": kept]
}

/* STATUS: the binding facts, with no dialog. With a keychain keyBlob it says whether that key is
   there and committed; with the file's four wrap fields too, whether this file is the committed
   one, so Node can tell before a touch. */
func status(_ req: [String: Any]) throws -> [String: Any] {
  guard let group = homeGroup() else {
    return ["ok": true, "keychainHome": false, "bound": false, "key": NSNull(), "marker": NSNull()]
  }
  let marks = try readMarkers(group)
  var out: [String: Any] = ["ok": true, "keychainHome": true, "bound": !marks.isEmpty, "key": NSNull(), "marker": NSNull()]
  guard let blobText = req["keyBlob"] as? String, blobText.hasPrefix(keychainPrefix) else { return out }
  let tag = try tagOf(blobText)
  let key = try readKeys(group).first { $0.tag == tag }
  out["key"] = ["present": key != nil, "fresh": fresh(key)]
  if let mark = marks[tag] { out["marker"] = ["at": iso(mark.at)] }
  if req["ephemeralPublicKey"] != nil {
    let m = try material(req)
    out["pinMatches"] = marks[tag].map { same($0.pin, pin(tag, m)) } ?? false
  }
  return out
}

/* Touch ID with nothing to unwrap: the window asks for it to lift the frost. */
func presence(_ req: [String: Any]) -> [String: Any] {
  let reason = (req["reason"] as? String) ?? "Unlock Phosphor"
  let ctx = LAContext()
  ctx.localizedCancelTitle = "Cancel"
  let sem = DispatchSemaphore(value: 0)
  var result: (Bool, Error?) = (false, nil)
  ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, err in
    result = (ok, err); sem.signal()
  }
  sem.wait()
  if result.0 { return ["ok": true] }
  if let e = result.1 as NSError?, LAError.Code(rawValue: e.code) == .userCancel { return failure("user_cancel", "cancelled") }
  return failure("auth_failed", result.1?.localizedDescription ?? "not verified")
}

// Errors: bad_input, se_unavailable, user_cancel, interaction_required, auth_failed,
// foreign_key, crypto_failed, and on a build with a keychain home keychain_unavailable,
// blob_refused, pin_mismatch, not_committed, no_key, stale_key, marker_exists, nothing_bound.
// A wrong AAD or a foreign ciphertext surfaces as crypto_failed, never as a partial plaintext:
// AES-GCM authenticates before it decrypts. foreign_key is a blob this enclave cannot load at all,
// which is the other Mac's wallet file. keychain_unavailable is a build with a Team ID that cannot
// reach its home: it never makes a blob instead and never opens one, because it cannot tell
// whether a marker forbids it.
func answer(_ line: String) -> String {
  let result: [String: Any]
  if let data = line.data(using: .utf8),
     let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
     let op = req["op"] as? String {
    do {
      switch op {
      case "probe": result = probe()
      case "create": result = try create(req)
      case "unwrap": result = try unwrap(req)
      case "commit": result = try commit(req)
      case "sweep": result = try sweep(req)
      case "status": result = try status(req)
      case "presence": result = presence(req)
      default: result = failure("bad_input", "unknown op \(op)")
      }
    } catch let f as Fail {
      result = failure(f.code, f.message)
    } catch {
      result = failure("crypto_failed", "\(error)")
    }
  } else {
    result = failure("bad_input", "expected one JSON object with an op")
  }
  let data = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
  return String(decoding: data, as: UTF8.self)
}

#if PHOSPHOR_STDIO
FileHandle.standardOutput.write(Data((answer(readLine(strippingNewline: true) ?? "") + "\n").utf8))
exit(0)
#else
/* WHO MAY CONNECT. Only the Phosphor shell, and the requirement says so in the strongest terms
   the signature this service carries allows. The service reads its own signature and pins the
   peer to the same authority:

   - Developer ID (a Team ID on this code): the peer must be Apple-anchored, carry a Developer ID
     certificate chain (the CA at certificate 1 and the leaf marker Apple puts only on a Developer
     ID Application leaf), carry the Team ID this service was signed with, and be the app with
     identifier com.karimbabasf.phosphor. This is the Developer ID branch of the designated
     requirement in Apple's TN3127, without its Mac App Store alternative, which Phosphor never
     ships through. The Team ID alone was not enough: any certificate issued to the team (an Apple
     Development cert from Xcode on any Mac) carries the same OU, so the markers pin the authority
     to Developer ID, the only kind a shipped build has (audit 2026-10-01, L13). Nobody without the
     team's Developer ID private key can produce that.
   - Ad-hoc (no Team ID): the peer must carry identifier com.karimbabasf.phosphor. An ad-hoc
     signature is not tied to anyone, so this stops a stray process or a copy of this service
     hosted under another name, and nothing more: a same-user process that builds its own bundle
     named com.karimbabasf.phosphor around a copy of this service gets through. It could equally
     load the device-bound blob with CryptoKit itself. What closes both is the Developer ID key
     in the keychain home, see TWO HOMES above; scripts/xpc-attack.sh measures all of this.

   A signature this code cannot read is a service that trusts nobody: nil, and every connection
   is cancelled. The requirement is checked by the system on every message, before the handler
   sees it; a peer that fails it only ever produces XPC_ERROR_PEER_CODE_SIGNING_REQUIREMENT. */
let hostIdentifier = "com.karimbabasf.phosphor"

func peerRequirement() -> String? {
  guard let signing = ownSigning() else { return nil }
  if let team = teamOf(signing) {
    return "anchor apple generic and identifier \"\(hostIdentifier)\" "
      + "and certificate 1[field.1.2.840.113635.100.6.2.6] "
      + "and certificate leaf[field.1.2.840.113635.100.6.1.13] "
      + "and certificate leaf[subject.OU] = \"\(team)\""
  }
  return "identifier \"\(hostIdentifier)\""
}

xpc_main { peer in
  guard let requirement = peerRequirement(),
        xpc_connection_set_peer_code_signing_requirement(peer, requirement) == 0
  else {
    xpc_connection_cancel(peer)
    return
  }
  xpc_connection_set_event_handler(peer) { event in
    guard xpc_get_type(event) == XPC_TYPE_DICTIONARY else {
      // A peer that failed the requirement, or one that went away. Either way this connection
      // is done, and nothing it sent was read.
      xpc_connection_cancel(peer)
      return
    }
    guard let reply = xpc_dictionary_create_reply(event) else { return }
    let request = xpc_dictionary_get_string(event, "request").map { String(cString: $0) } ?? ""
    xpc_dictionary_set_string(reply, "answer", answer(request))
    xpc_connection_send_message(peer, reply)
  }
  xpc_connection_resume(peer)
}
#endif
