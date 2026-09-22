// The chain table a card test hands the window, built off the same registry the server sends it
// from (src/http/state.ts). A hand written table here would let a card pass a test against rows
// the app never sends.

import { readFileSync } from 'node:fs';
import { RECEIVE_NETWORKS, SPEND_NETWORKS } from '../../src/rails/intents-address.ts';

export const CHAINS_SOURCE = readFileSync(new URL('../../ui/core/chains.js', import.meta.url), 'utf8');

export const CHAIN_ROWS = [...RECEIVE_NETWORKS, ...SPEND_NETWORKS]
  .filter((n, i, all) => all.findIndex((m) => m.id === n.id) === i)
  .map((n) => ({ id: n.id, name: n.name, mark: n.mark, colour: n.colour }));

// The window as a card test builds it: run chains.js in the sandbox and fill its table once.
export function fillChains(sandbox: Record<string, unknown>, run: (source: string, name: string) => void): void {
  run(CHAINS_SOURCE, 'ui/core/chains.js');
  const win = (sandbox.window ?? {}) as { PhosphorChains?: { set: (rows: unknown) => void } };
  win.PhosphorChains?.set(CHAIN_ROWS);
}
