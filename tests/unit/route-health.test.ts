// Route health: whether NEAR Intents is taking money on a network right now.
//
// On 2026-09-26 near.com showed "TON: Service disruption reported" while the POA bridge still
// answered a TON deposit address, and 1Click's dry quote of TON into intents answered 400
// "Quoting for this pair is not available". These tests hold the probe to that reading, the
// status page mapping to the page's own shapes, and the checker to one request per key and a
// short memory. fetch is injected everywhere; nothing here reaches the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FEED_TTL_MS,
  OPEN_TTL_MS,
  PROBE_USD,
  SHAKY_TTL_MS,
  STATUS_LINK,
  bridgeReason,
  classifyProbe,
  cleanTitle,
  combine,
  createRouteHealth,
  namedNetworks,
  parsePosts,
  parseServices,
  probeAmount,
  probeAsset,
  quoteSaysClosed,
  routeSentence,
  statusReasons,
  withReason,
} from '../../src/preflight/route-health.ts';
import type { RouteHealthDeps, RouteVerdict } from '../../src/preflight/route-health.ts';
import { RECEIVE_NETWORKS, receiveNetworkOf } from '../../src/rails/intents-address.ts';
import type { OneClickToken } from '../../src/intents.ts';

const NOW = Date.parse('2026-09-26T18:00:00.000Z');
const ACCOUNT = '0x1111111111111111111111111111111111111111';

// The rows the live list carried on 2026-09-26 for the chains these tests ask about.
const TOKENS: OneClickToken[] = [
  { assetId: 'nep245:v2_1.omni.hot.tg:1117_', blockchain: 'ton', symbol: 'GRAM', decimals: 9, price: 1.55 },
  { assetId: 'nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR', blockchain: 'ton', symbol: 'USDT', decimals: 6, contractAddress: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', price: 1 },
  { assetId: 'nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz', blockchain: 'stellar', symbol: 'XLM', decimals: 7, price: 0.214091 },
  { assetId: 'nep141:eth.omft.near', blockchain: 'eth', symbol: 'ETH', decimals: 18, price: 2694.83 },
  { assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', blockchain: 'eth', symbol: 'USDC', decimals: 6, contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', price: 1 },
  { assetId: 'nep141:sol.omft.near', blockchain: 'sol', symbol: 'SOL', decimals: 9, price: 120.46 },
  { assetId: 'nep141:zec.omft.near', blockchain: 'zec', symbol: 'ZEC', decimals: 8, price: 1634.53 },
  { assetId: 'nep245:v2_1.omni.hot.tg:9745_11111111111111111111', blockchain: 'plasma', symbol: 'XPL_(DEPRECATED)', decimals: 18, price: 0.1 },
  { assetId: 'nep141:plasma.omft.near', blockchain: 'plasma', symbol: 'XPL', decimals: 18, price: 0.1 },
  { assetId: '1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054', blockchain: 'hypercore', symbol: 'USDC', decimals: 8, contractAddress: '0x6d1e7cde53ba9467b783cb7c530ce054', price: 1 },
  { assetId: 'nep141:wrap.near', blockchain: 'near', symbol: 'wNEAR', decimals: 24, contractAddress: 'wrap.near', price: 5.03 },
];

type Call = { url: string; body: Record<string, unknown> | null };
type Reply = { status: number; body: unknown } | 'hang' | 'throw';

const NOT_AVAILABLE = { status: 400, body: { message: 'Quoting for this pair is not available' } };
const MEMO_WANTED = { status: 400, body: { message: 'Incorrect depositMode for originAsset from stellar chain' } };
const QUOTED = { status: 201, body: { quote: { amountIn: '1' } } };
const NO_POSTS = { status: 200, body: { posts: [], continuationToken: null } };

// A fetch that answers by URL and remembers every call. `quote` picks the reply per request body.
function fakeFetch(opts: { quote?: (body: Record<string, unknown>) => Reply; posts?: () => Reply; services?: () => Reply } = {}): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ url, body });
    let reply: Reply;
    if (url.endsWith('/v0/quote')) reply = opts.quote?.(body ?? {}) ?? QUOTED;
    else if (url.includes('/api/posts')) reply = opts.posts?.() ?? NO_POSTS;
    else if (url.endsWith('/api/services')) reply = opts.services?.() ?? { status: 200, body: SERVICES };
    else throw new Error(`unexpected url ${url}`);
    if (reply === 'throw') throw new Error('socket hang up');
    if (reply === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })));
      });
    }
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

