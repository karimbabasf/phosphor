// Which chain's coin a send takes (fix round 2, 2026-10-01).
//
// Karim asked his agent to "send 1 USDC". He held USDC inside NEAR Intents from Base and from
// Arbitrum, two different coins under one symbol; the send took the larger, the Base row, and the
// card he read said only "1 USDC". The draft now names the chain the chosen coin came in on whenever
// the symbol is held from more than one, and the propose reply carries it for the card.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { IntentsHolding, IntentsRead } from '../../src/ledger/intents.ts';
import { ETH_USDC_FLAVOR, SELF_EVM, makeCtx } from './helpers/proposals.ts';
import { makeHttp } from './helpers/http.ts';

const BASE_USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const ARB_USDC = 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near';
const FRIEND = '0x2222222222222222222222222222222222222222';

function holding(assetId: string, originChain: string, amount: number): IntentsHolding {
  return { accountId: SELF_EVM.toLowerCase(), assetId, symbol: 'USDC', originChain, amount, decimals: 6 } as IntentsHolding;
}

function held(...rows: IntentsHolding[]): IntentsRead {
  return { ok: true, fetchedAt: new Date().toISOString(), holdings: rows };
}

test('regression: a send of a coin held from two chains names the chain of the coin it takes', async () => {
  const h = makeCtx({ intents: held(holding(ARB_USDC, 'arb', 10), holding(BASE_USDC, 'base', 30)) });
  const inside = await h.svc.proposeSend({ to: 'alice.near', symbol: 'USDC', amount: 1, where: 'intents' });
  assert.equal(inside.draft.kind, 'intents_send');
  assert.equal((inside.draft as { originAsset: string }).originAsset, BASE_USDC, 'the largest row is the one taken');
  assert.equal((inside.draft as { fromChain?: string }).fromChain, 'base');

  const out = await h.svc.proposeSend({ to: FRIEND, symbol: 'USDC', amount: 1, where: 'eth' });
  assert.equal(out.draft.kind, 'intents_pay');
  assert.equal((out.draft as { fromChain?: string }).fromChain, 'base');
});

test('regression: the propose reply carries it, so the card drawn from the reply says it too', async () => {
  const h = makeCtx({ intents: held(holding(BASE_USDC, 'base', 30), holding(ARB_USDC, 'arb', 10)) });
  const door = makeHttp({ proposals: h.svc, dataDir: h.dataDir });
  const r = await door.post('send', { to: 'alice.near', symbol: 'USDC', amount: 1, where: 'intents', confirmed: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((r.json.send as { fromChain?: string }).fromChain, 'base');
});

test('a coin held from one chain, or twice on the same chain, names none', async () => {
  const one = makeCtx({ intents: held(holding(ETH_USDC_FLAVOR, 'eth', 30)) });
  const p = await one.svc.proposeSend({ to: 'alice.near', symbol: 'USDC', amount: 1, where: 'intents' });
  assert.equal('fromChain' in p.draft, false, JSON.stringify(p.draft));

  const same = makeCtx({ intents: held(holding(ETH_USDC_FLAVOR, 'eth', 30), holding('nep141:eth-usdc-two.omft.near', 'eth', 5)) });
  const q = await same.svc.proposeSend({ to: 'alice.near', symbol: 'USDC', amount: 1, where: 'intents' });
  assert.equal('fromChain' in q.draft, false, 'two coins from one chain: the chain does not tell them apart');
});
