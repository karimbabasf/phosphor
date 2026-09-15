# Vault UI contract

The backend side of the vault is built (branch `feat/vault`). This is what the window has to
draw and exactly what it reads and posts. Every POST carries `token` like every custody route
(ui/core/net.js adds it). Every refusal is HTTP 200 `{ ok: false, error: <sentence>, code }`.

## What the window reads

`GET /api/state` now carries two new fields beside `lock`:

```
vault: {
  custody: 'secure-enclave' | 'software' | null,   // null: no wallet; 'software' is the scrypt password file
  state: 'unlocked' | 'locked' | 'no_wallet' | 'needs_migration',
  enclave: {
    attached: boolean,        // the desktop shell is relaying to the enclave
    ready: boolean,           // attached AND this Mac has an enclave the person can authenticate to
    capability: { secureEnclave, biometry: 'touchid'|'none'|..., canAuthenticate } | null,
    keyMadeAt: string | null,
    binding: 'device' | 'app' | null   // 'device': ad-hoc build, blob on disk; 'app': keychain, Developer ID build
  },
  foreign: boolean,           // the file was made on another Mac: offer Restore, never Create
  waiting: { id, op: 'probe'|'create'|'unwrap'|'presence', reason, since } | null,  // a system dialog is up
  backedUp: boolean, backedUpAt: string | null,
  idleMinutes: 5 | 15 | 60,
  hasMnemonic: boolean
}
deposit: null | { phase: 'watching'|'seen'|'landed'|'stopped', chain, symbol, address, startedAt, baseline, amount, txHash, ms }
```

`GET /api/vault` returns the `vault` object alone. `GET /api/deposit` returns `{ deposit }`.
`GET /api/intents-receive` (exists) returns `{ account, verified, tampered, networks: [{ id, name, address, memo, unavailable, accepts: [{symbol, minDeposit, decimals}], warning }], note }`.

