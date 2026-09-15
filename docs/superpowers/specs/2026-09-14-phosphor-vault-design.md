# Phosphor vault: keys behind the Secure Enclave, one touch per move

Date: 2026-09-14. Branch `feat/vault`, worktree `~/Developer/Apps/phosphor-vault`.
Status: design, built in the same session. Every claim marked MEASURED was run on this Mac
(Apple M5, macOS 26.6.2) before the design was written.

## 1. What this is

Phosphor holds a wallet and lets an agent drive it. Today the keys sit in
`~/.phosphor/keys.enc.json` as an AES-GCM envelope under a scrypt password typed into the
window, unlocked for fifteen minutes at a time, and every signer in the Node process reads them
while unlocked. That is a good software wallet. It is not a vault: a copy of the file plus a
weak password opens it anywhere, the password is the whole secret, and an unlocked process signs
for any caller inside it for a quarter of an hour.

The goal Karim set: a balance in the seven figures has to be safe in it, onboarding has to be
one click, and the sentence that describes it has to be true.

## 2. The decision: the app makes the wallet, the Mac's Secure Enclave holds the key to it

**Deposit-in, not bring-your-own-key.** The wallet is generated inside the app on first run and
its keys never exist anywhere else. Import stays as a *restore* path in Settings (recovery
phrase in, for a user moving Macs), not as the front door. Three reasons, in order:

1. Friction. Create is one click and one Touch ID. Import is a paste of the most sensitive
   string a person owns into a text field, on a screen, from a clipboard.
2. Security. A key that was born here was never in a clipboard, a screenshot, a browser
   extension or another app's memory. Every imported key has a history nobody can audit.
3. The pitch. "Your agent's wallet was created behind the Secure Enclave and has never left it"
   is true and checkable. "We keep your imported key safe" is a promise about the past.

**The Secure Enclave wraps the data key.** MEASURED on this Mac from an ad-hoc signed binary,
which is how the shipped bundle is signed (`signingIdentity: "-"`, no Apple team identity on
this machine):

- A P-256 key made with `SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl:)` under
  `[.privateKeyUsage, .userPresence]` works, and its `dataRepresentation` (427 bytes) persists
  it without the keychain. The private half never leaves the enclave, not even to the process
  that made it.
- ECDH against that key with `LAContext.interactionNotAllowed = true` fails with
  `LAError -1004 "User interaction is required"`. The gate is the hardware, not a flag.
- With interaction allowed, the same call asks for Touch ID (or the login password, or Apple
  Watch) in a system dialog and then answers. A wrong AAD fails as `crypto_failed`, never as a
  partial plaintext.
- The keychain route is closed: a permanent enclave key in the keychain needs
  `keychain-access-groups`, and an ad-hoc signature carrying that entitlement is killed at
  launch (exit 137). `SecKeyCopyExternalRepresentation` on a non-permanent enclave key answers
  "export not implemented". CryptoKit is the only path, so the enclave work is a Swift sidecar.

So: `keys.enc.json` version 2 keeps the same payload envelope (AES-256-GCM under a 32-byte data
key, header as AAD) and replaces the scrypt wrap of the data key with an enclave wrap:

```
wrap: {
  type: "secure-enclave",
  keyBlob: <SE private key, opaque, base64>,
  publicKey: <X9.63, base64>,
  ephemeralPublicKey: <X9.63, base64>,
  ciphertext: <nonce || ct || tag, base64>     // AES-256-GCM over the data key
}
```

Wrap key = HKDF-SHA256(ECDH x-coordinate, salt "phosphor-vault", info
"phosphor-vault-dek-wrap-v1" || ephemeralPub || enclavePub). AAD = canonical header, so a
wrapped key moved beside other addresses fails to open. The Node side wraps (public key only,
`src/keystore/sewrap.ts`); the Swift sidecar unwraps (`src-tauri/se-helper/main.swift`). MEASURED:
a data key wrapped by Node round-trips through the sidecar after Touch ID, and the wrong AAD is
refused.

