// Which NEAR Intents verifier is deployed, and whether it is the build the chip vault was spiked
// on: its version (contract_source_metadata) and the hash of its code (view_account). Read by
// scripts/verifier-check.ts, which prints it, and by the release gate (scripts/release-check.ts,
// --stage signed), which stops a release on any other build, or on no answer, until someone reruns
// the spike on it and pins the new pair here and in src/relay/verifier.ts.
//
// TWO PROVIDERS, RUN BY TWO COMPANIES. An RPC's answer carries no proof, so one provider alone
// could pass a release on a verifier nobody spiked. The gate asks two keyless NEAR RPCs that
// different organizations run, FastNEAR and dRPC, and passes only when both name the same pair.
// One of them silent fails closed, and so do two answers that differ. NEAR's own rpc.mainnet.near.org
// is no second voice: since the 2025 deprecation of the near.org endpoints, FastNEAR runs them too.
//
// The sign job installs nothing and runs only Node's own modules and the scripts beside them
// (tests/unit/release-workflow.test.ts), so this file keeps its own copy of the spiked pair, the
// RPCs and the verifier's account. tests/unit/verifier-gate.test.ts holds each equal to the app's.

import { setTimeout as sleep } from 'node:timers/promises';

export const VERIFIER_ACCOUNT = 'intents.near';
export const NEAR_RPC = 'https://free.rpc.fastnear.com';
// The second voice: dRPC's public NEAR endpoint, keyless.
export const SECOND_NEAR_RPC = 'https://near.drpc.org';

export type NearRpc = { name: string; url: string };

// The providers the gate asks, each run by its own organization.
export const NEAR_RPCS: readonly NearRpc[] = [
  { name: 'FastNEAR', url: NEAR_RPC },
  { name: 'dRPC', url: SECOND_NEAR_RPC },
];

// The build every payload shape, event and view the chip vault relies on was run live against,
// rev a2dd140892b68140bf7e70814604d3ba074d656c, on 2026-10-04.
export const SPIKED = { version: '0.4.4', codeHash: 'EHTzkKyabhTGuKpvET5hBi7xPdKacuesMc91dDGkWvqb' } as const;

export type DeployedVerifier = { version: string; codeHash: string };

export function isSpiked(deployed: DeployedVerifier): boolean {
  return deployed.version === SPIKED.version && deployed.codeHash === SPIKED.codeHash;
}

type Json = Record<string, unknown>;

async function query(fetchImpl: typeof fetch, rpcUrl: string, params: Json): Promise<unknown> {
  const res = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (body.error !== undefined || body.result === undefined) throw new Error('no result');
  return body.result;
}

// The two answers as one pair, or null when either is not what those views answer: a view that ran
// and failed answers flat inside `result` (a panic, an unknown method), which is no answer.
export function deployedVerifierOf(metadata: unknown, account: unknown): DeployedVerifier | null {
  const m = metadata as { result?: unknown; error?: unknown } | null;
  const a = account as { code_hash?: unknown } | null;
  if (m === null || typeof m !== 'object' || (m.error !== undefined && m.error !== null) || !Array.isArray(m.result)) return null;
  if (a === null || typeof a !== 'object' || typeof a.code_hash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a.code_hash)) return null;
  let version: unknown;
  try {
    version = (JSON.parse(Buffer.from(Uint8Array.from(m.result as number[])).toString('utf8')) as { version?: unknown }).version;
  } catch {
    return null;
  }
  if (typeof version !== 'string' || !/^[0-9A-Za-z.+-]{1,40}$/.test(version)) return null;
  return { version, codeHash: a.code_hash };
}

/* The deployed verifier, or null when the RPC gave no answer in `tries` asks. The free RPC answers
   -429 now and then under load, so a read that got no answer is asked again. */
export async function readDeployedVerifier(opts: { fetchImpl?: typeof fetch; rpcUrl?: string; tries?: number; pauseMs?: number } = {}): Promise<DeployedVerifier | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const rpcUrl = opts.rpcUrl ?? NEAR_RPC;
  for (let attempt = 0; attempt < (opts.tries ?? 3); attempt += 1) {
    if (attempt > 0) await sleep(opts.pauseMs ?? 1_500);
    try {
      const [metadata, account] = await Promise.all([
        query(fetchImpl, rpcUrl, { request_type: 'call_function', finality: 'final', account_id: VERIFIER_ACCOUNT, method_name: 'contract_source_metadata', args_base64: Buffer.from('{}').toString('base64') }),
        query(fetchImpl, rpcUrl, { request_type: 'view_account', finality: 'final', account_id: VERIFIER_ACCOUNT }),
      ]);
      const deployed = deployedVerifierOf(metadata, account);
      if (deployed !== null) return deployed;
    } catch {
      // no answer this time
    }
  }
  return null;
}

export type ProviderAnswer = NearRpc & { deployed: DeployedVerifier | null };

/* What each provider answers, asked side by side: null for one that gave no answer in `tries`. */
export async function readDeployedVerifiers(opts: { fetchImpl?: typeof fetch; rpcs?: readonly NearRpc[]; tries?: number; pauseMs?: number } = {}): Promise<ProviderAnswer[]> {
  const rpcs = opts.rpcs ?? NEAR_RPCS;
  return Promise.all(
    rpcs.map(async (rpc) => ({
      ...rpc,
      deployed: await readDeployedVerifier({ rpcUrl: rpc.url, ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }), ...(opts.tries === undefined ? {} : { tries: opts.tries }), ...(opts.pauseMs === undefined ? {} : { pauseMs: opts.pauseMs }) }),
    })),
  );
}

/* The one pair at least two providers all name, or null: one silent, or two that differ. */
export function agreedVerifier(answers: readonly ProviderAnswer[]): DeployedVerifier | null {
  const first = answers[0]?.deployed ?? null;
  if (answers.length < 2 || first === null) return null;
  const same = answers.every((a) => a.deployed !== null && a.deployed.version === first.version && a.deployed.codeHash === first.codeHash);
  return same ? first : null;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const said = (a: ProviderAnswer): string => `${a.name} (${hostOf(a.url)})`;

/* What stops a release, one sentence each: a provider that gave no answer, two that differ, or a
   verifier other than the spiked one. */
export function verifierProblems(answers: readonly ProviderAnswer[]): string[] {
  if (answers.length < 2) return [`${VERIFIER_ACCOUNT} was read from fewer than two NEAR RPCs, so one provider's word would decide the release alone`];
  const silent = answers.filter((a) => a.deployed === null);
  if (silent.length > 0) {
    return silent.map((a) => `${VERIFIER_ACCOUNT} could not be read from ${said(a)}: the NEAR RPC did not answer, so nobody can say this release signs for the verifier the chip vault was spiked on`);
  }
  const deployed = agreedVerifier(answers);
  if (deployed === null) {
    const each = answers.map((a) => `${said(a)} says ${a.deployed!.version} (code ${a.deployed!.codeHash})`).join(', ');
    return [`the NEAR RPCs disagree about ${VERIFIER_ACCOUNT}: ${each}, so nobody can say which build is deployed: ask again later, and read it by hand if they still differ`];
  }
  if (isSpiked(deployed)) return [];
  return [
    `${VERIFIER_ACCOUNT} is ${deployed.version} (code ${deployed.codeHash}), not ${SPIKED.version} (code ${SPIKED.codeHash}), the build the chip vault was spiked on: rerun the spike against it (node scripts/verifier-check.ts --simulate and the chip's live tests), then pin the new pair in scripts/verifier-gate.ts and src/relay/verifier.ts`,
  ];
}
