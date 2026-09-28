// Phosphor's usage, read from the venue's own record rather than anything the app reports.
//
// Every 1Click quote carries referral "phosphor" (src/intents.ts PHOSPHOR_REFERRAL), and the
// Intents Explorer API filters swaps by it, so these numbers are what NEAR Intents says Phosphor
// moved. The Explorer token is read from Keychain (service near-intents-explorer-jwt) and never
// printed. The API allows one request every 5 seconds, so a long history takes a while.
//
// Run: npm run usage [-- --since 2026-09-27 --all-statuses]
import { execFileSync } from 'node:child_process';

import { PHOSPHOR_REFERRAL } from '../src/intents.ts';

const BASE = 'https://explorer.near-intents.org/api/v0/transactions';
const PAGE = 1000;
const GAP_MS = 5_500;

type Tx = {
  depositAddress: string;
  depositMemo?: string | null;
  status: string;
  createdAtTimestamp: number;
  amountInUsd?: string | number | null;
  senders?: string[] | null;
  refundTo?: string | null;
};

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function token(): string {
  try {
    return execFileSync('security', ['find-generic-password', '-a', 'phosphor', '-s', 'near-intents-explorer-jwt', '-w']).toString().trim();
  } catch {
    throw new Error('no Explorer token in Keychain: security add-generic-password -U -a phosphor -s near-intents-explorer-jwt -w "<token>"');
  }
}

async function page(jwt: string, after: Tx | null): Promise<Tx[]> {
  const q = new URLSearchParams({ referral: PHOSPHOR_REFERRAL, numberOfTransactions: String(PAGE), direction: 'next' });
  if (after !== null) {
    q.set('lastDepositAddress', after.depositAddress);
    if (after.depositMemo) q.set('lastDepositMemo', after.depositMemo);
  }
  let res = await fetch(`${BASE}?${q}`, { headers: { Authorization: `Bearer ${jwt}` } });
  // A run started within 5 seconds of the last one meets the rate limit on its first page.
  for (let tries = 0; res.status === 429 && tries < 3; tries += 1) {
    await new Promise((r) => setTimeout(r, GAP_MS));
    res = await fetch(`${BASE}?${q}`, { headers: { Authorization: `Bearer ${jwt}` } });
  }
  if (!res.ok) throw new Error(`Explorer answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as unknown;
  const list = Array.isArray(body) ? body : (body as { data?: unknown }).data;
  if (!Array.isArray(list)) throw new Error('Explorer answered without a transaction list');
  return list as Tx[];
}

async function main(): Promise<void> {
  const jwt = token();
  const since = arg('since');
  const sinceSec = since === null ? 0 : Math.floor(Date.parse(since) / 1000);
  if (Number.isNaN(sinceSec)) throw new Error(`--since ${since} is not a date`);
  const allStatuses = process.argv.includes('--all-statuses');

  const rows: Tx[] = [];
  let after: Tx | null = null;
  for (;;) {
    const got = await page(jwt, after);
    rows.push(...got);
    const oldest = got.at(-1);
    if (got.length < PAGE || oldest === undefined || oldest.createdAtTimestamp < sinceSec) break;
    after = oldest;
    await new Promise((r) => setTimeout(r, GAP_MS));
  }

  const inRange = rows.filter((t) => t.createdAtTimestamp >= sinceSec);
  const counted = allStatuses ? inRange : inRange.filter((t) => t.status === 'SUCCESS');
  const wallets = new Set<string>();
  for (const t of counted) for (const s of t.senders ?? []) if (s) wallets.add(s.toLowerCase());
  const volume = counted.reduce((sum, t) => sum + (Number(t.amountInUsd) || 0), 0);
  const byStatus: Record<string, number> = {};
  for (const t of inRange) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  const days = counted.map((t) => t.createdAtTimestamp).sort((a, b) => a - b);
  const day = (s: number | undefined): string => (s === undefined ? '-' : new Date(s * 1000).toISOString().slice(0, 10));

  console.log(`referral        ${PHOSPHOR_REFERRAL}${since === null ? '' : `, since ${since}`}`);
  console.log(`swaps           ${counted.length}${allStatuses ? ' (all statuses)' : ' (SUCCESS only)'}`);
  console.log(`volume in, USD  ${volume.toFixed(2)}`);
  console.log(`unique wallets  ${wallets.size} (distinct senders)`);
  console.log(`first, last     ${day(days[0])}, ${day(days.at(-1))}`);
  console.log(`by status       ${JSON.stringify(byStatus)}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
