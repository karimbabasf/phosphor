// The exact set of tools the agent's door opens onto.
//
// One list, because there were two and they drifted. tests/injection.test.ts asserted the set
// against a live MCP client while scripts/e2e.ts kept its own copy, and e2e is not part of
// `npm test`, so its copy was stale for two separate features before anyone noticed: the ten
// chart tools landed without it, then chart_trendline and market_search did. A duplicated list
// has already cost this codebase an afternoon once, in policy/engine.ts against the rail
// registry, and the failure shape was identical.
//
// Both callers import this. Adding a tool means changing one line here, and the two checks
// that hold the surface honest cannot disagree about what they are holding it to.
//
// The comments matter as much as the names. This is the whole capability surface of the app,
// and why a tool is on it is the part a reviewer needs.

import { CHAT_WITHHELD } from '../src/persona.ts';

export const EXPECTED_TOOLS: readonly string[] = [
  // The handshake presentation: the banner an agent prints on connect and the index of every
  // capability it has. It is the first thing an agent reads and therefore the highest-leverage
  // place to put a lie, which is why it is asserted like everything else.
  'start',
  'composition',
  'wallet',
  // Where money comes in. It opens the deposit card in the window and hands the agent a
  // fingerprint of the address, never the address: the window is where an address is read.
  // Lead only, because a card in the human's window is the lead's business.
  'deposit',
  'log_tail',
  'policy_show',
  'proposal_status',
  /* The list behind proposal_status, which needs an id that nothing else produced: an agent
     asked about "my last deposit" had to fish one out of the audit log or ask the person for a
     uuid about their own money. Lead only, like the deposit card: a spawned worker measures
     something and reports, and enumerating what its parent is in the middle of paying for is
     not that. */
  'proposals',
  /* One move's whole story in one call: the view, this row's audit lines, what the router last
     said, what the venue holds now. Lead only for the same reason `proposals` is. The view, the
     venue reading and the verdict reasons can carry this app's OWN addresses, which is what
     tells a person where their money sits; the quote handle is fingerprinted, the log lines have
     theirs fingerprinted, and the quote's own signature and the deposit address 1Click minted
     stay on the row, so nothing here can be reused as a destination. */
  'diagnose',
  /* The swap reads (plan contract 1, the routes are src/http/read/swap.ts). Each files nothing
     and signs nothing: what can be swapped, what a swap would get now, and one swap's truth now
     (the swap service, the balance, any refund). They exist because the agent guessed an asset
     id it could not check, filed four proposals that were really probes, and repeated a card
     that said the swap service held money that never left (R3, 2026-09-23). */
  'swap_assets',
  'swap_quote',
  'swap_check',
  'propose_policy_change',
  // The rails. Each moves funds through a contract and none takes an address: the property
  // walk in tests/injection.test.ts is what holds that to be true.
  //
  // propose_hl_deposit, propose_lp_add and propose_lp_remove were removed from this surface
  // deliberately (2026-08-13): none had been run on a live chain, and an unproven fund-moving
  // rail is not something to find the edges of with real money.
  //
  // propose_hl_deposit reappeared on 2026-08-20, and the question above was asked. The answer
  // is not "it has been tested more". It is that the rail changed shape: it was a bespoke
  // transfer to Hyperliquid's Bridge2 contract and became a NEAR Intents route into HyperCore.
  // Since 2026-09-11 it spends the intents balance, and propose_hl_withdraw brings collateral
  // back into that same balance: the one propose tool that never auto-executes, refused under
  // any open position, with no destination field at all.
  //
  // propose_lp_add, propose_lp_remove and the four yield tools are gone for good rather than
  // held back: this app now runs two venues, NEAR Intents and Hyperliquid, and the rails behind
  // those six were removed from it. This list and the rail table finally name the same set.
  'propose_swap',
  // Funds the Hyperliquid perps account from the intents balance: one signed intent, no chain
  // argument, and the account credited is derived from our own key.
  'propose_hl_deposit',
  // Brings collateral back into the intents balance. One argument, the amount; the intents
  // account credited is our own, derived from the key, and every withdrawal is a click.
  'propose_hl_withdraw',
  // A balance leaving for somebody else (2026-09-17): the one tool with a destination field,
  // and the one with a confirmation field. `where` picks a real chain payout or a credit to
  // another intents account, with no default; `to` is decoded for that place; `confirmed` is
  // the literal true the schema holds the agent to after the read-back. No allowlist: the card
  // and the Touch ID sentence that name the receiver are the gate, and the send always waits
  // for that click, whatever the size.
  'propose_send',
  // A trade: one plan, whole, priced at the collateral it puts at stake. The venue holds the
  // entry, the stop and the target, so the click threshold is the only wall.
  'propose_trade',
  // A change to an armed plan: exits, cancel or close. A change that only takes risk off lands
  // without the wall; one that widens is priced like a new plan.
  'propose_trade_change',
  // The chart. These read and drive a view, never funds.
  'chart_read',
  'chart_scan',
  // A picture of one chart, rendered by the window. A read, and the lead's: it asks the window
  // the human is looking at to render, so a worker does not hold it.
  'chart_snapshot',
  // The measurement instrument. Many operations in one call, so its arguments are enumerated
  // rather than left as a free-form bag: the property walk cannot see inside an open record.
  'chart_batch',
  'market_search',
  'research',
  // Chain lookups (2026-09-16): four reads whose answers come from off the machine, held to the
  // same shape as research. The network is a closed enum, the address or hash has to pass its
  // shape before a URL exists, the hosts are fixed in src/chainscan/networks.ts, and every string
  // that comes back is data. Two of them carry `address`, and the property walk in
  // tests/injection.test.ts allows it on exactly those two as a lookup key: a read cannot pay
  // anyone, and the field never reaches a rail.
  'chain_address',
  'chain_transactions',
  'chain_transaction',
  'intents_activity',
  // The chart's one write. View, indicators, presets, levels, marks, lines and zones in one
  // call, with `clear` scoped to the caller's own work: ten tools used to do this one call
  // each, and every one of those was a model turn. Withheld from a worker, as is the layout:
  // a worker measures and reports, it does not redraw the chart the human is looking at.
  'chart_draw',
  // Up to four charts side by side. The first is the primary the human interacts with.
  'chart_layout',
  // Moves the window between the three surfaces. Named `switch` rather than set_view_mode
  // because the requirement is that switching costs one word.
  'switch',
  // Recolours the window. Same category as `switch`: it changes what a human
  // sees, reaches no rail and no money, and it cannot touch the approval gate's red, which
  // is not one of its slots. See src/view/theme.ts.
  'set_theme',
  // The trading surface. Reads answer "what is my situation"; writes change what is drawn and
  // what is pointed at. What is NOT here is the point: there is no close, no cancel, no flatten
  // and no disarm. Those live on /api/trade/action, which this door does not open onto, so the
  // capability is absent rather than guarded.
  'trade_read',
  'trade_batch',
  'trade_focus',
  'trade_highlight',
  'trade_overlay',
  'trade_clear',
  // A plan drawn as an idea. It has no authority and moves nothing; "go" arms it by id.
  'trade_plan',
  /* Draws something that already exists as a card: a proposal, a transaction, a position, the
     deposit card. "Show me the transaction" used to come back as prose with a hash pasted in the
     middle of it. It reads what a read tool would and writes nothing but the window, which is
     why it is a view tool and not a read: what it changes is what the human is looking at. */
  'show',
  // The team. Phosphor allowed one agent at a time until 2026-08-21 and now seats several, so
  // these five exist to keep a roster from being a crowd: who is here, a board they write one
  // line each to, and workers one of them can put on a piece of work.
  //
  // None of them moves money and none of them can. What they return is written by OTHER AGENTS,
  // which makes it data in exactly the way a token name or a headline is data: it cannot
  // instruct, approve or widen anything, and the tool descriptions say so.
  'agent_roster',
  'agent_board',
  'agent_post',
  'agent_jobs',
  // The one that spawns another model. It is on an operator's surface and NOT on a worker's:
  // src/mcp.ts does not register it when PHOSPHOR_ROLE is analyst, so a chain of models cannot
  // spawn a chain of models. A worker's surface is this list minus agent_spawn, minus every
  // propose_*, and minus the two window controls (switch, set_theme).
  'agent_spawn',
  // The only tool answered inside the shim instead of proxied to the app. It reads an enabled
  // skill file off this machine and returns its text, which is why it needs no app state and
  // why it still works while the roster is full. It moves nothing and, like every other read
  // here, cannot reach a rail.
  'skill',
  // Answered inside the shim like skill: the changelog this copy ships with, read from disk, so
  // "what's new" comes from the notes and not from memory. No state, no rail, takes a version.
  'whats_new',
  // The knowledge profile's one write: a concept the agent just taught, appended to the file the
  // next role text is built from. It takes a noun phrase in a closed alphabet, ten per session,
  // and nothing it writes can reach the role as an instruction (tests/unit/profile.test.ts).
  'profile_learned',
];

