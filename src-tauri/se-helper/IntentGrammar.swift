// IntentGrammar.swift: the only payloads the chip key signs, and the sentence its Touch ID dialog
// shows. Part of the vault service, beside main.swift. It has no keychain, no network and no clock
// of its own: the caller passes the time and the keys it compares against.
//
// WHY A GRAMMAR. Node builds every vault payload, and Node is the part of Phosphor that may be
// compromised. One touch on a payload the owner did not mean can move the vault's money or give the
// vault to another key, and the dialog is the only text the owner reads before that touch. So the
// service reads the payload itself, accepts only the shapes Phosphor needs, and writes the dialog's
// sentence from what it read. Node never sends a sentence. The shapes: a move of tokens from the
// table out of the vault, the removal of a key, and the empty proof a rekey asks of the new chip key.
//
// WHY ITS OWN JSON PARSER. The verifier (intents.near, serde_json) reads the same bytes after this
// file does, and wherever two parsers disagree, the sentence names one thing while the chain runs
// another. JSONSerialization keeps the last of two equal keys and decodes escapes and numbers on its
// own terms. The parser below accepts a strict subset of JSON that every parser reads one way:
// printable ASCII, no escapes, no key twice in one object, nothing after the value. The grammar on
// top takes exact key sets. Everything Phosphor builds (JSON.stringify of ASCII values) is inside it.
//
// THE RULES. A refusal names the rule it broke; the service answers it as `grammar`, before any key
// is touched, so a refusal never raises a dialog.
//   size, ascii, json, escape, depth, duplicate_key   at most 4096 bytes, and the JSON above
//   payload_keys        exactly signer_id, verifying_contract, deadline, nonce, intents
//   signer_id           a NEAR account id
//   verifying_contract  intents.near
//   deadline            2026-10-04T18:33:36.641Z (0 to 9 fraction digits, UTC), later than now and
//                       at most 120 seconds after it
//   nonce               canonical base64 of 32 bytes: 5628f6c6 00, salt (4), its own expiry in
//                       nanoseconds (i64 little-endian), random (15); the expiry is exactly seven
//                       days after the payload's deadline, the one life every nonce Phosphor builds
//                       carries (NONCE_LIFE_AFTER_DEADLINE_MS, src/rails/intents-relay.ts)
//   intents, intent     a list of 0 to 4 objects that each name their kind; 0 is the rekey's proof
//   refused_kind        add_public_key, set_auth_by_predecessor_id and the rest of refusedKinds
//   unknown_kind        any other kind but transfer and remove_public_key
//   one_kind            one kind per payload
//   transfer_keys       exactly intent, receiver_id, tokens (memo, msg and min_gas never pass)
//   receiver            a NEAR account id, never the signer
//   one_receiver        one receiver per payload
//   tokens, token       exactly one asset per transfer, from TokenTable.swift
//   amount              a string of digits, no leading zero, 1 to the u128 maximum
//   token_repeat        a token symbol once per payload
//   remove_keys         exactly intent, public_key
//   public_key          ed25519:, secp256k1: or p256:, then the canonical base58 of a key that long
//   signing_key         never the chip key that signs
//   key_repeat          a key once per payload
//   sentence            at most 120 characters
//
// THE SENTENCE. Verb first, because the dialog reads "Phosphor is trying to <sentence>". Only the
// values the chip's marker pins are named in words: the vault, the allowance and the paper
// recovery key. Anything else is said the way src/vault/reason.ts says it: a NEAR name whole, and an
// id that is a key's hash by its first and last eight characters. Amounts are exact, thousands
// grouped, trailing zeros trimmed to two places.
//   confirm this Mac's Touch ID key for your vault          (no intents: the rekey's proof)
//   move 100.00 USDC from your vault to your allowance
//   send 2.50 USDC from your vault to 0x12ab5678...90abcd34
//   remove your paper recovery key from your vault
//   remove key secp256k1:TmysAU1B...H7MkuLjQ from your vault
//
// tests/unit/intent-grammar.test.ts runs all of it, compiled with a driver of its own: a corpus of
// every accept and refusal, 10 000 mutated payloads held to Node's JSON.parse, the chip's own DER
// signatures, and the chip-signed MultiPayloads the verifier accepted live.

import Foundation
import CryptoKit

struct GrammarRefusal: Error, Equatable {
  let rule: String
  let message: String
}

/* An asset the chip key may move: the verifier's id, the ticker the sentence says, and the decimals
   that place the point in its amount. The rows are TokenTable.swift, which scripts/gen-chip-tokens.ts
   writes from the app's own registry. */