// The page's service list as it answered on 2026-09-26.
const SERVICES = {
  services: [
    { name: 'Cross-Chain Bridging', id: 'PXQFSY1' },
    { name: '1Click Swap', id: 'PTEURIB' },
    { name: 'Message Bus', id: 'P2WM8Q9' },
    { name: 'Solvers Network', id: 'PLT88AT' },
    { name: 'Passive Deposit/Withdrawal Service', id: 'PYFS8RW' },
    { name: 'Explorer', id: 'PFFZY12' },
    { name: 'near.com', id: 'P19MLRF' },
    { name: 'Solana Blockchain', id: 'PYZGDVH' },
    { name: 'Bitcoin Blockchain', id: 'PV0VCGU' },
    { name: 'Ethereum Blockcain', id: 'PRR7C44' },
    { name: 'Other Blockchains', id: 'PNEJBRE' },
  ],
};

function post(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'P1',
    post_type: 'incident',
    title: 'Something',
    starts_at: '2026-09-26T17:00:00Z',
    ends_at: null,
    is_featured: true,
    latest_update: { status_id: 'PSCS3IV', impacts: [] },
    ...over,
  };
}

function checker(over: Partial<RouteHealthDeps> & { clock?: { t: number } } = {}): ReturnType<typeof createRouteHealth> {
  const clock = over.clock ?? { t: NOW };
  return createRouteHealth({ tokens: async () => TOKENS, now: () => clock.t, log: () => undefined, ...over });
}

// ---------- the probe ----------

test('a 201 is open, "not available" is closed, a deposit mode 400 asks for MEMO, anything else is unknown', () => {
  assert.equal(classifyProbe(201, { quote: {} }).state, 'open');
  assert.deepEqual(classifyProbe(400, NOT_AVAILABLE.body), { state: 'closed', memo: false, said: 'Quoting for this pair is not available' });
  for (const word of ['Token is disabled', 'Deposits paused', 'Route suspended', 'Chain under maintenance']) {
    assert.equal(classifyProbe(400, { message: word }).state, 'closed', word);
  }
  assert.equal(classifyProbe(400, MEMO_WANTED.body).memo, true);
  assert.equal(classifyProbe(400, { message: 'amount is required' }).state, 'unknown');
  // Liquidity is not the route: a same-asset probe should never meet it, and if it does it is not a closure.
  assert.equal(classifyProbe(400, { message: 'No liquidity available' }).state, 'unknown');
  assert.equal(classifyProbe(500, { message: 'Quoting for this pair is not available' }).state, 'unknown');
  assert.equal(classifyProbe(403, { message: 'API key disabled' }).state, 'unknown');
  assert.deepEqual(classifyProbe(502, null), { state: 'unknown', memo: false, said: 'http 502' });
  assert.equal(quoteSaysClosed('Quoting for this pair is not available'), true);
  assert.equal(quoteSaysClosed('Amount is too low for bridge, try at least 1000'), false);
});

test('the probe asks about the chain\'s own coin, the named asset when 1Click lists it there, and never a deprecated row', () => {
  const ton = receiveNetworkOf('ton');
  const plasma = receiveNetworkOf('plasma');
  const hypercore = receiveNetworkOf('hypercore');
  const near = receiveNetworkOf('near');
  assert.ok(ton && plasma && hypercore && near);
  assert.equal(probeAsset(ton, TOKENS)?.symbol, 'GRAM');
  assert.equal(probeAsset(ton, TOKENS, TOKENS[1].assetId)?.symbol, 'USDT');
  // An asset 1Click does not list on this chain falls back to the chain's coin rather than probing another chain.
  assert.equal(probeAsset(ton, TOKENS, 'nep141:eth.omft.near')?.symbol, 'GRAM');
  assert.equal(probeAsset(plasma, TOKENS)?.assetId, 'nep141:plasma.omft.near');
  assert.equal(probeAsset(hypercore, TOKENS)?.symbol, 'USDC');
  assert.equal(probeAsset(near, TOKENS)?.symbol, 'wNEAR');
});

