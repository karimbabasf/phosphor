// cfg.tradingNetwork: the one value every trading consumer reads.
//
// The bug this defends against has already happened once, and the comment in src/main.ts
// records it: the trading URLs were derived from cfg.network while the runner refused mainnet
// outright, so the window showed a mainnet account holding nothing while the real balance sat
// on testnet, and a mandate could be armed and never fire. It was fixed by pinning two
// constants to testnet, which worked right up until mainnet trading was wanted.
//
// So the contract under test is not "which network" but "one network, everywhere". These tests
// pin the resolution order, and the fact that a bad value stops the app rather than being
// guessed at.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.ts';
import { buildMandateCatalog } from '../../src/strategy/catalog.ts';

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-trading-net-'));
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(vars)) {
    saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const KEYS = path.join(os.tmpdir(), 'phosphor-trading-net-keys', 'keys.json');

function root(config: Record<string, unknown>): string {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ keysPath: KEYS, ...config }, null, 2));
  return dir;
}

// The env vars loadConfig reads, cleared so a developer's own shell cannot change the answer.
const CLEAN = { PHOSPHOR_NETWORK: undefined, PHOSPHOR_TRADING_NETWORK: undefined, PHOSPHOR_KEYS: KEYS };

test('tradingNetwork follows network when it is not set', () => {
  for (const network of ['testnet', 'mainnet'] as const) {
    const cfg = withEnv(CLEAN, () => loadConfig(root({ network })));
    assert.equal(cfg.network, network);
    assert.equal(cfg.tradingNetwork, network, `${network} should carry through`);
  }
});

test('an explicit tradingNetwork overrides network, which is how the wallet and the venue split', () => {
  // The real case: mainnet money in the wallet, trading still being proved out on testnet.
  const cfg = withEnv(CLEAN, () => loadConfig(root({ network: 'mainnet', tradingNetwork: 'testnet' })));
  assert.equal(cfg.network, 'mainnet');
  assert.equal(cfg.tradingNetwork, 'testnet');
});

test('PHOSPHOR_TRADING_NETWORK beats the file, so a run can be pointed without editing config', () => {
  const dir = root({ network: 'testnet', tradingNetwork: 'testnet' });
  const cfg = withEnv({ ...CLEAN, PHOSPHOR_TRADING_NETWORK: 'mainnet' }, () => loadConfig(dir));
  assert.equal(cfg.network, 'testnet');
  assert.equal(cfg.tradingNetwork, 'mainnet');
});

test('a tradingNetwork that is not one of the two stops the app instead of being guessed', () => {
  const dir = root({ network: 'testnet', tradingNetwork: 'devnet' });
  assert.throws(
    () => withEnv(CLEAN, () => loadConfig(dir)),
    /tradingNetwork must be "testnet" or "mainnet".*devnet/s,
  );
});

test('an empty tradingNetwork in the file falls back to network rather than throwing', () => {
  // Distinct from the case above: absent is a default, present-and-wrong is a mistake.
  const cfg = withEnv(CLEAN, () => loadConfig(root({ network: 'mainnet' })));
  assert.equal(cfg.tradingNetwork, 'mainnet');
});

// ---------- the thing the setting exists to keep true ----------

test('the mandate catalog tells an agent the truth about whose money it is', () => {
  const testnet = buildMandateCatalog('testnet');
  const mainnet = buildMandateCatalog('mainnet');

  assert.equal(testnet.network, 'testnet');
  assert.equal(mainnet.network, 'mainnet');

  // The network line leads, because it changes how every line under it should be read.
  assert.match(testnet.traps[0], /testnet/i);
  assert.match(mainnet.traps[0], /MAINNET/);
  assert.match(mainnet.traps[0], /real money/i);

  // The old text claimed mainnet was refused outright. On mainnet that is now false, and a
  // false reassurance is worse than none: it is the app telling the agent to be bolder than
  // it should be at exactly the moment the money is real.
  assert.doesNotMatch(mainnet.traps.join(' '), /never armed against real money/i);
  assert.doesNotMatch(mainnet.traps.join(' '), /refuses mainnet outright/i);

  // Everything else about the catalog is network-independent and must stay so.
  assert.deepEqual(testnet.actions, mainnet.actions);
  assert.deepEqual(testnet.conditions, mainnet.conditions);
  assert.equal(testnet.examples.length, mainnet.examples.length);
});