struct ChipToken: Equatable {
  let assetId: String
  let symbol: String
  let decimals: Int
}

/* What the chip's marker pins: the vault, the allowance it tops up, and the paper recovery key. */
struct ChipPins {
  let account: String
  let allowance: String
  let recovery: String
}

/* A key as the verifier spells it: the curve, a colon, the base58 of the raw key. */
struct IntentKey: Equatable {
  let curve: String
  let bytes: [UInt8]
  let text: String
}

enum VaultIntent: Equatable {
  case transfer(receiver: String, token: ChipToken, amount: String)
  case removeKey(IntentKey)
}

struct VaultPayload: Equatable {
  let signerId: String
  let verifyingContract: String
  let deadline: String
  let nonce: String
  let intents: [VaultIntent]
}

/* A JSON value as the strict parser read it. Members keep their order, and no key is in one object
   twice. A number keeps its text: no vault payload carries one, so the grammar only ever refuses it. */
indirect enum StrictJSON {
  case object([(key: String, value: StrictJSON)])
  case array([StrictJSON])
  case string(String)
  case number(String)
  case bool(Bool)
  case null
}

struct StrictJSONParser {
  let bytes: [UInt8]
  var at = 0

  init(_ bytes: [UInt8]) { self.bytes = bytes }

  var next: UInt8? { at < bytes.count ? bytes[at] : nil }

  static func isDigit(_ c: UInt8) -> Bool { c >= 0x30 && c <= 0x39 }

  func bad(_ message: String) -> GrammarRefusal { GrammarRefusal(rule: "json", message: "\(message), at byte \(at)") }

  mutating func document() throws -> StrictJSON {
    space()
    let value = try value(depth: 1)
    space()
    guard at == bytes.count else { throw bad("something follows the payload") }
    return value
  }

  mutating func space() {
    while let c = next, c == 0x20 || c == 0x09 || c == 0x0a || c == 0x0d { at += 1 }
  }

  mutating func value(depth: Int) throws -> StrictJSON {
    guard depth <= IntentGrammar.maxDepth else {
      throw GrammarRefusal(rule: "depth", message: "the payload nests deeper than \(IntentGrammar.maxDepth)")
    }
    guard let c = next else { throw bad("the payload ends where a value should start") }
    switch c {
    case UInt8(ascii: "{"): return try object(depth: depth)
    case UInt8(ascii: "["): return try array(depth: depth)
    case UInt8(ascii: "\""): return .string(try string())
    case UInt8(ascii: "t"): try literal("true"); return .bool(true)
    case UInt8(ascii: "f"): try literal("false"); return .bool(false)
    case UInt8(ascii: "n"): try literal("null"); return .null
    case UInt8(ascii: "-"), UInt8(ascii: "0")...UInt8(ascii: "9"): return .number(try number())
    default: throw bad("no JSON value starts here")
    }
  }

  mutating func object(depth: Int) throws -> StrictJSON {
    at += 1
    var members: [(key: String, value: StrictJSON)] = []
    var seen = Set<String>()
    space()
    if next == UInt8(ascii: "}") {
      at += 1
      return .object(members)
    }
    while true {
      space()
      guard next == UInt8(ascii: "\"") else { throw bad("an object key must be a string") }
      let key = try string()
      // Only printable ASCII gets this far, so two keys that are equal strings are equal bytes.
      guard seen.insert(key).inserted else {
        throw GrammarRefusal(rule: "duplicate_key", message: "the key \(key) appears twice in one object")
      }
      space()
      guard next == UInt8(ascii: ":") else { throw bad("a colon must follow the key \(key)") }
      at += 1
      space()
      members.append((key: key, value: try value(depth: depth + 1)))
      space()
      if next == UInt8(ascii: ",") {
        at += 1
        continue
      }
      guard next == UInt8(ascii: "}") else { throw bad("a comma or a closing brace must follow the value of \(key)") }
      at += 1
      return .object(members)
    }
  }

  mutating func array(depth: Int) throws -> StrictJSON {
    at += 1
    var items: [StrictJSON] = []
    space()
    if next == UInt8(ascii: "]") {
      at += 1
      return .array(items)
    }
    while true {
      space()
      items.append(try value(depth: depth + 1))
      space()
      if next == UInt8(ascii: ",") {
        at += 1
        continue
      }
      guard next == UInt8(ascii: "]") else { throw bad("a comma or a closing bracket must follow a list item") }
      at += 1
      return .array(items)
    }
  }

