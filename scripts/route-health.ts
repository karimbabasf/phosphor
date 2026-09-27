// Whether NEAR Intents is taking deposits on every network right now, read live, unsigned.
//
// The same checker the app runs (src/preflight/route-health.ts): one dry 1Click quote per network,
// the network's own coin from its chain into intents, and one read of the official status page,
// plus the POA bridge's token list for the bridge's own voice and each chain's newest block from
// src/chainscan. A dry quote mints no address and moves nothing, and no key is opened: the account
// the probe names is only where a quote that will never be taken would credit and refund.
//
// Run: node scripts/route-health.ts [--account 0x...] [--network ton]
// The account defaults to a placeholder, which 1Click prices the same as a real one.

import { oneClickClient } from '../src/intents.ts';
import { chainHead, scanNetworkOf } from '../src/chainscan/index.ts';
import { RECEIVE_NETWORKS, poaSupportedTokens } from '../src/rails/intents-address.ts';
import { bridgeReason, createRouteHealth, routeSentence, withReason } from '../src/preflight/route-health.ts';

const PLACEHOLDER = '0x1111111111111111111111111111111111111111';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] !== undefined ? String(process.argv[i + 1]) : fallback;
}

const account = arg('account', PLACEHOLDER).toLowerCase();
const only = arg('network', '');
const client = oneClickClient();
const routes = createRouteHealth({
  tokens: () => client.tokens(),
  chainHead: (id) => {
    const network = scanNetworkOf(id);
    return network === null ? Promise.resolve(null) : chainHead(network);
  },
  log: () => undefined,
});
const networks = RECEIVE_NETWORKS.filter((n) => only === '' || n.id === only);

const started = Date.now();
const [tokens, verdicts] = await Promise.all([
  poaSupportedTokens(),
  Promise.all(networks.map((n) => routes.check({ network: n.id, direction: 'in', account }))),
]);
const ms = Date.now() - started;

const rows = networks.map((n, i) => {
  const listed = tokens.filter((t) => t.network === n.bridge).length;
  const verdict = withReason(verdicts[i], bridgeReason(n.id, listed, tokens.length > 0));
  const why = verdict.reasons.map((r) => `${r.source}:${r.state}`).join(' ');
  return { id: n.id, state: verdict.state, why, sentence: routeSentence(verdict, 'deposit') };
});

const pad = (text: string, width: number): string => text.padEnd(width);
console.log(`${pad('network', 11)} ${pad('state', 9)} sources`);
for (const r of rows) console.log(`${pad(r.id, 11)} ${pad(r.state, 9)} ${r.why}`);
const closed = rows.filter((r) => r.state === 'closed');
const degraded = rows.filter((r) => r.state === 'degraded');
console.log(`\n${rows.length} networks in ${ms} ms; closed: ${closed.map((r) => r.id).join(', ') || 'none'}; degraded: ${degraded.map((r) => r.id).join(', ') || 'none'}`);
for (const r of [...closed, ...degraded]) console.log(`${r.id}: ${r.sentence}`);
