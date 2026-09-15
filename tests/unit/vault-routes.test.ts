// The vault routes, with a fake shell on the other end of the relay.
//
// The shell is a loop in this file that does what src-tauri/src/enclave.rs does: it polls
// POST /api/vault/pending with the window token, plays the enclave with a software P-256 key
// (the same stand-in tests/unit/keystore-enclave.test.ts uses), seals the data key under the
// transport key with the request id as AAD, and posts the answer to POST /api/vault/answer.
// It can also be told to cancel, or to answer as an enclave that does not know the key, which
// is what a wallet file carried to another Mac produces.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { createServer } from '../../src/server.ts';
import { createTradeView } from '../../src/trade/view.ts';
import { createAgents } from '../../src/agents.ts';
import { createAudit } from '../../src/audit.ts';
import { createStore } from '../../src/store.ts';
import { defaultPolicy } from '../../src/policy/file.ts';
import { createMarketData } from '../../src/market/index.ts';
import { createKeystore } from '../../src/keystore/index.ts';
import { defaultParams } from '../../src/keystore/kdf.ts';
import { seUnwrapWithSoftwareKey } from '../../src/keystore/sewrap.ts';
import { createVaultRelay } from '../../src/vault/relay.ts';
import type { AppConfig, ChainId, ChainStatus, LedgerSnapshot } from '../../src/types.ts';

const CHAINS: ChainId[] = ['eth', 'base', 'arb', 'sol', 'near'];

function snapshot(): LedgerSnapshot {
  const fetchedAt = new Date().toISOString();
  const status: ChainStatus = { ok: true, fetchedAt };
  return {
    holdings: [],
    chainStatus: Object.fromEntries(CHAINS.map((c) => [c, status])) as Record<ChainId, ChainStatus>,
    mode: 'demo',
    prices: {},
    gas: Object.fromEntries(CHAINS.map((c) => [c, { transferCostUsd: 0.1 }])) as LedgerSnapshot['gas'],
  };
}

function fast(): ReturnType<typeof defaultParams> {
  return { ...defaultParams(), N: 2 ** 14 };
}

/* The enclave, in software: one P-256 key per "Mac". */
type Enclave = { priv: crypto.KeyObject; pub: string };
function enclave(): Enclave {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x963 = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { priv: pair.privateKey, pub: x963.toString('base64') };
}

type Mode = 'answer' | 'cancel';