  mutating func string() throws -> String {
    at += 1
    let start = at
    while let c = next {
      if c == UInt8(ascii: "\"") {
        let text = String(decoding: bytes[start..<at], as: UTF8.self)
        at += 1
        return text
      }
      if c == UInt8(ascii: "\\") {
        throw GrammarRefusal(rule: "escape", message: "a backslash escape inside a string, at byte \(at)")
      }
      if c < 0x20 { throw bad("a control character inside a string") }
      at += 1
    }
    throw bad("a string never closes")
  }

  mutating func number() throws -> String {
    let start = at
    if next == UInt8(ascii: "-") { at += 1 }
    guard let first = next, Self.isDigit(first) else { throw bad("a number needs a digit") }
    at += 1
    if first != UInt8(ascii: "0") {
      while let c = next, Self.isDigit(c) { at += 1 }
    }
    if next == UInt8(ascii: ".") {
      at += 1
      guard let c = next, Self.isDigit(c) else { throw bad("a decimal point needs a digit after it") }
      while let c = next, Self.isDigit(c) { at += 1 }
    }
    if next == UInt8(ascii: "e") || next == UInt8(ascii: "E") {
      at += 1
      if next == UInt8(ascii: "+") || next == UInt8(ascii: "-") { at += 1 }
      guard let c = next, Self.isDigit(c) else { throw bad("an exponent needs a digit") }
      while let c = next, Self.isDigit(c) { at += 1 }
    }
    return String(decoding: bytes[start..<at], as: UTF8.self)
  }

  mutating func literal(_ word: String) throws {
    let w = Array(word.utf8)
    guard at + w.count <= bytes.count, Array(bytes[at..<(at + w.count)]) == w else { throw bad("no JSON value starts here") }
    at += w.count
  }
}

enum IntentGrammar {
  static let maxBytes = 4096
  static let maxDepth = 6
  static let maxIntents = 4
  static let maxSentence = 120
  static let windowNs: Int64 = 120_000_000_000
  /* How long a nonce outlives its payload's deadline. The verifier lets a V1 nonce expire at or
     after the deadline with no upper limit, and its garbage collector may clear one as soon as the
     nonce's own expiry passes, after which is_nonce_used reads false for a nonce that ran. Seven
     days is the life the relay rail and invite claims already give theirs, so the app asks the
     chain about every nonce it built under one rule; anything else is refused. */
  static let nonceLifeNs: Int64 = 7 * 86_400 * 1_000_000_000
  static let verifier = "intents.near"
  static let nonceHead: [UInt8] = [0x56, 0x28, 0xf6, 0xc6, 0x00]
  static let u128Max = Array("340282366920938463463374607431768211455".utf8)
  static let keyLengths: [String: Int] = ["ed25519": 32, "secp256k1": 64, "p256": 64]

  /* Every other kind the verifier knows (0.4.4 compiles eleven), refused by name, and the two that
     matter most first. A chip-signed add_public_key would give the vault to whatever key Node put
     in it, for one honest-looking touch. A chip-signed set_auth_by_predecessor_id would reopen the
     door the rekey closes: with it on, the old 0x key acts for the vault directly, with no intents
     key at all. Both are signed only by the old key, in Node, inside the rekey bundle. The rest move
     money out of the verifier, call other contracts or swap, which the vault never does by chip. */
  static let refusedKinds: [String: String] = [
    "add_public_key": "a key is added only by the old signer, inside a rekey, never by the chip key",
    "set_auth_by_predecessor_id": "the rekey turns this off with the old key, and the chip key never turns it back on",
    "auth_call": "the chip key never calls another contract",
    "token_diff": "the chip key never swaps; the allowance does",
    "ft_withdraw": "the chip key never moves money out of the verifier",
    "native_withdraw": "the chip key never moves money out of the verifier",
    "mt_withdraw": "the chip key never moves money out of the verifier",
    "nft_withdraw": "the chip key never moves money out of the verifier",
    "storage_deposit": "the chip key never pays another contract",
    "imt_mint": "the chip key never mints",
    "imt_burn": "the chip key never burns",
  ]

