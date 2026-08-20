// Prove the new exchange verbs against the real venue, on TESTNET, with real orders.
//
// Unit tests pin the wire shape. They cannot tell you the venue accepts it: on Hyperliquid a
// malformed action is rejected without a reason, so the only real check is a round trip. This
// does that for the four verbs added on 2026-08-20 (bracket, modify, batchModify,
// scheduleCancel) plus the resting limit they all build on.
//
// TESTNET ONLY, and it refuses otherwise. Every order it places is a resting limit priced far
// from mid so it cannot fill, and it cancels everything it placed before it exits, including
// on the failure paths.
//
// Run: PHOSPHOR_TRADING_NETWORK=testnet node scripts/hl-verbs-smoke.ts

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { createExchange, isScheduleCancelLocked } from '../src/hl/exchange.ts';
import { readApiWallet } from '../src/runner/keys.ts';
import type { OrderRequest } from '../src/hl/exchange.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cfg = loadConfig(root);

if (cfg.tradingNetwork !== 'testnet') {
  console.error(`refused: this places real orders and runs on testnet only (tradingNetwork is ${cfg.tradingNetwork}).`);
  console.error('run it as: PHOSPHOR_TRADING_NETWORK=testnet node scripts/hl-verbs-smoke.ts');
  process.exit(1);
}

// Both derived from the one setting, never stated twice. The refusal above already pins this
// script to testnet, so today these are always the testnet pair; deriving them anyway means a
// future edit that relaxes the guard cannot leave a testnet source byte signing against a
// mainnet key, which is the kind of mismatch the venue answers with a bare rejection.
const IS_MAINNET = cfg.tradingNetwork === 'mainnet';
const BASE = IS_MAINNET ? 'https://api.hyperliquid.xyz' : 'https://api.hyperliquid-testnet.xyz';
// The agent wallet for THIS network. Reading the flat legacy field here is what made this
// script sign testnet orders with a mainnet wallet after the mainnet approval on 2026-08-20.
const wallet = readApiWallet(cfg.keysPath, cfg.tradingNetwork);
if (wallet.key === null) {
  console.error(`no approved API wallet for ${cfg.tradingNetwork}. Run: PHOSPHOR_TRADING_NETWORK=${cfg.tradingNetwork} node scripts/hl-agent.ts`);
  process.exit(1);
}
if (wallet.source === 'legacy') {
  console.error(`WARNING: using the pre-2026-08-20 flat agent key, which is not stamped with a network.`);
  console.error(`If orders come back rejected, it was approved on the other one. Re-approve to be sure.`);
}
const agent = { privateKey: wallet.key, address: wallet.address ?? '(unknown)' };

const user = cfg.addresses.evm[0] ?? '';
const SYMBOL = process.argv.includes('--symbol') ? String(process.argv[process.argv.indexOf('--symbol') + 1]) : 'SOL';

