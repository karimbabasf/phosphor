// The entire basic screen, as one pure function.
//
// Every word a non-technical person reads is written here and nowhere else. The
// browser renders this object and composes no sentences of its own, for the same
// reason policy sentences are machine-rendered: a money sentence built in untested
// browser JavaScript is a claim nothing checks.
//
// THE RULE THIS FILE ENFORCES
// Basic may render fewer WORDS. It may never render fewer FACTS about where the
// money goes. Amount is the field least likely to be wrong. Destination is the one
// with a track record here: F2 shipped a correct amount alongside a solver-chosen
// deposit address while the screen said "your wallet".
//
// TWO PLACES THIS REFUSES TO STATE A NUMBER
//   1. A chain that failed to read. A zero and an unknown look identical on screen,
//      and basic is aimed at someone who cannot tell them apart.
//   2. A balance fetched before the most recent execution. The ledger cache serves
//      pre-trade balances after a write and still stamps them stale: [], because
//      stale[] tracks chains that failed to READ, not data that is out of date.
//      Verified 2026-08-12: an executed lp_add moved 36.540787 USDC and 0.011 WETH
//      on chain while wallet still returned every pre-trade figure.
// Both fail toward saying less rather than toward stating a stale number as fact.

import type {
  BasicAsk,
  BasicDestination,
  BasicHolding,
  BasicPrice,
  BasicRecent,
  BasicTone,
  BasicView,
  ChainId,
  ChainStatus,
  Proposal,
  WalletView,
  WriteDraft,
} from '../types.ts';

// What the server managed to read about the one coin this screen tracks. Null rather
// than a stale figure, and null rather than a zero: see the rule at the top of the file.
export type PriceReading = {
  product: string; // 'ETH-USD'
  priceUsd: number;
  changePct: number; // over the tracked window, not since some arbitrary epoch
} | null;

export type BasicInput = {
  wallet: WalletView;
  proposals: Proposal[];
  policyReadable: boolean;
  killSwitch: boolean;
  gateRequired: boolean;
  agentsConnected: number;
  chainStatus: Record<ChainId, ChainStatus>;
  // Needed to tell "your own wallet" from any other address without guessing.
  // Guessing is what F2 did.
  selfAddresses: string[];
  price: PriceReading;
};

// How many finished actions the screen is willing to list. Four is what fits above the
// fold beside everything else; a fifth turns the section into a log, which is the thing
// this screen exists not to be.
const RECENT_MAX = 4;

// Plain names for the symbols a non-technical reader will actually meet. The symbol
// itself is always kept alongside the plain name: the plain name is the part they can
// act on, the symbol is the part that is verifiable.
const PLAIN_SYMBOL: Record<string, string> = {
  USDC: 'US dollars (USDC)',
  USDT: 'US dollars (USDT)',
  DAI: 'US dollars (DAI)',
  PYUSD: 'US dollars (PYUSD)',
  USDE: 'US dollars (USDe)',
  WETH: 'Ether (WETH)',
  ETH: 'Ether (ETH)',
  SOL: 'Solana (SOL)',
  NEAR: 'NEAR',
  // Not held in any wallet this app reads, but the price tracker can be pointed at it,
  // and "BTC" is the ticker rather than the name for the reader this screen is for.
  BTC: 'Bitcoin (BTC)',
};

const PLAIN_CHAIN: Record<string, string> = {
  eth: 'Ethereum',
  base: 'Base',
  arb: 'Arbitrum',
  sol: 'Solana',
  near: 'NEAR',
};

export function plainSymbol(symbol: string): string {
  return PLAIN_SYMBOL[symbol.toUpperCase()] ?? symbol;
}

function plainChain(chain: string): string {
  return PLAIN_CHAIN[chain] ?? chain;
}

