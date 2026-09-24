# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People who already pay for an AI agent (Claude Code, Codex, Grok and the like) and want to hold, swap and trade crypto without learning DeFi first. Many are new to crypto and nervous about losing money. The first user is the founder, who also records demos of the app for investors and fellowships. The job: tell the agent what you want in plain words, see what it is about to do, approve it when it matters, and know at every moment where your money is.

## Product Purpose

Make DeFi accessible to everybody through the AI agents they already pay for. Phosphor is a local desktop app that is pure code (no AI inside). The user's own agent connects over MCP and drives it: the app is the car, the agent is the person with the key. Success is a person who has never touched DeFi swapping, moving and trading real money by talking, and wanting to come back.

## Positioning

Everyone is racing to give agents wallets; Phosphor is the thing that stops them. Every write is simulated, checked against the user's limits, and above a set amount released only by a physical click in the window that the agent cannot reach. Because the model is rented from a subscription the user already bought, a new user costs nothing to serve.

## Operating Context

- A macOS desktop window (Tauri shell around a local web UI and a Node backend on 127.0.0.1:4177).
- Money lives in two places: the NEAR Intents balance (swaps, sends, deposits) and Hyperliquid (perpetuals collateral). Money comes in through the deposit card.
- The agent chat is where nearly everything happens. Small actions under the user's approval amount run without a click; larger ones wait for Approve on the card.
- Screens today: Basic, Pro, Trade, Vault (agent connection and keys).
- Real mainnet funds from day one.

## Capabilities and Constraints

- Swaps inside NEAR Intents (1Click), sends to chains or other NEAR Intents accounts, Hyperliquid deposit, withdraw and perpetuals, deposit addresses per coin and network, safety rules (approval amount, per-trade and daily caps, lock timer, freeze).
- The window is the trust boundary: approvals happen by a human click, never by the agent.
- Basic is the agent chat plus balances, nothing else. Pro wraps the same chat with charts, positions and orders. One design language for both (decided 2026-09-23).
- Money actions appear inline in the chat as one compact card that changes in place, never as an overlay that covers messages (decided 2026-09-23).
- License FSL-1.1-MIT. The app ships as a signed DMG with an auto-updater.

## Brand Commitments

- Name and look are one idea: green phosphor light on near-black. Keep the identity and the logo mark; rebuild layout, type, spacing and motion so it feels new, calm and demo-ready (decided 2026-09-23).
- Voice: short and warm, plain English, a little friendly guidance, no protocol jargon (no "floor", "solver", "handle", "click line"). Information is laid out so it reads at a glance, never as a blob of text (decided 2026-09-23).
- No display serifs. Faces come from the founder's shortlist; Geist and Geist Mono are the default for technical surfaces.
- Public line: "everyone is racing to give agents wallets. I built the thing that stops them."

## Evidence on Hand

- Real mainnet history: swaps, deposits and Hyperliquid positions on the founder's own wallet.
- Screenshots of the current app in docs/screenshots/ (dummy-data fixture wallet in window-basic.png).
- No customer testimonials, user counts or benchmarks exist; do not invent them.

## Product Principles

1. Calm first: every surface lowers anxiety. Where the money is and whether it moved is always one glance away.
2. The conversation is the product. Cards and tools serve it and never crowd or cover it.
3. The human click is sacred, and the card shows exactly what it approves.
4. Plain words everywhere a person reads, including errors.
5. Simple code on the rails that already exist; no reinvented infrastructure.
