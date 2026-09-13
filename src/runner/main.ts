// The runner child: the only code in phosphor that places an order.
//
// No model runs in this process and no clock ticks in it. It holds plans a human approved, by
// id, and it does exactly one thing per command from the host: place the plan, protect it,
// change its exits, cancel it, close it. The host decides WHEN; this process decides only
// whether the plan it holds allows the thing it was asked, and then signs.
//
// That is the envelope. The host cannot ask for more than the human approved, because this
// process only knows how to place the plan it was given: a command names a plan, never a size,
// a price or a side. A command for a plan it does not hold, or whose expiry has passed, is
// refused by name.
//
// After a fire the venue holds the exits. This process can die and the position is still
// protected, which is the whole reason the entry, the stop and the target go to the venue as
// one bracket and never as a sequence this process has to be alive to finish.

import { createInfoClient } from '../hl/info.ts';
import {
  aggressiveLimitPrice,
  cloidFor,
  createExchange,
  defaultTransport,
  orderErrors,
  stopLimitPx,
} from '../hl/exchange.ts';
import type { OrderRequest, TriggerRequest } from '../hl/exchange.ts';
import { formatSize, roundToValidPrice } from '../hl/format.ts';
import { DEFAULT_TAKER_FEE_BPS, planRisk } from '../trade/risk.ts';
import type { Plan } from '../trade/plan.ts';
import type { AssetMeta, Cloids, FromChild, ToChild } from './protocol.ts';

const BASE_URL = process.env.PHOSPHOR_HL_URL ?? 'https://api.hyperliquid.xyz';
// The master account the positions are read against. Not a secret: it is the address the
// whole app is configured around, and reading it is the one thing this process does with it.
const USER = process.env.PHOSPHOR_HL_USER ?? '';

/* THE KEY ARRIVES ON STDIN, one line, and stdin is closed behind it.
 *
 * It used to arrive in the environment, which was chosen over argv on purpose and correctly so,
 * since argv is world-readable in `ps`. The environment is narrower and still not private: `ps
 * eww <pid>` prints it for any process the same user owns, and this app's whole threat model is
 * a same-user process. A pipe is readable by the two ends and nothing else.
 *
 * It cannot be wiped once it is here. A JavaScript string is immutable and the collector copies
 * it, which is the same honest limit the keystore states about its own buffers, and the answer
 * to it is the same: the parent kills this process when the signing session expires, and a dead
 * process has no heap. */
let KEY: `0x${string}` | undefined;
let stdinBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  stdinBuffer += chunk;
  const end = stdinBuffer.indexOf('\n');
  if (end < 0) return;
  const line = stdinBuffer.slice(0, end).trim();
  stdinBuffer = '';
  if (/^0x[0-9a-fA-F]{64}$/.test(line)) KEY = line as `0x${string}`;
});

type Held = {
  plan: Plan;
  meta: AssetMeta;
  cloids: Cloids;
  gen: number;
  fired: boolean;
  // The position size the resting exits were sized to, or zero when none rest.
  exitSz: number;
};

const held = new Map<string, Held>();

// How long the venue took, summed over every POST the command in hand has made, reads and
// writes alike. Reset per command by the queue below; read into the event that answers it.
// Signing is outside the clock: this is the venue's time, not this process's.
let venueClock = 0;
async function atVenue<T>(work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await work();
  } finally {
    venueClock += performance.now() - started;
  }
}
function venueMs(): number {
  return Math.round(venueClock);
}

const rawInfo = createInfoClient({ baseUrl: BASE_URL });
const info = { post: <T>(body: unknown): Promise<T> => atVenue(() => rawInfo.post<T>(body)) };
let exchange: ReturnType<typeof createExchange> | null = null;

function send(e: FromChild): void {
  if (typeof process.send === 'function') process.send(e);
}