test('the probe is about twenty dollars of the coin, or one whole coin when unpriced', () => {
  const eth = TOKENS[3];
  const amount = Number(probeAmount(eth)) / 1e18;
  assert.ok(Math.abs(amount * 2694.83 - PROBE_USD) < 0.01, `${amount} ETH is not ~$${PROBE_USD}`);
  assert.equal(probeAmount({ ...eth, price: undefined }), (10n ** 18n).toString());
  assert.equal(probeAmount({ ...eth, price: 0 }), (10n ** 18n).toString());
});

test('TON is closed by 1Click, and the probe is a dry same-asset quote from TON into our intents account', async () => {
  const { fetchImpl, calls } = fakeFetch({ quote: (b) => (b.originAsset === TOKENS[0].assetId ? NOT_AVAILABLE : QUOTED) });
  const verdict = await checker({ fetchImpl }).check({ network: 'ton', direction: 'in', account: ACCOUNT });
  assert.equal(verdict.state, 'closed');
  assert.deepEqual(verdict.reasons.map((r) => [r.source, r.state]), [['oneclick', 'closed']]);
  const quote = calls.find((c) => c.url.endsWith('/v0/quote'))?.body;
  assert.ok(quote);
  assert.equal(quote.dry, true);
  assert.equal(quote.swapType, 'EXACT_INPUT');
  assert.equal(quote.originAsset, TOKENS[0].assetId);
  assert.equal(quote.destinationAsset, TOKENS[0].assetId);
  assert.equal(quote.depositType, 'ORIGIN_CHAIN');
  assert.equal(quote.recipientType, 'INTENTS');
  assert.equal(quote.refundType, 'INTENTS');
  assert.equal(quote.recipient, ACCOUNT);
  assert.equal(quote.refundTo, ACCOUNT);
  assert.equal(quote.depositMode, undefined);
  assert.ok(Date.parse(String(quote.deadline)) > NOW);
  assert.equal(
    routeSentence(verdict, 'deposit'),
    'NEAR Intents has paused TON deposits right now, so no address is shown. Money sent now may not arrive.',
  );
});

test('Stellar asks again in MEMO mode, is open, and is asked in MEMO mode from then on', async () => {
  const clock = { t: NOW };
  const { fetchImpl, calls } = fakeFetch({ quote: (b) => (b.depositMode === 'MEMO' ? QUOTED : MEMO_WANTED) });
  const routes = checker({ fetchImpl, clock });
  const verdict = await routes.check({ network: 'stellar', direction: 'in', account: ACCOUNT });
  assert.equal(verdict.state, 'open');
  const quotes = calls.filter((c) => c.url.endsWith('/v0/quote'));
  assert.deepEqual(quotes.map((c) => c.body?.depositMode), [undefined, 'MEMO']);
  clock.t += OPEN_TTL_MS + 1;
  await routes.check({ network: 'stellar', direction: 'in', account: ACCOUNT });
  assert.deepEqual(calls.filter((c) => c.url.endsWith('/v0/quote')).map((c) => c.body?.depositMode), [undefined, 'MEMO', 'MEMO']);
});

test('another 400, a timeout, a dropped socket and a body that is not JSON are all unknown, and none throws', async () => {
  const cases: Array<[string, Reply]> = [
    ['other 400', { status: 400, body: { message: 'recipient is not valid' } }],
    ['timeout', 'hang'],
    ['socket', 'throw'],
    ['5xx', { status: 503, body: 'upstream' }],
  ];
  for (const [label, reply] of cases) {
    const { fetchImpl } = fakeFetch({ quote: () => reply });
    const verdict = await checker({ fetchImpl, timeoutMs: 20 }).check({ network: 'eth', direction: 'in', account: ACCOUNT });
    assert.equal(verdict.state, 'unknown', label);
    assert.equal(verdict.reasons[0].source, 'oneclick', label);
  }
  // A token list that cannot be read is unknown too, not a throw.
  const verdict = await checker({ tokens: async () => Promise.reject(new Error('down')), fetchImpl: fakeFetch().fetchImpl }).check({ network: 'eth', direction: 'in', account: ACCOUNT });
  assert.equal(verdict.state, 'unknown');
});