export function money(usd: number): string {
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function isSelf(address: string, selfAddresses: string[]): boolean {
  const target = (address ?? '').trim().toLowerCase();
  if (target.length === 0) return false;
  return selfAddresses.some((a) => a.trim().toLowerCase() === target);
}

// ---------- freshness ----------

function newestFetchAt(chainStatus: Record<ChainId, ChainStatus>): number {
  let newest = 0;
  for (const status of Object.values(chainStatus ?? {})) {
    const t = Date.parse(status?.fetchedAt ?? '');
    if (Number.isFinite(t) && t > newest) newest = t;
  }
  return newest;
}

function newestExecutionAt(proposals: Proposal[]): number {
  let newest = 0;
  for (const p of proposals) {
    if (p.status !== 'executed') continue;
    const t = Date.parse(p.decidedAt ?? '');
    if (Number.isFinite(t) && t > newest) newest = t;
  }
  return newest;
}

// ---------- the ask ----------

function amountUsdOf(draft: WriteDraft): number {
  if (draft.kind === 'consolidate') return draft.totalUsd;
  if (draft.kind === 'transfer') return draft.leg.amountUsd;
  if (draft.kind === 'policy_change') return 0;
  return draft.amountUsd;
}

function symbolsOf(draft: WriteDraft): string[] {
  const out: string[] = [];
  if (draft.kind === 'swap') out.push(draft.fromSymbol, draft.toSymbol);
  else if (draft.kind === 'hl_deposit') out.push(draft.symbol);
  else if (draft.kind === 'lp_add') out.push(draft.token0.symbol, draft.token1.symbol);
  else if (draft.kind === 'consolidate') out.push(draft.symbol);
  else if (draft.kind === 'transfer') out.push(draft.leg.symbol);
  return [...new Set(out.filter((s) => (s ?? '').length > 0))];
}

function chainsOf(draft: WriteDraft): string[] {
  const out: string[] = [];
  if (draft.kind === 'swap') out.push(draft.chain, draft.toChain);
  else if (draft.kind === 'hl_deposit') out.push(draft.chain);
  else if (draft.kind === 'lp_add' || draft.kind === 'lp_remove') out.push(draft.chain);
  else if (draft.kind === 'consolidate') out.push(draft.toChain, ...draft.legs.map((l) => l.fromChain));
  else if (draft.kind === 'transfer') out.push(draft.leg.fromChain, draft.leg.toChain);
  return [...new Set(out)];
}

const NOT_YOURS = 'an address that is NOT your wallet';

// Every address the funds touch, labelled by who chose it. A quoter-chosen address is
// never described as the user's own wallet, which is the exact sentence F2 shipped.
function destinationsOf(proposal: Proposal, selfAddresses: string[]): BasicDestination[] {
  const draft = proposal.draft;
  const out: BasicDestination[] = [];

  function push(address: string, label: string, chosenBy: 'app' | 'quoter'): void {
    const clean = (address ?? '').trim();
    if (clean.length === 0) return;
    if (out.some((d) => d.address.toLowerCase() === clean.toLowerCase())) return;
    out.push({ label, address: clean, chosenBy });
  }

  if (draft.kind === 'swap') {
    push(draft.counterparty, 'the exchange contract this app keeps on its approved list', 'app');
    push(draft.to, isSelf(draft.to, selfAddresses) ? 'your own wallet' : NOT_YOURS, 'app');
  } else if (draft.kind === 'hl_deposit') {
    push(draft.bridge, 'the Hyperliquid bridge contract, from the list this app keeps', 'app');
  } else if (draft.kind === 'lp_add' || draft.kind === 'lp_remove') {
    push(draft.counterparty, 'the Uniswap contract this app keeps on its approved list', 'app');
  } else if (draft.kind === 'transfer') {
    const to = draft.leg.to;
    push(to, isSelf(to, selfAddresses) ? 'your own wallet' : NOT_YOURS, 'app');
  } else if (draft.kind === 'consolidate') {
    for (const leg of draft.legs) {
      push(leg.to, isSelf(leg.to, selfAddresses) ? 'your own wallet' : NOT_YOURS, 'app');
    }
  }

  // The venue mints these per quote, so they can never be on an allowlist and they are
  // what actually gets signed. They must be on screen, labelled for what they are.
  for (const entry of proposal.simulation?.depositAddresses ?? []) {
    push(entry.address, 'an address the swap service chose, not your wallet', 'quoter');
  }

  return out;
}

// "$0.00" is not an amount, it is the absence of one, and a refusal reading "tried to
// gather $0.00 of your dollars" tells this reader nothing. A draft can legitimately
// price at zero (nothing left to consolidate, which is then refused), so the money
// clause is dropped rather than printed as a figure.
function amountClause(amountUsd: number): string {
  return amountUsd > 0 ? `${money(amountUsd)} of ` : '';
}

function askHeadline(draft: WriteDraft, amountUsd: number): string {
  if (draft.kind === 'swap') {
    return `It wants to change ${amountClause(amountUsd)}your ${plainSymbol(draft.fromSymbol)} into ${plainSymbol(draft.toSymbol)}.`;
  }
  if (draft.kind === 'hl_deposit') {
    return `It wants to move ${amountClause(amountUsd)}your ${plainSymbol(draft.symbol)} to your Hyperliquid trading account.`;
  }
  if (draft.kind === 'lp_add') {
    return `It wants to put ${amountClause(amountUsd)}your money into a Uniswap pool holding ${plainSymbol(draft.token0.symbol)} and ${plainSymbol(draft.token1.symbol)}.`;
  }
  if (draft.kind === 'lp_remove') {
    const pct = Math.round(draft.liquidityPct * 100);
    const worth = amountUsd > 0 ? `, worth about ${money(amountUsd)}` : '';
    return `It wants to take ${pct}% of one of your Uniswap pool positions back out${worth}.`;
  }
  if (draft.kind === 'consolidate') {
    return `It wants to gather ${amountClause(amountUsd)}your ${plainSymbol(draft.symbol)} onto ${plainChain(draft.toChain)}.`;
  }
  if (draft.kind === 'transfer') {
    return `It wants to send ${amountClause(amountUsd)}your ${plainSymbol(draft.leg.symbol)} to another address.`;
  }
  return `It wants to change one of your safety rules: "${draft.sentence}".`;
}

// What actually happens to the total. A swap does NOT reduce it, so saying "you would
// have $X left" for a swap would be a fabricated number in the most sensitive place on
// the screen. Each kind says only what is true of it.
function askAfterLine(draft: WriteDraft, totalUsd: number | null, amountUsd: number): string {
  if (draft.kind === 'policy_change') return 'This does not move any money. It changes a rule.';
  if (draft.kind === 'swap') return 'Your total stays about the same. This changes what you are holding, not how much.';
  if (draft.kind === 'hl_deposit') return 'The money stays yours. It moves to your trading account.';
  if (draft.kind === 'lp_add') return `${money(amountUsd)} moves into the pool. You can take it back out later.`;
  if (draft.kind === 'lp_remove') return 'Money comes back out of the pool to you.';
  if (draft.kind === 'consolidate') return 'The money stays yours. It moves onto one chain.';
  // A transfer is the only kind that genuinely leaves, so it is the only one allowed to
  // state a balance afterwards, and only when the balance is known.
  if (totalUsd === null) return 'This money leaves your wallet. Your balance is still being checked.';
  return `You would have about ${money(totalUsd - amountUsd)} left afterwards.`;
}

function factsOf(draft: WriteDraft, amountUsd: number, destinations: BasicDestination[]): string[] {
  const facts: string[] = [];
  if (draft.kind !== 'policy_change') facts.push(`Amount: ${money(amountUsd)}.`);
  const symbols = symbolsOf(draft);
  if (symbols.length > 0) facts.push(`What is involved: ${symbols.map(plainSymbol).join(' and ')}.`);
  const chains = chainsOf(draft);
  if (chains.length > 0) facts.push(`Where: ${chains.map(plainChain).join(', ')}.`);
  if (destinations.some((d) => d.chosenBy === 'quoter')) {
    facts.push('Part of this money goes to an address chosen by the swap service, not by you and not by this app.');
  }
  if (destinations.some((d) => d.label === NOT_YOURS)) {
    facts.push('This money is going somewhere that is not your own wallet.');
  }
  return facts;
}

function buildAsk(proposal: Proposal, totalUsd: number | null, selfAddresses: string[]): BasicAsk {
  const draft = proposal.draft;
  const amountUsd = amountUsdOf(draft);
  const destinations = destinationsOf(proposal, selfAddresses);
  return {
    proposalId: proposal.id,
    kind: draft.kind,
    headline: askHeadline(draft, amountUsd),
    afterLine: askAfterLine(draft, totalUsd, amountUsd),
    amountUsd,
    symbols: symbolsOf(draft),
    chains: chainsOf(draft),
    destinations,
    facts: factsOf(draft, amountUsd, destinations),
  };
}

// ---------- what you own ----------

// A quantity is shown at the precision that distinguishes it, not at a fixed one.
// "0.00" of Ether and "0.31" of Ether are different holdings; "1204.00" and
// "1204.000000" are the same one, and the second is harder to read at a glance.
function quantity(amount: number): string {
  if (!Number.isFinite(amount)) return '0';
  const abs = Math.abs(amount);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits });
}

