# UI brief: phosphor

What was asked for, verbatim from the spec. This page is judged against this file.

One page. No routes, no navigation, no menus, no modals except the approval gate. Everything
visible at once, on one screen, with no page scrolling at all (Karim, 2026-08-11: "move everything
around so it all fits on one page, no scrolling"). This supersedes the original "or within a single
scroll".

Deliberately plain. The interface exists to show what the backend is doing, not to impress.
Success: a person who has never seen this understands within ten seconds what they hold, what it
costs them, and whether anything is waiting for their click. The page looks like a terminal, not
like a dashboard product.

## Asked for
- One page, no routes, no navigation, no menus, no modals except the approval gate
- All seven regions on screen together: status bar full width, then two columns. Left is what is
  held (composition, cost, chart), right is what governs it (approval gate, policy, log). Revised
  2026-08-11 from "seven stacked regions in order", which could not fit one screen.
- The page never scrolls. A region whose content outgrows its box scrolls inside itself.
- System monospace stack only, no webfont
- Homebrew terminal: near-black ground, phosphor green, one hue, hierarchy by brightness/opacity only
- Red exclusively for pending approvals, refusals, and breached share cells
- No rounded corners, shadows, gradients, icons, illustration; box-drawing characters for separation
- No animation except cursor blink and appending log lines
- Canvas candlesticks, monotone green, tick-only axes, asset selectable, stale marker
- Policy as plain sentences, never JSON
- Terminal-dense character grid, not app-airy

## States that must work
resting, pending, refusal, kill switch on, policy unreadable, agent connected
