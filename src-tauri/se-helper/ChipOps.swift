// ChipOps.swift: the chip key's five ops, part of the vault service beside main.swift, compiled in
// with PHOSPHOR_CHIP (scripts/build-se-helper.sh).
//
// WHAT THE CHIP KEY IS. A P-256 Secure Enclave key, made like the vault's own (permanent,
// privateKeyUsage and userPresence, in the keychain home only, never a blob) under its own tag
// prefix, that signs NEAR Intents payloads for the vault account in the WebAuthn standard. Once a
// vault has moved to it, it is the key that moves the vault's money, and it signs only here.
//
// WHY THE SERVICE READS WHAT IT SIGNS. Node builds every payload, and Node is the part of
// Phosphor that may be compromised. So the service never signs bytes it has not read: every
// payload goes through the grammar (IntentGrammar.swift), which takes a move of known tokens out
// of the vault, the removal of a key, or the empty rekey proof, and nothing else. The sentence the
// Touch ID dialog shows is written here from what the grammar read; Node never sends one.
//
// THE MARKER pins a chip key to the vault it signs for, the allowance it tops up and the paper
// recovery key, written once by chipCommit while the key is in its first minutes, and never
// deleted by any op. It is what lets the sentence say "your vault", "your allowance" and "your
// paper recovery key", and a payload that signs for any other account is refused (wrong_signer).
// A chip key with no marker signs nothing.
//
// EVERY CHECK BEFORE THE KEY. signIntent refuses, in this order and before the one call that asks
// the owner, so a refusal never raises a dialog: the request's form (bad_input), the marker
// (not_committed), the key (no_key), the grammar (grammar, the message naming the rule), the signer
// against the marker's account (wrong_signer), then the sentence (grammar, rule sentence). Then the
// platform signs with a context of its own whose reason is the sentence, and the answer is checked
// against the key before it leaves. Every chip op on a build with no keychain home answers
// keychain_unavailable: a chip key lives nowhere else.
//
//   {"op":"chipCreate","label"?}            {keyRef:"chip:<tag>", publicKey:"p256:<base58 of x || y>"}
//   {"op":"chipCommit","keyRef","account","allowance","recovery"}      {keyRef, at}
//   {"op":"chipStatus","keyRef"?}           {keychainHome, chips:[{keyRef, publicKey, fresh, marker}]}
//   {"op":"chipSweep","label"?}             {deleted, kept}
//   {"op":"signIntent","keyRef","payload"}  {keyRef, sentence, signed:<the verifier's MultiPayload>}
//
// tests/unit/chip-service.test.ts runs all of it against the stand-in keychain, whose software key
// signs where the enclave would, and verifies every signature in Node.

import Foundation
import CryptoKit

let chipRefPrefix = "chip:"

func chipHome() throws -> String {
  guard let group = homeGroup() else { throw Fail(code: "keychain_unavailable", message: "this build has no keychain home, so it holds no chip key") }
  return group
}

func chipTag(_ keyRef: Any?) throws -> String {
  guard let text = keyRef as? String, text.hasPrefix(chipRefPrefix), validTag(String(text.dropFirst(chipRefPrefix.count)), base: chipTagBase) else {
    throw Fail(code: "bad_input", message: "keyRef names no chip key")
  }
  return String(text.dropFirst(chipRefPrefix.count))
}

func readChipKeys(_ group: String) throws -> [VaultKey] {
  switch platform.keys(group: group) {
  case .success(let keys): return keys.filter { $0.tag.hasPrefix(chipTagBase) }
  case .failure(let e): throw Fail(code: "keychain_unavailable", message: "the keychain home could not be read: \(e.status)")
  }
}

func readChipMarkers(_ group: String) throws -> [String: ChipMark] {
  switch platform.chipMarkers(group: group) {
  case .success(let marks): return marks
  case .failure(let e): throw Fail(code: "keychain_unavailable", message: "the keychain home could not be read: \(e.status)")
  }
}

/* x || y of the chip key under `tag`, or nil when the group holds none. */
func chipPoint(_ tag: String, _ group: String) throws -> Data? {
  switch platform.publicKey(tag: tag, group: group) {
  case .success(nil): return nil
  case .success(let pub?):
    guard pub.count == 65, pub.first == 0x04 else { throw Fail(code: "crypto_failed", message: "the chip key's public half is not X9.63") }
    return Data(pub.dropFirst())
  case .failure(let e): throw Fail(code: "keychain_unavailable", message: "the keychain home could not be read: \(e.status)")
  }
}

