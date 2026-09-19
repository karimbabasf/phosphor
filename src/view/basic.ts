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
//      Verified 2026-08-12: an executed move sent 36.540787 USDC and 0.011 WETH on
//      chain while wallet still returned every pre-trade figure.
// Both fail toward saying less rather than toward stating a stale number as fact.

import type {
  BasicAction,
  BasicAsk,
  BasicDestination,
  BasicHolding,
  BasicPrice,
  BasicRecent,
  BasicTone,
  BasicView,
  ChainId,
  LogEvent,
  Proposal,
  SendRecipient,
  SimulationResult,
  WalletView,
  WriteDraft,
} from '../types.ts';

// What the server managed to read about one of the coins this screen tracks. Null rather
// than a stale figure, and null rather than a zero: see the rule at the top of the file.
export type PriceReading = {
  product: string; // 'ETH-USD'
  priceUsd: number;
  changePct: number; // over the tracked window, not since some arbitrary epoch
  closes: number[]; // the same window as a series, oldest first, for the line
} | null;

export type BasicInput = {
  wallet: WalletView;
  proposals: Proposal[];
  policyReadable: boolean;
  killSwitch: boolean;
  agentsConnected: number;
  // When the ledger's last read started, ISO. Held against the newest executed proposal.
  readAt: string;
  // Needed to tell "your own wallet" from any other address without guessing.
  // Guessing is what F2 did.
  selfAddresses: string[];
  // One per tracked coin, in the order the screen shows them. A null in the array is a
  // coin that could not be read, and it drops out rather than rendering blank.
  prices: PriceReading[];
  // The audit tail, for the assistant's half of the history. Typed events only: the
  // sentences are composed from the event kind and its arguments, never from msg.
  events: LogEvent[];
};

// How many finished actions the screen is willing to list. Four is what fits above the
// fold beside everything else; a fifth turns the section into a log, which is the thing
// this screen exists not to be.
const RECENT_MAX = 4;

// The assistant's half of the history. One more than the money half because the two lists
// sit side by side and an assistant is chattier than a wallet, and no more than that
// because a sixth line makes it a log again. Runs collapse before this cap applies, so
// five lines here are five DIFFERENT things.
const ACTION_MAX = 5;

// Which mark the browser draws beside a coin. Only the three this screen tracks: a mark
// nobody drew is worse than no mark, and the drawing lives in ui/app.js.
const MARK: Record<string, BasicPrice['mark']> = {
  BTC: 'btc',
  ETH: 'eth',
  SOL: 'sol',
};

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

function plainSymbol(symbol: string): string {
  return PLAIN_SYMBOL[symbol.toUpperCase()] ?? symbol;
}

function plainChain(chain: string): string {
  return PLAIN_CHAIN[chain] ?? chain;
}

// A payout network as this reader knows it. The ids are chainscan's (src/chainscan/networks.ts).
const PLAIN_NETWORK: Record<string, string> = {
  ethereum: 'Ethereum',
  base: 'Base',
  arbitrum: 'Arbitrum',
  solana: 'Solana',
  near: 'NEAR',
  bitcoin: 'Bitcoin',
};

function plainNetwork(network: string): string {
  return PLAIN_NETWORK[network] ?? network;
}

// "First send to this address" or "sent here 3 times before": the recipients book, in the
// destination label, so this reader sees an address they have never paid for what it is.
function sentBefore(recipient: SendRecipient | undefined): string {
  if (recipient === undefined) return '';
  if (!recipient.known) return '. First send to this address';
  return `. Sent here ${recipient.count} ${recipient.count === 1 ? 'time' : 'times'} before`;
}

