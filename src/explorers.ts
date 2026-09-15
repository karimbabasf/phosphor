// Which explorer a link goes to, by name.
//
// The receipt card ends in one button, "View on <explorer>", and the name on it has to come
// from the url the button opens rather than from the chain the row was filed under: an intent
// hash links to the NEAR Intents explorer while its row says "intents", and a Hyperliquid fill
// links to the venue's own explorer while its row says nothing about a chain at all. Keyed on
// the host, so a url built anywhere in this repo names itself, and a url this table does not
// know gets no name rather than a wrong one.
//
// Small and dependency free on purpose: src/trade/state.ts builds a fill's url from the prefix
// here, and pulling src/transactions.ts (viem, the keystore) into the trade payload for one
// string would be a heavy import bought for nothing.

export const HYPERLIQUID_EXPLORER_TX = 'https://app.hyperliquid.xyz/explorer/tx/';
export const HYPERLIQUID_EXPLORER_ADDRESS = 'https://app.hyperliquid.xyz/explorer/address/';

const EXPLORER_NAMES: ReadonlyArray<readonly [host: string, name: string]> = [
  ['basescan.org', 'Basescan'],
  ['arbiscan.io', 'Arbiscan'],
  ['etherscan.io', 'Etherscan'],
  ['solscan.io', 'Solscan'],
  ['nearblocks.io', 'Nearblocks'],
  ['explorer.near-intents.org', 'NEAR Intents explorer'],
  ['app.hyperliquid.xyz', 'Hyperliquid explorer'],
];

// The explorer's name for a url, or null when the host is not one this repo links to. A
// subdomain counts (sepolia.basescan.org is still Basescan); a host that merely contains the
// name does not, so nothing can name itself after an explorer by carrying the word.
export function explorerName(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const [suffix, name] of EXPLORER_NAMES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return name;
  }
  return null;
}