/* What a spawned worker holds, which is this surface minus everything that acts.
   Derived rather than typed out, so the two lists cannot drift: adding a tool above adds it to
   a worker too unless it is named here, which is the safe direction to be wrong in only because
   tests/injection.test.ts walks the whole surface for an address either way. */
export const WORKER_WITHHELD: readonly string[] = [
  'agent_spawn',
  'switch',
  'set_theme',
  // A worker measures. It does not put an idea on the chart the human might take for a plan,
  // and it does not draw on, arrange or photograph the chart the human is reading.
  'trade_plan',
  'chart_draw',
  'chart_layout',
  'chart_snapshot',
  'deposit',
  // The lead's own money timeline, and one row's whole story. A worker has no business in either.
  'proposals',
  'diagnose',
  'swap_check',
  /* Every window control, and the rule is now the helper rather than this list: src/mcp.ts
     registerView withholds a view tool from a worker unless it goes through registerTeamView,
     which is agent_post alone. `show` and the four trading overlays are here because they were
     registered through the ungated helper and a worker held them: a worker that can draw a
     proposal card into the conversation a human is mid-approval in is moving the surface the
     approval rests on, which is the same argument that withheld chart_draw and the snapshot. */
  'show',
  'trade_focus',
  'trade_highlight',
  'trade_overlay',
  'trade_clear',
  // A worker has no human in its session to have taught anything to.
  'profile_learned',
  ...EXPECTED_TOOLS.filter((t) => t.startsWith('propose_')),
];

export const EXPECTED_WORKER_TOOLS_SORTED: readonly string[] = EXPECTED_TOOLS.filter(
  (t) => !WORKER_WITHHELD.includes(t),
).sort();

export const EXPECTED_TOOLS_SORTED: readonly string[] = [...EXPECTED_TOOLS].sort();

/* What the window's own agent holds: every tool but the ones src/persona.ts CHAT_WITHHELD names.
   The window spawns it with PHOSPHOR_SURFACE=chat, and src/mcp.ts does not register those. */
export const EXPECTED_CHAT_TOOLS_SORTED: readonly string[] = EXPECTED_TOOLS.filter((t) => !CHAT_WITHHELD.includes(t)).sort();
