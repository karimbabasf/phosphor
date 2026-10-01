// The coins a card was priced with are the coins that move.
//
// Every intents rail names its coins by 1Click's asset id and counts them in that coin's decimals,
// and both come off 1Click's token list, which nothing signs. The rails read the list again at
// execute, so a list that changed after the click (a TLS position on the venue, or the venue's own
// list) bought a different coin than the card showed (audit 2026-10-01, aud-money-rails: "100 USDC
// to USDT" signed for nep141:junk-listed-token.near). The card's coins now ride on its simulation,
// the proposal pins them into the draft it lands, and execute refuses a list that says otherwise.
// The send, payout, deposit and relay rails carry the same tests in their own suites.
//
// Run: node --test tests/unit/asset-pins.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

import { resolveAsset } from '../../src/intents.ts';
import type { OneClickToken, TokensFile } from '../../src/intents.ts';
import { INTENTS_NATIVE_COUNTERPARTY, intentsApi, intentsNativeRail } from '../../src/rails/intents-native.ts';
import { floorUnderQuote } from '../../src/rails/slippage.ts';
import type { HlDepositDraft, MovedAssets, Rail, SwapDraft, WriteDraft } from '../../src/types.ts';
import { TEST_QUOTE_KEY, signQuote } from './helpers/signed-quote.ts';
import { ETH_USDC_FLAVOR, makeCtx } from './helpers/proposals.ts';

const OWNER = privateKeyToAccount(('0x' + '11'.repeat(32)) as Hex).address;
const ORIGIN = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const DEST = 'nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near';
const JUNK = 'nep141:junk-listed-token.near';
const HANDLE = 'q-abc.1click.near';
const NOW = Date.parse('2026-10-01T12:00:00Z');