function requireExchange(): ReturnType<typeof createExchange> {
  if (KEY === undefined) throw new Error('no API wallet key: the app did not hand one to this runner');
  if (exchange === null) {
    exchange = createExchange({ privKey: KEY, baseUrl: BASE_URL, transport: (url, body) => atVenue(() => defaultTransport(url, body)) });
  }
  return exchange;
}

// The venue's own words for a cancel that found nothing to cancel. A stop the venue already
// cancelled when its target filled, or an entry that filled a moment ago, is not a failure: the
// order is gone, which is what the cancel asked for.
const ALREADY_GONE = /never placed, already canceled, or filled/i;

// ---------- reads ----------

type Position = { szi: number; entryPx: number; leverageType: string; leverage: number };

async function readPosition(coin: string): Promise<Position | null> {
  const state = await info.post<{ assetPositions?: { position: Record<string, unknown> }[] }>({
    type: 'clearinghouseState',
    user: USER,
  });
  const row = (state.assetPositions ?? []).map((p) => p.position).find((p) => String(p.coin) === coin);
  if (row === undefined) return null;
  const szi = Number(row.szi);
  if (!Number.isFinite(szi) || szi === 0) return null;
  const lev = row.leverage as { type?: string; value?: number } | undefined;
  return {
    szi,
    entryPx: Number(row.entryPx),
    leverageType: String(lev?.type ?? ''),
    leverage: Number(lev?.value ?? 0),
  };
}

async function hasRestingOrders(coin: string): Promise<boolean> {
  const rows = await info.post<{ coin?: string }[]>({ type: 'openOrders', user: USER });
  return Array.isArray(rows) && rows.some((r) => String(r.coin) === coin);
}

async function readLeverage(coin: string): Promise<{ type: string; value: number } | null> {
  const active = await info.post<{ leverage?: { type?: string; value?: number } }>({ type: 'activeAssetData', user: USER, coin });
  const lev = active.leverage;
  if (lev === undefined || lev.value === undefined) return null;
  return { type: String(lev.type ?? ''), value: Number(lev.value) };
}

// ---------- writes ----------

// Leverage is an ACCOUNT setting per coin on the venue, not an order field, so an order placed
// without setting it runs at whatever the account was last left at. Isolated, always: the
// margin posted is then the most the venue can take for this plan, which is the number the
// human approved. Never changed under a position or a resting entry: the venue would refuse,
// and a plan that changed the leverage under another plan's position would change that plan.
async function ensureLeverage(h: Held): Promise<string | null> {
  const coin = h.plan.symbol;
  const current = await readLeverage(coin);
  if (current !== null && current.type === 'isolated' && current.value === h.plan.leverage) return null;
  if ((await readPosition(coin)) !== null || (await hasRestingOrders(coin))) {
    return (
      `${coin} is at ${current === null ? 'an unknown leverage' : `${current.value}x ${current.type}`} with a position or a ` +
      `resting order on it, so its leverage cannot move to ${h.plan.leverage}x isolated for this plan`
    );
  }
  const res = await requireExchange().updateLeverage(h.meta.assetId, false, h.plan.leverage);
  const refused = orderErrors(res);
  if (refused.length > 0) return `the venue refused ${h.plan.leverage}x isolated on ${coin}: ${refused.join('; ')}`;
  return null;
}

function nextGen(h: Held): number {
  h.gen += 1;
  return h.gen;
}