// One row per THING OWNED, not one per chain. The same dollars sitting on four chains
// is one holding to this reader; which chain each part sits on is a pro-screen fact and
// putting it here was the "extra info" that made the first version unreadable.
// Pool positions collapse together for the same reason: a quantity summed across two
// different pools would be a number that means nothing.
function buildHoldings(wallet: WalletView, unknown: boolean): BasicHolding[] {
  if (unknown) return [];

  const tokens = new Map<string, { qty: number; usd: number }>();
  let poolUsd = 0;

  for (const row of wallet.rows ?? []) {
    if (row.kind === 'lp') {
      poolUsd += row.valueUsd;
      continue;
    }
    const key = row.symbol.toUpperCase();
    const at = tokens.get(key) ?? { qty: 0, usd: 0 };
    at.qty += row.quantity;
    at.usd += row.valueUsd;
    tokens.set(key, at);
  }

  const out: BasicHolding[] = [];
  for (const [symbol, at] of tokens) {
    out.push({
      name: plainSymbol(symbol),
      quantityLine: quantity(at.qty),
      valueLine: money(at.usd),
      valueUsd: at.usd,
    });
  }
  if (poolUsd > 0) {
    out.push({
      name: 'Money in Uniswap pools',
      quantityLine: '',
      valueLine: money(poolUsd),
      valueUsd: poolUsd,
    });
  }

  return out.sort((a, b) => b.valueUsd - a.valueUsd);
}