const tokens: TokensFile = {
  eth: {}, sol: {}, near: {},
  base: { USDC: { tokenId: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 } },
  arb: { USDT: { tokenId: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', decimals: 6 } },
} as TokensFile;
const honest: OneClickToken[] = [
  { assetId: ORIGIN, decimals: 6, blockchain: 'base', symbol: 'USDC', contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  { assetId: DEST, decimals: 6, blockchain: 'arb', symbol: 'USDT', contractAddress: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9' },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// No registry rows: both coins come off the list alone, the way every coin past the pinned few does.
const NO_REGISTRY = { eth: {}, base: {}, arb: {}, sol: {}, near: {} } as TokensFile;

// An honest 1Click over a list the test can change: it prices whatever coin and amount it is
// asked for, and generates the transfer the live quote named.
function world(listNow: () => OneClickToken[], registry: TokensFile = tokens) {
  const asked: Array<Record<string, any>> = [];
  const signed: string[] = [];
  let live: Record<string, any> = {};
  const fetchImpl: typeof fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/v0/quote')) {
      const req = JSON.parse(String(init?.body)) as Record<string, any>;
      asked.push(req);
      const amountIn = BigInt(req['amount']);
      const out = (amountIn * 9_999n) / 10_000n;
      const quote: Record<string, unknown> = {
        amountIn: req['amount'], amountInFormatted: '100.0', amountInUsd: '100', minAmountIn: req['amount'],
        amountOut: out.toString(), amountOutFormatted: String(Number(out) / 1e6), amountOutUsd: '99.99',
        minAmountOut: ((out * 9_950n) / 10_000n).toString(), timeEstimate: 12,
      };
      if (req['dry'] === false) {
        live = req;
        Object.assign(quote, { depositAddress: HANDLE, deadline: req['deadline'], timeWhenInactive: req['deadline'] });
      }
      return json(signQuote({ quoteRequest: req, quote }));
    }
    if (u.endsWith('/v0/generate-intent')) {
      const payload = JSON.stringify({
        signer_id: OWNER.toLowerCase(), verifying_contract: 'intents.near', deadline: new Date(NOW + 72 * 3600_000).toISOString(),
        nonce: 'bm9uY2Utbm9uY2Utbm9uY2Utbm9uY2Utbm9uY2U=',
        intents: [{ intent: 'transfer', receiver_id: HANDLE, tokens: { [live['originAsset']]: live['amount'] } }],
      });
      return json({ intent: { standard: 'erc191', payload } }, 201);
    }
    if (u.endsWith('/v0/submit-intent')) return json({ intentHash: '44XpLRAuZKoVGs9T4qbSNv33MDKMePPAibA52geVLWFw' });
    if (u.includes('/v0/status')) return json({ status: 'SUCCESS', swapDetails: {} });
    throw new Error('unexpected ' + u);
  };
  const real = intentsApi({ apiKey: '', fetchImpl });
  const reads = [0n, 99_990_000n];
  const rail = intentsNativeRail({
    keysPath: '/nonexistent', quoteKey: TEST_QUOTE_KEY, tokens: registry,
    api: { ...real, tokens: async () => listNow() },
    signer: { address: () => OWNER, signErc191: async (_k: string, p: string) => { signed.push(p); return 'secp256k1:sig'; } } as any,
    // A million USDC held, so a balance that covers the approved amount covers a hundred times it.
    verifierBalance: async (_a, asset) => (asset === ORIGIN ? 1_000_000_000_000n : (reads.shift() ?? 99_990_000n)),
    nonceUsed: async () => true,
    now: () => NOW, sleepImpl: async () => {}, pollIntervalMs: 1, pollTimeoutMs: 50,
    settleSchedule: { firstMs: 1, maxMs: 2, timeoutMs: 6 },
  });
  return { rail, asked, signed };
}

function unpinned(minAmountOut = 0): SwapDraft {
  return {
    kind: 'swap', venue: 'intents-native', chain: 'base', toChain: 'arb', fromSymbol: 'USDC', toSymbol: 'USDT',
    amountIn: 100, amountInExact: '100', amountUsd: 100, minAmountOut, from: OWNER, to: OWNER, counterparty: INTENTS_NATIVE_COUNTERPARTY, quote: null,
  };
}

// The propose: the floor off the quote, then the card; the proposal pins what the card priced.
async function approved(w: ReturnType<typeof world>): Promise<SwapDraft> {
  const draft = unpinned();
  draft.minAmountOut = floorUnderQuote((await w.rail.quote!(draft))!);
  const card = await w.rail.simulate(draft);
  assert.equal(card.ok, true, String(card.error));
  assert.deepEqual(card.assets, { origin: { assetId: ORIGIN, decimals: 6 }, destination: { assetId: DEST, decimals: 6 } });
  return { ...draft, assets: card.assets };
}

test('the audit repro: a list that names another coin for USDT after the click refuses the swap, and nothing is signed', async () => {
  let forged = false;
  const w = world(() => (forged ? honest.map((t) => (t.assetId === DEST ? { ...t, assetId: JUNK } : t)) : honest));
  const draft = await approved(w);
  assert.equal(w.asked.at(-1)?.['destinationAsset'], DEST, 'the card asked for the real USDT');

  forged = true;
  const before = w.asked.length;
  await assert.rejects(
    () => w.rail.execute(draft, 'p1'),
    /1Click's coin list now gives USDT on arb as nep141:junk-listed-token\.near, not the nep141:arb-0xfd08[0-9a-f]+\.omft\.near this move was priced and approved with, so nothing was signed/,
  );
  assert.equal(w.asked.length, before, 'no quote is asked for the other coin');
  assert.equal(w.signed.length, 0);
});

test('a list that counts the spent coin in other decimals after the click refuses the swap, and nothing is signed', async () => {
  // 6 on the card; 8 at the click would sign 10,000 USDC for the 100 the card showed, and the
  // balance covers it. A registry row's own decimals refuse that first; the pin is what holds the
  // coins with none, which is every coin past the pinned few.
  let changed = false;
  const w = world(() => (changed ? honest.map((t) => (t.assetId === ORIGIN ? { ...t, decimals: 8 } : t)) : honest), NO_REGISTRY);
  const draft = await approved(w);
  changed = true;
  await assert.rejects(() => w.rail.execute(draft, 'p1'), /counts USDC on base in 8 decimals, not the 6 this move was priced and approved with, so nothing was signed/);
  assert.equal(w.asked.filter((q) => q['dry'] === false).length, 0, 'no live quote is asked for');
  assert.equal(w.signed.length, 0);
});

test('the same list at the click runs the swap the card priced', async () => {
  const w = world(() => honest);
  const draft = await approved(w);
  const res = await w.rail.execute(draft, 'p1');
  assert.equal(res.ok, true, res.detail);
  assert.equal(w.signed.length, 1);
  assert.equal(w.asked.at(-1)?.['destinationAsset'], DEST);
});

test('a swap approved before its coins were pinned is not run, and the card still prices one', async () => {
  const w = world(() => honest);
  const draft = unpinned(99);
  await assert.rejects(() => w.rail.execute(draft, 'p1'), /approved before Phosphor pinned the coins it moves, so it was not run and nothing was signed/);
  assert.equal(w.asked.length, 0);
  assert.equal((await w.rail.simulate(draft)).ok, true, 'a draft with nothing pinned yet is a propose, and is priced');
});

// ---------- the proposal pins what its card priced ----------

test('a proposal lands its draft with the coins the simulation priced, and execute is handed them', async () => {
  const assets: MovedAssets = {
    origin: { assetId: ETH_USDC_FLAVOR, decimals: 6 },
    destination: { assetId: '1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054', decimals: 8 },
  };
  const ran: WriteDraft[] = [];
  const rail: Rail = {
    kind: 'hl_deposit',
    valueUsd: () => 0,
    simulate: async () => ({ ok: true, summary: 'priced', assets }),
    execute: async (draft) => {
      ran.push(draft);
      return { ok: true, detail: 'credited', txids: ['h1'] };
    },
  };
  const h = makeCtx({ rails: [rail], intentsUsdc: 500 });
  const made = await h.svc.proposeHlDeposit({ amount: 20 });
  const row = await h.svc.settled(made.id, 5000);
  assert.deepEqual((h.store.get(row.id)?.draft as HlDepositDraft).assets, assets);
  assert.equal(ran.length, 1, JSON.stringify(row.verdict));
  assert.deepEqual((ran[0] as HlDepositDraft).assets, assets);
});

// ---------- the registry's own ids ----------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tokens.json'), 'utf8')) as TokensFile & { _comment?: string };

test('a list that files a registry coin under another id is refused when the coin is proposed, not only after the click', () => {
  const pinnedRegistry = { ...tokens, arb: { USDT: { ...tokens.arb.USDT!, assetId: DEST } } } as TokensFile;
  const forged = honest.map((t) => (t.assetId === DEST ? { ...t, assetId: JUNK } : t));
  assert.throws(() => resolveAsset('arb', 'USDT', pinnedRegistry, forged), /files USDT on arb as nep141:junk-listed-token\.near, not the nep141:arb-0xfd08/);
  const pick = resolveAsset('arb', 'USDT', pinnedRegistry, honest);
  assert.equal(pick.kind === 'one' ? pick.assetId : null, DEST);
});

test('every id data/tokens.json pins is the id 1Click files that contract under', () => {
  let pinned = 0;
  for (const [chain, rows] of Object.entries(shipped)) {
    if (chain === '_comment') continue;
    for (const [symbol, row] of Object.entries(rows as Record<string, { tokenId: string; assetId?: string }>)) {
      if (row.assetId === undefined) continue;
      pinned += 1;
      const id = row.tokenId.toLowerCase();
      // The id shapes 1Click lists (read off its list on 2026-10-01): a bridged EVM contract,
      // a NEAR contract itself, and a Solana mint under a 20 byte hash 1Click derives.
      const expected = chain === 'near' ? `nep141:${row.tokenId}` : chain === 'sol' ? /^nep141:sol-[0-9a-f]{40}\.omft\.near$/ : `nep141:${chain}-${id}.omft.near`;
      if (typeof expected === 'string') assert.equal(row.assetId, expected, `${symbol} on ${chain}`);
      else assert.match(row.assetId, expected, `${symbol} on ${chain}`);
    }
  }
  assert.equal(pinned, 11);
});