function exitLegs(h: Held, sizeCoin: number, gen: number): { legs: TriggerRequest[]; cloids: Cloids } {
  const long = h.plan.side === 'long';
  const sz = h.meta.szDecimals;
  const stopTrigger = roundToValidPrice(h.plan.stop, sz, true, !long);
  const cloids: Cloids = { ...h.cloids, stop: cloidFor({ plan: h.plan.id, leg: 'stop', gen }) };
  const legs: TriggerRequest[] = [
    {
      assetId: h.meta.assetId,
      isBuy: !long,
      size: sizeCoin,
      triggerPx: stopTrigger,
      limitPx: stopLimitPx(stopTrigger, !long, sz),
      isMarket: true,
      tpsl: 'sl',
      szDecimals: sz,
      cloid: cloids.stop,
      reduceOnly: true,
    },
  ];
  if (h.plan.target !== undefined) {
    const target = roundToValidPrice(h.plan.target, sz, true, !long);
    cloids.target = cloidFor({ plan: h.plan.id, leg: 'target', gen });
    legs.push({
      assetId: h.meta.assetId,
      isBuy: !long,
      size: sizeCoin,
      triggerPx: target,
      limitPx: target,
      isMarket: false,
      tpsl: 'tp',
      szDecimals: sz,
      cloid: cloids.target,
      reduceOnly: true,
    });
  } else {
    delete cloids.target;
  }
  return { legs, cloids };
}

type Status = { resting?: { oid: number }; filled?: { totalSz: string; avgPx: string; oid: number }; error?: string } | string;

function statusesOf(res: unknown): Status[] {
  const r = res as { response?: { data?: { statuses?: Status[] } } } | null;
  const s = r?.response?.data?.statuses;
  return Array.isArray(s) ? s : [];
}

function oidOf(s: Status | undefined): number | undefined {
  if (s === undefined || typeof s === 'string') return undefined;
  return s.resting?.oid ?? s.filled?.oid;
}

// Cancel by the ids this app owns. The venue's "already canceled" is success: the order is gone.
async function cancelCloids(assetId: number, cloids: string[]): Promise<string[]> {
  if (cloids.length === 0) return [];
  const res = await requireExchange().cancelByCloid(cloids.map((cloid) => ({ assetId, cloid })));
  return orderErrors(res).filter((e) => !ALREADY_GONE.test(e));
}

async function placeExits(h: Held, sizeCoin: number): Promise<{ oids: { stop?: number; target?: number }; refused: string[] }> {
  const gen = nextGen(h);
  const { legs, cloids } = exitLegs(h, sizeCoin, gen);
  const res = await requireExchange().exits(legs);
  const refused = orderErrors(res);
  if (refused.length > 0) return { oids: {}, refused };
  const statuses = statusesOf(res);
  h.cloids = cloids;
  h.exitSz = sizeCoin;
  return { oids: { stop: oidOf(statuses[0]), target: oidOf(statuses[1]) }, refused: [] };
}

// The exits of a position that exists, placed or resized to match it. Read from the venue rather
// than from what this process believes, because the position is the venue's fact.
async function protect(h: Held): Promise<{ ok: true; oids: { stop?: number; target?: number }; sz: number } | { ok: false; reason: string }> {
  const pos = await readPosition(h.plan.symbol);
  if (pos === null) return { ok: false, reason: `nothing is open on ${h.plan.symbol} to protect` };
  const sz = Math.abs(pos.szi);
  if (h.exitSz === sz) return { ok: true, oids: {}, sz };
  const old = [h.cloids.stop, h.cloids.target].filter((c): c is string => c !== undefined);
  const cancelRefused = await cancelCloids(h.meta.assetId, old);
  if (cancelRefused.length > 0) return { ok: false, reason: `the venue refused to replace the exits: ${cancelRefused.join('; ')}` };
  const placed = await placeExits(h, sz);
  if (placed.refused.length > 0) {
    // The most dangerous failure in this file: the position is open and believes itself
    // protected. Said as loudly as the protocol allows.
    return { ok: false, reason: `the venue refused the exits and ${h.plan.symbol} is OPEN WITHOUT A STOP: ${placed.refused.join('; ')}` };
  }
  return { ok: true, oids: placed.oids, sz };
}

