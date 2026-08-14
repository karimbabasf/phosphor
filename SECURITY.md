# Security

phosphor moves real money on mainnet and has had no third-party audit. Reports are welcome.

## Reporting a vulnerability

Do not open a public issue for anything that could move, expose or lose funds.

Use GitHub private vulnerability reporting: the **Security** tab, then **Report a vulnerability**.
It is private to the maintainer until an advisory is published.

If that is not available to you, open a public issue that asks for a private channel and says
nothing technical. No details, no reproduction, no addresses.

Useful reports carry: the version or commit, the config that was live (network, gate state, policy),
the exact steps, what you expected the policy engine to do, and what it did.

## In scope

- Anything that gets a write executed without the human click the policy required.
- Anything that lets the connected agent reach approval, execution or policy directly.
- Key material leaving the machine, landing in a log, or entering the git tree.
- Forged, dropped or reordered entries in the append-only audit log, or a log that records
  `decidedBy: 'human'` when no person clicked.
- A policy rule (budget, allowlist, threshold, composition limit, kill switch) that can be bypassed
  or silently skipped.
- A proposal whose displayed facts differ from what actually gets signed, on any of the three
  windows.
- Prompt injection that reaches a real capability rather than only the agent's text.

## Out of scope

- Bugs in third-party protocols, chains, bridges, venues or RPC providers. Report those to them.
- Losses caused by your own configuration, your own approval, or a rule that did what it said.
- Anything that needs an attacker who already has your machine, your shell or your key file.
- The testnet template shipping with `approvalGate: false`. That flag is not read on mainnet, which
  is documented in [docs/security-model.md](docs/security-model.md).
- Limits the security model already states as known and unclaimed. Read it first.

## What to expect

Best effort, from one person, with no promised timeline. There is no bug bounty and no payment.

Only the latest commit on `main` is supported. There are no backports and no patched releases of
older versions.

Please allow 90 days for a fix before publishing, or less if the issue is already being exploited.
Credit in the advisory if you want it.

## Known limits

The honest list of what the trust boundary does and does not cover is
[docs/security-model.md](docs/security-model.md). The risk of running this at all is
[DISCLAIMER.md](DISCLAIMER.md).
