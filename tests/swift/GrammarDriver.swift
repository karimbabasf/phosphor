// The intent grammar's test driver. tests/unit/intent-grammar.test.ts compiles it with
// src-tauri/se-helper/IntentGrammar.swift and TokenTable.swift into its own temp folder; no build
// script names it, so it is never in an app. It reads one JSON request per line on stdin and writes
// one answer per line, so one process runs the corpus, the mutated payloads and the signatures.
//
//   {"op":"parse","payload"|"payloadHex","nowMs","chip":<hex of x || y>,"pins":{account,allowance,recovery}}
//       -> {"ok":true,"parsed":<the payload as the grammar read it>,"sentence"} or {"ok":false,"rule","message"}
//   {"op":"der","der":<hex>}          -> {"ok":true,"raw":<hex>,"low":<hex>} or a refusal
//   {"op":"low","raw":<hex>}          -> {"ok":true,"low":<hex>}
//   {"op":"wrap","payload"}           -> {"ok":true,"clientDataJSON","authenticatorData","signed":<hex>}
//   {"op":"base58","hex"}             -> {"ok":true,"text"}
//   {"op":"unbase58","text"}          -> {"ok":true,"hex"} or {"ok":false}
//   {"op":"p256","hex"}               -> {"ok":true,"text"}
//   {"op":"multipayload","payloadHex","publicKey":<hex of x || y>,"der":<hex>} -> {"ok":true,"signed":<MultiPayload>}
//   {"op":"tokens"}                   -> {"ok":true,"tokens":[[assetId, symbol, decimals]]}

import Foundation

@main
struct GrammarDriver {
  static func main() {
    var out = Data()
    while let line = readLine(strippingNewline: true) {
      let answer = (try? JSONSerialization.data(withJSONObject: respond(line), options: [.sortedKeys]))
        ?? Data("{\"ok\":false,\"rule\":\"driver\",\"message\":\"the answer did not encode\"}".utf8)
      out.append(answer)
      out.append(0x0a)
      if out.count > 1 << 20 {
        FileHandle.standardOutput.write(out)
        out.removeAll()
      }
    }
    FileHandle.standardOutput.write(out)
  }

  static func respond(_ line: String) -> [String: Any] {
    guard let req = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any], let op = req["op"] as? String else {
      return driverError("expected one JSON object with an op")
    }
    do {
      switch op {
      case "parse": return try parse(req)
      case "der":
        let raw = try ChipSignature.raw(der: try hexField(req, "der"))
        return ["ok": true, "raw": hex(raw), "low": hex(ChipSignature.lowS(raw))]
      case "low": return ["ok": true, "low": hex(ChipSignature.lowS(try hexField(req, "raw")))]
      case "wrap":
        let payload = Data((req["payload"] as? String ?? "").utf8)
        return [
          "ok": true,
          "clientDataJSON": String(decoding: ChipWebAuthn.clientDataJSON(payload: payload), as: UTF8.self),
          "authenticatorData": ChipWebAuthn.base64url(ChipWebAuthn.authenticatorData),
          "signed": hex(ChipWebAuthn.signedData(payload: payload)),
        ]
      case "base58": return ["ok": true, "text": Base58.encode([UInt8](try hexField(req, "hex")))]
      case "unbase58":
        guard let bytes = Base58.decode(req["text"] as? String ?? "") else { return ["ok": false] }
        return ["ok": true, "hex": hex(Data(bytes))]
      case "p256": return ["ok": true, "text": ChipWebAuthn.p256(try hexField(req, "hex"))]
      case "multipayload":
        let signed = try ChipWebAuthn.multiPayload(payload: try hexField(req, "payloadHex"), publicKey: try hexField(req, "publicKey"), der: try hexField(req, "der"))
        return ["ok": true, "signed": signed]
      case "tokens": return ["ok": true, "tokens": chipTokens.map { [$0.assetId, $0.symbol, $0.decimals] as [Any] }]
      default: return driverError("unknown op \(op)")
      }
    } catch let refusal as GrammarRefusal {
      return ["ok": false, "rule": refusal.rule, "message": refusal.message]
    } catch {
      return driverError("\(error)")
    }
  }

  static func parse(_ req: [String: Any]) throws -> [String: Any] {
    let payload: Data
    if let text = req["payload"] as? String {
      payload = Data(text.utf8)
    } else {
      payload = try hexField(req, "payloadHex")
    }
    guard let nowMs = (req["nowMs"] as? NSNumber)?.int64Value, let pins = req["pins"] as? [String: String],
          let account = pins["account"], let allowance = pins["allowance"], let recovery = pins["recovery"]
    else { return driverError("parse needs nowMs and pins") }
    let read = try IntentGrammar.parse(payload, now: Date(timeIntervalSince1970: Double(nowMs) / 1000), chip: try hexField(req, "chip"))
    let sentence = try IntentGrammar.sentence(read, pins: ChipPins(account: account, allowance: allowance, recovery: recovery))
    return ["ok": true, "parsed": describe(read), "sentence": sentence]
  }

  static func describe(_ p: VaultPayload) -> [String: Any] {
    let intents = p.intents.map { item -> [String: Any] in
      switch item {
      case .transfer(let receiver, let token, let amount):
        return ["intent": "transfer", "receiver_id": receiver, "tokens": [token.assetId: amount]]
      case .removeKey(let key):
        return ["intent": "remove_public_key", "public_key": key.text]
      }
    }
    return ["signer_id": p.signerId, "verifying_contract": p.verifyingContract, "deadline": p.deadline, "nonce": p.nonce, "intents": intents]
  }

  static func driverError(_ message: String) -> [String: Any] { ["ok": false, "rule": "driver", "message": message] }

  static func hexField(_ req: [String: Any], _ key: String) throws -> Data {
    guard let text = req[key] as? String, text.utf8.count % 2 == 0 else { throw GrammarRefusal(rule: "driver", message: "\(key) must be hex") }
    var out = Data()
    var high: UInt8?
    for c in text.utf8 {
      let v: UInt8
      switch c {
      case UInt8(ascii: "0")...UInt8(ascii: "9"): v = c - UInt8(ascii: "0")
      case UInt8(ascii: "a")...UInt8(ascii: "f"): v = c - UInt8(ascii: "a") + 10
      default: throw GrammarRefusal(rule: "driver", message: "\(key) must be lowercase hex")
      }
      if let h = high {
        out.append(h << 4 | v)
        high = nil
      } else {
        high = v
      }
    }
    return out
  }

  static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
}