// The position's own entry price stands in for the plan's once there is one: a change on an
// open plan measures from where the venue actually filled it, and a stop entry that has fired
// is not asked to sit past the mark again.
function refusalBeforeSigning(h: Held, mark: number, change?: { stop?: number; target?: number }, entryPx?: number): string | null {
  if (Date.now() >= Date.parse(h.plan.expiresAt ?? '')) return `${h.plan.id} expired at ${h.plan.expiresAt ?? 'an unknown time'}`;
  const plan: Plan = { ...h.plan, ...(change?.stop !== undefined ? { stop: change.stop } : {}), ...(change?.target !== undefined ? { target: change.target } : {}) };
  const out = planRisk(plan, {
    mark,
    szDecimals: h.meta.szDecimals,
    maxLeverage: h.meta.maxLeverage,
    freeCollateralUsd: null,
    takerFeeBps: DEFAULT_TAKER_FEE_BPS,
    sameCoinLeverage: null,
    ...(entryPx !== undefined && Number.isFinite(entryPx) && entryPx > 0 ? { entryPx } : {}),
  });
  return out.ok ? null : out.refusal;
}

// ---------- commands ----------

async function fire(m: Extract<ToChild, { cmd: 'fire' }>): Promise<FromChild> {
  const h = held.get(m.id);
  if (h === undefined) return { ev: 'refused', seq: m.seq, id: m.id, reason: `this runner holds no plan ${m.id}` };
  if (h.fired) return { ev: 'refused', seq: m.seq, id: m.id, reason: `${m.id} has already been placed` };
  const refusal = refusalBeforeSigning(h, m.mark);
  if (refusal !== null) return { ev: 'refused', seq: m.seq, id: m.id, reason: refusal };
  const leverage = await ensureLeverage(h);
  if (leverage !== null) return { ev: 'refused', seq: m.seq, id: m.id, reason: leverage };

  const ex = requireExchange();
  const long = h.plan.side === 'long';
  const sz = h.meta.szDecimals;
  const entry = h.plan.entry;
  const px =
    entry.type === 'market'
      ? roundToValidPrice(aggressiveLimitPrice(m.mark, long, entry.maxSlippageBps), sz, true, long)
      : entry.px;
  const sizeCoin = Number(formatSize(h.plan.sizeUsd / px, sz));
  const gen = nextGen(h);
  const entryCloid = cloidFor({ plan: h.plan.id, leg: 'entry', gen });
  // Counted as fired before the await: a reply that never comes must not let a second fire
  // through, and the cloid makes a retry of the same fire the same order to the venue.
  h.fired = true;
  h.cloids = { ...h.cloids, entry: entryCloid };

  if (entry.type === 'market') {
    // One bracket: the entry IOC at its bound, the stop with its limit ten percent past the
    // trigger, the target as a limit. The exits are born with the entry.
    const order: OrderRequest = { assetId: h.meta.assetId, isBuy: long, price: px, size: sizeCoin, reduceOnly: false, tif: 'Ioc', szDecimals: sz, cloid: entryCloid };
    const { legs, cloids } = exitLegs(h, sizeCoin, gen);
    const res = await ex.bracket(order, legs);
    const refused = orderErrors(res);
    const statuses = statusesOf(res);
    const first = statuses[0];
    const filledSz = first !== undefined && typeof first !== 'string' && first.filled !== undefined ? Number(first.filled.totalSz) : 0;
    const avgPx = first !== undefined && typeof first !== 'string' && first.filled !== undefined ? Number(first.filled.avgPx) : null;
    if (refused.length > 0 && filledSz <= 0) {
      h.fired = false;
      return { ev: 'refused', seq: m.seq, id: m.id, reason: `the venue refused the bracket: ${refused.join('; ')}` };
    }
    h.cloids = cloids;
    let oids: { entry?: number; stop?: number; target?: number } = { entry: oidOf(first), stop: oidOf(statuses[1]), target: oidOf(statuses[2]) };
    if (filledSz + 1e-12 < sizeCoin) {
      // A partial IOC: the venue drops the bracket's children, so the fill is protected by
      // exits of its own, sized to what actually filled, before this process answers.
      const placed = await placeExits(h, filledSz);
      if (placed.refused.length > 0) {
        return { ev: 'error', seq: m.seq, id: m.id, message: `the entry part-filled ${filledSz} and the venue refused its exits, so ${h.plan.symbol} is OPEN WITHOUT A STOP: ${placed.refused.join('; ')}` };
      }
      oids = { entry: oids.entry, ...placed.oids };
    } else {
      h.exitSz = sizeCoin;
    }
    return { ev: 'placed', seq: m.seq, id: m.id, oids, filledSz, avgPx, cloids: h.cloids, gen: h.gen, venueMs: venueMs() };
  }

  // A limit or a stop entry rests alone. The venue holds it; the exits are placed on protect,
  // sized to the position, once anything fills.
  let res: unknown;
  if (entry.type === 'limit') {
    res = await ex.order([{ assetId: h.meta.assetId, isBuy: long, price: px, size: sizeCoin, reduceOnly: false, tif: 'Gtc', szDecimals: sz, cloid: entryCloid }]);
  } else {
    const bound = roundToValidPrice(aggressiveLimitPrice(px, long, entry.maxSlippageBps), sz, true, long);
    res = await ex.trigger(
      [{ assetId: h.meta.assetId, isBuy: long, size: sizeCoin, triggerPx: px, limitPx: bound, isMarket: true, tpsl: 'sl', szDecimals: sz, cloid: entryCloid, reduceOnly: false }],
      'na',
    );
  }
  const refused = orderErrors(res);
  if (refused.length > 0) {
    h.fired = false;
    return { ev: 'refused', seq: m.seq, id: m.id, reason: `the venue refused the entry: ${refused.join('; ')}` };
  }
  const first = statusesOf(res)[0];
  const filledSz = first !== undefined && typeof first !== 'string' && first.filled !== undefined ? Number(first.filled.totalSz) : 0;
  const avgPx = first !== undefined && typeof first !== 'string' && first.filled !== undefined ? Number(first.filled.avgPx) : null;
  let oids: { entry?: number; stop?: number; target?: number } = { entry: oidOf(first) };
  if (filledSz > 0) {
    // A limit that crossed the book filled at once. Protect it now rather than waiting for the
    // host to notice the position.
    const placed = await placeExits(h, filledSz);
    if (placed.refused.length > 0) {
      return { ev: 'error', seq: m.seq, id: m.id, message: `the entry filled ${filledSz} and the venue refused its exits, so ${h.plan.symbol} is OPEN WITHOUT A STOP: ${placed.refused.join('; ')}` };
    }
    oids = { ...oids, ...placed.oids };
  }
  return { ev: 'placed', seq: m.seq, id: m.id, oids, filledSz, avgPx, cloids: h.cloids, gen: h.gen, venueMs: venueMs() };
}

