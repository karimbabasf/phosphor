<p align="center">
  <img src="brand/phosphor-logo-green-on-black.png" alt="" width="92">
</p>

<h1 align="center">Phosphor</h1>

<p align="center">
  A Mac app that holds real money and lets an AI agent move it.<br>
  Every move above your limit waits for your click. Sends and withdrawals always do.
</p>

<p align="center">
  <a href="https://phosphor.money/download/mac"><b>Download for Mac</b></a>
  &nbsp;·&nbsp;
  <a href="https://phosphor.money/docs">Docs</a>
  &nbsp;·&nbsp;
  <a href="DISCLAIMER.md">Read before you fund it</a>
</p>

<p align="center">
  <a href="https://github.com/karimbabasf/phosphor/actions/workflows/ci.yml"><img src="https://github.com/karimbabasf/phosphor/actions/workflows/ci.yml/badge.svg" alt="Tests"></a>
  <a href="https://github.com/karimbabasf/phosphor/releases/latest"><img src="https://img.shields.io/github/v/release/karimbabasf/phosphor?label=release&color=1f7a3a" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-FSL--1.1--MIT-1f7a3a" alt="License FSL-1.1-MIT"></a>
</p>

## What it is

The app is the car. The agent is the driver. You hold the key.

Phosphor runs on your Mac and nowhere else. There is no server, no account and no telemetry. Every
request it sends to NEAR Intents' 1Click service carries the label `phosphor`, which 1Click's
public explorer shows. Your keys sit in a sealed file on your own disk: sealed to the Mac's Secure
Enclave on a Touch ID wallet, with your password on a password wallet. On a signed release a Touch
ID wallet is Phosphor-only, or becomes so with one Touch ID once it is backed up: no other app on
the Mac can ask to open it. The Vault tab can then move your vault to this Mac's Touch ID key and a
24-word paper key you write by hand: after that only those two keys open it, every move out of it
asks for a Touch ID that names it, and the agent spends from a small allowance ($100 by default).
Any MCP agent drives the app (Claude Code, Codex, anything that speaks MCP), or the app runs its
own assistant.
The agent reads your money, prices a move and proposes it. The agent can never approve. A send, a
withdrawal, a rule change and any move above your click threshold wait for your click in the
window. Smaller swaps, Hyperliquid deposits and trades run on their own, inside a daily limit,
under rules the policy engine checks with no model in the path.

Two venues, and only two. A swap reaches any coin NEAR Intents lists, on any chain it lists. A
payout reaches every chain the deposit card lists except Zcash and Aleo, which are refused by
name, and only an address the app can decode and check by itself. Perps run on Hyperliquid.

This is alpha software that moves real money. It has had no third-party audit. It is not a wallet
service, an exchange, a broker or an adviser, and nothing it or your agent says is financial
advice. Read [DISCLAIMER.md](DISCLAIMER.md) first.

## Install

[Download the disk image](https://phosphor.money/download/mac). Apple silicon, macOS
13.5 or later. Drag Phosphor into Applications.

The app holds keys, so check the file first. The release page lists the SHA-256 of the disk image,
and this must print the same one:

```sh
shasum -a 256 ~/Downloads/Phosphor-macOS-arm64.dmg
```

To check it was built by this repository's release workflow from the tag of its version, at the
commit it prints (0.10.2 and later; use the tag of the version you downloaded):

```sh
gh attestation verify ~/Downloads/Phosphor-macOS-arm64.dmg --repo karimbabasf/phosphor \
  --signer-workflow karimbabasf/phosphor/.github/workflows/release.yml \
  --source-ref refs/tags/v0.10.20
```

The app and the disk image are signed with an Apple Developer ID and notarised by Apple, so
macOS opens Phosphor on first launch with no warning.

Two more checks run on their own. Before the app starts its backend, it hashes its own files, and
if any changed since the release was built it starts nothing and asks you to install a fresh copy.
An update installs only when Apple's Security framework finds Phosphor's Developer ID, identifier
and team on it; one that fails is refused and the app stays as it was. To check the files in your
copy against this repository's source yourself, follow
[Check a release yourself](docs/security.md#check-a-release-yourself).

## Invite codes

Someone may send you an invite code, `PHOS-` and 27 letters and digits, usually as a link to
phosphor.money/invite. It holds USDC for a new wallet. Paste it on the first run's Have an invite
code? step, or later under the same question in Add money, and the money moves into your wallet
once the wallet exists. If your Mac's clock runs more than two minutes behind, nothing moves and
the app says so: set date and time to automatic, then add the code again. Never paste a code into the
chat: the app holds back a code it recognizes there, but one changed by hand can slip through to
your agent. How a claim works: [docs/money.md](docs/money.md#invite-codes). To hand codes out
yourself, see [Issuing invite codes](docs/money.md#issuing-invite-codes): any USDC you send the
treasury inside NEAR Intents works, because `npm run invite -- convert` turns it into NEAR USDC.

## Connect an agent

The first run asks which agent you use and registers Phosphor with it. To do it by hand later,
**Phosphor > Copy MCP Config** in the menu bar puts the one line on your clipboard with your real
paths filled in. Run it in the directory you want the agent to work from. An agent you start
yourself like this asks once in the window, "Allow this agent?", and until you allow it every move
it proposes waits for your click. Any agent that reads a web page or a stranger's words through
Phosphor (a token name, a memo, a venue's error text Phosphor does not know) waits for your click
on every move after that, until its session ends.

Then ask it things.

> What do I hold?
>
> Swap 20 USDC into WETH.
>
> Short SOL at 10x if it loses that trend line, and cap me at $200.

Details, and what the agent can never do, are in
[docs/connect-an-agent.md](docs/connect-an-agent.md).

## Run from source

Needs Node 24 or later and a Rust toolchain.

```sh
npm install
npm run tauri dev
```

That opens the window. `npm run app` runs the backend alone on http://127.0.0.1:4177, and
`npm run app:build` writes the app and the disk image under `src-tauri/target/release/bundle/`.
To point Claude Code at the checkout instead of the installed app:

```sh
claude mcp add phosphor -- node "$PWD/src/mcp.ts"
```

## Test

```sh
npm test         # unit, injection and lockdown suites
npm run typecheck
npm run eval     # scores the agent against the behaviour rubric
npm run sweep    # the secret sweep CI runs over the tree and the history a push publishes
npm run attack   # plays a hostile program on this Mac against the app npm run app:build made
```

To check the wallet's security claims yourself, test by test, see [docs/verify.md](docs/verify.md).

## Docs

Read them at [phosphor.money/docs](https://phosphor.money/docs), or in
[docs/](docs/README.md).

- [Getting started](docs/getting-started.md): download, wallet, backup, the move to Touch ID, the
  lock and the brake.
- [Security model](docs/security-model.md): the threat model, the trust boundary, the fail-closed
  rules, the limits.
- [Known limits](docs/known-limits.md): what this build does not cover.
- [Architecture](docs/architecture.md) and [Reference](docs/reference.md): for people changing it.
- [SECURITY.md](SECURITY.md): reporting a vulnerability privately.
- [CONTRIBUTING.md](CONTRIBUTING.md): the bar for a change.

## License

Functional Source License 1.1 with an MIT future license
([FSL-1.1-MIT](LICENSE)). Read it, run it, change it, audit it. You may not offer Phosphor, or a
product that does what Phosphor does, to other people as a commercial product or service. Each
version turns MIT two years after its release. The fonts and token logos carry their own notices
in `ui/fonts/OFL.txt` and `ui/logos/ATTRIBUTION.md`.