test('a status page that does not answer is unknown and leaves an open probe open', async () => {
  const { fetchImpl } = fakeFetch({ posts: () => 'hang' });
  const verdict = await checker({ fetchImpl, timeoutMs: 20 }).check({ network: 'eth', direction: 'in', account: ACCOUNT });
  assert.equal(verdict.state, 'open');
  assert.ok(verdict.reasons.some((r) => r.source === 'status' && r.state === 'unknown'));
});

test('money out is never probed: only the status page and the chain speak for it', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const verdict = await checker({ fetchImpl }).check({ network: 'eth', direction: 'out', account: ACCOUNT });
  assert.equal(verdict.state, 'unknown');
  assert.equal(calls.filter((c) => c.url.endsWith('/v0/quote')).length, 0);
});

// ---------- the status page ----------

function statusVerdict(posts: Record<string, unknown>[], network: string, now = NOW): RouteVerdict {
  const reasons = statusReasons(parsePosts({ posts }), parseServices(SERVICES) ?? new Map(), network, now);
  return { network, direction: 'in', state: combine(reasons), reasons, checkedAt: now };
}

test('a title naming TON, or its coin GRAM, closes TON both ways and quotes the page', () => {
  for (const title of ['TON: Service disruption reported', 'GRAM deposits delayed', 'Toncoin withdrawals paused']) {
    const verdict = statusVerdict([post({ title })], 'ton');
    assert.equal(verdict.state, 'closed', title);
    assert.equal(verdict.reasons[0].link, STATUS_LINK);
    assert.equal(statusVerdict([post({ title })], 'eth').state, 'unknown', `${title} touches eth`);
  }
  const verdict = statusVerdict([post({ title: 'TON: Service disruption reported' })], 'ton');
  assert.equal(
    routeSentence({ ...verdict, direction: 'out' }, 'payout'),
    'NEAR Intents is not taking payouts to TON right now, so nothing was signed and nothing moved. The NEAR Intents status page says: "TON: Service disruption reported".',
  );
});

test('"ZEC & Solana Paused" closes Zcash and Solana and nothing else', () => {
  assert.deepEqual([...namedNetworks('ZEC & Solana Paused')].sort(), ['sol', 'zec']);
  const posts = [post({ title: 'ZEC & Solana Paused' })];
  assert.equal(statusVerdict(posts, 'zec').state, 'closed');
  assert.equal(statusVerdict(posts, 'sol').state, 'closed');
  for (const other of ['eth', 'btc', 'near', 'base', 'ton']) assert.equal(statusVerdict(posts, other).state, 'unknown', other);
});

test('chain words are read whole, the service itself is not the NEAR chain, and ordinary words stay words', () => {
  assert.deepEqual([...namedNetworks('Bitcoin Cash deposits delayed')], ['bch']);
  assert.deepEqual([...namedNetworks('NEAR Intents degraded performance')], []);
  assert.deepEqual([...namedNetworks('near.com is slow')], []);
  assert.deepEqual([...namedNetworks('NEAR deposits delayed')], ['near']);
  assert.deepEqual([...namedNetworks('Elevated base fee on swaps')], []);
  assert.deepEqual([...namedNetworks('Base withdrawals delayed')], ['base']);
  assert.deepEqual([...namedNetworks('Maintenance Mon 09:00 UTC')], []);
  assert.deepEqual([...namedNetworks('Tonight: solver upgrade')], []);
  assert.deepEqual([...namedNetworks('ETH withdrawals slow')], ['eth']);
  assert.deepEqual([...namedNetworks('Hyperliquid deposits paused')], ['hypercore']);
});