async function boot(opts: { mode?: AppConfig['mode'] } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-vault-'));
  const token = crypto.randomBytes(32).toString('hex');
  process.env.PHOSPHOR_WINDOW_TOKEN = token;
  const keysPath = path.join(dataDir, 'keys', 'keys.json');
  const keystore = createKeystore({ keysPath, mode: opts.mode ?? 'demo', kdf: fast });
  const transport = crypto.randomBytes(32);
  const vault = createVaultRelay({ transportKey: transport });
  const cfg: AppConfig = {
    mode: opts.mode ?? 'demo',
    port: 0,
    addresses: { evm: [], solana: [], near: [] },
    economicTransferUsd: 10,
    candleProducts: ['BTC-USD'],
    dataDir,
    keysPath,
  };
  let releases = 0;
  const audit = createAudit(dataDir);
  const server = createServer({
    cfg,
    token,
    vault,
    audit,
    store: createStore(dataDir),
    keystore,
    riskRows: [],
    ledger: { snapshot, intents: () => undefined, hyperliquid: () => undefined, refresh: async () => snapshot(), applyDemoTransfer: () => {} },
    market: createMarketData({
      fetchImpl: (async () => ({ ok: true, json: async () => [], text: async () => '', headers: new Headers() })) as unknown as typeof fetch,
    }),
    proposals: {
      proposeConsolidate: async () => { throw new Error('unused'); },
      proposePolicyChange: async () => { throw new Error('unused'); },
      proposeSwap: async () => { throw new Error('unused'); },
      proposeHlDeposit: async () => { throw new Error('unused'); },
      proposeHlWithdraw: async () => { throw new Error('unused'); },
      proposeIntentsDeposit: async () => { throw new Error('unused'); },
      proposeIntentsWithdraw: async () => { throw new Error('unused'); },
      proposeTrade: async () => { throw new Error('unused'); },
      proposeTradeChange: async () => { throw new Error('unused'); },
      approve: async () => { throw new Error('unused'); },
      refuse: async () => { throw new Error('unused'); },
      get: () => undefined,
      list: () => [],
      sessionSpentUsd: () => 0,
      releaseQueued: async () => {
        releases += 1;
        return 0;
      },
      reconcileOnBoot: () => [],
      reconcile: () => Promise.reject(new Error('not wired in this stub')),
      settle: () => Promise.resolve(true),
      dailyLimit: (capUsd: number) => ({ capUsd, spentUsd: 0, resetsAt: null }),
    },
    getPolicy: () => defaultPolicy(),
    setKill: () => {},
    agents: createAgents(),
    getView: () => 'pro',
    setView: () => {},
    trade: {
      view: createTradeView('BTC'),
      payload: () => ({}) as never,
      read: () => ({}),
      batch: () => [],
      action: async () => ({ ok: false, detail: 'no venue in this test' }),
      plan: () => ({ ok: false as const, error: 'no venue in this test' }),
      meta: () => null,
      mark: () => null,
      free: () => null,
      onUpdate: () => {},
      stop: () => {},
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function post(route: string, body: Record<string, unknown>, withToken = true) {
    const res = await fetch(`${url}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: url },
      body: JSON.stringify(withToken ? { token, ...body } : body),
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  }
  async function get(route: string) {
    const res = await fetch(`${url}${route}`, { headers: { origin: url } });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  }

  /* The fake shell. `mac` is the enclave it answers with; a request wrapped to a different
     enclave fails as the real one would, with crypto_failed. */
  const mac = enclave();
  const dialog: { mode: Mode } = { mode: 'answer' };
  let running = true;
  const seen: string[] = [];
  const shell = (async () => {
    while (running) {
      const pending = await post('/api/vault/pending', { waitMs: 200 });
      if (pending.status !== 200) break;
      const request = pending.json?.request;
      if (!request) continue;
      seen.push(`${request.op}:${request.reason ?? ''}`);
      if (dialog.mode === 'cancel') {
        await post('/api/vault/answer', { id: request.id, ok: false, error: 'user_cancel', message: 'cancelled' });
        continue;
      }
      if (request.op === 'probe') {
        await post('/api/vault/answer', { id: request.id, ok: true, secureEnclave: true, biometry: 'touchid', canAuthenticate: true });
      } else if (request.op === 'create') {
        await post('/api/vault/answer', { id: request.id, ok: true, keyBlob: crypto.randomBytes(64).toString('base64'), publicKey: mac.pub, binding: 'device' });
      } else if (request.op === 'presence') {
        await post('/api/vault/answer', { id: request.id, ok: true });
      } else if (request.op === 'unwrap') {
        let dek: Buffer | null = null;
        try {
          dek = seUnwrapWithSoftwareKey(
            { ephemeralPublicKey: request.ephemeralPublicKey, ciphertext: request.ciphertext },
            mac.priv,
            Buffer.from(request.aad, 'base64'),
          );
        } catch {
          dek = null;
        }
        if (dek === null) {
          await post('/api/vault/answer', { id: request.id, ok: false, error: 'crypto_failed', message: 'not this enclave' });
          continue;
        }
        const nonce = crypto.randomBytes(12);
        const c = crypto.createCipheriv('aes-256-gcm', transport, nonce);
        c.setAAD(Buffer.from(request.id, 'utf8'));
        const ct = Buffer.concat([c.update(dek), c.final()]);
        await post('/api/vault/answer', { id: request.id, ok: true, dekSealed: Buffer.concat([nonce, ct, c.getAuthTag()]).toString('base64') });
      }
    }
  })();

  // The probe the app sends at boot, so enclaveReady() is true before the first verb.
  const probed = await vault.ask({ op: 'probe' });
  assert.ok(probed.ok);

  return {
    url,
    token,
    keystore,
    keysPath,
    vault,
    audit,
    post,
    get,
    seen,
    releases: () => releases,
    setMode: (m: Mode) => {
      dialog.mode = m;
    },
    swapMac: () => {
      const other = enclave();
      mac.priv = other.priv;
      mac.pub = other.pub;
    },
    close: async () => {
      running = false;
      vault.stop();
      await new Promise<void>((r) => server.close(() => r()));
      await shell.catch(() => undefined);
    },
  };
}

test('the relay routes refuse a caller without the window token', async () => {
  const b = await boot();
  try {
    const pending = await b.post('/api/vault/pending', { waitMs: 0 }, false);
    assert.equal(pending.status, 403);
    const answer = await b.post('/api/vault/answer', { id: 'x', ok: true }, false);
    assert.equal(answer.status, 403);
    const nothing = await b.post('/api/vault/answer', { id: 'x', ok: true });
    assert.equal(nothing.status, 409, 'an answer with nothing waiting is refused');
  } finally {
    await b.close();
  }
});

test('create: one call, one touch, and a wallet the enclave opened comes back with no phrase in it', async () => {
  const b = await boot();
  try {
    const before = await b.get('/api/vault');
    assert.equal(before.json.custody, null);
    assert.equal(before.json.enclave.ready, true);

    const made = await b.post('/api/vault/create', {});
    assert.equal(made.status, 200, JSON.stringify(made.json));
    assert.equal(made.json.ok, true);
    assert.equal(made.json.custody, 'secure-enclave');
    assert.match(made.json.addresses.evm, /^0x[0-9a-fA-F]{40}$/);
    assert.equal(made.json.mnemonic, undefined, 'the phrase is not handed out at creation');
    assert.equal(b.keystore.state(), 'unlocked', 'proven open by the touch, and left open');
    assert.deepEqual(b.seen.filter((s) => s.startsWith('create')), ['create:']);
    assert.ok(b.seen.includes('unwrap:Confirm your new Phosphor wallet'), 'the proving touch names itself');

    const after = await b.get('/api/vault');
    assert.equal(after.json.custody, 'secure-enclave');
    assert.equal(after.json.backedUp, false);
    assert.equal(after.json.enclave.binding, 'device');

    const state = await b.get('/api/state');
    assert.equal(state.json.vault.custody, 'secure-enclave');
    assert.ok(!/"(privateKey|secretKey|mnemonic|password)"/.test(JSON.stringify(state.json)), 'the state payload names key material');

    const twice = await b.post('/api/vault/create', {});
    assert.equal(twice.status, 409, 'a second wallet is refused');
  } finally {
    await b.close();
  }
});

test('a cancelled proving touch leaves no wallet behind', async () => {
  const b = await boot();
  try {
    b.setMode('cancel');
    const made = await b.post('/api/vault/create', {});
    // The create itself needs no dialog and succeeds; the confirm is what the person cancels.
    // In cancel mode every request is refused, so the create is refused too and nothing is written.
    assert.equal(made.json.ok, false);
    assert.equal(b.keystore.state(), 'no_wallet');
    assert.equal(fs.existsSync(b.keystore.path()), false);
  } finally {
    await b.close();
  }
});

test('unlock, reveal, prove and forget: each touch names itself and the phrase is proven, never copied', async () => {
  const b = await boot({ mode: 'live' });
  try {
    await b.post('/api/vault/create', {});
    b.keystore.lock();

    const byPassword = await b.post('/api/unlock', { password: 'anything' });
    assert.equal(byPassword.json.ok, false);
    assert.equal(byPassword.json.code, 'enclave_required');

    const opened = await b.post('/api/vault/unlock', {});
    assert.equal(opened.json.ok, true, JSON.stringify(opened.json));
    assert.equal(b.keystore.state(), 'unlocked');
    assert.equal(b.releases(), 1, 'an unlock releases the queue the way a password unlock does');
    assert.ok(b.seen.includes('unwrap:Open your Phosphor vault'));

    const revealed = await b.post('/api/vault/reveal', {});
    assert.equal(revealed.json.ok, true);
    assert.equal(revealed.json.words.length, 12);
    assert.equal(revealed.json.paths.evm, "m/44'/60'/0'/0/0");
    assert.ok(b.seen.includes('unwrap:Reveal your recovery phrase'), 'the reveal took its own touch even though the wallet was open');

    const words: string[] = revealed.json.words;
    const wrong = await b.post('/api/vault/backup-proven', { words: [{ index: 0, word: 'zebra' }, { index: 1, word: words[1] }, { index: 2, word: words[2] }] });
    assert.equal(wrong.json.ok, false);
    assert.equal(wrong.json.code, 'wrong_words');
    assert.equal((await b.get('/api/vault')).json.backedUp, false);

    const tooFew = await b.post('/api/vault/backup-proven', { words: [{ index: 0, word: words[0] }] });
    assert.equal(tooFew.json.ok, false);

    const right = await b.post('/api/vault/backup-proven', { words: [{ index: 3, word: ` ${words[3].toUpperCase()} ` }, { index: 7, word: words[7] }, { index: 11, word: words[11] }] });
    assert.equal(right.json.ok, true);
    assert.equal((await b.get('/api/vault')).json.backedUp, true);

    // Nothing in the audit log carries a word of the phrase.
    const log = JSON.stringify(b.audit.tail(200));
    for (const w of words) assert.ok(!new RegExp(`"${w}"`).test(log));

    const noConfirm = await b.post('/api/vault/forget', { confirm: 'yes' });
    assert.equal(noConfirm.status, 400);
    const gone = await b.post('/api/vault/forget', { confirm: 'FORGET' });
    assert.equal(gone.json.ok, true);
    assert.ok(b.seen.includes('presence:Forget this wallet on this Mac'));
    assert.equal(b.keystore.state(), 'no_wallet');
    assert.equal(fs.existsSync(b.keystore.path()), false);
    assert.equal((await b.get('/api/vault')).json.backedUp, false);
  } finally {
    await b.close();
  }
});

test('forget is refused until the phrase is proven backed up', async () => {
  const b = await boot({ mode: 'live' });
  try {
    await b.post('/api/vault/create', {});
    const refused = await b.post('/api/vault/forget', { confirm: 'FORGET' });
    assert.equal(refused.json.ok, false);
    assert.equal(refused.json.code, 'not_backed_up');
    assert.equal(b.keystore.state(), 'unlocked');
  } finally {
    await b.close();
  }
});

test('a wallet file from another Mac is named as foreign, and restore from the phrase replaces it', async () => {
  const b = await boot({ mode: 'live' });
  try {
    const made = await b.post('/api/vault/create', {});
    const revealed = await b.post('/api/vault/reveal', {});
    const phrase = (revealed.json.words as string[]).join(' ');
    b.keystore.lock();

    // A new Mac: the enclave does not know this key.
    b.swapMac();
    const opened = await b.post('/api/vault/unlock', {});
    assert.equal(opened.json.ok, false);
    assert.equal(opened.json.code, 'foreign');
    assert.equal((await b.get('/api/vault')).json.foreign, true);

    // Not backed up here, different phrase, but the file cannot be opened: restore is allowed.
    const restored = await b.post('/api/vault/restore', { mnemonic: phrase });
    assert.equal(restored.json.ok, true, JSON.stringify(restored.json));
    assert.equal(restored.json.addresses.evm, made.json.addresses.evm, 'the same wallet, behind the new enclave');
    assert.equal((await b.get('/api/vault')).json.foreign, false);
    assert.equal((await b.get('/api/vault')).json.backedUp, true, 'a phrase typed from a record is a backup');
    assert.equal(b.keystore.state(), 'unlocked');

    // Now proven backed up, restoring a different phrase is allowed too; a bad phrase never is.
    const bad = await b.post('/api/vault/restore', { mnemonic: 'abandon abandon abandon' });
    assert.equal(bad.json.ok, false);
    assert.equal(bad.json.code, 'bad_phrase');
  } finally {
    await b.close();
  }
});

test('restore over an unbacked wallet this Mac can open is refused', async () => {
  const b = await boot({ mode: 'live' });
  try {
    await b.post('/api/vault/create', {});
    const other = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const refused = await b.post('/api/vault/restore', { mnemonic: other });
    assert.equal(refused.json.ok, false);
    assert.equal(refused.json.code, 'not_backed_up');
  } finally {
    await b.close();
  }
});

test('a password wallet moves behind the enclave with the password once, and the password then opens nothing', async () => {
  const b = await boot();
  try {
    const password = 'a long enough password';
    const made = await b.post('/api/wallet/create', { password });
    assert.equal(made.json.ok, true);
    assert.equal((await b.get('/api/vault')).json.custody, 'software');

    const wrong = await b.post('/api/vault/migrate', { password: 'not it' });
    assert.equal(wrong.json.ok, false);
    assert.equal(wrong.json.code, 'wrong_password');

    const moved = await b.post('/api/vault/migrate', { password });
    assert.equal(moved.json.ok, true, JSON.stringify(moved.json));
    assert.equal((await b.get('/api/vault')).json.custody, 'secure-enclave');
    assert.ok(b.seen.includes('unwrap:Move your wallet behind the Secure Enclave'));
    assert.equal(b.keystore.state(), 'unlocked');
    assert.equal(b.keystore.keys().evm?.address, made.json.addresses.evm);

    b.keystore.lock();
    const stale = await b.post('/api/unlock', { password });
    assert.equal(stale.json.ok, false);
    assert.equal(stale.json.code, 'enclave_required');
    assert.equal((await b.post('/api/vault/unlock', {})).json.ok, true);
  } finally {
    await b.close();
  }
});

test('the vault prefs set the idle time and the deposit card is opened and watched', async () => {
  const b = await boot();
  try {
    const bad = await b.post('/api/vault/prefs', { idleMinutes: 7 });
    assert.equal(bad.status, 400);
    const ok = await b.post('/api/vault/prefs', { idleMinutes: 60 });
    assert.equal(ok.json.idleMinutes, 60);
    assert.equal((await b.get('/api/vault')).json.idleMinutes, 60);

    const shown = await b.post('/api/deposit/show', { chain: 'sol', symbol: 'sol', address: 'Dep0s1t' });
    assert.equal(shown.json.ok, true);
    assert.equal(shown.json.deposit.phase, 'watching');
    assert.equal(shown.json.deposit.symbol, 'SOL');
    assert.equal((await b.get('/api/deposit')).json.deposit.chain, 'sol');
    assert.equal((await b.get('/api/state')).json.deposit.phase, 'watching');
    const nope = await b.post('/api/deposit/show', { chain: 'btc', symbol: 'BTC' });
    assert.equal(nope.status, 400);
    const stopped = await b.post('/api/deposit/stop', {});
    assert.equal(stopped.json.ok, true);
    assert.equal((await b.get('/api/deposit')).json.deposit.phase, 'stopped');
  } finally {
    await b.close();
  }
});

test('with no shell relaying, the enclave verbs say so and the password path is untouched', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-vault-bare-'));
  const keysPath = path.join(dataDir, 'keys', 'keys.json');
  const keystore = createKeystore({ keysPath, kdf: fast });
  const token = crypto.randomBytes(32).toString('hex');
  const cfg: AppConfig = { mode: 'demo', port: 0, addresses: { evm: [], solana: [], near: [] }, economicTransferUsd: 10, candleProducts: [], dataDir, keysPath };
  const server = createServer({
    cfg,
    token,
    audit: createAudit(dataDir),
    store: createStore(dataDir),
    keystore,
    riskRows: [],
    ledger: { snapshot, intents: () => undefined, hyperliquid: () => undefined, refresh: async () => snapshot(), applyDemoTransfer: () => {} },
    market: createMarketData({ fetchImpl: (async () => ({ ok: true, json: async () => [], text: async () => '', headers: new Headers() })) as unknown as typeof fetch }),
    proposals: {
      proposeConsolidate: async () => { throw new Error('unused'); },
      proposePolicyChange: async () => { throw new Error('unused'); },
      proposeSwap: async () => { throw new Error('unused'); },
      proposeHlDeposit: async () => { throw new Error('unused'); },
      proposeHlWithdraw: async () => { throw new Error('unused'); },
      proposeIntentsDeposit: async () => { throw new Error('unused'); },
      proposeIntentsWithdraw: async () => { throw new Error('unused'); },
      proposeTrade: async () => { throw new Error('unused'); },
      proposeTradeChange: async () => { throw new Error('unused'); },
      approve: async () => { throw new Error('unused'); },
      refuse: async () => { throw new Error('unused'); },
      get: () => undefined,
      list: () => [],
      sessionSpentUsd: () => 0,
      releaseQueued: async () => 0,
      reconcileOnBoot: () => [],
      reconcile: () => Promise.reject(new Error('not wired in this stub')),
      settle: () => Promise.resolve(true),
      dailyLimit: (capUsd: number) => ({ capUsd, spentUsd: 0, resetsAt: null }),
    },
    getPolicy: () => defaultPolicy(),
    setKill: () => {},
    agents: createAgents(),
    getView: () => 'pro',
    setView: () => {},
    trade: {
      view: createTradeView('BTC'),
      payload: () => ({}) as never,
      read: () => ({}),
      batch: () => [],
      action: async () => ({ ok: false, detail: 'no venue in this test' }),
      plan: () => ({ ok: false as const, error: 'no venue in this test' }),
      meta: () => null,
      mark: () => null,
      free: () => null,
      onUpdate: () => {},
      stop: () => {},
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${url}/api/vault/create`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify({ token }) });
    const json = (await res.json()) as { ok: boolean; code: string };
    assert.equal(json.ok, false);
    assert.equal(json.code, 'enclave_unavailable');
    const status = await (await fetch(`${url}/api/vault`)).json() as { enclave: { attached: boolean; ready: boolean } };
    assert.equal(status.enclave.attached, false);
    assert.equal(status.enclave.ready, false);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
