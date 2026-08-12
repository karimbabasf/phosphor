// The approval gate can be switched off for testnet. These tests are what stands between
// that convenience and a product that lies about what it is: mainnet must ignore the flag.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gateRequired, gateBanner } from '../../src/policy/gate.ts';

test('mainnet requires the gate even when the config asks for it off', () => {
  assert.equal(gateRequired({ network: 'mainnet', approvalGate: false }), true);
});

test('mainnet requires the gate when the config asks for it on', () => {
  assert.equal(gateRequired({ network: 'mainnet', approvalGate: true }), true);
});

test('testnet honours the flag in both directions', () => {
  assert.equal(gateRequired({ network: 'testnet', approvalGate: false }), false);
  assert.equal(gateRequired({ network: 'testnet', approvalGate: true }), true);
});

test('the banner appears only when the gate is actually off', () => {
  assert.equal(gateBanner({ network: 'testnet', approvalGate: true }), null);
  assert.equal(gateBanner({ network: 'mainnet', approvalGate: false }), null);
  const banner = gateBanner({ network: 'testnet', approvalGate: false });
  assert.ok(banner !== null && banner.includes('GATE DISABLED'));
});