async function modify(m: Extract<ToChild, { cmd: 'modify' }>): Promise<FromChild> {
  const h = held.get(m.id);
  if (h === undefined) return { ev: 'refused', seq: m.seq, id: m.id, reason: `this runner holds no plan ${m.id}` };
  const pos = await readPosition(h.plan.symbol);
  const refusal = refusalBeforeSigning(h, m.mark, { stop: m.stop, target: m.target }, pos !== null && h.fired ? pos.entryPx : undefined);
  if (refusal !== null) return { ev: 'refused', seq: m.seq, id: m.id, reason: refusal };
  if (m.stop !== undefined) h.plan = { ...h.plan, stop: m.stop };
  if (m.target !== undefined) h.plan = { ...h.plan, target: m.target };
  if (pos !== null && h.exitSz > 0) {
    // Exits rest on the venue: cancel by the ids this app owns and place the next generation.
    const old = [h.cloids.stop, h.cloids.target].filter((c): c is string => c !== undefined);
    const cancelRefused = await cancelCloids(h.meta.assetId, old);
    if (cancelRefused.length > 0) return { ev: 'error', seq: m.seq, id: m.id, message: `the venue refused to replace the exits: ${cancelRefused.join('; ')}` };
    h.exitSz = 0;
    const placed = await placeExits(h, Math.abs(pos.szi));
    if (placed.refused.length > 0) {
      return { ev: 'error', seq: m.seq, id: m.id, message: `the old exits are gone and the venue refused the new ones, so ${h.plan.symbol} is OPEN WITHOUT A STOP: ${placed.refused.join('; ')}` };
    }
  }
  return { ev: 'modified', seq: m.seq, id: m.id, stop: h.plan.stop, target: h.plan.target ?? null, cloids: h.cloids, gen: h.gen, venueMs: venueMs() };
}