  /* The payload, read: every rule but the sentence's. `chip` is the signing key's x || y (64 bytes,
     its X9.63 form without the 04), which no payload may remove. */
  static func parse(_ payload: Data, now: Date, chip: Data) throws -> VaultPayload {
    guard payload.count <= maxBytes else {
      throw GrammarRefusal(rule: "size", message: "the payload is \(payload.count) bytes, over \(maxBytes)")
    }
    let bytes = [UInt8](payload)
    if let at = bytes.firstIndex(where: { !($0 >= 0x20 && $0 <= 0x7e) && $0 != 0x09 && $0 != 0x0a && $0 != 0x0d }) {
      throw GrammarRefusal(rule: "ascii", message: "byte \(at) is not printable ASCII or JSON whitespace")
    }
    var parser = StrictJSONParser(bytes)
    let top = try fields(try parser.document(), ["signer_id", "verifying_contract", "deadline", "nonce", "intents"], rule: "payload_keys", what: "the payload")

    let signer = try string(top["signer_id"], rule: "signer_id", what: "signer_id")
    guard isAccountId(signer) else { throw GrammarRefusal(rule: "signer_id", message: "signer_id is not a NEAR account id") }
    guard try string(top["verifying_contract"], rule: "verifying_contract", what: "verifying_contract") == verifier else {
      throw GrammarRefusal(rule: "verifying_contract", message: "verifying_contract must be \(verifier)")
    }

    let deadlineText = try string(top["deadline"], rule: "deadline", what: "the deadline")
    guard let deadline = nanoseconds(rfc3339: deadlineText) else {
      throw GrammarRefusal(rule: "deadline", message: "the deadline must read like 2026-10-04T18:33:36.641Z")
    }
    let nowMs = (now.timeIntervalSince1970 * 1000).rounded()
    guard nowMs >= 0, nowMs < 9_000_000_000_000 else { throw GrammarRefusal(rule: "deadline", message: "this Mac's clock is not a time") }
    let nowNs = Int64(nowMs) * 1_000_000
    guard deadline > nowNs, deadline - nowNs <= windowNs else {
      throw GrammarRefusal(rule: "deadline", message: "the deadline must be later than now and at most 120 seconds after it")
    }

    let nonce = try string(top["nonce"], rule: "nonce", what: "the nonce")
    try checkNonce(nonce, deadline: deadline)

    guard case .array(let items)? = top["intents"] else { throw GrammarRefusal(rule: "intents", message: "intents must be a list") }
    guard items.count <= maxIntents else {
      throw GrammarRefusal(rule: "intents", message: "\(items.count) intents, over \(maxIntents)")
    }
    let signing = [UInt8](chip)
    let intents = try items.map { try intent($0, signer: signer, chip: signing) }
    try together(intents)
    return VaultPayload(signerId: signer, verifyingContract: verifier, deadline: deadlineText, nonce: nonce, intents: intents)
  }

  /* The dialog's sentence for a parsed payload, or the `sentence` refusal when it would not fit. */
  static func sentence(_ payload: VaultPayload, pins: ChipPins) throws -> String {
    let from = name(payload.signerId, pins)
    let said: String
    switch payload.intents.first {
    case nil:
      said = "confirm this Mac's Touch ID key for \(from)"
    case .transfer(let receiver, _, _)?:
      let amounts = payload.intents.map { item -> String in
        guard case .transfer(_, let token, let amount) = item else { return "" }
        return "\(decimal(amount, places: token.decimals)) \(token.symbol)"
      }
      let own = receiver == pins.allowance || receiver == pins.account
      said = "\(own ? "move" : "send") \(list(amounts)) from \(from) to \(name(receiver, pins))"
    case .removeKey?:
      let recovery = intentKey(pins.recovery)
      let keys = payload.intents.map { item -> String in
        guard case .removeKey(let key) = item else { return "" }
        if key == recovery { return "your paper recovery key" }
        return "key \(key.curve):\(ends(String(key.text.dropFirst(key.curve.count + 1))))"
      }
      said = "remove \(list(keys)) from \(from)"
    }
    guard said.utf8.count <= maxSentence else {
      throw GrammarRefusal(rule: "sentence", message: "the sentence would be \(said.utf8.count) characters, over \(maxSentence)")
    }
    return said
  }

  /* An object's members by key, when its keys are exactly `keys`. */
  static func fields(_ value: StrictJSON, _ keys: [String], rule: String, what: String) throws -> [String: StrictJSON] {
    guard case .object(let members) = value else { throw GrammarRefusal(rule: rule, message: "\(what) must be a JSON object") }
    var out: [String: StrictJSON] = [:]
    for member in members { out[member.key] = member.value }
    let extra = members.map { $0.key }.filter { !keys.contains($0) }
    let missing = keys.filter { out[$0] == nil }
    guard extra.isEmpty, missing.isEmpty else {
      var why: [String] = []
      if !extra.isEmpty { why.append("carries \(extra.joined(separator: ", "))") }
      if !missing.isEmpty { why.append("lacks \(missing.joined(separator: ", "))") }
      throw GrammarRefusal(rule: rule, message: "\(what) \(why.joined(separator: " and ")); it takes exactly \(keys.joined(separator: ", "))")
    }
    return out
  }

