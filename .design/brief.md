# UI brief: agent-crypto-control

What was asked for, verbatim from the spec. This page is judged against this file.

One page. No routes, no navigation, no menus, no modals except the approval gate. Everything visible at once or within a single scroll.

Deliberately plain. The interface exists to show what the backend is doing, not to impress.

- Type: system monospace stack only (ui-monospace, SFMono-Regular, Menlo, monospace). No webfont, no display face, no font loading.
- Colour: Homebrew terminal. Near-black background, green phosphor foreground. One hue throughout. Hierarchy comes from brightness and opacity, never from a second colour.
- The one exception: pending approvals and refusals render in red. A safety gate that does not visually shout is a safety bug. This is the one place where the interface interrupts rather than informs.
- No rounded corners, no shadows, no gradients, no icons, no illustration. Box-drawing characters where separation is needed.
- No animation except a cursor blink and new log lines appending.
- Dense, aligned to a character grid. Terminal-dense, not app-airy.

Regions, top to bottom:
1. Status bar: total dollars held, agent connection state, policy state, kill switch.
2. Composition: table of issuer, chain, amount, share, freeze flag, sorted by share descending. Share column is where a policy violation becomes visible.
3. Cost: the fragmentation number with its four-line breakdown.
4. Chart: live canvas candlesticks, asset selectable, monotone green, ticks only, stale marker when the source is down.
5. Policy: current rules as plain sentences, not JSON.
6. Approval gate: empty most of the time. Pending proposals appear with simulation output and two buttons. Cannot be dismissed from the chat.
7. Log: append-only stream, newest first, every request, approval and refusal with its reason.

Success: a person who has never seen this understands within ten seconds what they hold, what it costs them, and whether anything is waiting for their click. The page looks like a terminal, not like a dashboard product.
