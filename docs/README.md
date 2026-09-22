# Phosphor docs

These pages are the user documentation for Phosphor, the local Mac app that holds your keys,
your venue connections and your rules while an agent proposes moves and you click. They describe
version 0.9.1, the version in `package.json`. The site at
[phosphor.karimbabasf.com/docs](https://phosphor.karimbabasf.com/docs) is rendered from these
files, and the three developer documents below sit beside them.

## Pages
- [Getting started](getting-started.md): download, check the file, make or restore a wallet, back it up, the lock and the brake.
- [Connect an agent](connect-an-agent.md): pick the agent you already use, what it sees and what it can never do.
- [Money](money.md): the two pockets, deposit, swap, send, fund and withdraw from Hyperliquid, settling, fees and refusals.
- [Trading](trading.md): Trade mode, a proposed trade, the click, armed plans and their session key, what runs after a lock.
- [Policy](policy.md): the rules, the click threshold, policy as sentences, changing a rule, the three verdicts.
- [Security](security.md): what the agent can read, draft and never decide, the window token, the enclave, the lock, the honest limits.
- [Tools](tools.md): every MCP tool the app registers, grouped, one line each.
- [Troubleshooting](troubleshooting.md): a late or unconfirmed move, a venue that does not answer, Gatekeeper, an agent that will not connect, the unlock queue, a refused address.
- [Known limits](known-limits.md): what this build does not cover, what each limit means for your money, and what closes it.
- [Changelog](changelog.md): what changed in each version, newest first.

## For developers
- [Architecture](architecture.md): the two-process topology, module map, data flow and failure modes.
- [Security model](security-model.md): the trust boundary, the three verdicts, fail-closed rules, the approval token and the v1 limits.
- [Reference](reference.md): the tool surface, policy as sentences, the first run, config, keys and signing.

## Keeping these current
These pages describe the version in `package.json`, nothing older and nothing planned. Every
version bump updates the pages it touches and adds a changelog entry in the same commit.
`tests/unit/docs.test.ts` fails the suite when the top entry of the changelog is not the package
version, when a page listed here is missing, or when a link between these files is broken. The
website at [phosphor.karimbabasf.com/docs](https://phosphor.karimbabasf.com/docs) is rebuilt from
these files, so a stale page here is a stale page there.
