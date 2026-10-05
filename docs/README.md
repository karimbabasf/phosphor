# Phosphor docs

These pages are the user documentation for Phosphor, the local Mac app that holds your keys,
your venue connections and your rules while an agent proposes moves and you click. They describe
version 0.10.16, the version in `package.json`. The site at
[phosphor.money/docs](https://phosphor.money/docs) is rendered from these
files, and the four developer documents below sit beside them.

## Pages
- [Getting started](getting-started.md): download, check the file, make or restore a wallet, back it up, move your vault to Touch ID, the lock and the brake.
- [Connect an agent](connect-an-agent.md): pick the agent you already use, start it in the chat or your terminal, what it sees and what it can never do.
- [Money](money.md): the two pockets, the vault and the allowance once it moves to Touch ID, top-ups and the sweep, deposit, swap, send, fund and withdraw from Hyperliquid, settling, fees and refusals.
- [Trading](trading.md): Trade mode, a proposed trade, the click, armed plans and their session key, what runs after a lock.
- [Policy](policy.md): the rules, the click threshold, the click after a web page, policy as sentences, changing a rule, the three verdicts.
- [Security](security.md): what the agent can read, draft and never decide, why a web page is not an instruction, the window token, the Secure Enclave, the lock, the honest limits.
- [Tools](tools.md): every MCP tool the app registers, grouped, one line each.
- [Troubleshooting](troubleshooting.md): a late or unconfirmed move, a venue that does not answer, Gatekeeper, an agent that will not connect, the unlock queue, a refused address, moving the vault to Touch ID.
- [Known limits](known-limits.md): what this build does not cover, what each limit means for your money, and what closes it.
- [Changelog](changelog.md): what changed in each version, newest first.

## For developers
- [Architecture](architecture.md): the two-process topology, module map, data flow and failure modes.
- [Security model](security-model.md): the threat model with the test behind each defence, the trust boundary, the three verdicts, fail-closed rules, the approval token and the v1 limits.
- [Reference](reference.md): the tool surface, policy as sentences, the first run, config, keys and signing.
- [Check it yourself](verify.md): the wallet's seven security claims, each with the code that enforces it, the test that proves it and the command that runs it; checking your download and your vault on NEAR.

## Keeping these current
These pages describe the version in `package.json`, nothing older and nothing planned. Every
version bump updates the pages it touches and adds a changelog entry in the same commit.
`tests/unit/docs.test.ts` fails the suite when the top entry of the changelog is not the package
version, when a page listed here is missing, or when a link between these files is broken. The
website at [phosphor.money/docs](https://phosphor.money/docs) is rebuilt from
these files, so a stale page here is a stale page there.