  static func string(_ value: StrictJSON?, rule: String, what: String) throws -> String {
    guard case .string(let text)? = value else { throw GrammarRefusal(rule: rule, message: "\(what) must be a string") }
    return text
  }

  static func intent(_ value: StrictJSON, signer: String, chip: [UInt8]) throws -> VaultIntent {
    guard case .object(let members) = value else { throw GrammarRefusal(rule: "intent", message: "an intent must be a JSON object") }
    guard case .string(let kind)? = members.first(where: { $0.key == "intent" })?.value else {
      throw GrammarRefusal(rule: "intent", message: "an intent must name its kind in a string")
    }
    if let why = refusedKinds[kind] { throw GrammarRefusal(rule: "refused_kind", message: "\(kind): \(why)") }
    switch kind {
    case "transfer": return try transfer(value, signer: signer)
    case "remove_public_key": return try removal(value, chip: chip)
    default: throw GrammarRefusal(rule: "unknown_kind", message: "\(kind) is not a kind the chip key signs")
    }
  }

  static func transfer(_ value: StrictJSON, signer: String) throws -> VaultIntent {
    let f = try fields(value, ["intent", "receiver_id", "tokens"], rule: "transfer_keys", what: "a transfer")
    let receiver = try string(f["receiver_id"], rule: "receiver", what: "receiver_id")
    guard isAccountId(receiver) else { throw GrammarRefusal(rule: "receiver", message: "receiver_id is not a NEAR account id") }
    guard receiver != signer else { throw GrammarRefusal(rule: "receiver", message: "a transfer to its own signer moves nothing") }
    guard case .object(let tokens)? = f["tokens"], tokens.count == 1 else {
      throw GrammarRefusal(rule: "tokens", message: "tokens must hold exactly one asset")
    }
    guard let token = chipTokens.first(where: { $0.assetId == tokens[0].key }) else {
      throw GrammarRefusal(rule: "token", message: "\(tokens[0].key) is not in the chip token table")
    }
    guard case .string(let amount) = tokens[0].value, isAmount(amount) else {
      throw GrammarRefusal(rule: "amount", message: "an amount must be a string of digits from 1 to the u128 maximum, with no leading zero")
    }
    return .transfer(receiver: receiver, token: token, amount: amount)
  }

  static func removal(_ value: StrictJSON, chip: [UInt8]) throws -> VaultIntent {
    let f = try fields(value, ["intent", "public_key"], rule: "remove_keys", what: "a key removal")
    let text = try string(f["public_key"], rule: "public_key", what: "public_key")
    guard let key = intentKey(text) else {
      throw GrammarRefusal(rule: "public_key", message: "public_key must be ed25519:, secp256k1: or p256: and the base58 of a key that long")
    }
    guard !(key.curve == "p256" && key.bytes == chip) else {
      throw GrammarRefusal(rule: "signing_key", message: "the chip key never removes itself")
    }
    return .removeKey(key)
  }

  /* A key in the one spelling that decodes to it: a known curve, and base58 that re-encodes to
     itself at that curve's length, so two different strings never name one key. */
  static func intentKey(_ text: String) -> IntentKey? {
    guard let colon = text.firstIndex(of: ":") else { return nil }
    let curve = String(text[..<colon])
    let body = String(text[text.index(after: colon)...])
    // Base58 of n bytes is never longer than 2n characters, so a longer body is refused before the
    // quadratic decode runs on it.
    guard let length = keyLengths[curve], body.utf8.count <= 2 * length, let bytes = Base58.decode(body), bytes.count == length,
          Base58.encode(bytes) == body
    else { return nil }
    return IntentKey(curve: curve, bytes: bytes, text: text)
  }

  /* What holds across the intents: one kind, one receiver, a token symbol once and a key once. A
     symbol and not an id, so a sentence never says USDC twice for two different USDC. */
  static func together(_ intents: [VaultIntent]) throws {
    var kinds = Set<String>()
    var receivers = Set<String>()
    var symbols = Set<String>()
    var keys = Set<String>()
    for item in intents {
      switch item {
      case .transfer(let receiver, let token, _):
        kinds.insert("transfer")
        receivers.insert(receiver)
        guard symbols.insert(token.symbol).inserted else {
          throw GrammarRefusal(rule: "token_repeat", message: "\(token.symbol) appears twice; a payload moves each token once")
        }
      case .removeKey(let key):
        kinds.insert("remove_public_key")
        guard keys.insert(key.text).inserted else {
          throw GrammarRefusal(rule: "key_repeat", message: "one key is removed twice")
        }
      }
    }
    guard kinds.count <= 1 else { throw GrammarRefusal(rule: "one_kind", message: "a payload carries one kind of intent") }
    guard receivers.count <= 1 else { throw GrammarRefusal(rule: "one_receiver", message: "every transfer in a payload goes to one receiver") }
  }

