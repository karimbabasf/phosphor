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

export const EXPECTED_TOOLS: readonly string[] = [
  // The handshake presentation: the banner an agent prints on connect and the index of every
  // capability it has. It is the first thing an agent reads and therefore the highest-leverage
  // place to put a lie, which is why it is asserted like everything else.
  'start',
  'balances',
  'candles',
  'composition',
  'wallet',
  'log_tail',
  'policy_show',
  'proposal_status',
  'propose_consolidate',
  'propose_policy_change',
  // The rails. Each moves funds through a contract and none takes an address: the property
  // walk in tests/injection.test.ts is what holds that to be true.
  //
  // propose_hl_deposit, propose_lp_add and propose_lp_remove were removed from this surface
  // deliberately (2026-08-13): none had been run on a live chain, and an unproven fund-moving
  // rail is not something to find the edges of with real money. The rails still exist under
  // src/rails/ and a human can still drive them. If one reappears here, ask whether it has
  // been proven since.
  //
  // propose_hl_deposit reappeared on 2026-08-20, and the question above was asked. The answer
  // is not "it has been tested more". It is that the rail changed shape: it was a bespoke
  // transfer to Hyperliquid's Bridge2 contract and is now a NEAR Intents route into HyperCore,
  // and 1Click cannot quote OUT of hypercore. The direction is a property of the venue rather
  // than a check of ours, so an agent holding this can add collateral and has no path on this
  // surface to remove any. lp_add and lp_remove are unchanged and stay off.
  'propose_swap',
  // Funds the Hyperliquid perps account, from any chain this app signs for. One way in by
  // construction; getting money off the venue is a signed withdraw3 a human runs at a terminal
  // and is deliberately not a tool. Its chain argument is EVM only for the same reason
  // propose_intents_withdraw's is.
  'propose_hl_deposit',
  // Funds this app's own balance inside intents.near. Its far side is an account id rather
  // than a chain address, and the credited account is derived from our own key, so there is no
  // argument here that can name it.
  'propose_intents_deposit',
  // The way back out, and the only rail on this surface that pays an ordinary address on a
  // chain. That makes it the sharpest test of the no-address rule. Its chain argument is EVM
  // only, because this app derives its EVM address from a key it holds and can therefore prove
  // the destination is its own; it holds no Solana key.
  'propose_intents_withdraw',
  // Arming a bot. The one proposal that grants STANDING authority rather than spending once,
  // so it never auto-approves on any network.
  'propose_mandate',
  // How to write a mandate, as data. Opening a position is the one action that cannot be
  // reached by reading a tool signature, because it takes a program rather than arguments.
  'mandate_catalog',
  // The chart. These read and drive a view, never funds.
  'chart_read',
  'chart_measure',
  'chart_scan',
  // The measurement instrument. Many operations in one call, so its arguments are enumerated
  // rather than left as a free-form bag: the property walk cannot see inside an open record.
  'chart_batch',
  'indicator_catalog',
  'market_search',
  'research',
  'chart_set_view',
  'chart_add_indicator',
  'chart_remove_indicator',
  'chart_level',
  'chart_mark',
  // The sloped line. A level is horizontal and a mark is vertical, so neither could express one.
  'chart_trendline',
  // Tidying up, and the reason it grew targets: with a team on one chart, "clear what the agent
  // drew" stopped being one thing. `mine` is this session's own work and is the default,
  // because a tidy that reached a colleague's by default would be the commonest way one agent
  // silently undoes another.
  'chart_clear',
  // A whole study package in one call, and the tidy that makes it always fit. It clears the
  // calling agent's own studies before it draws, so it can never be refused by the pane cap and
  // the chart cannot silently accumulate. See src/presets.ts.
  'chart_preset',
  // Moves the window between the three surfaces. Named `switch` rather than set_view_mode
  // because the requirement is that switching costs one word.
  'switch',
  // Recolours the window. Same category as `switch` and `watch`: it changes what a human
  // sees, reaches no rail and no money, and it cannot touch the approval gate's red, which
  // is not one of its slots. See src/view/theme.ts.
  'set_theme',
  // Picks the coins the basic screen tracks and saves the choice. Named for what the human
  // says, like `switch`. It changes what a human sees and reaches no rail and no money.
  'watch',
  // The trading surface. Reads answer "what is my situation"; writes change what is drawn and
  // what is pointed at. What is NOT here is the point: there is no close, no cancel, no flatten
  // and no disarm. Those live on /api/trade/action, which this door does not open onto, so the
  // capability is absent rather than guarded.
  'trade_read',
  'trade_batch',
  'trade_focus',
  'trade_highlight',
  'trade_overlay',
  'trade_note',
  'trade_clear',
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
  // propose_*, and minus the three window controls (switch, watch, set_theme).
  'agent_spawn',
  // The only tool answered inside the shim instead of proxied to the app. It reads an enabled
  // skill file off this machine and returns its text, which is why it needs no app state and
  // why it still works while the roster is full. It moves nothing and, like every other read
  // here, cannot reach a rail.
  'skill',
];

/* What a spawned worker holds, which is this surface minus everything that acts.
   Derived rather than typed out, so the two lists cannot drift: adding a tool above adds it to
   a worker too unless it is named here, which is the safe direction to be wrong in only because
   tests/injection.test.ts walks the whole surface for an address either way. */
export const WORKER_WITHHELD: readonly string[] = [
  'agent_spawn',
  'switch',
  'watch',
  'set_theme',
  ...EXPECTED_TOOLS.filter((t) => t.startsWith('propose_')),
];

export const EXPECTED_WORKER_TOOLS_SORTED: readonly string[] = EXPECTED_TOOLS.filter(
  (t) => !WORKER_WITHHELD.includes(t),
).sort();

export const EXPECTED_TOOLS_SORTED: readonly string[] = [...EXPECTED_TOOLS].sort();