// ---------- the one price ----------

// plainSymbol keeps the ticker in parentheses because the ticker is the verifiable half.
// The price line has the symbol on its own line already, so it takes the bare name.
function bareName(symbol: string): string {
  return plainSymbol(symbol).replace(/\s*\(.*\)$/, '');
}

function buildPrice(reading: PriceReading): BasicPrice | null {
  if (reading === null) return null;
  if (!Number.isFinite(reading.priceUsd) || reading.priceUsd <= 0) return null;
  if (!Number.isFinite(reading.changePct)) return null;

  const symbol = (reading.product.split('-')[0] ?? reading.product).toUpperCase();
  const pct = Math.abs(reading.changePct).toFixed(1);

  // A tenth of a percent either way is noise, and an arrow drawn on noise tells this
  // reader that something happened when nothing did.
  let direction: BasicPrice['direction'] = 'flat';
  if (reading.changePct >= 0.1) direction = 'up';
  else if (reading.changePct <= -0.1) direction = 'down';

  const changeLine =
    direction === 'flat' ? 'level today' : `${direction === 'up' ? 'up' : 'down'} ${pct}% today`;

  return {
    name: bareName(symbol),
    symbol,
    priceLine: `$${reading.priceUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    changeLine,
    direction,
  };
}

// ---------- what happened ----------

// Past tense, for something that actually happened.
function didHeadline(draft: WriteDraft, amountUsd: number): string {
  const amt = amountUsd > 0 ? money(amountUsd) : 'money';
  if (draft.kind === 'swap') {
    return `Changed ${amt} of your ${plainSymbol(draft.fromSymbol)} into ${plainSymbol(draft.toSymbol)}.`;
  }
  if (draft.kind === 'hl_deposit') return `Moved ${amt} to your Hyperliquid trading account.`;
  if (draft.kind === 'lp_add') return `Put ${amt} into a Uniswap pool.`;
  if (draft.kind === 'lp_remove') return 'Took money back out of a Uniswap pool.';
  if (draft.kind === 'consolidate') return `Gathered ${amt} of your ${plainSymbol(draft.symbol)} onto ${plainChain(draft.toChain)}.`;
  if (draft.kind === 'transfer') return `Sent ${amt} to another address.`;
  return 'Changed one of your safety rules.';
}

// The same action as a thing that did NOT happen, so a refusal never reads as a receipt.
function wantedPhrase(draft: WriteDraft, amountUsd: number): string {
  const amt = amountUsd > 0 ? money(amountUsd) : 'money';
  if (draft.kind === 'swap') {
    return `changing ${amt} of your ${plainSymbol(draft.fromSymbol)} into ${plainSymbol(draft.toSymbol)}`;
  }
  if (draft.kind === 'hl_deposit') return `moving ${amt} to your Hyperliquid trading account`;
  if (draft.kind === 'lp_add') return `putting ${amt} into a Uniswap pool`;
  if (draft.kind === 'lp_remove') return 'taking money back out of a Uniswap pool';
  if (draft.kind === 'consolidate') return `gathering ${amt} of your ${plainSymbol(draft.symbol)} onto ${plainChain(draft.toChain)}`;
  if (draft.kind === 'transfer') return `sending ${amt} to another address`;
  return 'changing one of your safety rules';
}

function clockTime(stamp: string | undefined): string {
  const t = Date.parse(stamp ?? '');
  if (!Number.isFinite(t)) return '';
  return new Date(t)
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    .toLowerCase();
}

// Built from the proposals, which are typed, and never from the audit event's msg field.
// That text is written for whoever is debugging this app and reads as noise to the
// person who owns the money.
function buildRecent(proposals: Proposal[]): BasicRecent[] {
  const finished = proposals.filter(
    (p) => p.status === 'executed' || p.status === 'refused' || p.status === 'policy_refused',
  );

  finished.sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt));

  return finished.slice(0, RECENT_MAX).map((p) => {
    const amount = amountUsdOf(p.draft);
    if (p.status === 'executed') {
      return { headline: didHeadline(p.draft, amount), timeLine: clockTime(p.decidedAt), outcome: 'done' as const };
    }
    if (p.status === 'refused') {
      return {
        headline: `You said no to ${wantedPhrase(p.draft, amount)}.`,
        timeLine: clockTime(p.decidedAt),
        outcome: 'refused' as const,
      };
    }
    return {
      headline: `Your rules blocked ${wantedPhrase(p.draft, amount)}.`,
      timeLine: clockTime(p.decidedAt),
      outcome: 'blocked' as const,
    };
  });
}

// ---------- the screen ----------

function newestBy(proposals: Proposal[], statuses: string[]): Proposal | null {
  let best: Proposal | null = null;
  for (const p of proposals) {
    if (!statuses.includes(p.status)) continue;
    const stamp = p.decidedAt ?? p.createdAt;
    const bestStamp = best === null ? '' : (best.decidedAt ?? best.createdAt);
    if (best === null || stamp > bestStamp) best = p;
  }
  return best;
}

function refusalHeadline(proposal: Proposal): string {
  const what = askHeadline(proposal.draft, amountUsdOf(proposal.draft))
    .replace(/^It wants to /, '')
    .replace(/\.$/, '');
  return `The assistant tried to ${what}. Phosphor stopped it. Your money did not move.`;
}

export function buildBasic(input: BasicInput): BasicView {
  const { wallet, proposals, policyReadable, killSwitch, gateRequired, agentsConnected } = input;

  // --- what we are willing to say about the balance ---
  const staleChains = wallet.stale ?? [];
  const lastExecution = newestExecutionAt(proposals);
  const staleAfterWrite = lastExecution > 0 && newestFetchAt(input.chainStatus) < lastExecution;

  let totalUsd: number | null = wallet.totalUsd;
  let totalLine = money(wallet.totalUsd);
  if (staleChains.length > 0) {
    totalUsd = null;
    totalLine = 'still checking';
  } else if (staleAfterWrite) {
    totalUsd = null;
    totalLine = 'checking your new balance';
  }

  const placeCount = Object.keys(wallet.byChain ?? {}).length;
  let placesLine: string;
  if (staleChains.length > 0) {
    placesLine = `${staleChains.length} ${staleChains.length === 1 ? 'place' : 'places'} could not be checked just now.`;
  } else if (staleAfterWrite) {
    placesLine = 'The last change has not been counted yet.';
  } else {
    // "all normal" is a claim about the whole app to this reader, not just about the
    // chain reads, so it is dropped whenever a warning is on screen. Otherwise the
    // page reads "all normal" directly under a red box saying everything is frozen.
    const abnormal = killSwitch || !policyReadable || !gateRequired;
    placesLine = `spread across ${placeCount} ${placeCount === 1 ? 'place' : 'places'}.${abnormal ? '' : ' all normal.'}`;
  }

  // --- state ---
  const pending = newestBy(proposals, ['pending']);
  const working = newestBy(proposals, ['approved', 'executing']);
  // One bucket for every finished outcome, so the MOST RECENT one wins.
  // Ranking these by status instead of by time meant a human refusal at 02:15 was
  // reported as an unrelated policy refusal from 02:13: the person pressed NO and
  // the screen told them about something else. Found by pressing the button.
  const settled = newestBy(proposals, ['executed', 'refused', 'policy_refused']);

  // Most dangerous first. Kill switch and an unreadable policy both mean nothing can
  // move at all, so they outrank a question the human cannot act on anyway.
  let tone: BasicTone;
  let headline: string;
  let ask: BasicAsk | null = null;

  if (killSwitch) {
    tone = 'frozen';
    // Says what is true of the money. The warning below says what was done and by whom,
    // and the two may not be the same sentence: see the headline/warning test.
    headline = 'Your money is locked where it is.';
  } else if (!policyReadable) {
    tone = 'broken';
    headline = 'Something is wrong with the rules. Nothing can move.';
  } else if (pending !== null) {
    tone = 'asking';
    headline = 'The assistant is asking.';
    ask = buildAsk(pending, totalUsd, input.selfAddresses);
  } else if (working !== null) {
    tone = 'working';
    headline = 'Working on it. Please wait.';
  } else if (!gateRequired) {
    tone = 'broken';
    // The warning below carries this fact in its own words. The headline says what is
    // true of the money instead, so the screen is not the same sentence twice: on a
    // page this spare, a restatement reads as a rendering fault rather than emphasis.
    // Same reasoning as agentLine, and it only became visible once the screen had room.
    headline = 'Your money is here, but this app is not protecting it.';
  } else if (settled !== null && settled.status === 'policy_refused') {
    tone = 'stopped';
    headline = refusalHeadline(settled);
  } else if (settled !== null && settled.status === 'refused') {
    tone = 'calm';
    headline = 'You said no. Nothing moved.';
  } else if (settled !== null) {
    tone = 'calm';
    headline = totalUsd === null ? 'Done. Checking your new balance.' : `Done. You now have ${money(totalUsd)}.`;
  } else if (agentsConnected === 0) {
    tone = 'calm';
    // Deliberately not the same sentence as agentLine below. On a screen this spare,
    // the same words twice reads as a rendering fault rather than as emphasis.
    headline = 'Your money is safe. Nothing is connected to it right now.';
  } else {
    tone = 'calm';
    headline = 'Your money is safe. Nothing is happening.';
  }

  // A warning is independent of tone: the gate being off matters just as much while a
  // question is on screen as it does when the screen is quiet.
  let warning: string | null = null;
  if (killSwitch) warning = 'You have frozen everything. The assistant cannot move any money.';
  else if (!policyReadable) warning = 'The safety rules cannot be read, so every move is being refused.';
  else if (!gateRequired) warning = 'This app is set to move money without asking you first.';

  const agentLine = agentsConnected > 0 ? 'An assistant is connected.' : 'No assistant is connected.';

  // The footer is a promise about what happens next, so it has to agree with the
  // warning directly above it. An earlier version said "You will be asked before
  // anything moves" on a screen whose warning said the gate was off. Two sentences
  // contradicting each other is worse than either one alone, and worst here, because
  // the reader has no third source to break the tie.
  let footer: string;
  if (ask !== null) footer = 'Nothing moves unless you press YES.';
  else if (killSwitch) footer = 'Nothing can move while everything is frozen.';
  else if (!policyReadable) footer = 'Nothing can move until the rules are fixed.';
  else if (!gateRequired) footer = 'You will NOT be asked before money moves.';
  else footer = 'You will be asked before anything moves.';

  return {
    tone,
    totalUsd,
    totalLine,
    placesLine,
    headline,
    ask,
    warning,
    agentLine,
    footer,
    // Tied to the same condition that nulls the total. A holdings list with a chain
    // missing from it looks exactly like the holdings list of someone who owns less,
    // and this reader has nothing to check it against.
    holdings: buildHoldings(wallet, totalUsd === null),
    price: buildPrice(input.price),
    recent: buildRecent(proposals),
  };
}
