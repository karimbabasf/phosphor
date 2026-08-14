# Disclaimer

Read this before you point phosphor at real money.

This document supplements the [MIT license](LICENSE). Where the two disagree, the license governs.

## No warranty and no liability

The software is provided "as is", with no warranty of any kind. The author is not liable for any
loss, claim or damage arising from the software or from its use, including lost funds. This is the
plain-English version of the two capitalised paragraphs in [LICENSE](LICENSE), and those paragraphs
are the ones that count.

## Your keys, your money, and no undo

phosphor is non-custodial. Keys stay on your machine. The author never holds, controls, transmits
or can access your funds or your keys, and cannot recover, reverse, cancel or refund anything.

Blockchain transactions are final. A wrong address, a wrong amount, a bad token approval or a
signed message you did not read is permanent.

## The safety systems are engineering, not a guarantee

The policy engine, the approval gate and the audit log are the point of this project. They are also
software, written fast, by one person. They can carry bugs. They can be misconfigured. A rail can
behave in a way the rules did not anticipate.

[docs/security-model.md](docs/security-model.md) states what is claimed and, more usefully, what is
not. Read the limits, and treat them as the specification rather than as small print. Nothing here
has had a third-party security audit.

Do not make this the only control standing between an agent and money you cannot afford to lose.

## Alpha software

Version 0.x. Interfaces, tool names, config format and behaviour change without notice or
migration. Some rails are implemented but have never run against a live chain, including Uniswap v3
liquidity and the Hyperliquid bridge deposit. The trading surface has only ever run on testnet.

## Not financial advice

Nothing in this repository, in the app, in its documentation, or in anything an AI agent says while
driving it is financial, investment, trading, legal or tax advice. Nothing here is a solicitation,
an offer or a recommendation to buy, sell or hold any asset.

Prices move. Perpetual futures are leveraged and can liquidate a position in full. Automated rules
execute exactly as written, including when the market makes the rule wrong, and including while you
are asleep. Every position is yours, and so is every outcome.

## Not a regulated service

phosphor is software you run yourself. It is not a wallet service, exchange, broker, dealer, money
transmitter, money services business, custodian, payment processor, investment adviser or financial
institution.

There is no server, no hosted component, no account, no telemetry, no fee and no commission.
Running it creates no customer relationship, no fiduciary duty and no agency relationship with the
author.

## Compliance is yours

You are responsible for deciding whether you may lawfully run this software, and reach the
protocols behind it, where you live. That includes securities and derivatives law, sanctions and
export control (including US OFAC programmes), anti-money-laundering rules, and tax reporting.

Do not use it if you are a sanctioned person, are in a sanctioned or embargoed jurisdiction, or are
somewhere the activity is prohibited.

## Third parties are not the author's

phosphor routes through infrastructure the author does not run: NEAR Intents, Uniswap, Hyperliquid,
the underlying chains and bridges, RPC providers and price feeds. The author does not operate,
monitor or continuously vet any of them, and is not responsible for their code, outages, fees,
slippage, censorship, insolvency or exploits.

The same holds for the AI agent you connect. A model can misread you, invent a proposal, or be
manipulated by content it reads on the way. That risk is the reason the approval gate exists, and
the click is still yours.

## No support obligation

There is no service level, and no obligation to maintain, fix, answer, or keep any of this working.
The project may change direction or stop at any time.

## Using it means accepting this

If any of the above is unacceptable to you, do not use the software. By using it you accept these
terms and you accept the whole risk of loss.