  static func checkNonce(_ text: String, deadline: Int64) throws {
    guard let data = Data(base64Encoded: text), data.count == 32, data.base64EncodedString() == text else {
      throw GrammarRefusal(rule: "nonce", message: "the nonce must be canonical base64 of 32 bytes")
    }
    let bytes = [UInt8](data)
    guard Array(bytes[0..<5]) == nonceHead else {
      throw GrammarRefusal(rule: "nonce", message: "the nonce must be a V1 nonce, starting 5628f6c6 00")
    }
    var ns: UInt64 = 0
    for byte in bytes[9..<17].reversed() { ns = (ns << 8) | UInt64(byte) }
    let (expiry, overflow) = deadline.addingReportingOverflow(nonceLifeNs)
    guard !overflow, Int64(bitPattern: ns) == expiry else {
      throw GrammarRefusal(rule: "nonce", message: "the nonce must expire exactly seven days after the payload's deadline")
    }
  }

  /* A NEAR account id: 2 to 64 of a-z and 0-9, in runs joined by single dots, dashes or underscores. */
  static func isAccountId(_ s: String) -> Bool {
    let b = Array(s.utf8)
    guard b.count >= 2, b.count <= 64 else { return false }
    var afterSeparator = true
    for c in b {
      if (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) {
        afterSeparator = false
        continue
      }
      guard c == UInt8(ascii: "-") || c == UInt8(ascii: "_") || c == UInt8(ascii: "."), !afterSeparator else { return false }
      afterSeparator = true
    }
    return !afterSeparator
  }

  /* Exactly the digits a u128 prints: no sign, no leading zero, 1 to 2^128 - 1. */
  static func isAmount(_ s: String) -> Bool {
    let b = Array(s.utf8)
    guard !b.isEmpty, b.count <= u128Max.count, b[0] != UInt8(ascii: "0"), b.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }) else {
      return false
    }
    return b.count < u128Max.count || !u128Max.lexicographicallyPrecedes(b)
  }

  /* 2026-10-04T18:33:36.641Z and nothing looser, as nanoseconds since 1970, or nil. Years stop at
     2261 so the nanoseconds fit an i64, as they do in the nonce. */
  static func nanoseconds(rfc3339 s: String) -> Int64? {
    let b = Array(s.utf8)
    guard b.count >= 20, b.count <= 30, b[b.count - 1] == UInt8(ascii: "Z") else { return nil }
    func digits(_ from: Int, _ to: Int) -> Int? {
      var v = 0
      for i in from..<to {
        guard StrictJSONParser.isDigit(b[i]) else { return nil }
        v = v * 10 + Int(b[i] - 0x30)
      }
      return v
    }
    guard b[4] == UInt8(ascii: "-"), b[7] == UInt8(ascii: "-"), b[10] == UInt8(ascii: "T"),
          b[13] == UInt8(ascii: ":"), b[16] == UInt8(ascii: ":"),
          let year = digits(0, 4), let month = digits(5, 7), let day = digits(8, 10),
          let hour = digits(11, 13), let minute = digits(14, 16), let second = digits(17, 19)
    else { return nil }
    var nanos = 0
    if b.count > 20 {
      guard b[19] == UInt8(ascii: "."), b.count >= 22, let fraction = digits(20, b.count - 1) else { return nil }
      nanos = fraction
      for _ in 0..<(30 - b.count) { nanos *= 10 }
    }
    guard year >= 1970, year <= 2261, month >= 1, month <= 12, day >= 1, day <= daysIn(month, of: year),
          hour < 24, minute < 60, second < 60
    else { return nil }
    let seconds = Int64(daysFromCivil(year, month, day)) * 86_400 + Int64(hour * 3600 + minute * 60 + second)
    return seconds * 1_000_000_000 + Int64(nanos)
  }

  static func daysIn(_ month: Int, of year: Int) -> Int {
    switch month {
    case 2: return (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 ? 29 : 28
    case 4, 6, 9, 11: return 30
    default: return 31
    }
  }

  /* Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's days_from_civil). */
  static func daysFromCivil(_ year: Int, _ month: Int, _ day: Int) -> Int {
    let y = month <= 2 ? year - 1 : year
    let era = y / 400
    let yoe = y - era * 400
    let doy = (153 * (month > 2 ? month - 3 : month + 9) + 2) / 5 + day - 1
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146_097 + doe - 719_468
  }

  static func name(_ account: String, _ pins: ChipPins) -> String {
    if account == pins.account { return "your vault" }
    if account == pins.allowance { return "your allowance" }
    // A NEAR name is said whole: anyone can register one and choose both of its ends.
    let b = Array(account.utf8)
    let hex = { (c: UInt8) in (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) }
    if b.count == 64, b.allSatisfy(hex) { return ends(account) }
    if b.count == 42, account.hasPrefix("0x"), b.dropFirst(2).allSatisfy(hex) { return "0x" + ends(String(account.dropFirst(2))) }
    return account
  }

  /* Eight characters each end: four and four of hex is a few minutes of a vanity generator, eight
     and eight is beyond it (src/vault/reason.ts, END_CHARS). */
  static func ends(_ s: String) -> String { "\(s.prefix(8))...\(s.suffix(8))" }

  static func list(_ items: [String]) -> String {
    guard items.count > 1 else { return items.first ?? "" }
    return items.dropLast().joined(separator: ", ") + " and " + items[items.count - 1]
  }

  /* An amount in base units as the sentence says it: exact, the point placed by the token's
     decimals, thousands grouped, trailing zeros trimmed down to two places. */
  static func decimal(_ amount: String, places: Int) -> String {
    var digits = Array(amount)
    if digits.count <= places { digits = Array(repeating: "0", count: places + 1 - digits.count) + digits }
    let whole = Array(digits[..<(digits.count - places)])
    var fraction = Array(digits[(digits.count - places)...])
    while fraction.count > 2, fraction.last == "0" { fraction.removeLast() }
    while fraction.count < 2 { fraction.append("0") }
    var grouped = ""
    for (i, c) in whole.enumerated() {
      if i > 0, (whole.count - i) % 3 == 0 { grouped.append(",") }
      grouped.append(c)
    }
    return grouped + "." + String(fraction)
  }
}