**No password in enclave mode.** Touch ID, with the Mac login password as the system's own
fallback (clamshell Macs, Mac minis, a cut finger). The user has nothing new to remember and
nothing to type. There is no password-wrapped copy of the data key on disk in this mode, because
a second wrap is only as strong as its weaker half, and an offline brute force is exactly what
the enclave removes.

**Software mode stays for Macs without an enclave** (Intel without T2, or a source checkout
whose sidecar is missing): the existing scrypt password path, unchanged, and Settings says which
mode is live and why.

## 3. Who holds what, and when

Three processes, one rule each:

| Process | Holds | Never holds |
|---|---|---|
| Rust shell (`phosphor-desktop`) | the window, the per-boot handshake, the sidecar path | any key, any data key for longer than one relay |
| Swift sidecar (`se-helper`) | one request, for one call, then it exits | files, network, state |
| Node backend | the sealed payload; the data key and derived keys **only while the session is open** | the enclave key blob's private half (nobody does), the password (there is none) |
| Webview window | the window token | any key, any IPC into the shell (by design, see `src-tauri/src/main.rs`) |
| Agent (over MCP) | addresses, balances, proposals | keys, the deposit address in full (see 6) |

**Touch ID opens the vault; anything over the click threshold gets its own touch.** Two tiers,
because Phosphor's product is an agent that makes small moves on its own inside limits a person
wrote, and a design that asked for a finger on every $20 rebalance would sell that off:

1. *The session.* Touch ID replaces the password as the thing that opens the wallet. Open, the
   wallet signs the moves the policy allows without a click (under `humanClickAboveUsd`), exactly
   as today. It closes on idle (default 15 minutes, set in the Vault tab), on sleep, on window
   close, on the kill switch. Nothing about the policy engine changes.
2. *The touch.* A proposal the policy sends to a human is approved by a click AND a Touch ID whose
   system dialog names the move ("Approve: swap 500 USDC to ETH on NEAR Intents"), every time,
   open session or not. The click moves the proposal to `awaiting_touch`; the backend queues an
   unseal request; the shell's long-poll thread runs the sidecar with that reason; the answer
   both opens the wallet (if it was closed) and approves that one proposal. A cancelled dialog
   puts the proposal back to `pending` with the cancel in the audit log. Nothing else queued is
   released by that touch: each click-tier proposal has its own.

Armed rules keep working the way they do today through the scoped Hyperliquid API-wallet
session, which is a separate, limited key that cannot withdraw, and is provisioned under a touch.

The Touch ID reason is composed by the backend from the proposal's structured fields (rail,
asset, amount, venue), never from agent text, so the system dialog says what the click does.