test('no chain named: a chain service in outage closes that chain, Other Blockchains and shared services warn', () => {
  const solOutage = [post({ title: 'Deposits delayed', latest_update: { status_id: 'PP34365', impacts: [{ service_id: 'PYZGDVH', severity_id: 'PZ9VM86' }] } })];
  assert.equal(statusVerdict(solOutage, 'sol').state, 'closed');
  assert.equal(statusVerdict(solOutage, 'eth').state, 'unknown');

  const others = [post({ title: 'Deposits delayed', latest_update: { status_id: 'PSCS3IV', impacts: [{ service_id: 'PNEJBRE', severity_id: 'PCIGMKW' }] } })];
  assert.equal(statusVerdict(others, 'ton').state, 'degraded');
  assert.equal(statusVerdict(others, 'base').state, 'degraded');
  for (const own of ['sol', 'btc', 'eth']) assert.equal(statusVerdict(others, own).state, 'unknown', own);

  const global = [post({ title: 'Solver degradation', latest_update: { status_id: 'PSCS3IV', impacts: [{ service_id: 'PLT88AT', severity_id: 'PCIGMKW' }] } })];
  for (const network of ['eth', 'sol', 'ton', 'hypercore']) assert.equal(statusVerdict(global, network).state, 'degraded', network);

  // The explorer and near.com move no money, and an operational impact is no impact.
  const quiet = [
    post({ title: 'Explorer lag', latest_update: { status_id: 'PSCS3IV', impacts: [{ service_id: 'PFFZY12', severity_id: 'PZ9VM86' }] } }),
    post({ id: 'P2', title: 'All good', latest_update: { status_id: 'PSCS3IV', impacts: [{ service_id: 'PTEURIB', severity_id: 'PGV50ZJ' }] } }),
  ];
  assert.equal(statusVerdict(quiet, 'eth').state, 'unknown');
});

test('a resolved incident is ignored, and maintenance counts only inside its window and until completed', () => {
  assert.equal(statusVerdict([post({ title: 'TON paused', latest_update: { status_id: 'P8TG2TF', impacts: [] } })], 'ton').state, 'unknown');
  const window = { post_type: 'maintenance', title: 'Solana upgrade', starts_at: '2026-09-26T17:00:00Z', ends_at: '2026-09-26T19:00:00Z' };
  assert.equal(statusVerdict([post({ ...window, latest_update: { status_id: 'PS0JKGT', impacts: [] } })], 'sol').state, 'closed');
  assert.equal(statusVerdict([post({ ...window, latest_update: { status_id: 'PVA7LVG', impacts: [] } })], 'sol', Date.parse('2026-09-26T16:59:00Z')).state, 'unknown');
  assert.equal(statusVerdict([post({ ...window, latest_update: { status_id: 'PS0JKGT', impacts: [] } })], 'sol', Date.parse('2026-09-26T19:01:00Z')).state, 'unknown');
  assert.equal(statusVerdict([post({ ...window, latest_update: { status_id: 'PORYK43', impacts: [] } })], 'sol').state, 'unknown');
  // A window over a shared service warns everyone while it runs.
  const bus = post({ ...window, title: 'Message bus upgrade', latest_update: { status_id: 'PS0JKGT', impacts: [{ service_id: 'P2WM8Q9', severity_id: 'PJSKIN7' }] } });
  assert.equal(statusVerdict([bus], 'eth').state, 'degraded');
});

test('a title is quoted, never obeyed: controls, invisible characters and angle brackets go, and it stops at 120', () => {
  assert.equal(cleanTitle('TON\u0000 paused​ <script>x</script> "now"'), "TON paused scriptx/script 'now'");
  assert.equal(cleanTitle('‮TON'), 'TON');
  const long = cleanTitle('x'.repeat(300));
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('...'));
  assert.equal(cleanTitle(42), '');
});

// ---------- the checker ----------

test('the status page is read once for every network asked at the same moment, and a probe once per key', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const routes = checker({ fetchImpl });
  await Promise.all([
    ...RECEIVE_NETWORKS.map((n) => routes.check({ network: n.id, direction: 'in', account: ACCOUNT })),
    ...Array.from({ length: 5 }, () => routes.check({ network: 'eth', direction: 'in', account: ACCOUNT })),
  ]);
  assert.equal(calls.filter((c) => c.url.includes('/api/posts')).length, 1);
  const ethProbes = calls.filter((c) => c.url.endsWith('/v0/quote') && c.body?.originAsset === 'nep141:eth.omft.near');
  assert.equal(ethProbes.length, 1);
});