/* The webauthn wrapper the service puts around every payload it signs, exactly as the verifier
   accepted it live (0.4.4): authenticator data is sha256("phosphor.money"), flags 0x05 (user
   present, user verified) and a zero counter; client data names the payload's sha256 as the
   challenge. The verifier checks the flags and the challenge, never the origin or the rp id. */
enum ChipWebAuthn {
  static let origin = "https://phosphor.money"
  static let authenticatorData = Data(SHA256.hash(data: Data("phosphor.money".utf8))) + Data([0x05, 0x00, 0x00, 0x00, 0x00])

  static func clientDataJSON(payload: Data) -> Data {
    let challenge = base64url(Data(SHA256.hash(data: payload)))
    return Data("{\"type\":\"webauthn.get\",\"challenge\":\"\(challenge)\",\"origin\":\"\(origin)\"}".utf8)
  }

  /* What the chip signs: SecKeyCreateSignature with ecdsaSignatureMessageX962SHA256 hashes it once
     more, which is ES256. */
  static func signedData(payload: Data) -> Data {
    authenticatorData + Data(SHA256.hash(data: clientDataJSON(payload: payload)))
  }

  static func base64url(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  /* A P-256 public key (x || y) or signature (r || s) as the verifier spells it. */
  static func p256(_ bytes: Data) -> String { "p256:" + Base58.encode([UInt8](bytes)) }

  /* The MultiPayload the verifier takes, from the payload exactly as the grammar read it, the chip
     key's x || y, and the DER the chip answered over signedData(payload:). */
  static func multiPayload(payload: Data, publicKey: Data, der: Data) throws -> [String: String] {
    [
      "standard": "webauthn",
      "payload": String(decoding: payload, as: UTF8.self),
      "public_key": p256(publicKey),
      "signature": p256(try ChipSignature.wire(der: der)),
      "client_data_json": String(decoding: clientDataJSON(payload: payload), as: UTF8.self),
      "authenticator_data": base64url(authenticatorData),
    ]
  }
}

/* The chip answers DER; the verifier takes r || s with a low S. */
enum ChipSignature {
  /* The order n of P-256 (SEC 2), big-endian. */
  static let order: [UInt8] = [
    0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51,
  ]

  /* n / 2, rounded down. */
  static let halfOrder: [UInt8] = {
    var out = [UInt8](repeating: 0, count: 32)
    var carry: UInt8 = 0
    for i in 0..<32 {
      out[i] = (order[i] >> 1) | carry
      carry = (order[i] & 1) << 7
    }
    return out
  }()

