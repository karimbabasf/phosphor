// The venues an existing policy.json does not list, and the one proposal that offers to add them.
//
// A fresh install seeds the allowlist with all nine rail venues. An existing policy.json is
// never rewritten, so every install that predates a venue had that rail DEAD rather than gated:
// evaluateRail refuses an unlisted counterparty outright, and the only sentence anybody saw was
// one about an allowlist nobody was going to hand-edit. The app asks now.
//
// Nothing here can approve itself. A policy change is always needs_approval, whatever else is
// true, so the proposal lands pending and waits for a click.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AppConfig, Policy, RiskRow } from '../../src/types.ts';
import { createAudit } from '../../src/audit.ts';
import { createStore } from '../../src/store.ts';
import { createLedger } from '../../src/ledger/index.ts';
import { defaultPolicy, loadPolicy, savePolicy } from '../../src/policy/file.ts';
import { renderSentences } from '../../src/policy/render.ts';
import { syntheticQuoter, stubSigner } from '../../src/intents.ts';
import { createProposalService } from '../../src/proposals.ts';
import { venueAllowlist, verifiedVenueContracts } from '../../src/rails/index.ts';
import { missingVenues, proposeVenueGap, venueGapSentence } from '../../src/policy/venues.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const riskRows = (JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'risk-table.json'), 'utf8')) as { rows: RiskRow[] }).rows;

// A policy that lists everything except the venues named, which is the shape an install from
// before those venues existed has.
function policyWithout(...absent: string[]): Policy {
  const p = defaultPolicy();
  const drop = new Set(absent.map((a) => a.toLowerCase()));
  p.outbound.destinationAllowlist = venueAllowlist().filter((v) => !drop.has(v));
  p.sentences = renderSentences(p);
  return p;
}

function setup(policy: Policy) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-venuegap-'));
  const cfg: AppConfig = {
    mode: 'demo',
    keysPath: path.join(dataDir, 'keys.json'),
    port: 4177,
    addresses: { evm: [], solana: [], near: [] },
    economicTransferUsd: 10,
    candleProducts: [],
    dataDir,
  };
  savePolicy(dataDir, policy);
  const audit = createAudit(dataDir);
  const store = createStore(dataDir);
  const svc = createProposalService({
    cfg,
    audit,
    store,
    ledger: createLedger(cfg),
    riskRows,
    quoter: syntheticQuoter(),
    signer: stubSigner(),
    dataDir,
  });

  const file = (): Promise<unknown> =>
    proposeVenueGap({
      policy: loadPolicy(dataDir),
      seeded: venueAllowlist(),
      list: () => store.list(),
      propose: (params) => svc.proposePolicyChange(params),
      audit,
    });

  return { dataDir, store, audit, svc, file };
}

const AAVE_ARB = '0x794a61358d6845594f94dc1db02a252b5b4814ad';
const AAVE_BASE = '0xa238dd80c259a72e81d7e4664a9801593f98d1c5';

test('a policy missing two venues yields one pending proposal listing both', async () => {
  const h = setup(policyWithout(AAVE_ARB, AAVE_BASE));

  await h.file();

  const filed = h.store.list().filter((p) => p.kind === 'policy_change');
  assert.equal(filed.length, 1, 'one proposal, not one per venue');
  assert.equal(filed[0].status, 'pending', 'it waits for a click');
  assert.equal(filed[0].verdict.outcome, 'needs_approval', 'a policy change is never auto-approved');

  const draft = filed[0].draft;
  assert.equal(draft.kind, 'policy_change');
  if (draft.kind !== 'policy_change') return;
  const asked = draft.patch.outbound?.destinationAllowlist ?? [];
  assert.ok(asked.includes(AAVE_ARB), 'the first missing venue is in the patch');
  assert.ok(asked.includes(AAVE_BASE), 'and so is the second');
  assert.deepEqual([...asked].sort(), [...venueAllowlist()].sort(), 'the patch asks for exactly the seeded list, nothing else');
  assert.match(draft.sentence, /Allow the two contracts this version of Phosphor verified on chain \(Aave on Arbitrum and Base\)/);
});

test('a policy that already allows every venue yields nothing', async () => {
  const h = setup(policyWithout());

  assert.equal(await h.file(), null);
  assert.deepEqual(h.store.list(), []);
});

test('a second boot files nothing, because the question is already on screen', async () => {
  const h = setup(policyWithout(AAVE_ARB, AAVE_BASE));

  await h.file();
  await h.file();
  await h.file();

  assert.equal(h.store.list().filter((p) => p.kind === 'policy_change').length, 1);
});

test('a pending proposal covering only some of the gap does not suppress one covering the rest', async () => {
  const h = setup(policyWithout(AAVE_ARB, AAVE_BASE));

  // Somebody asked for one of the two by hand, and it is still waiting.
  const policy = loadPolicy(h.dataDir);
  assert.ok(policy !== null);
  await h.svc.proposePolicyChange({
    patch: { outbound: { destinationAllowlist: [...policy.outbound.destinationAllowlist, AAVE_ARB] } },
    sentence: 'Allow the Aave pool on Arbitrum',
  });

  await h.file();

  const filed = h.store.list().filter((p) => p.kind === 'policy_change');
  assert.equal(filed.length, 2, 'the partial one is not an answer to the whole gap');
});

test('the sentence a person reads names every contract this version verified, and says six when six are missing', () => {
  const all = verifiedVenueContracts().map((v) => v.address);
  assert.equal(
    venueGapSentence(all),
    'Allow the six contracts this version of Phosphor verified on chain (Aave on Arbitrum and Base, Uniswap on Arbitrum and Base)',
  );
});

test('the gap is computed case insensitively, because an allowlist is written by hand', () => {
  const p = policyWithout(AAVE_ARB);
  p.outbound.destinationAllowlist = p.outbound.destinationAllowlist.map((a) => a.toUpperCase());
  assert.deepEqual(missingVenues(p, venueAllowlist()), [AAVE_ARB]);
});

test('an unreadable policy asks for nothing, because there is nothing to patch', async () => {
  const h = setup(policyWithout(AAVE_ARB));
  fs.writeFileSync(path.join(h.dataDir, 'policy.json'), '{ not json');

  assert.equal(await h.file(), null);
  assert.deepEqual(h.store.list(), []);
});
