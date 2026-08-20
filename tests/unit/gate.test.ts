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

// ---------- the second axis, added 2026-08-20 ----------
//
// `network` and `tradingNetwork` are deliberately separate: the wallet can hold mainnet money
// while trading is proved out on testnet, or the reverse. The reverse is the dangerous one, and
// it only became reachable when the second setting existed.

test('mainnet trading forces the gate even when the wallet network is testnet', () => {
  // The funding rail moves REAL money in exactly this configuration, because NEAR Intents has
  // no testnet and always delivers to mainnet HyperCore. Honouring approvalGate:false here
  // would auto-execute it.
  assert.equal(gateRequired({ network: 'testnet', tradingNetwork: 'mainnet', approvalGate: false }), true);
  assert.equal(gateRequired({ network: 'testnet', tradingNetwork: 'mainnet', approvalGate: true }), true);
});

test('a mainnet wallet still forces the gate whatever trading is doing', () => {
  assert.equal(gateRequired({ network: 'mainnet', tradingNetwork: 'testnet', approvalGate: false }), true);
});

test('both on testnet is the only case where the flag is honoured', () => {
  assert.equal(gateRequired({ network: 'testnet', tradingNetwork: 'testnet', approvalGate: false }), false);
  assert.equal(gateRequired({ network: 'testnet', tradingNetwork: 'testnet', approvalGate: true }), true);
});

test('an absent tradingNetwork falls back to network rather than to testnet', () => {
  // Fail closed: an older config shape must not read as "no mainnet anywhere".
  assert.equal(gateRequired({ network: 'mainnet', approvalGate: false }), true);
  assert.equal(gateRequired({ network: 'testnet', approvalGate: false }), false);
});

test('the banner still appears only when the gate is genuinely off', () => {
  assert.equal(gateBanner({ network: 'testnet', tradingNetwork: 'mainnet', approvalGate: false }), null);
  assert.match(gateBanner({ network: 'testnet', tradingNetwork: 'testnet', approvalGate: false }) ?? '', /AUTO-APPROVES/);
});