// What the chain said about the receiver, from the simulation, as its own sentence.
function activityClause(simulation: SimulationResult | null | undefined): string {
  const activity = simulation?.send?.activity;
  return typeof activity === 'string' && activity !== '' ? ` ${activity}` : '';
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

function readAtMs(readAt: string): number {
  const t = Date.parse(readAt ?? '');
  return Number.isFinite(t) ? t : 0;
}

// A row after which the balance may differ from the last read: anything that went through,
// and anything that carries a hash whatever its status, because a hash means money moved or
// may have. Stamped by when the rail returned when that was recorded: the decision can be a
// minute earlier, and a read taken between the two is not the new balance.
function movedMoney(p: Proposal): boolean {
  if (p.status === 'executed') return true;
  if (p.status !== 'failed' && p.status !== 'needs_reconciliation') return false;
  // A hash, or the handle or nonce of a signed intent or a venue send that got no answer:
  // each is something live at a venue that this app did not see settle.
  const evidence = p.result?.evidence;
  return (p.result?.txids ?? []).length > 0 || evidence?.handle !== undefined || evidence?.nonce !== undefined;
}

function movedAt(p: Proposal): string {
  return p.settledAt ?? p.decidedAt ?? p.createdAt;
}

function newestExecutionAt(proposals: Proposal[]): number {
  let newest = 0;
  for (const p of proposals) {
    if (!movedMoney(p)) continue;
    const t = Date.parse(movedAt(p));
    if (Number.isFinite(t) && t > newest) newest = t;
  }
  return newest;
}

// The newest row the app cannot confirm, when it is newer than the newest settled outcome:
// "Done. You now have $X" would be the wrong sentence over it.
function newestUnconfirmed(proposals: Proposal[]): Proposal | null {
  let best: Proposal | null = null;
  for (const p of proposals) {
    if (p.status === 'executed' || !movedMoney(p)) continue;
    if (best === null || movedAt(p) > movedAt(best)) best = p;
  }
  return best;
}

// ---------- the ask ----------

/* THE KINDS THIS APP NO LONGER BUILDS, AND WHY EVERY SWITCH BELOW STILL ANSWERS FOR THEM.
   lp_add, lp_remove, yield_deposit and yield_withdraw were real rails, consolidate and
   transfer were the chain-era fund moves, and intents_deposit and intents_withdraw moved
   between a chain wallet and the verifier. state/proposals.json holds executed and refused rows
   naming them, and the money they moved was real. This screen renders that history, so a row it
   dropped or threw on would be this app telling its owner something did not happen when it did.
   Nothing can propose one of these again; every one of them can still be read back.
   `kindOf` exists because draft.kind no longer includes the retired names, so TypeScript calls
   the comparison unreachable and refuses it. Reading the same field as a string is the honest
   way to say "this value is wider at rest than the live type is". `retired` is the matching
   read for the fields those drafts carried. */
const RETIRED_KINDS = ['lp_add', 'lp_remove', 'yield_deposit', 'yield_withdraw', 'mandate_arm', 'consolidate', 'transfer', 'intents_deposit', 'intents_withdraw'];

type RetiredLeg = { fromChain?: ChainId; toChain?: ChainId; symbol?: string; amountUsd?: number; to?: string };

type RetiredDraft = {
  chain?: ChainId;
  symbol?: string;
  liquidityPct?: number;
  token0?: { symbol: string };
  token1?: { symbol: string };
  counterparty?: string;
  to?: string;
  maxNotionalUsd?: number;
  maxLossUsd?: number;
  // consolidate and transfer, the chain-era fund moves.
  toChain?: ChainId;
  totalUsd?: number;
  legs?: RetiredLeg[];
  leg?: RetiredLeg;
};

function kindOf(draft: WriteDraft): string {
  return draft.kind;
}

function retired(draft: WriteDraft): RetiredDraft {
  return draft as unknown as RetiredDraft;
}

function isRetired(draft: WriteDraft): boolean {
  return RETIRED_KINDS.includes(kindOf(draft));
}

export function amountUsdOf(draft: WriteDraft): number {
  if (kindOf(draft) === 'consolidate') return retired(draft).totalUsd ?? 0;
  if (kindOf(draft) === 'transfer') return retired(draft).leg?.amountUsd ?? 0;
  if (draft.kind === 'policy_change') return 0;
  // Every retired kind carried amountUsd too, so the same read serves them.
  return (draft as { amountUsd?: number }).amountUsd ?? 0;
}

function symbolsOf(draft: WriteDraft): string[] {
  const out: string[] = [];
  if (draft.kind === 'swap') out.push(draft.fromSymbol, draft.toSymbol);
  // Every one-symbol kind. The retired intents deposit was missing here once, so its "What is
  // involved" line came out blank on the one screen a human approves money from.
  else if (draft.kind === 'hl_deposit' || draft.kind === 'hl_withdraw' || draft.kind === 'intents_send' || draft.kind === 'intents_pay')
    out.push(draft.symbol);
  else if (kindOf(draft) === 'intents_deposit' || kindOf(draft) === 'intents_withdraw')
    out.push(retired(draft).symbol ?? '');
  else if (kindOf(draft) === 'lp_add')
    out.push(retired(draft).token0?.symbol ?? '', retired(draft).token1?.symbol ?? '');
  else if (kindOf(draft) === 'yield_deposit' || kindOf(draft) === 'yield_withdraw' || kindOf(draft) === 'consolidate')
    out.push(retired(draft).symbol ?? '');
  else if (kindOf(draft) === 'transfer') out.push(retired(draft).leg?.symbol ?? '');
  return [...new Set(out.filter((s) => (s ?? '').length > 0))];
}

function chainsOf(draft: WriteDraft): string[] {
  const out: string[] = [];
  // A swap moves nothing between chains: both legs sit inside NEAR Intents, and chain and
  // toChain name the assets' home chains, which the headline already says. Nothing to list.
  if (draft.kind === 'swap') return [];
  if (kindOf(draft) === 'intents_deposit' || kindOf(draft) === 'intents_withdraw') out.push(retired(draft).chain ?? '');
  // A Hyperliquid deposit starts inside the verifier and lands on the venue; neither is a
  // chain the wallet reads, and both are named in the headline, so the chain line stays empty.
  else if (kindOf(draft) === 'consolidate') out.push(retired(draft).toChain ?? '', ...(retired(draft).legs ?? []).map((l) => l.fromChain ?? ''));
  else if (kindOf(draft) === 'transfer') out.push(retired(draft).leg?.fromChain ?? '', retired(draft).leg?.toChain ?? '');
  else if (isRetired(draft)) out.push(retired(draft).chain ?? '');
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
    push(draft.counterparty, 'the NEAR Intents contract this app keeps on its approved list', 'app');
    push(draft.hlAccount, isSelf(draft.hlAccount, selfAddresses) ? 'your own trading account' : NOT_YOURS, 'app');
  } else if (draft.kind === 'hl_withdraw') {
    // The send goes to an address the quoter mints, which is why it is not listed as yours;
    // what matters to this reader is where the money ends up, and that is their own balance.
    push(draft.to, isSelf(draft.to, selfAddresses) ? 'your own NEAR Intents balance' : NOT_YOURS, 'app');
  } else if (isRetired(draft)) {
    push(retired(draft).counterparty ?? '', 'the contract this app kept on its approved list', 'app');
  } else if (kindOf(draft) === 'intents_withdraw') {
    // The retired draft that paid out to an ordinary address on a chain. Basic exists to say
    // whose address that is, so it says it here rather than showing a withdrawal with no
    // destination at all.
    const to = retired(draft).to ?? '';
    push(to, isSelf(to, selfAddresses) ? 'your own wallet' : NOT_YOURS, 'app');
  } else if (draft.kind === 'intents_send') {
    // The two drafts MEANT to name somebody else's address. Each is said as exactly that, with
    // whether the address has ever been paid before, so the person clicking reads the whole
    // address they are paying and knows it is not theirs. No approved list since 2026-09-17:
    // this sentence and the Touch ID dialog are the gate.
    push(draft.to, isSelf(draft.to, selfAddresses) ? 'your own NEAR Intents balance' : `the NEAR Intents account you are sending to${sentBefore(draft.recipient)}`, 'app');
  } else if (draft.kind === 'intents_pay') {
    push(
      draft.to,
      draft.recipient.ownAddress || isSelf(draft.to, selfAddresses)
        ? `your own wallet on ${plainNetwork(draft.network)}`
        : `a wallet on ${plainNetwork(draft.network)} that is NOT yours${sentBefore(draft.recipient)}`,
      'app',
    );
  } else if (kindOf(draft) === 'transfer') {
    const to = retired(draft).leg?.to ?? '';
    push(to, isSelf(to, selfAddresses) ? 'your own wallet' : NOT_YOURS, 'app');
  } else if (kindOf(draft) === 'consolidate') {
    for (const leg of retired(draft).legs ?? []) {
      push(leg.to ?? '', isSelf(leg.to ?? '', selfAddresses) ? 'your own wallet' : NOT_YOURS, 'app');
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

function askHeadline(draft: WriteDraft, amountUsd: number, simulation?: SimulationResult | null): string {
  if (draft.kind === 'swap') {
    return `It wants to change ${amountClause(amountUsd)}your ${plainSymbol(draft.fromSymbol)} into ${plainSymbol(draft.toSymbol)}.`;
  }
  if (draft.kind === 'hl_deposit') {
    return `It wants to move ${amountClause(amountUsd)}your ${plainSymbol(draft.symbol)} to your Hyperliquid trading account.`;
  }
  if (draft.kind === 'hl_withdraw') {
    return `It wants to bring ${amountClause(amountUsd)}your ${plainSymbol(draft.symbol)} back out of your Hyperliquid trading account into the NEAR trading service.`;
  }
  if (kindOf(draft) === 'intents_deposit') {
    return `It wants to move ${amountClause(amountUsd)}your ${plainSymbol(retired(draft).symbol ?? '')} into a NEAR account this app holds for you, ready to trade.`;
  }
  if (kindOf(draft) === 'intents_withdraw') {
    return `It wants to bring ${amountClause(amountUsd)}your ${plainSymbol(retired(draft).symbol ?? '')} back out of the NEAR trading service and into your ${plainChain(retired(draft).chain ?? '')} wallet.`;
  }
  if (draft.kind === 'intents_send') {
    return `It wants to send ${amountClause(amountUsd)}your ${plainSymbol(draft.symbol)} inside the NEAR trading service to another account, ${draft.to}. The money will belong to whoever holds that account's key.`;
  }
  if (draft.kind === 'intents_pay') {
    const own = draft.recipient.ownAddress ? ' That is your own wallet.' : ' The money will belong to whoever holds that wallet\'s key.';
    return `It wants to pay ${amountClause(amountUsd)}your ${plainSymbol(draft.symbol)} out of the NEAR trading service to ${draft.to}, a wallet on ${plainNetwork(draft.network)}.${own}${activityClause(simulation)}`;
  }
  if (kindOf(draft) === 'lp_add') {
    const pair = `${plainSymbol(retired(draft).token0?.symbol ?? '')} and ${plainSymbol(retired(draft).token1?.symbol ?? '')}`;
    return `It wants to put ${amountClause(amountUsd)}your money into a pool holding ${pair}.`;
  }
  if (kindOf(draft) === 'lp_remove') {
    const pct = Math.round((retired(draft).liquidityPct ?? 0) * 100);
    const worth = amountUsd > 0 ? `, worth about ${money(amountUsd)}` : '';
    return `It wants to take ${pct}% of one of your pool positions back out${worth}.`;
  }
  if (kindOf(draft) === 'consolidate') {
    return `It wants to gather ${amountClause(amountUsd)}your ${plainSymbol(retired(draft).symbol ?? '')} onto ${plainChain(retired(draft).toChain ?? '')}.`;
  }
  if (kindOf(draft) === 'transfer') {
    return `It wants to send ${amountClause(amountUsd)}your ${plainSymbol(retired(draft).leg?.symbol ?? '')} to another address.`;
  }
  // A trade puts collateral at stake and names the loss that ends it. Those two numbers are
  // the whole ask, so they are the sentence.
  if (draft.kind === 'trade') {
    if (draft.op === 'open') {
      const side = draft.plan.side === 'long' ? 'buy' : 'sell';
      return `It wants to ${side} ${plainSymbol(draft.plan.symbol)} with ${money(draft.risk.marginUsd)} of your trading account at stake, and to stop out once it has lost ${money(draft.risk.maxLossUsd)}.`;
    }
    if (draft.cancel === true) return `It wants to cancel trade ${draft.id} before it opens. Nothing is at risk after that.`;
    if (draft.close === true) return `It wants to close trade ${draft.id} now, at the market, with ${money(draft.before.marginUsd)} at stake.`;
    return `It wants to move the stop on trade ${draft.id}, so the most it can lose goes from ${money(draft.before.maxLossUsd)} to ${money(draft.after.maxLossUsd)}.`;
  }
  // The retired mandate rows still on disk read as what they were: standing permission.
  if (kindOf(draft) === 'mandate_arm') {
    return `It wanted standing permission to trade ${plainSymbol(retired(draft).symbol ?? '')} on its own, holding at most ${money(retired(draft).maxNotionalUsd ?? 0)} at a time and stopping for good once it had lost ${money(retired(draft).maxLossUsd ?? 0)}.`;
  }
  // No percentage in either sentence, on purpose. This screen exists for someone who owns
  // the money and is not technical, and a rate is the part of a yield product most likely to
  // be read as a promise. The dollars are the fact.
  if (kindOf(draft) === 'yield_deposit') {
    return `It wants to put ${amountClause(amountUsd)}your ${plainSymbol(retired(draft).symbol ?? '')} somewhere it earns interest.`;
  }
  if (kindOf(draft) === 'yield_withdraw') {
    return `It wants to bring your ${plainSymbol(retired(draft).symbol ?? '')} back out of the place it has been earning interest.`;
  }
  return `It wants to change one of your safety rules: "${(draft as { sentence?: string }).sentence ?? ''}".`;
}

// What actually happens to the total. A swap does NOT reduce it, so saying "you would
// have $X left" for a swap would be a fabricated number in the most sensitive place on
// the screen. Each kind says only what is true of it.
function askAfterLine(draft: WriteDraft, totalUsd: number | null, amountUsd: number): string {
  if (draft.kind === 'policy_change') return 'This does not move any money. It changes a rule.';
  if (draft.kind === 'swap') return 'Your total stays about the same. This changes what you are holding, not how much.';
  if (draft.kind === 'hl_deposit') return 'The money stays yours. It moves to your trading account.';
  // Collateral coming back. The venue takes 1 USDC on top for the fresh address it is sent
  // to, so the sentence names that rather than letting the reader find it on the receipt.
  if (draft.kind === 'hl_withdraw')
    return 'The money comes back out of your trading account and is held for you by the NEAR trading service. Hyperliquid charges 1 USDC extra for this.';
  // Deliberately not "it stays in your wallet". It does not: it leaves the wallet and is
  // held for this app by the NEAR Intents contract, and getting it back on chain is a
  // separate action. Saying so is the difference between an informed click and a surprise.
  if (kindOf(draft) === 'intents_deposit')
    return 'The money stays yours, but it leaves your wallet and is held by the NEAR trading service. Bringing it back is a separate step.';
  // The one kind where money ARRIVES. Falling through to the transfer line would have told
  // this reader they were about to have less, which is the opposite of what happens.
  if (kindOf(draft) === 'intents_withdraw')
    return 'The money comes back into your own wallet, where you can spend it directly again.';
  if (draft.kind === 'intents_send')
    return 'The money leaves your balance for good and lands in the other account. There is no way to take it back from here.';
  if (draft.kind === 'intents_pay')
    return `The money leaves the NEAR trading service for good and lands on ${plainNetwork(draft.network)}. If the bridge cannot deliver it, it comes back to your balance; once it has landed there is no way to take it back from here.`;
  if (kindOf(draft) === 'lp_add') return `${money(amountUsd)} moves into the pool. You can take it back out later.`;
  if (kindOf(draft) === 'lp_remove') return 'Money comes back out of the pool to you.';
  if (kindOf(draft) === 'yield_deposit')
    return `${money(amountUsd)} moves into a lending pool and starts earning. It is still yours and there is no lock: you can take it back whenever you want.`;
  if (kindOf(draft) === 'yield_withdraw') return 'The money comes back into your own wallet, with whatever it earned.';
  if (kindOf(draft) === 'consolidate') return 'The money stays yours. It moves onto one chain.';
  if (draft.kind === 'trade') return 'The money stays in your trading account. Only the amount at stake can be lost, and the stop is on the exchange itself.';
  if (kindOf(draft) === 'mandate_arm') return 'This was standing permission from an older build. Nothing moves now.';
  // A transfer is the only kind that genuinely leaves, so it is the only one allowed to
  // state a balance afterwards, and only when the balance is known.
  if (totalUsd === null) return 'This money leaves your wallet. Your balance is still being checked.';
  return `You would have about ${money(totalUsd - amountUsd)} left afterwards.`;
}

/* WHAT THE RULE CHANGE ACTUALLY SAYS, line by line.

   The only thing this screen used to tell a person about a policy change was the agent's own
   sentence in the headline and "This does not move any money. It changes a rule." below it. The
   agent writes both halves of that: the patch AND the sentence beside it. So a patch setting the
   click threshold to a billion dollars and replacing the destination allowlist, described as
   "cap the freezable share", produced a card that named neither. One click and every later
   proposal executed with no human in it.

   The app already renders the policy as deterministic sentences (src/policy/render.ts) and
   already computes the before and after pair at src/proposals/draft.ts. Nothing displayed it.
   These lines are that diff, and they are facts rather than prose because facts are the lines
   this screen may not drop. Every removal gets its own line: mergePatch REPLACES the destination
   allowlist and the forbidden issuers rather than merging them, so the deletions
   are the part a reader would otherwise never see. */
function ruleChangeFacts(simulation: SimulationResult | null): string[] {
  const diff = simulation?.policyDiff;
  if (diff === undefined) return [];
  const before = diff.before;
  const after = diff.after;
  const removed = before.filter((line) => !after.includes(line));
  const added = after.filter((line) => !before.includes(line));
  // Removals first. A rule that stops applying is the dangerous half of any policy change, and
  // it is the half a person skimming a list of additions reads past.
  const facts = removed.map((line) => `This rule would be removed: "${line}"`);
  for (const line of added) facts.push(`This rule would be added: "${line}"`);
  if (facts.length === 0) facts.push('None of your rules would actually read any differently afterwards.');
  return facts;
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
    headline: askHeadline(draft, amountUsd, proposal.simulation),
    afterLine: askAfterLine(draft, totalUsd, amountUsd),
    amountUsd,
    symbols: symbolsOf(draft),
    chains: chainsOf(draft),
    destinations,
    facts: [...factsOf(draft, amountUsd, destinations), ...ruleChangeFacts(proposal.simulation)],
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
function buildHoldings(wallet: WalletView, unknown: boolean): BasicHolding[] {
  if (unknown) return [];

  const tokens = new Map<string, { qty: number; usd: number }>();

  for (const row of wallet.rows ?? []) {
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
      share: 0,
    });
  }
  out.sort((a, b) => b.valueUsd - a.valueUsd);

  // Against the sum of the rows, not against wallet.totalUsd. They are the same number
  // whenever both are readable, and when they are not, a ring whose slices do not close
  // is a drawing of an arithmetic error. The ring says how the rows below it divide up.
  const sum = out.reduce((total, row) => total + row.valueUsd, 0);
  if (sum > 0) for (const row of out) row.share = row.valueUsd / sum;

  return out;
}

// ---------- the three prices ----------

// plainSymbol keeps the ticker in parentheses because the ticker is the verifiable half.
// The price line has the symbol on its own line already, so it takes the bare name.
function bareName(symbol: string): string {
  return plainSymbol(symbol).replace(/\s*\(.*\)$/, '');
}

// A line needs two points to be a line, and every point on it has to be a real close.
// One NaN in the middle of the series draws a spike that reads as a crash, so a series
// with a hole in it is dropped whole and the row shows a price with no line under it.
function series(closes: number[] | undefined): number[] {
  const raw = closes ?? [];
  if (raw.length < 2) return [];
  for (const close of raw) if (!Number.isFinite(close) || close <= 0) return [];
  return raw;
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

  // Bitcoin at $64,210.37 and Solana at $142.08 both want two decimals; a coin priced
  // under a dollar wants more, and rounding it to $0.00 would be the same failure as
  // printing a zero for an unknown.
  const digits = reading.priceUsd >= 1 ? 2 : 6;

  return {
    name: bareName(symbol),
    symbol,
    mark: MARK[symbol] ?? null,
    priceLine: `$${reading.priceUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits })}`,
    changeLine,
    direction,
    points: series(reading.closes),
  };
}

function buildPrices(readings: PriceReading[]): BasicPrice[] {
  const out: BasicPrice[] = [];
  for (const reading of readings ?? []) {
    const price = buildPrice(reading);
    if (price !== null) out.push(price);
  }
  return out;
}

// ---------- what happened ----------

// Both of these run every figure through amountClause, the helper written further up for
// exactly this: a draft can legitimately price at zero, and the money clause is DROPPED
// rather than replaced with a word. Substituting "money" was tried and shipped a sentence
// reading "gathering money of your US dollars (USDT) onto Ethereum", which is not English.
// Found by reading the rendered screen with real refusals on it, not from the object.

// Past tense, for something that actually happened.
export function didHeadline(draft: WriteDraft, amountUsd: number): string {
  const amt = amountClause(amountUsd);
  if (draft.kind === 'swap') {
    return `Changed ${amt}your ${plainSymbol(draft.fromSymbol)} into ${plainSymbol(draft.toSymbol)}.`;
  }
  if (draft.kind === 'hl_deposit') return `Moved ${amt}your ${plainSymbol(draft.symbol)} to your Hyperliquid trading account.`;
  if (draft.kind === 'hl_withdraw') return `Brought ${amt}your ${plainSymbol(draft.symbol)} back out of your Hyperliquid trading account.`;
  /* The two rails that now carry nearly all of it, and neither had a sentence: both fell
     through to the safety-rules line at the bottom, so a NEAR Intents deposit read as
     "Changed one of your safety rules." on this screen and on every receipt. */
  if (kindOf(draft) === 'intents_deposit') {
    return `Moved ${amt}your ${plainSymbol(retired(draft).symbol ?? '')} from ${plainChain(retired(draft).chain ?? '')} into NEAR Intents.`;
  }
  if (kindOf(draft) === 'intents_withdraw') {
    return `Brought ${amt}your ${plainSymbol(retired(draft).symbol ?? '')} out of NEAR Intents onto ${plainChain(retired(draft).chain ?? '')}.`;
  }
  if (draft.kind === 'intents_send') {
    return `Sent ${amt}your ${plainSymbol(draft.symbol)} inside NEAR Intents to ${draft.to}.`;
  }
  if (draft.kind === 'intents_pay') {
    return `Paid ${amt}your ${plainSymbol(draft.symbol)} out of NEAR Intents to ${draft.to} on ${plainNetwork(draft.network)}.`;
  }
  if (kindOf(draft) === 'lp_add') return `Put ${amt}your money into a pool.`;
  if (kindOf(draft) === 'lp_remove') return 'Took money back out of a pool.';
  if (kindOf(draft) === 'yield_deposit') return `Put ${amt}your money somewhere it earns interest.`;
  if (kindOf(draft) === 'yield_withdraw') return 'Brought your money back out of the place it was earning interest.';
  if (kindOf(draft) === 'consolidate') return `Gathered ${amt}your ${plainSymbol(retired(draft).symbol ?? '')} onto ${plainChain(retired(draft).toChain ?? '')}.`;
  if (kindOf(draft) === 'transfer') return `Sent ${amt}your ${plainSymbol(retired(draft).leg?.symbol ?? '')} to another address.`;
  /* The venue rows. An approved plan is a bot from the moment the click lands: the runner
     places the entry and manages the exits without asking again, so the receipt says what
     was armed, in the plan's own figures. The fill is not here, because the proposal never
     learns it: the runner reads fills off the venue, and the trade page shows them. A
     change names the plan by its id, which is all the change draft carries. */
  if (draft.kind === 'trade') {
    if (draft.op === 'open') {
      const plan = draft.plan;
      const side = plan.side === 'long' ? 'Long' : 'Short';
      const target = plan.target === undefined ? '' : `, target ${price(plan.target)}`;
      return `Armed a bot: ${side} ${plan.symbol} ${money(plan.sizeUsd)} at ${plan.leverage}x, stop ${price(plan.stop)}${target}.`;
    }
    if (draft.cancel === true) return `Cancelled bot ${draft.id} before it opened.`;
    if (draft.close === true) return `Closed trade ${draft.id} at the market.`;
    const moved: string[] = [];
    if (draft.stop !== undefined) moved.push(`the stop to ${price(draft.stop)}`);
    if (draft.target !== undefined) moved.push(`the target to ${price(draft.target)}`);
    return `Moved ${moved.length > 0 ? moved.join(' and ') : 'the exits'} on trade ${draft.id}.`;
  }
  if (kindOf(draft) === 'mandate_arm') {
    const arm = retired(draft);
    return `Armed a bot on ${arm.symbol ?? 'the venue'}: at most ${money(arm.maxNotionalUsd ?? 0)} at a time, stopping for good after ${money(arm.maxLossUsd ?? 0)} lost.`;
  }
  return 'Changed one of your safety rules.';
}

// The same sentence as a thing that was tried and did not, or may not have, go through. Built
// from the past tense form so the two never drift: only the verb changes.
const TRIED_VERBS: Record<string, string> = {
  Changed: 'change',
  Moved: 'move',
  Brought: 'bring',
  Put: 'put',
  Took: 'take',
  Gathered: 'gather',
  Sent: 'send',
  Armed: 'arm',
  Cancelled: 'cancel',
  Closed: 'close',
};

export function triedHeadline(draft: WriteDraft, amountUsd: number): string {
  const did = didHeadline(draft, amountUsd);
  const space = did.indexOf(' ');
  const verb = TRIED_VERBS[space > 0 ? did.slice(0, space) : did];
  return verb === undefined ? `Tried: ${did}` : `Tried to ${verb}${did.slice(space)}`;
}

// A venue price in the sentence, as the venue quotes it: grouped thousands, no trailing
// zeros, and as many decimals as the plan gave it, so a stop at 0.4512 is not rounded to 0.45.
function price(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

// The same action as a thing that did NOT happen, so a refusal never reads as a receipt.
function wantedPhrase(draft: WriteDraft, amountUsd: number): string {
  const amt = amountClause(amountUsd);
  if (draft.kind === 'swap') {
    return `changing ${amt}your ${plainSymbol(draft.fromSymbol)} into ${plainSymbol(draft.toSymbol)}`;
  }
  if (draft.kind === 'hl_deposit') return `moving ${amt}your ${plainSymbol(draft.symbol)} to your Hyperliquid trading account`;
  if (draft.kind === 'hl_withdraw') return `bringing ${amt}your ${plainSymbol(draft.symbol)} back out of your Hyperliquid trading account`;
  if (kindOf(draft) === 'intents_deposit') {
    return `moving ${amt}your ${plainSymbol(retired(draft).symbol ?? '')} from ${plainChain(retired(draft).chain ?? '')} into NEAR Intents`;
  }
  if (kindOf(draft) === 'intents_withdraw') {
    return `bringing ${amt}your ${plainSymbol(retired(draft).symbol ?? '')} out of NEAR Intents onto ${plainChain(retired(draft).chain ?? '')}`;
  }
  if (draft.kind === 'intents_send') {
    return `sending ${amt}your ${plainSymbol(draft.symbol)} inside NEAR Intents to ${draft.to}`;
  }
  if (draft.kind === 'intents_pay') {
    return `paying ${amt}your ${plainSymbol(draft.symbol)} out of NEAR Intents to ${draft.to} on ${plainNetwork(draft.network)}`;
  }
  if (kindOf(draft) === 'lp_add') return `putting ${amt}your money into a pool`;
  if (kindOf(draft) === 'lp_remove') return 'taking money back out of a pool';
  if (kindOf(draft) === 'yield_deposit') return `putting ${amt}your money somewhere it earns interest`;
  if (kindOf(draft) === 'yield_withdraw') return 'bringing your money back out of the place it was earning interest';
  if (kindOf(draft) === 'consolidate') return `gathering ${amt}your ${plainSymbol(retired(draft).symbol ?? '')} onto ${plainChain(retired(draft).toChain ?? '')}`;
  if (kindOf(draft) === 'transfer') return `sending ${amt}your ${plainSymbol(retired(draft).leg?.symbol ?? '')} to another address`;
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
  // Everything that finished, plus everything that may have moved money and did not finish:
  // a move the app cannot confirm is the one line on this list the owner most needs to see,
  // and leaving it out reads as "nothing happened". A failed row with no hash and no handle
  // moved nothing and stays off the list, as before.
  const finished = proposals.filter(
    (p) => p.status === 'executed' || p.status === 'refused' || p.status === 'policy_refused' || movedMoney(p),
  );

  finished.sort((a, b) => movedAt(b).localeCompare(movedAt(a)));

  return finished.slice(0, RECENT_MAX).map((p) => {
    const amount = amountUsdOf(p.draft);
    if (p.status === 'executed') {
      return { headline: didHeadline(p.draft, amount), timeLine: clockTime(movedAt(p)), outcome: 'done' as const };
    }
    if (p.status === 'failed' || p.status === 'needs_reconciliation') {
      // Never past tense, and the rail's own sentence beside it: that line names the handle,
      // the hash and what the venue said, which is what the owner checks against.
      const sentence = p.result?.detail ?? '';
      return {
        headline: `${triedHeadline(p.draft, amount)} Not confirmed${sentence === '' ? '.' : `: ${sentence}`}`,
        timeLine: clockTime(movedAt(p)),
        outcome: 'unconfirmed' as const,
      };
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

// ---------- what the assistant did ----------

// The audit log stores its arguments as unknown, so every field is read defensively:
// one bad line in a file this app appends to forever must not empty the list.
function field(data: unknown, key: string): string {
  if (typeof data !== 'object' || data === null) return '';
  const value = (data as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

// What a read was actually looking at, in the reader's own terms. Grouped rather than
// named one by one: "chart_scan" and "chart_measure" are one fact to this reader, and
// seventeen tool names on a screen written for a senior is the pro screen's log.
function readLine(tool: string): string {
  if (tool === 'wallet' || tool === 'balances' || tool === 'composition' || tool === 'start') {
    return 'Looked at what you own.';
  }
  if (tool === 'policy_show') return 'Read your safety rules.';
  if (tool === 'log_tail' || tool === 'proposal_status') return 'Looked at what has happened here.';
  if (tool === 'trade_read' || tool === 'trade_batch') return 'Looked at its trading account.';
  if (tool.startsWith('chart_') || tool === 'candles' || tool === 'market_search' || tool === 'indicator_catalog') {
    return 'Looked at prices.';
  }
  return 'Looked something up.';
}

// One sentence per event, or null for an event this reader has no use for. Returning null
// rather than a vaguer sentence is the same choice made everywhere else in this file: the
// list is short, so a line that says nothing costs one that would have.
function actionLine(event: LogEvent): string | null {
  if (event.type === 'agent_connected') return 'An assistant connected.';
  if (event.type === 'agent_disconnected') return 'The assistant disconnected.';
  if (event.type === 'agent_rejected') return 'Another assistant tried to take over. It was turned away.';
  if (event.type !== 'tool_call') return null;

  // The one discriminator that is typed rather than prose. A human pressing a button in
  // the trade window is also logged as a tool_call, and this list is what the ASSISTANT
  // did: putting the owner's own clicks in it would tell them a machine did those.
  const op = field(event.data, 'op');
  if (op === 'read') return readLine(field(event.data, 'tool'));
  // The money half of the history already carries every proposal, by outcome. This line is
  // the moment of asking, which is a thing the assistant did and the other list cannot show
  // until it is decided.
  if (op === 'propose') return 'Asked your permission to move money.';
  if (op === 'view') return 'Changed what the detailed screen shows.';
  if (op === 'set_view_mode') {
    return field(event.data, 'mode') === 'basic'
      ? 'Switched this window to the simple screen.'
      : 'Switched this window to the detailed screen.';
  }
  // The one action on this list the owner asked for out loud, so it is worth its own
  // sentence rather than falling through to nothing.
  if (op === 'set_basic_coins') return 'Changed which coins this screen shows.';
  return null;
}

// Newest first, runs collapsed. The audit tail arrives newest first (src/audit.ts
// reverses it), and collapsing a run means collapsing NEIGHBOURS: two wallet reads with a
// proposal between them are two separate things that happened, and merging them across
// the proposal would put the newest time on the oldest event.
function buildActions(events: LogEvent[]): BasicAction[] {
  const out: BasicAction[] = [];
  for (const event of events ?? []) {
    const line = actionLine(event);
    if (line === null) continue;
    const last = out[out.length - 1];
    if (last !== undefined && last.line === line) {
      last.repeat += 1;
      continue;
    }
    if (out.length === ACTION_MAX) break;
    out.push({ line, timeLine: clockTime(event.ts), repeat: 1 });
  }
  return out;
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
  const { wallet, proposals, policyReadable, killSwitch, agentsConnected } = input;

  // --- what we are willing to say about the balance ---
  const staleChains = wallet.stale ?? [];
  const lastExecution = newestExecutionAt(proposals);
  const staleAfterWrite = lastExecution > 0 && readAtMs(input.readAt) < lastExecution;

  /* The number and the sentence are two fields, because they land in two places. The hero's
     own slot is set in the balance type, and a sentence there ("checking your new balance", in
     44 px, for as long as the read stayed older than the fill) is what the screenshot of
     2026-09-14 showed. So the slot carries the last read total whenever one exists, and the
     sentence that says why that number is not yet fact is `checkingLine`, set in the state line
     under it. `totalUsd` still goes null, so nothing downstream (the ask, the holdings, the
     change since the window opened) treats the number as settled. An unknown total that reads
     as nothing leaves the slot empty rather than showing a zero: a zero and an unknown look the
     same on screen, and this reader has nothing to check either against. */
  let totalUsd: number | null = wallet.totalUsd;
  let checkingLine: string | null = null;
  if (staleChains.length > 0) {
    totalUsd = null;
    checkingLine = 'Still checking.';
  } else if (staleAfterWrite) {
    totalUsd = null;
    checkingLine = 'Checking your new balance.';
  }
  const totalLine = totalUsd === null && wallet.totalUsd === 0 ? '' : money(wallet.totalUsd);

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
    const abnormal = killSwitch || !policyReadable;
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
  const unconfirmed = newestUnconfirmed(proposals);
  const unconfirmedIsNewest =
    unconfirmed !== null && (settled === null || movedAt(unconfirmed) > (settled.decidedAt ?? settled.createdAt));

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
  } else if (unconfirmedIsNewest) {
    tone = 'stopped';
    headline = 'The last move is not confirmed. Do not send it again; open Activity to check it.';
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

  // A warning is independent of tone: a frozen app matters just as much while a question
  // is on screen as it does when the screen is quiet.
  let warning: string | null = null;
  if (killSwitch) warning = 'You have frozen everything. The assistant cannot move any money.';
  else if (!policyReadable) warning = 'The safety rules cannot be read, so every move is being refused.';

  const agentLine = agentsConnected > 0 ? 'An assistant is connected.' : 'No assistant is connected.';

  // The footer is a promise about what happens next, so it has to agree with the warning
  // directly above it. Two sentences contradicting each other is worse than either one
  // alone, and worst here, because the reader has no third source to break the tie.
  let footer: string;
  if (ask !== null) footer = 'Nothing moves unless you press YES.';
  else if (killSwitch) footer = 'Nothing can move while everything is frozen.';
  else if (!policyReadable) footer = 'Nothing can move until the rules are fixed.';
  else footer = 'You will be asked before anything moves.';

  return {
    tone,
    totalUsd,
    totalLine,
    checkingLine,
    placesLine,
    headline,
    ask,
    warning,
    agentLine,
    footer,
    /* EMPTIED WHEN A PLACE COULD NOT BE READ, and only then. A holdings list with a chain
       missing from it looks exactly like the holdings list of someone who owns less, and this
       reader has nothing to check it against.
       A read that merely predates the last write is a different thing: every place answered,
       the figures are the ones from a moment ago, and the line under the total already says the
       new balance is being checked. Tied to `totalUsd === null` this emptied that list too, so
       a person who had just deposited $250 watched the panel say "Nothing here yet. Open Money
       in and send something to one of your addresses." for the three seconds around the settle.
       Seen at 1440 on 2026-09-19 while photographing the stages. */
    holdings: buildHoldings(wallet, staleChains.length > 0),
    prices: buildPrices(input.prices),
    recent: buildRecent(proposals),
    actions: buildActions(input.events),
  };
}