SSE frames (ui/screens/shell.js already routes `state` and `lock`):
- `{ type: 'lock', state }` as before.
- `{ type: 'deposit', phase, chain, symbol, address, amount, txHash, ms, ... }` on every watcher change. `phase: 'watching'` with a fresh `startedAt` means "open the deposit card" (the agent's `deposit` tool or the Vault tab asked for it).

Proposal statuses now include `awaiting_touch`: the person clicked approve and the Touch ID dialog that names the move is up. It goes to `approved` when the enclave answers, or back to `pending` on cancel or timeout (150 s).

## What the window posts (all `{ token, ... }`)

| Route | Body | Answer | When |
|---|---|---|---|
| `POST /api/vault/create` | `{}` | `{ ok, addresses, custody }` or a refusal (`enclave_unavailable`, `user_cancel`) | First run, enclave ready. One click, one Touch ID. No phrase comes back. |
| `POST /api/wallet/create` | `{ password }` | as before | First run, enclave NOT ready (software mode). Unchanged. |
| `POST /api/vault/unlock` | `{ purpose?: 'address' }` | `{ ok, released }` or refusal (`user_cancel`, `foreign`) | Lock screen "Unlock with Touch ID"; the deposit card when `verified` is false ("Touch ID to show the address"). Waits for the dialog: up to 150 s. |
| `POST /api/unlock` | `{ password }` | as before | Software mode only. |
| `POST /api/vault/reveal` | `{}` | `{ ok, words: [12], paths: {evm, solana, near} }` | Vault tab > Reveal recovery phrase. Fresh Touch ID every time. Show once; Print button; NO copy button. |
| `POST /api/vault/backup-proven` | `{ words: [{index, word}, x3] }` | `{ ok, backedUpAt }` or `{ ok:false, code:'wrong_words' }` | The Prove step: three random positions typed back. Only this clears "not backed up". |
| `POST /api/vault/restore` | `{ mnemonic }` | `{ ok, addresses }` or refusal (`bad_phrase`, `not_backed_up`, `user_cancel`) | Vault tab > Restore, and the "made on another Mac" boot state. 12 or 24 words. |
| `POST /api/vault/migrate` | `{ password }` | `{ ok }` or refusal (`wrong_password`, `enclave_unavailable`, `user_cancel`) | The "Move your keys behind the Secure Enclave" card, shown once at boot when `custody === 'software'` and `enclave.ready`; dismissable; also a button in the Vault tab. |
| `POST /api/vault/forget` | `{ confirm: 'FORGET' }` | `{ ok }` or refusal (`not_backed_up`) | Vault tab > Danger. Typed confirmation, refused unless backed up, then Touch ID. |
| `POST /api/vault/prefs` | `{ idleMinutes: 5\|15\|60 }` | `{ ok, ...prefs }` | Vault tab > Window. |
| `POST /api/deposit/show` | `{ chain, symbol, address? }` | `{ ok, deposit }` | Vault tab address rows, Money-in. Starts the watcher and broadcasts. |
| `POST /api/deposit/stop` | `{}` | `{ ok }` | Closing the card does NOT stop it (the watch outlives the card); only an explicit Stop does. |
| `POST /api/approve` | `{ id }` | as before; the row comes back `awaiting_touch` on an enclave wallet | Decision card. |

## The screens

1. **First run (ui/screens/firstrun.js, exists).** When `vault.enclave.ready`: the words step and the
   password step are gone. One screen: mark, one sentence, one button "Create wallet". Click,
   the Touch ID dialog says "Phosphor: Confirm your new Phosphor wallet", then the addresses
   step, then the existing "Connect your assistant" step, then Home. Keep the existing software
   flow (password, 12 words, prove) for when the enclave is not ready. If `vault.foreign`, the
   first screen is "Made on another Mac" with one field (the phrase) and one button, Restore.
2. **Lock screen (ui/screens/lock.js, exists).** On `custody === 'secure-enclave'`: no password
   field. One button "Unlock with Touch ID" (`POST /api/vault/unlock`); while waiting, the
   button reads "Waiting for Touch ID" and is disabled; on `user_cancel` it comes back. On a
   password wallet: unchanged.
3. **Decision card (ui/screens/decision.js, exists).** New state `awaiting_touch`: the yes
   button becomes "Touch ID: confirm on your Mac", disabled, with the dialog's sentence under
   it (`vault.waiting.reason`). Back to normal when the status changes.
4. **Vault tab (new screen, ui/screens/vault.js, reachable from the bar next to the existing
   views).** Sections, top to bottom: Custody (Secure Enclave on this Mac, key made <date>,
   "opens with Touch ID, or your Mac login password" and, if `binding === 'device'`, one line
   "Any process on this Mac can ask; a Developer ID build binds the key to Phosphor"; or
   Software with the reason and "Move behind the Secure Enclave" when `enclave.ready`);
   Addresses (EVM, Solana, NEAR; each row: chunked address, verified or unverified badge, Copy,
   Show QR which opens the deposit card for that chain); Recovery (Backed up: yes/no with date;
   Reveal recovery phrase; Restore from a phrase); Agent (what it can see, what it cannot;
   "Moves under $<humanClickAboveUsd> run without a click while the vault is open", link to
   policy); Window (frost after 5/15/60 minutes); Danger (Forget this wallet on this Mac).
5. **Deposit card (new, a modal over any screen, ui/screens/deposit.js).** Opens on the SSE
   deposit frame or from the Vault tab. Content: the network in exchange words (eth "Ethereum
   (ERC-20)", base "Base", arb "Arbitrum One", sol "Solana (SPL)", near "NEAR Protocol"), the
   asset, the minimum, the address from `/api/intents-receive` for that chain (never from the
   frame alone: fetch, compare with the frame's `address`, refuse to draw on mismatch), chunked
   in groups of four with the first and last four characters in large type, a QR (ui/vendor/
   qrcode.js), and a Copy button. Three checks before anything draws: `verified` must be true
   (else the card shows one button, "Touch ID to show the address", which posts
   `/api/vault/unlock {purpose:'address'}`); the QR is rendered and then DECODED back (vendor a
   small decoder, ui/vendor/jsqr.js, MIT) and compared byte for byte, mismatch draws nothing and
   says so; Copy writes, reads the clipboard back, and shows "copied, ends in ...9Xk2". The
   warning line from the report is shown verbatim. Under it the watcher: "Watching for your
   deposit" with elapsed time, then "Seen on <network>: <amount> <asset>, confirming", then
   "Landed: <amount> <asset> in <n> s". The first `landed` while `backedUp` is false opens a
   card "You have money in. Back up now." with one button that goes to Reveal.
6. **The migration card** on boot for password wallets when the enclave is ready, and the
   "not backed up" badge in the bar when a wallet exists and `backedUp` is false.

## Design

Match the window: Geist and Geist Mono, the existing tokens in ui/design/*.css, the existing
card and button classes, the colourways. Copy is plain English, short, no exclamation marks.
The Touch ID dialog is the system's; nothing in the window imitates it.
