# Check it yourself

Phosphor's wallet makes seven security claims. For each one this page names the code that enforces
it, the test that fails if it stops holding, and the command that runs that test, followed by the
lines it prints when the claim holds. Then it shows how to check your download and your vault on
NEAR with tools that are not Phosphor's, and what you cannot check yet.

The claims are about a vault that moved to this Mac's Touch ID key (the Vault tab's move); before
it, your wallet's own key signs
([What signs, and with what](security-model.md#what-signs-and-with-what)).
[What it defends against](security-model.md#what-it-defends-against-and-the-test-that-proves-it)
covers the rest of the app the same way. To report a claim that does not hold, see
[SECURITY.md](https://github.com/karimbabasf/phosphor/blob/main/SECURITY.md).

## Before you start

You need a Mac with Node 24 and Xcode's command line tools, and a clone at the tag of your version:

```
git clone --depth 1 --branch v0.10.16 https://github.com/karimbabasf/phosphor.git
cd phosphor && npm ci
```

In the blocks below, a line that starts with `$ ` is a command and the lines after it are what it
must print. A passing test prints `✔`, its name and its time; every run ends with `ℹ fail 0`, and
`npm test` runs them all. `PASS` lines come from the attack suite, which plays a hostile program
against the app this checkout builds: `npm run app:build` once, then
`npm run attack -- --only <case>`.

The boundary is the vault service, in Swift under `src-tauri/se-helper/`: `main.swift` holds the
keychain and the Touch ID call, `ChipOps.swift` the operations of the vault's Touch ID key (the chip
key) and `IntentGrammar.swift` the only payloads it signs. The backend builds every payload and may
be compromised, so the service reads each one itself. Its tests run it with a stand-in keychain.

## The claims

### 1. Only this Mac's Touch ID key and your paper key can move your vault

The move is one call to the NEAR Intents verifier: add the chip key and the paper key, remove every
other key, turn off auth by predecessor id. Its dry run must report exactly the events the app
planned. The NEAR Intents relay puts the signed call on chain and pays NEAR's fee; it can delay or
drop it and cannot change it, because every payload in it is signed. Afterwards the app checks at
one final block that those two are the vault's only keys, and says so when another key is there.

Enforced by the verifier, which runs an intent for the vault only when a key it holds for it signed;
`IntentGrammar.swift` (`refusedKinds`, claim 3); `src/vault/rekey.ts` (`rekeyIntents`,
`rekeyEvents`), `src/vault/payload.ts` (`expectedEvents`), `src/vault/submit.ts` (`rekeyViews`).
Proved by `tests/unit/rekey-core.test.ts`, `tests/unit/rekey.test.ts` and the verifier's own dry
run of the move, signed by keys made for it; `spiked: yes` says it is the build Phosphor tested.

```
$ node scripts/run-tests.ts tests/unit/rekey-core.test.ts tests/unit/rekey.test.ts
✔ a migration signs C7's bundle: P_a adds the chip and the paper, removes the owner key and turns predecessor auth off
✔ the migration bundle simulates to exactly C7's five events on P_a's hash, and runs to the four views
✔ a key someone adds to the vault while the move is being signed is caught after it: the vault moved, and the window is told it holds a key the move did not add
$ node scripts/verifier-check.ts --simulate
intents.near 0.4.5 BtA1BE...othk spiked: yes
PASS simulate move to the chip (own key adds chip and paper, removes itself, predecessor auth off; paper []; chip []): executed=3 events=public_key_added,public_key_added,public_key_removed,set_auth_by_predecessor_id(enabled=false),intents_executed exact: yes
```

### 2. Every chip key signature takes one Touch ID, and the vault service writes its sentence

The chip key's access control asks for you on every use: Touch ID, or your login password. Each
signature gets its own context, and the dialog shows a sentence the service wrote from the payload
it read, such as "move 100.00 USDC from your vault to your allowance". The backend never sends one.

Enforced by `main.swift` (`accessControl` with `.userPresence`; the platform's `sign`, reuse 0,
the sentence as `localizedReason`), `ChipOps.swift` (`signIntent`) and `IntentGrammar.swift`
(`IntentGrammar.sentence`). Proved by `tests/unit/chip-service.test.ts` and
`tests/unit/enclave-sidecar.test.ts`.

```
$ node scripts/run-tests.ts tests/unit/chip-service.test.ts tests/unit/enclave-sidecar.test.ts
✔ every payload the grammar takes is signed once, its dialog says exactly its sentence, and the signature verifies in Node
✔ every refusal before the key answers with no dialog: the corpus, the signer, and the order C1 gives
✔ the enclave key demands the owner every time, and the two wrap halves share their constants
```

### 3. The chip key signs only what its grammar allows: no key change, money only to your allowance

The grammar takes a move of known tokens out of the vault to your allowance, the removal of a key
other than the signing chip key, and the empty proof a move asks of a new chip key. The allowance is
the account the chip key's marker pinned before the vault moved, so the chip names no receiver but
your own allowance: a transfer to any other account is refused, a name made to read like yours
(`your-allowance.near`) among them. Every other kind is refused by name before the key is touched,
`add_public_key` and `set_auth_by_predecessor_id` first, so a refusal raises no dialog. It reads
only JSON that every parser reads one way. The backend runs the same rules first
(`src/vault/chip-grammar.ts`), so a payload they refuse never reaches the service.

Enforced by `IntentGrammar.swift` (`refusedKinds`, `IntentGrammar.parse`, `StrictJSONParser`, and
the `receiver` rule in `IntentGrammar.sentence`), which `ChipOps.swift` `signIntent` calls before
the key. Proved by `tests/unit/intent-grammar.test.ts`,
`tests/unit/audit2-grammar-named-receiver.test.ts` and attack `31-chip-hostile-payloads` (claim 6).
The `ℹ` line is the count the test prints for its corpus of payloads.

```
$ node scripts/run-tests.ts tests/unit/intent-grammar.test.ts tests/unit/audit2-grammar-named-receiver.test.ts
✔ every corpus case is accepted with its sentence byte for byte, or refused by its rule
ℹ 148 corpus cases: 21 accepted, 127 refused, 28 rules
✔ the chip key never signs add_public_key or set_auth_by_predecessor_id, however the payload dresses it
✔ 10 000 mutated payloads: every one the grammar accepts reads the same in JSON.parse, and none crashes it
✔ AU2-01: a receiver the marker does not pin never gets a Touch ID sentence, and Node refuses it first
```

### 4. Agents cannot move vault money

No agent is offered a vault tool, and every `/api/vault` write needs the window's token. A top-up
waits for your click at any size, then your Touch ID. A move that runs with no click and finds the
allowance short signs nothing; a move you clicked takes the difference behind its own Touch ID.

Enforced by `src/policy/engine.ts` (`evaluateTopUp`), `src/proposals/execute.ts`
(`proposeVaultTopUp`, the shortfall check), `src/http/allowance.ts` and `src/http/chip.ts` (window
only, nothing on `/api/mcp`). Proved by `tests/unit/allowance-property.test.ts`,
`tests/unit/allowance-routes.test.ts` and attacks `32-mcp-chip-reach`, `33-relay-ops`,
`34-agent-top-up`.

```
$ node scripts/run-tests.ts tests/unit/allowance-property.test.ts tests/unit/allowance-routes.test.ts
✔ 1000 random agent proposals, the vault Touch ID always cancelled: the vault never moves, only the allowance pays
✔ the agent has no door to the allowance: no op on /api/mcp and no tool names a top-up or a size
$ npm run attack -- --only 3
PASS  32-mcp-chip-reach          no agent reaches the chip vault: no seat is offered a chip tool, and every /api/vault write refuses what an agent holds
PASS  33-relay-ops               only the shell, holding the relay secret, takes or answers relay requests; a demo hands out no chip key write
PASS  34-agent-top-up            an agent cannot make or approve a vault top-up: the chip key moves vault money only after a person clicks
```

### 5. The allowance holds at most its size plus 10 percent while no move is under way

Agents spend the allowance with no Touch ID ($100 unless you pick another size). A top-up asks for
at most the room under the size plus 10 percent ($110), or the size alone while the allowance's
balance cannot be read. A sweep sends everything over that line back to the vault, USDC first,
after every settled move, at every unlock and every ten minutes; until then, money sent to the
allowance's address can hold it over. While moves are approved, waiting on a Touch ID or running,
the sweep keeps the larger of the size and what they will spend, and sends home what is over that
plus 10 percent.

Enforced by `src/vault/allowance.ts` (`sweepPlan`) and `src/proposals/execute.ts`
(`proposeVaultTopUp`). Proved by `tests/unit/allowance.test.ts`.

```
$ node scripts/run-tests.ts tests/unit/allowance.test.ts
✔ nothing goes home while the allowance is worth at most its size plus 10 %, exactly at the line included
✔ USDC first, then the rest by dollar value, down to the size and never under it
✔ a top-up the window asks for: USDC only, never past the size plus 10 %, never from an empty vault
```

### 6. A hostile backend cannot add a key or skip a touch

This is claims 2 and 3 on the built app. On a signed release, macOS checks every caller of the
vault service before it reads a message, and lets only the signed Phosphor app through; a build
with no Team ID refuses every chip operation. Rewriting `state/vault.json` cannot point the vault
at another chip key, or bring your wallet's key back while NEAR shows the vault moved: the
service's marker, written once and never deleted, and the chain decide.

Enforced by `main.swift` (`peerRequirement`, `xpc_main`), `ChipOps.swift` (`chipCommit`) and
`src/vault/chip.ts` (`ownerKeyGate`). Proved by `tests/unit/vault-peer-check.test.ts`,
`tests/unit/vault-chip.test.ts` and attacks `30-xpc-sign-intent`, `31-chip-hostile-payloads`,
`35-vault-json-keyref-swap`. Add `--app /Applications/Phosphor.app` after `--only 3` to also watch
macOS turn every stranger away from a signed release's service.

```
$ node scripts/run-tests.ts tests/unit/vault-peer-check.test.ts tests/unit/vault-chip.test.ts
✔ a peer that fails the service requirement is refused, and the Phosphor shell is answered
✔ deleting the chip entry in vault.json does not bring the owner key back while a marker names the vault and the chain shows it moved
$ npm run attack -- --only 3
PASS  30-xpc-sign-intent         a stranger asking the enclave XPC service for signIntent or chipCreate is refused: no chip op reaches a key from outside the shell
PASS  31-chip-hostile-payloads   every hostile vault payload, set_auth and add_public_key among them, is refused before the chip service raises its one dialog
PASS  35-vault-json-keyref-swap  rewriting vault.json cannot point the vault at another chip key or bring the owner key back
```

### 7. The app you run is the one the tag builds

Before it starts the backend, the shell hashes the app's own files (the payload) and starts nothing
when they differ from the digest built into the release. `shasum` gets the same digest.

Enforced by `src-tauri/src/payload.rs` (`check`) and `scripts/payload-digest.ts`. Proved by
`tests/unit/payload-digest.test.ts`, attack `03-payload-tamper` and the three digests in
[Check a release yourself](security-model.md#check-a-release-yourself).

```
$ node scripts/run-tests.ts tests/unit/payload-digest.test.ts
✔ the digest is what shasum gives for the same files, by the command docs/security.md prints
```

## Check your download

[Check a release yourself](security-model.md#check-a-release-yourself) checks the disk image's
SHA-256, GitHub's attestation that the tag's release workflow built it, and the payload digest. The
checks below add who signed it and that Apple notarized it. Open the disk image first: it mounts at
`/Volumes/Phosphor`.

```
$ xcrun stapler validate ~/Downloads/Phosphor-macOS-arm64.dmg
The validate action worked!
$ spctl --assess --type open --context context:primary-signature --verbose=2 ~/Downloads/Phosphor-macOS-arm64.dmg
source=Notarized Developer ID
$ codesign --verify --deep --strict --verbose=2 /Volumes/Phosphor/Phosphor.app
/Volumes/Phosphor/Phosphor.app: satisfies its Designated Requirement
$ codesign -dv --verbose=2 /Volumes/Phosphor/Phosphor.app 2>&1 | grep -E '^(Identifier|TeamIdentifier)='
Identifier=com.karimbabasf.phosphor
TeamIdentifier=35Z6P26CBD
$ spctl --assess --type execute --verbose=2 /Volumes/Phosphor/Phosphor.app
source=Notarized Developer ID
$ codesign -d --entitlements - /Volumes/Phosphor/Phosphor.app/Contents/XPCServices/com.karimbabasf.phosphor.vault.xpc
	[Key] keychain-access-groups
	[Value]
		[Array]
			[String] 35Z6P26CBD.com.karimbabasf.phosphor.vault
```

35Z6P26CBD is Phosphor's team, the only one the updater accepts (`TEAMS` in
`src-tauri/src/update.rs`), and the last command shows the vault service keeping its keys in one
keychain group of that team's. The same commands work on `/Applications/Phosphor.app`.

## Check your vault on NEAR

The Vault tab's "Who opens your vault" reads your vault from NEAR through Phosphor.
`scripts/vault-check.ts` reads it with no Phosphor code in the way. It needs Node alone (no
`npm ci`) and imports nothing else, so you can read all of it:

```
node scripts/vault-check.ts <your vault's 0x address>
```

It asks two NEAR RPC providers run by different organizations, FastNEAR and dRPC, at one final
block: which public keys intents.near holds for the vault, and whether auth by predecessor id is
on. It prints the block, and an answer only when both agree. When they disagree it exits 1, when
one gives no answer it exits 2, and both times it names each provider's answer. A moved vault holds
two keys, `p256:` (this Mac's Touch ID key) and `secp256k1:` (your paper key), and reads
`predecessor auth: off`.

The vault's own key, the one its 0x address comes from, is never in that list, even while it can
sign, so ask for it by name. The installed app keeps the move's public keys, and no secret, in
`~/Library/Application Support/com.karimbabasf.phosphor/state/chip-run.json`: `old` is your
wallet's key, `recovery` your paper key, `chip.publicKey` this Mac's Touch ID key.

```
node scripts/vault-check.ts <your vault's 0x address> --key <old> --key <chip.publicKey>
```

| Who opens your vault, in the Vault tab | What vault-check.ts prints |
|---|---|
| This Mac's Touch ID key: Opens it | `has <chip.publicKey>: yes`, and that key in the list |
| Your paper key: Opens it | the `recovery` key in the list |
| Your recovery phrase (or private key): No longer opens it | `has <old>: no` |
| The NEAR door: Shut | `predecessor auth: off` |
| A warning that the vault holds a key Phosphor did not add | a third key in the list |

The Vault tab reads all five rows from NEAR through one provider, and reads again once its last
read is a minute old; right after a move, a row says Checking... until a read begun after the move
answers. This check reads all five from two providers at one block. If the two disagree, trust
neither until you know why.
[What stays open](security-model.md#what-stays-open) says who can switch predecessor auth back on.

## What you cannot check yet

- **The compiled programs.** The payload digest covers the app's own files, not the shell, the
  bundled Node or the vault service, which do not yet build byte for byte the same twice. Their
  signatures say who built them, not from what source ("A release signs what its build job made"
  in [What stays open](security-model.md#what-stays-open)).
- **The real Secure Enclave and its dialog.** The unit tests run the vault service against a
  stand-in keychain. Attacks 12 and 30 reach a signed app's real service with `--app`, but no
  command shows you the real Touch ID dialog: read each sentence before you touch.
- **An outside audit.** There is none yet: an audit by a third party is planned and not done.
- **The RPC.** The app reads NEAR through FastNEAR alone. `vault-check.ts` asks two providers, and
  two that tell the same lie at the same block would pass it. Only a NEAR node of your own needs
  no trust.
- **The verifier.** Its owners can upgrade it, and its admins can switch predecessor auth back on
  for any account. `verifier-check.ts` says `spiked: no` on another build, `vault-check.ts` shows
  the door, and [What stays open](security-model.md#what-stays-open) has both.