async function cancel(m: Extract<ToChild, { cmd: 'cancel' }>): Promise<FromChild> {
  const h = held.get(m.id);
  if (h === undefined) return { ev: 'refused', seq: m.seq, id: m.id, reason: `this runner holds no plan ${m.id}` };
  if (h.exitSz > 0) {
    return { ev: 'refused', seq: m.seq, id: m.id, reason: `${m.id} is open: its exits are its protection. Close it, or change the stop` };
  }
  if (h.cloids.entry !== undefined) {
    const refused = await cancelCloids(h.meta.assetId, [h.cloids.entry]);
    if (refused.length > 0) return { ev: 'error', seq: m.seq, id: m.id, message: `the venue refused the cancel: ${refused.join('; ')}. The entry is still working` };
  }
  // Anything that filled before the cancel landed is a position, and a position gets its exits
  // before this process answers: a cancelled plan is never a naked one.
  const pos = await readPosition(h.plan.symbol);
  if (pos !== null && h.fired) {
    const out = await protect(h);
    if (!out.ok) return { ev: 'error', seq: m.seq, id: m.id, message: out.reason };
    return { ev: 'cancelled', seq: m.seq, id: m.id, filledSz: Math.abs(pos.szi), cloids: h.cloids, gen: h.gen, venueMs: venueMs() };
  }
  held.delete(m.id);
  return { ev: 'cancelled', seq: m.seq, id: m.id, filledSz: 0, cloids: h.cloids, gen: h.gen, venueMs: venueMs() };
}

async function closeCoin(coin: string, meta: AssetMeta, mark: number, maxSlippageBps: number): Promise<{ closed: boolean; detail: string; stillOpenSz: number }> {
  const pos = await readPosition(coin);
  if (pos === null) return { closed: true, detail: `${coin}: already flat`, stillOpenSz: 0 };
  const isBuy = pos.szi < 0;
  const px = roundToValidPrice(aggressiveLimitPrice(mark, isBuy, maxSlippageBps), meta.szDecimals, true, isBuy);
  const res = await requireExchange().order([
    { assetId: meta.assetId, isBuy, price: px, size: Math.abs(pos.szi), reduceOnly: true, tif: 'Ioc', szDecimals: meta.szDecimals },
  ]);
  const refused = orderErrors(res);
  if (refused.length > 0) return { closed: false, detail: `${coin}: the venue refused the close: ${refused.join('; ')}`, stillOpenSz: Math.abs(pos.szi) };
  const after = await readPosition(coin);
  const stillOpenSz = after === null ? 0 : Math.abs(after.szi);
  return { closed: stillOpenSz === 0, detail: stillOpenSz === 0 ? `${coin}: closed at ${px}` : `${coin}: ${stillOpenSz} still open after the close at ${px}`, stillOpenSz };
}

async function close(m: Extract<ToChild, { cmd: 'close' }>): Promise<FromChild> {
  const h = held.get(m.id);
  if (h === undefined) return { ev: 'refused', seq: m.seq, id: m.id, reason: `this runner holds no plan ${m.id}` };
  const out = await closeCoin(h.plan.symbol, h.meta, m.mark, m.maxSlippageBps);
  if (!out.closed) return { ev: 'error', seq: m.seq, id: m.id, message: out.detail };
  // Flat. The venue usually cancels the exits itself; asking again is free and "already
  // canceled" is success.
  const exits = [h.cloids.stop, h.cloids.target].filter((c): c is string => c !== undefined);
  const refused = await cancelCloids(h.meta.assetId, exits);
  if (refused.length > 0) return { ev: 'error', seq: m.seq, id: m.id, message: `closed, and the venue refused to cancel the exits: ${refused.join('; ')}` };
  held.delete(m.id);
  return { ev: 'closed', seq: m.seq, id: m.id, stillOpenSz: 0, venueMs: venueMs() };
}