/* What a marker pins, from a request: two NEAR account ids, the vault and its allowance, and the
   paper recovery key, which the plan makes secp256k1. */
func pinsOf(_ req: [String: Any]) throws -> ChipPins {
  guard let account = req["account"] as? String, IntentGrammar.isAccountId(account),
        let allowance = req["allowance"] as? String, IntentGrammar.isAccountId(allowance), allowance != account,
        let recovery = req["recovery"] as? String, IntentGrammar.intentKey(recovery)?.curve == "secp256k1"
  else { throw Fail(code: "bad_input", message: "account and allowance must be two NEAR account ids, and recovery a secp256k1 key") }
  return ChipPins(account: account, allowance: allowance, recovery: recovery)
}

/* A marker's data: {"account","allowance","recovery","v":1}, keys sorted. */
func chipMarkerBody(_ pins: ChipPins) -> Data {
  let doc: [String: Any] = ["account": pins.account, "allowance": pins.allowance, "recovery": pins.recovery, "v": 1]
  return (try? JSONSerialization.data(withJSONObject: doc, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data()
}

/* The pins in a marker's data, or nil unless the data is exactly what chipCommit writes for them:
   a marker that does not read pins nothing, so its key signs nothing. */
func chipPinsIn(_ body: Data) -> ChipPins? {
  guard let doc = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any], let pins = try? pinsOf(doc), chipMarkerBody(pins) == body else {
    return nil
  }
  return pins
}

func chipCreate(_ req: [String: Any]) throws -> [String: Any] {
  let group = try chipHome()
  guard platform.enclaveAvailable() else { throw Fail(code: "se_unavailable", message: "no Secure Enclave on this Mac") }
  let tag = chipTagBase + (try label(req).map { $0 + "." } ?? "") + UUID().uuidString
  switch platform.makeKey(tag: tag, group: group) {
  case .success(let pub):
    guard pub.count == 65, pub.first == 0x04 else { throw Fail(code: "crypto_failed", message: "the new chip key's public half is not X9.63") }
    return ["ok": true, "keyRef": chipRefPrefix + tag, "publicKey": ChipWebAuthn.p256(Data(pub.dropFirst()))]
  case .failure(let e): throw Fail(code: "keychain_unavailable", message: "the keychain home refused a new chip key: \(e.status)")
  }
}

/* COMMIT pins a chip key to a vault, once, while the key is in its first minutes, the same window
   the vault's own commit keeps: a key nobody pinned then is an orphan for good. The same pins
   again answer as the first time did; other pins are refused. */
func chipCommit(_ req: [String: Any]) throws -> [String: Any] {
  let group = try chipHome()
  let tag = try chipTag(req["keyRef"])
  let want = chipMarkerBody(try pinsOf(req))
  guard let key = try readChipKeys(group).first(where: { $0.tag == tag }) else { throw Fail(code: "no_key", message: "no such chip key in the keychain home") }
  guard fresh(key) else { throw Fail(code: "stale_key", message: "that chip key is past its first minutes and can no longer be pinned") }
  func settled(_ marks: [String: ChipMark]) throws -> [String: Any]? {
    guard let mark = marks[tag] else { return nil }
    guard mark.body == want else { throw Fail(code: "marker_exists", message: "that chip key is pinned to another vault") }
    return ["ok": true, "keyRef": chipRefPrefix + tag, "at": iso(mark.at)]
  }
  if let done = try settled(try readChipMarkers(group)) { return done }
  let status = platform.addChipMarker(tag: tag, body: want, group: group)
  if status == errSecDuplicateItem, let done = try settled(try readChipMarkers(group)) { return done }
  guard status == errSecSuccess else { throw Fail(code: "keychain_unavailable", message: "the chip marker was not written: \(status)") }
  return ["ok": true, "keyRef": chipRefPrefix + tag, "at": iso(platform.now())]
}

/* STATUS: every chip key in the group and every chip marker, or the one keyRef names, with no
   dialog. A marker whose key is gone is listed with publicKey null, so a vault that moved still
   reads as moved; a marker that does not read shows empty pins, which name no vault. */
func chipStatus(_ req: [String: Any]) throws -> [String: Any] {
  let group = try chipHome()
  let only = try req["keyRef"].map { try chipTag($0) }
  let marks = try readChipMarkers(group)
  let keys = try readChipKeys(group)
  var tags = Set(keys.map { $0.tag }).union(marks.keys.filter { validTag($0, base: chipTagBase) })
  if let only { tags = tags.filter { $0 == only } }
  let chips = try tags.sorted().map { tag -> [String: Any] in
    let key = keys.first { $0.tag == tag }
    var point: Data?
    if key != nil { point = try chipPoint(tag, group) }
    var marker: Any = NSNull()
    if let mark = marks[tag] {
      let pins = chipPinsIn(mark.body)
      marker = ["account": pins?.account ?? "", "allowance": pins?.allowance ?? "", "recovery": pins?.recovery ?? "", "at": iso(mark.at)]
    }
    return ["keyRef": chipRefPrefix + tag, "publicKey": point.map { ChipWebAuthn.p256($0) as Any } ?? NSNull(), "fresh": fresh(key), "marker": marker]
  }
  return ["ok": true, "keychainHome": true, "chips": chips]
}

/* SWEEP deletes the chip keys that can never sign: no marker pins them and they are past their
   first minutes. Never a pinned key, never a marker, never a key outside the chip prefix. It needs
   nothing pinned first, unlike the vault's sweep: an unpinned chip key opens no wallet. */
func chipSweep(_ req: [String: Any]) throws -> [String: Any] {
  let group = try chipHome()
  let scope = chipTagBase + (try label(req).map { $0 + "." } ?? "")
  let marks = try readChipMarkers(group)
  var deleted = 0
  var kept = 0
  for key in try readChipKeys(group) where key.tag.hasPrefix(scope) {
    if marks[key.tag] != nil || fresh(key) {
      kept += 1
      continue
    }
    if platform.deleteKey(tag: key.tag, group: group) == errSecSuccess { deleted += 1 } else { kept += 1 }
  }
  return ["ok": true, "deleted": deleted, "kept": kept]
}

/* SIGN one payload. The payload is read, wrapped and echoed as one Data: the request's string as
   JSONSerialization decoded it, which drops one leading U+FEFF. So a payload Node sent with one is
   signed and answered without it, consistently, and Node's byte-equal check on the answer is what
   tells the two apart. */
func signIntent(_ req: [String: Any]) throws -> [String: Any] {
  let group = try chipHome()
  let tag = try chipTag(req["keyRef"])
  guard let text = req["payload"] as? String else { throw Fail(code: "bad_input", message: "payload must be a string") }
  let payload = Data(text.utf8)
  guard let mark = try readChipMarkers(group)[tag] else { throw Fail(code: "not_committed", message: "no marker pins that chip key, so it signs nothing") }
  guard let pins = chipPinsIn(mark.body) else { throw Fail(code: "not_committed", message: "the marker for that chip key does not read, so it signs nothing") }
  guard let chip = try chipPoint(tag, group) else { throw Fail(code: "no_key", message: "no such chip key in the keychain home") }
  let sentence: String
  do {
    let read = try IntentGrammar.parse(payload, now: platform.now(), chip: chip)
    guard read.signerId == pins.account else {
      throw Fail(code: "wrong_signer", message: "the payload signs for another account than the vault this key is pinned to")
    }
    sentence = try IntentGrammar.sentence(read, pins: pins)
  } catch let refusal as GrammarRefusal {
    throw Fail(code: "grammar", message: "\(refusal.rule): \(refusal.message)")
  }
  let message = ChipWebAuthn.signedData(payload: payload)
  let der = try platform.sign(tag: tag, group: group, data: message, reason: sentence)
  // What leaves is checked against the key first: a signature that is not this key's over these
  // bytes would only be refused on chain, after the owner was told it was made.
  guard let rs = try? ChipSignature.wire(der: der), let signed = try? ChipWebAuthn.multiPayload(payload: payload, publicKey: chip, der: der),
        let key = try? P256.Signing.PublicKey(rawRepresentation: chip),
        let signature = try? P256.Signing.ECDSASignature(rawRepresentation: rs), key.isValidSignature(signature, for: message)
  else { throw Fail(code: "crypto_failed", message: "the chip answered a signature that does not verify") }
  return ["ok": true, "keyRef": chipRefPrefix + tag, "sentence": sentence, "signed": signed]
}