async function info<T>(body: unknown): Promise<T> {
  const res = await fetch(`${BASE}/info`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

const meta = await info<{ universe: { name: string; szDecimals: number; maxLeverage: number }[] }>({ type: 'meta' });
const assetId = meta.universe.findIndex((u) => u.name === SYMBOL);
if (assetId < 0) {
  console.error(`${SYMBOL} is not on testnet`);
  process.exit(1);
}
const szDecimals = meta.universe[assetId].szDecimals;

const mids = await info<Record<string, string>>({ type: 'allMids' });
const mid = Number(mids[SYMBOL]);
const state = await info<{ marginSummary?: { accountValue?: string }; withdrawable?: string }>({
  type: 'clearinghouseState',
  user,
});

console.log(`network   testnet`);
console.log(`account   ${user}`);
console.log(`agent     ${agent.address}`);
console.log(`market    ${SYMBOL} (asset ${assetId}, szDecimals ${szDecimals}), mid ${mid}`);
console.log(`margin    accountValue ${state.marginSummary?.accountValue ?? '?'}, withdrawable ${state.withdrawable ?? '?'}\n`);

const ex = createExchange({ privKey: agent.privateKey as `0x${string}`, isMainnet: IS_MAINNET, baseUrl: BASE });

// Far enough below mid that it rests rather than fills, and a size small enough that the
// margin on this account covers it.
const restPrice = Math.round(mid * 0.7 * 100) / 100;
const size = Number((12 / restPrice).toFixed(szDecimals));

function base(over: Partial<OrderRequest> = {}): OrderRequest {
  return { assetId, isBuy: true, price: restPrice, size, reduceOnly: false, tif: 'Gtc', szDecimals, ...over };
}

type Resp = { status?: string; response?: { data?: { statuses?: unknown[] } } };
const placed: number[] = [];

function report(label: string, r: unknown): boolean {
  const res = r as Resp;
  const statuses = res.response?.data?.statuses;
  const ok = res.status === 'ok' && !JSON.stringify(statuses ?? {}).includes('"error"');
  console.log(`${ok ? 'OK     ' : 'FAILED '} ${label.padEnd(26)} ${JSON.stringify(statuses ?? res).slice(0, 190)}`);
  for (const s of statuses ?? []) {
    const oid = (s as { resting?: { oid?: number }; filled?: { oid?: number } })?.resting?.oid;
    if (typeof oid === 'number') placed.push(oid);
  }
  return ok;
}

async function cancelAllPlaced(): Promise<void> {
  if (placed.length === 0) return;
  const r = await ex.cancel(placed.map((oid) => ({ assetId, oid })));
  console.log(`cleanup  cancelled ${placed.length}: ${JSON.stringify((r as Resp).response?.data?.statuses ?? r).slice(0, 120)}`);
  placed.length = 0;
}

try {
  // 1. A plain resting limit. Everything else builds on this shape.
  report('resting limit (Gtc)', await ex.order([base()]));
  const first = placed[0];

  // 2. modify: re-peg it without leaving the book.
  //
  // A successful modify answers {"status":"ok","response":{"type":"default"}} and does NOT
  // return the new oid, while the order it replaced is gone. So the id has to be re-read, and
  // a caller that keeps using the old one gets "Cannot modify canceled or filled order" on its
  // next call. Found exactly that way on 2026-08-20; the runner has the same obligation.
  if (first !== undefined) {
    const moved = Math.round(restPrice * 0.99 * 100) / 100;
    report('modify (re-peg)', await ex.modify(first, base({ price: moved })));
    placed.length = 0;
    const live = await info<{ coin: string; oid: number }[]>({ type: 'openOrders', user });
    for (const o of live) if (o.coin === SYMBOL) placed.push(o.oid);
    console.log(`         re-read oids after modify: ${placed.join(', ') || 'none'}`);
  }

  // 3. batchModify: the ladder case, one round trip.
  if (placed.length > 0) {
    const moved = Math.round(restPrice * 0.98 * 100) / 100;
    report(
      'batchModify',
      await ex.batchModify(placed.slice(0, 1).map((oid) => ({ oid, order: base({ price: moved }) }))),
    );
    placed.length = 0;
    const live = await info<{ coin: string; oid: number }[]>({ type: 'openOrders', user });
    for (const o of live) if (o.coin === SYMBOL) placed.push(o.oid);
  }

  // 4. bracket: entry plus a stop, one signature, grouping normalTpsl.
  report(
    'bracket (entry + stop)',
    await ex.bracket(base({ price: Math.round(mid * 0.72 * 100) / 100 }), [
      {
        assetId,
        isBuy: false,
        size,
        triggerPx: Math.round(mid * 0.6 * 100) / 100,
        isMarket: true,
        tpsl: 'sl',
        szDecimals,
      },
    ]),
  );

  // 5. scheduleCancel: arm the dead-man switch, then stand it down. The venue requires at
  //    least 5 seconds of lead, and only allows 10 triggers a day, so this arms and clears
  //    rather than letting one fire.
  const armed = await ex.scheduleCancel(Date.now() + 60_000);
  if (isScheduleCancelLocked((armed as { response?: unknown }).response)) {
    // Not a failure of ours. The venue gates this behind $1m of traded volume, which this
    // account has nowhere near, so the net is simply unavailable and the supervisor in
    // src/runner/main.ts is what is actually watching.
    console.log(`LOCKED  scheduleCancel               ${String((armed as { response?: unknown }).response).slice(0, 150)}`);
  } else {
    report('scheduleCancel (arm +60s)', armed);
    report('scheduleCancel (stand down)', await ex.scheduleCancel(null));
  }
} finally {
  await cancelAllPlaced();
  const open = await info<unknown[]>({ type: 'openOrders', user });
  console.log(`\nopen orders left on ${SYMBOL}: ${(open as { coin?: string }[]).filter((o) => o.coin === SYMBOL).length}`);
}