async function flatten(m: Extract<ToChild, { cmd: 'flatten' }>): Promise<FromChild> {
  const stillOpen: string[] = [];
  const details: string[] = [];
  for (const c of m.coins) {
    try {
      const out = await closeCoin(c.coin, c.meta, c.mark, 100);
      details.push(out.detail);
      if (!out.closed) stillOpen.push(c.coin);
    } catch (err) {
      stillOpen.push(c.coin);
      details.push(`${c.coin}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const byAsset = new Map<number, string[]>();
  for (const c of m.cancels) byAsset.set(c.assetId, [...(byAsset.get(c.assetId) ?? []), c.cloid]);
  for (const [assetId, cloids] of byAsset) {
    try {
      const refused = await cancelCloids(assetId, cloids);
      if (refused.length > 0) details.push(`cancel on asset ${assetId}: ${refused.join('; ')}`);
    } catch (err) {
      details.push(`cancel on asset ${assetId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  held.clear();
  return { ev: 'flat', seq: m.seq, stillOpen, detail: details.join('; ') };
}

async function release(m: Extract<ToChild, { cmd: 'release' }>): Promise<FromChild> {
  const h = held.get(m.id);
  if (h === undefined) return { ev: 'released', seq: m.seq, id: m.id };
  const exits = [h.cloids.stop, h.cloids.target].filter((c): c is string => c !== undefined);
  const refused = await cancelCloids(h.meta.assetId, exits);
  held.delete(m.id);
  if (refused.length > 0) return { ev: 'error', seq: m.seq, id: m.id, message: `the venue refused to cancel the leftover exits: ${refused.join('; ')}` };
  return { ev: 'released', seq: m.seq, id: m.id };
}

async function handle(m: ToChild): Promise<FromChild | null> {
  switch (m.cmd) {
    case 'arm':
      held.set(m.plan.id, { plan: m.plan, meta: m.meta, cloids: { ...m.cloids }, gen: m.gen, fired: m.cloids.entry !== undefined, exitSz: 0 });
      return { ev: 'armed', seq: m.seq, id: m.plan.id };
    case 'fire':
      return fire(m);
    case 'protect': {
      const h = held.get(m.id);
      if (h === undefined) return { ev: 'refused', seq: m.seq, id: m.id, reason: `this runner holds no plan ${m.id}` };
      const out = await protect(h);
      if (!out.ok) return { ev: 'error', seq: m.seq, id: m.id, message: out.reason };
      return { ev: 'protected', seq: m.seq, id: m.id, oids: out.oids, sz: out.sz, cloids: h.cloids, gen: h.gen, venueMs: venueMs() };
    }
    case 'modify':
      return modify(m);
    case 'cancel':
      return cancel(m);
    case 'close':
      return close(m);
    case 'flatten':
      return flatten(m);
    case 'release':
      return release(m);
    case 'disarm':
      held.delete(m.id);
      return null;
    case 'kill':
      process.exit(0);
  }
}

// One command at a time. Two fires for two plans on one coin would otherwise race the leverage
// read, and a protect landing during a modify would size exits the modify then cancels.
let queue: Promise<void> = Promise.resolve();

process.on('message', (raw: unknown) => {
  const m = raw as ToChild;
  queue = queue.then(async () => {
    venueClock = 0;
    try {
      const out = await handle(m);
      if (out !== null) send(out);
    } catch (err) {
      send({
        ev: 'error',
        seq: m.seq,
        id: 'id' in m ? m.id : null,
        message: `runner command ${String(m.cmd)} failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
});

send({ ev: 'ready', seq: 0 });