**The shell asks, the page never can.** The control window is a remote loopback page with no
Tauri IPC bridge, and that stays. The shell reaches the enclave for the backend by long-polling
`POST /api/vault/pending` and answering on `POST /api/vault/answer`. Both routes take a relay
secret (line 5 of the backend's stdin handshake) that the page never receives, so a compromised
page cannot stand where the shell stands; both check the boot nonce in the response; and the
data key rides inside the answer encrypted under a fourth per-boot secret (the transport key),
so a loopback capture shows nothing. The page can only ever move a proposal into the state that
makes the backend ask.

## 4. Onboarding

First run, enclave available:

1. One screen: the mark, one sentence, one button, **Create wallet**.
2. Click. The backend asks the shell for an enclave key (no prompt: making a key needs no
   presence), makes a 12-word BIP-39 mnemonic and a data key, derives EVM, Solana and NEAR,
   wraps the data key to the enclave, writes `keys.enc.json` v2 atomically.
3. One Touch ID, "Confirm your new wallet": the round trip is proven before the screen says
   done. A wallet the enclave cannot open is never shown as created.
4. Home. Addresses are on screen. Total time: two seconds and one touch.

**Backup is prompted, not forced.** The first-run screen does not stop for a recovery phrase.
A quiet badge in the bar says "not backed up" until the phrase has been revealed once; the
deposit card carries one line, "back up before you send more than a test amount"; and the first
deposit that lands opens a card with one button, **Back up now**. Reveal is Touch ID gated and
shows the 12 words once, in the window, never in chat and never to the agent.

Existing installs (Karim's mainnet wallet is one): boot shows one card, **Move your keys behind
the Secure Enclave**, that takes the password once, re-wraps the data key to a fresh enclave key,
proves the round trip with a Touch ID, and only then replaces the file. No step can leave the
wallet in a state that opens with neither the old password nor the enclave. Software mode stays
available and the card can be dismissed; Settings keeps the button.

## 5. Settings: the Vault tab

A new screen in the window, reachable from the bar. Sections, top to bottom:

1. **Custody.** Secure Enclave: on, this Mac, key made <date>. Or: Software (scrypt), with the
   reason, and the upgrade button.
2. **Addresses.** EVM, Solana, NEAR id. Each row: chunked address, copy, QR. Copy and QR go
   through the deposit card (6). Rows show "verified" once the enclave has opened the wallet in
   this session, and "unverified" before that, which is the audit's rule for headers.
3. **Recovery.** Backed up: yes/no. **Reveal recovery phrase** (Touch ID). **Restore from a
   phrase** (typed confirmation, refused while the current wallet holds a balance, Touch ID).
4. **Agent.** What the agent can see (addresses, balances, proposals) and cannot (keys, the
   phrase). The Hyperliquid API wallet: status, made <date>, **Revoke**.
5. **Window.** Frost after N minutes idle (privacy only; frost never affects signing). Lift the
   frost with Touch ID.
6. **Danger.** **Forget this wallet on this Mac**: typed confirmation, refused unless backed up,
   Touch ID, then the file is shredded.

## 6. The deposit card

Trigger: the user asks the agent "what is my SOL deposit address" (or clicks an address in the
Vault tab). The agent calls the `deposit` MCP tool with `{asset}`. The tool:

- returns to the agent ONLY: a disclaimer to relay ("Send a small test amount first and wait for
  it to land before sending the rest"), the asset and chain, and the address **fingerprint**
  (first 6 and last 4 characters). Never the full address. The tool description says so, and the
  agent is told to point at the window.
- opens the deposit card in the window with the full address, a QR, chunked text with the
  first and last four characters in large type, a copy button, and the chain named in words.

Foolproof means three checks before anything renders: the address is the one derived from the
open wallet this session (Touch ID once if not yet verified; the card asks for it), the QR is
rendered and then **decoded back** in the window and compared byte for byte to that string
(mismatch: the card refuses and says so), and the copy button reads the clipboard back and shows
"copied, ends in ...9Xk2". Any asset the app cannot derive an address for gets no card and a
plain refusal, never a guess.

Landing feedback: while the card is open the backend watches that address on its chain
(Solana `getSignaturesForAddress` plus balance every 2 s, EVM balance and token balance every
3 s, the NEAR Intents balance every 3 s) and the card moves through **watching, seen
(unconfirmed, amount), landed (confirmed)** with the time it took. The first landed deposit
triggers the backup card.

## 7. Threat model, honestly

| Attack | Before | After |
|---|---|---|
| Wallet file copied to another machine | opens with the password | random bytes: the data key is wrapped under an enclave key bound to this Mac |
| Offline brute force of the password | possible, slowed by scrypt | there is no password |
| Local process reads the file | gets the envelope | same, and it is useless |
| Local process asks the enclave | n/a | it gets the system dialog in its own name, and the user sees a request that is not Phosphor's |
| Malware asks the backend to sign | during the 15-minute unlock, yes, any size | small moves inside the policy while the session is open; anything over the click threshold needs a Touch ID whose dialog names the proposal |
| Compromised page (XSS) | could approve | could still move a proposal to awaiting_touch; the dialog still names it |
| Prompt injection on the agent | proposes, cannot approve | unchanged; the deposit address it can quote is a fingerprint |
| Memory read of the backend | needs get-task-allow (absent) or root | same, and the exposure is one session, bounded by the policy's limits |
| Root, a malicious signed update, physical coercion | game over | game over, and the sentence says so |

The sentence for the README: *every dollar that leaves this wallet leaves with your fingerprint,
and the key that signs it was made behind the Secure Enclave of this Mac and has never left.*

## 8. Verification

- Unit: sewrap round trip against a software P-256 key; v2 envelope open/refuse and tamper
  detection; awaiting_touch to approved to executing, and cancel back to pending; the
  transport-key AEAD; the deposit tool never returns a full address; the reason composer reads
  structured fields only.
- Cross-implementation: Node wraps, the sidecar unwraps (one Touch ID), wrong AAD refused.
- Rust: `cargo test` for the sidecar caller and the long-poll parser.
- e2e: `npm run tauri dev`, create a wallet in a throwaway data dir, deposit card for SOL
  decodes to the derived address, approve a proposal and see the dialog.
- Penetration test: independent agents attack the built branch (local process, malicious
  page, malicious agent, crypto review) and every finding is fixed or listed.

## 9. Decisions after the review (2026-09-14, five independent passes)

Three agents attacked the design above (an attacker, two users, a skeptic buyer) and two mapped
the code and the field. What changed:

1. **Deposit-in, unanimously.** Both users and the skeptic land on it: the beginner never sees a
   text field for a string they do not have, and the whale trusts a wallet they can check (the
   phrase's derivation paths match Phantom, the card's address comes from a Touch ID open, a test
   deposit lands) more than one they pasted into a hot app. Import stays as Restore only.
2. **Backup is proven, not shown.** "Backed up" clears only after the person types three of the
   12 words back (the existing first-run Prove step stays). The reveal has Print and no Copy. The
   agent's `start` and `wallet` tools return `backedUp`, so it can say "you have money in and no
   backup" once there is a balance. The first deposit that lands opens the backup card.
3. **Restore has to work on a Mac that cannot open the file.** A version 2 file made on another
   Mac boots to "Made on another Mac: restore from your recovery phrase", never to Create. Restore
   is refused only while the current wallet is not proven backed up AND the phrase derives
   different addresses AND this Mac can open the file. Restore takes 12 or 24 words.
4. **Deposit is chain-first.** The `deposit` tool takes `{asset, chain}`; the refusal lists what
   is accepted; the card names the network in the exchange's words ("on Coinbase choose
   Solana"); the watcher runs until landed or 24 hours, not while the card is open.
5. **The Connect-your-assistant step stays** after Create. Home shows whether an agent is attached.
6. **The dialog says Phosphor.** The sidecar carries an embedded Info.plist naming it, and the
   reason always starts with "Phosphor:". When the app is signed with a Developer ID the enclave
   key moves into the data-protection keychain, app-bound by code signature, so no other process
   can even raise the dialog; ad-hoc signed, the key is device-bound only. The Vault tab shows
   which of the two is live.

What the review settled about the claim:

- The enclave makes and keeps the P-256 lock key. The wallet keys (secp256k1, ed25519) are made
  in the app from the phrase and are decrypted into the app's memory while the vault is open.
  The Secure Enclave cannot sign those curves, and no Mac software wallet signs behind it.
- `userPresence` means Touch ID, or Apple Watch, or the Mac login password. That password is now
  a key to the vault and the Vault tab says so.
- Armed Hyperliquid rules trade through a trading-only key that cannot withdraw but can lose.
- An untrusted process running as the user, a poisoned dependency inside the backend, root, a
  malicious signed update or coercion are not stopped by any of this.

**The honest sentence:** Phosphor is a local hot wallet an agent can drive but never hold. The
wallet file opens only on this Mac, through its Secure Enclave, after your Touch ID on a dialog
that names the move, and the agent never sees a key.

**The honest number:** safe for the working balance of a seven-figure stack, with the reserve in
a hardware wallet or a Safe and the policy capping what Phosphor holds and where it can send.
Not "a million dollars in one hot key". Before a bigger number: a Developer ID build with the
enclave key app-bound in the keychain, and a third-party audit.