test('an open answer is kept a minute, a closed one twenty seconds, and the page a minute', async () => {
  const clock = { t: NOW };
  const { fetchImpl, calls } = fakeFetch({ quote: (b) => (b.originAsset === TOKENS[0].assetId ? NOT_AVAILABLE : QUOTED) });
  const routes = checker({ fetchImpl, clock });
  const probesOf = (asset: string): number => calls.filter((c) => c.url.endsWith('/v0/quote') && c.body?.originAsset === asset).length;
  const posts = (): number => calls.filter((c) => c.url.includes('/api/posts')).length;
  const ask = (network: string): Promise<RouteVerdict> => routes.check({ network, direction: 'in', account: ACCOUNT });

  await ask('eth');
  await ask('ton');
  clock.t = NOW + SHAKY_TTL_MS - 1;
  await ask('eth');
  await ask('ton');
  assert.deepEqual([probesOf('nep141:eth.omft.near'), probesOf(TOKENS[0].assetId), posts()], [1, 1, 1]);

  clock.t = NOW + SHAKY_TTL_MS + 1;
  await ask('eth');
  await ask('ton');
  assert.deepEqual([probesOf('nep141:eth.omft.near'), probesOf(TOKENS[0].assetId), posts()], [1, 2, 1]);

  clock.t = NOW + Math.max(OPEN_TTL_MS, FEED_TTL_MS) + 1;
  await ask('eth');
  assert.deepEqual([probesOf('nep141:eth.omft.near'), posts()], [2, 2]);
});

test('a TON recovery shows within twenty seconds', async () => {
  const clock = { t: NOW };
  let closed = true;
  const { fetchImpl } = fakeFetch({ quote: () => (closed ? NOT_AVAILABLE : QUOTED) });
  const routes = checker({ fetchImpl, clock });
  assert.equal((await routes.check({ network: 'ton', direction: 'in', account: ACCOUNT })).state, 'closed');
  closed = false;
  clock.t += SHAKY_TTL_MS + 1;
  assert.equal((await routes.check({ network: 'ton', direction: 'in', account: ACCOUNT })).state, 'open');
});

test('a live status post closes a network the probe calls open, and the combined sentence quotes the page', async () => {
  const { fetchImpl } = fakeFetch({ posts: () => ({ status: 200, body: { posts: [post({ title: 'ZEC & Solana Paused' })] } }) });
  const verdict = await checker({ fetchImpl }).check({ network: 'sol', direction: 'in', account: ACCOUNT });
  assert.equal(verdict.state, 'closed');
  assert.deepEqual(verdict.reasons.map((r) => `${r.source}:${r.state}`).sort(), ['oneclick:open', 'status:closed']);
  assert.match(routeSentence(verdict, 'deposit') ?? '', /paused Solana deposits.*status page says: "ZEC & Solana Paused"/);
});

test('the chain seam warns on a stale head and is ignored when it does not answer', async () => {
  const { fetchImpl } = fakeFetch();
  const stale = await checker({ fetchImpl, chainHead: async () => ({ ageSec: 3600 }) }).check({ network: 'eth', direction: 'out', account: ACCOUNT });
  assert.equal(stale.state, 'degraded');
  assert.equal(routeSentence(stale, 'payout'), 'The newest Ethereum block is 60 minutes old, so payouts to Ethereum may take longer than usual.');
  const silent = await checker({ fetchImpl, timeoutMs: 20, chainHead: () => new Promise(() => undefined) }).check({ network: 'eth', direction: 'in', account: ACCOUNT });
  assert.equal(silent.state, 'open');
});

test('the bridge closes a network it credits nothing on, but only when its list was read', () => {
  const open: RouteVerdict = { network: 'ton', direction: 'in', state: 'open', reasons: [{ source: 'oneclick', state: 'open', text: '' }], checkedAt: NOW };
  assert.equal(bridgeReason('ton', 2, true), null);
  assert.equal(bridgeReason('ton', 0, false), null);
  const closed = withReason(open, bridgeReason('ton', 0, true));
  assert.equal(closed.state, 'closed');
  assert.equal(routeSentence(closed, 'deposit'), 'The NEAR Intents bridge credits nothing on TON right now, so no address is shown.');
});

test('degraded reads as a warning with the page quoted, and open and unknown say nothing', () => {
  const verdict = statusVerdict([post({ title: 'Solver degradation', latest_update: { status_id: 'PSCS3IV', impacts: [{ service_id: 'PLT88AT', severity_id: 'PCIGMKW' }] } })], 'base');
  assert.equal(
    routeSentence(verdict, 'deposit'),
    'NEAR Intents reports trouble that may slow Base deposits right now, so it may take longer than usual. The NEAR Intents status page says: "Solver degradation".',
  );
  assert.equal(routeSentence({ ...verdict, state: 'open' }, 'deposit'), null);
  assert.equal(routeSentence({ ...verdict, state: 'unknown' }, 'deposit'), null);
});
