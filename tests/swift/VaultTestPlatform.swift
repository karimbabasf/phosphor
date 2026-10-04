// The keychain, the enclave and the clock of src-tauri/se-helper/main.swift, played from a JSON
// file, so tests/unit/vault-service.test.ts can run the service's rules with no Touch ID and no
// keychain. Compiled only into that test's own binary, with PHOSPHOR_STDIO and PHOSPHOR_TESTSEAM;
// no build script passes either flag to the service that ships, and the test checks that too.
//
// Read from the environment, by this binary alone:
//   PHOSPHOR_TEST_STORE  the JSON file: keys, markers and every call made, read and written per call
//   PHOSPHOR_TEST_TEAM   the Team ID to report; empty or absent is a build with none
//   PHOSPHOR_TEST_NOW    the clock, in seconds since 1970
//   PHOSPHOR_TEST_FAIL   op=status pairs, comma separated: that keychain call answers that status
//   PHOSPHOR_TEST_SE     "0" for a Mac with no Secure Enclave
//   PHOSPHOR_TEST_TOUCH  "cancel" for an owner who cancels the dialog
//
// The enclave is a software P-256 key, kept in the file. What the keychain answers where this file
// has to choose is what the custody spike measured on a real Mac: a process that names no group and
// carries no entitlement gets errSecMissingEntitlement (-34018) for a permanent key, a lookup that
// finds nothing gets errSecItemNotFound (-25300), and a second add of the same item gets
// errSecDuplicateItem (-25299).

#if PHOSPHOR_TESTSEAM
import Foundation
import CryptoKit

final class TestPlatform: Platform {
  struct Key: Codable { var tag: String; var group: String; var created: Double; var priv: String }
  struct Mark: Codable { var tag: String; var group: String; var body: String; var created: Double }
  struct Store: Codable { var keys: [Key] = []; var markers: [Mark] = []; var calls: [String] = []; var blobs: Int = 0 }

  let env = ProcessInfo.processInfo.environment

  func load() -> Store {
    guard let path = env["PHOSPHOR_TEST_STORE"], let data = FileManager.default.contents(atPath: path) else { return Store() }
    return (try? JSONDecoder().decode(Store.self, from: data)) ?? Store()
  }

  func save(_ store: Store) {
    guard let path = env["PHOSPHOR_TEST_STORE"], let data = try? JSONEncoder().encode(store) else { return }
    FileManager.default.createFile(atPath: path, contents: data)
  }

  func record(_ call: String) {
    var store = load()
    store.calls.append(call)
    save(store)
  }

  func failing(_ op: String) -> OSStatus? {
    for pair in (env["PHOSPHOR_TEST_FAIL"] ?? "").split(separator: ",") {
      let kv = pair.split(separator: "=")
      if kv.count == 2, kv[0] == op, let status = Int32(kv[1]) { return status }
    }
    return nil
  }

  func team() -> String? {
    let team = env["PHOSPHOR_TEST_TEAM"] ?? ""
    return team.isEmpty ? nil : team
  }

  func enclaveAvailable() -> Bool { env["PHOSPHOR_TEST_SE"] != "0" }

  func now() -> Date {
    Date(timeIntervalSince1970: Double(env["PHOSPHOR_TEST_NOW"] ?? "") ?? Date().timeIntervalSince1970)
  }

  func makeKey(tag: String, group: String?) -> Result<Data, KeychainStatus> {
    record("makeKey \(group ?? "-")")
    if let status = failing("makeKey") { return .failure(KeychainStatus(status: status)) }
    guard let group else { return .failure(KeychainStatus(status: -34018)) }
    let priv = P256.KeyAgreement.PrivateKey()
    var store = load()
    store.keys.append(Key(tag: tag, group: group, created: now().timeIntervalSince1970, priv: priv.rawRepresentation.base64EncodedString()))
    save(store)
    return .success(priv.publicKey.x963Representation)
  }

  func keys(group: String) -> Result<[VaultKey], KeychainStatus> {
    record("keys \(group)")
    if let status = failing("keys") { return .failure(KeychainStatus(status: status)) }
    return .success(load().keys.filter { $0.group == group }.map { VaultKey(tag: $0.tag, created: Date(timeIntervalSince1970: $0.created)) })
  }

  func deleteKey(tag: String, group: String) -> OSStatus {
    record("deleteKey \(tag) \(group)")
    if let status = failing("deleteKey") { return status }
    var store = load()
    let before = store.keys.count
    store.keys.removeAll { $0.tag == tag && $0.group == group }
    save(store)
    return store.keys.count < before ? errSecSuccess : errSecItemNotFound
  }

  func markers(group: String) -> Result<[String: Marker], KeychainStatus> {
    record("markers \(group)")
    if let status = failing("markers") { return .failure(KeychainStatus(status: status)) }
    var out: [String: Marker] = [:]
    for mark in load().markers where mark.group == group {
      out[mark.tag] = Marker(pin: pinIn(Data(base64Encoded: mark.body)), at: Date(timeIntervalSince1970: mark.created))
    }
    return .success(out)
  }

  func addMarker(tag: String, body: Data, group: String) -> OSStatus {
    record("addMarker \(tag) \(group)")
    if let status = failing("addMarker") { return status }
    var store = load()
    if store.markers.contains(where: { $0.tag == tag && $0.group == group }) { return errSecDuplicateItem }
    store.markers.append(Mark(tag: tag, group: group, body: body.base64EncodedString(), created: now().timeIntervalSince1970))
    save(store)
    return errSecSuccess
  }

  func agree(tag: String, group: String?, eph: Data, reason: String) throws -> (Data, Data) {
    record("agree \(tag) \(group ?? "-")")
    if env["PHOSPHOR_TEST_TOUCH"] == "cancel" { throw Fail(code: "user_cancel", message: "cancelled") }
    guard let key = load().keys.first(where: { $0.tag == tag && (group == nil || $0.group == group) }),
          let raw = Data(base64Encoded: key.priv),
          let priv = try? P256.KeyAgreement.PrivateKey(rawRepresentation: raw)
    else { throw Fail(code: "crypto_failed", message: "keychain key -25300") }
    let secret = try priv.sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PublicKey(x963Representation: eph))
    return (secret.withUnsafeBytes { Data($0) }, priv.publicKey.x963Representation)
  }

  func makeBlob() throws -> (Data, Data) {
    record("makeBlob")
    var store = load()
    store.blobs += 1
    save(store)
    let priv = P256.KeyAgreement.PrivateKey()
    return (priv.rawRepresentation, priv.publicKey.x963Representation)
  }

  func agree(blob: Data, eph: Data, reason: String) throws -> (Data, Data) {
    record("agree blob")
    if env["PHOSPHOR_TEST_TOUCH"] == "cancel" { throw Fail(code: "user_cancel", message: "cancelled") }
    guard let priv = try? P256.KeyAgreement.PrivateKey(rawRepresentation: blob) else {
      throw Fail(code: "foreign_key", message: "this Secure Enclave did not make that key")
    }
    let secret = try priv.sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PublicKey(x963Representation: eph))
    return (secret.withUnsafeBytes { Data($0) }, priv.publicKey.x963Representation)
  }
}
#endif