  /* r || s from DER: a SEQUENCE of two INTEGERs, each positive, minimal and below n, with nothing
     after them. An integer shorter than 32 bytes is padded on the left. */
  static func raw(der: Data) throws -> Data {
    let b = [UInt8](der)
    guard b.count >= 8, b.count <= 72, b[0] == 0x30, Int(b[1]) == b.count - 2 else {
      throw GrammarRefusal(rule: "der", message: "not a DER sequence of the right length")
    }
    var at = 2
    let r = try integer(b, &at)
    let s = try integer(b, &at)
    guard at == b.count else { throw GrammarRefusal(rule: "der", message: "bytes after the second integer") }
    return Data(r + s)
  }

  static func integer(_ b: [UInt8], _ at: inout Int) throws -> [UInt8] {
    guard at + 2 <= b.count, b[at] == 0x02 else { throw GrammarRefusal(rule: "der", message: "an INTEGER is missing") }
    let length = Int(b[at + 1])
    at += 2
    guard length >= 1, length <= 33, at + length <= b.count else { throw GrammarRefusal(rule: "der", message: "an INTEGER has a bad length") }
    var v = Array(b[at..<(at + length)])
    at += length
    guard v[0] & 0x80 == 0 else { throw GrammarRefusal(rule: "der", message: "a negative INTEGER") }
    if v.count > 1, v[0] == 0 {
      guard v[1] & 0x80 != 0 else { throw GrammarRefusal(rule: "der", message: "an INTEGER with a needless leading zero") }
      v.removeFirst()
    }
    guard v.count <= 32 else { throw GrammarRefusal(rule: "der", message: "an INTEGER longer than 32 bytes") }
    let padded = [UInt8](repeating: 0, count: 32 - v.count) + v
    guard padded.contains(where: { $0 != 0 }), padded.lexicographicallyPrecedes(order) else {
      throw GrammarRefusal(rule: "der", message: "an INTEGER outside 1 to n - 1")
    }
    return padded
  }

  /* S = n - S when S > n / 2: the verifier refuses a high S, and the chip returns one about half
     the time (25 of 61 in spike2). Anything but 64 bytes comes back as it went in. */
  static func lowS(_ raw: Data) -> Data {
    guard raw.count == 64 else { return raw }
    let r = [UInt8](raw.prefix(32))
    let s = [UInt8](raw.suffix(32))
    guard halfOrder.lexicographicallyPrecedes(s) else { return raw }
    var out = [UInt8](repeating: 0, count: 32)
    var borrow = 0
    for i in (0..<32).reversed() {
      var d = Int(order[i]) - Int(s[i]) - borrow
      borrow = d < 0 ? 1 : 0
      if d < 0 { d += 256 }
      out[i] = UInt8(d)
    }
    return Data(r + out)
  }

  /* What the verifier takes, from what the chip answers. */
  static func wire(der: Data) throws -> Data { lowS(try raw(der: der)) }
}

/* Base58 with the Bitcoin alphabet, which NEAR uses for keys and signatures. */
enum Base58 {
  static let alphabet = Array("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".utf8)
  static let values: [UInt8: Int] = {
    var out: [UInt8: Int] = [:]
    for (i, c) in alphabet.enumerated() { out[c] = i }
    return out
  }()

  static func encode(_ bytes: [UInt8]) -> String {
    var zeros = 0
    while zeros < bytes.count, bytes[zeros] == 0 { zeros += 1 }
    var digits: [Int] = []
    for byte in bytes[zeros...] {
      var carry = Int(byte)
      for i in 0..<digits.count {
        carry += digits[i] << 8
        digits[i] = carry % 58
        carry /= 58
      }
      while carry > 0 {
        digits.append(carry % 58)
        carry /= 58
      }
    }
    return String(repeating: "1", count: zeros) + String(decoding: digits.reversed().map { alphabet[$0] }, as: UTF8.self)
  }

  static func decode(_ text: String) -> [UInt8]? {
    let chars = Array(text.utf8)
    var zeros = 0
    while zeros < chars.count, chars[zeros] == UInt8(ascii: "1") { zeros += 1 }
    var bytes: [Int] = []
    for c in chars[zeros...] {
      guard var carry = values[c] else { return nil }
      for i in 0..<bytes.count {
        carry += bytes[i] * 58
        bytes[i] = carry & 0xff
        carry >>= 8
      }
      while carry > 0 {
        bytes.append(carry & 0xff)
        carry >>= 8
      }
    }
    return [UInt8](repeating: 0, count: zeros) + bytes.reversed().map { UInt8($0) }
  }
}
