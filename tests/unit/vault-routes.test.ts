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
import { receiveNetworkOf } from '../../src/rails/intents-address.ts';
import type { IntentsReceiveNetwork } from '../../src/http/wallet.ts';
import type { AppConfig, LedgerSnapshot } from '../../src/types.ts';
import { stubView } from '../fixtures/view.ts';
import { ADDRESS_WAIT_MS, STATUS_LINK } from '../../src/preflight/route-health.ts';
import type { RouteAsk, RouteHealth } from '../../src/preflight/route-health.ts';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { isLocked, useKeystore } from '../../src/keystore/index.ts';
import { readApiWalletKey } from '../../src/runner/keys.ts';
import { createRunnerHost } from '../../src/runner/host.ts';
import { createSession } from '../../src/keystore/session.ts';
import { createPlanStore } from '../../src/trade/plans.ts';
import type { PlanRow } from '../../src/trade/plans.ts';
import type { FromChild, ToChild } from '../../src/runner/protocol.ts';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base58Encode } from '../../src/chain/near.ts';
import { tempDir } from './helpers/tmp.ts';
import { RAW, SERVICE_MESSAGE, VAULT_REFUSAL_CODES } from '../fixtures/vault-refusal-codes.ts';
import { refusal } from '../../src/http/wallet.ts';


function snapshot(): LedgerSnapshot {
  return { mode: 'demo', fetchedAt: new Date().toISOString(), prices: {} };
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

/* One report row off the registry, the way the live report builds it, so the fake report is
   the real shape and a field added to the contract fails here rather than in the window. */
function network(id: string, address: string, accepts: Array<{ symbol: string; minDeposit: string; minDepositHuman: string; decimals: number; contract: string | null }>): IntentsReceiveNetwork {
  const net = receiveNetworkOf(id);
  if (net === undefined) throw new Error(`no registry network ${id}`);
  return {
    ...net,
    address,
    memo: null,
    unavailable: null,
    sharedWith: [],
    warning: `${net.name} only.`,
    accepts: accepts.map((a) => ({ ...a, assetId: `nep141:${id}-${a.symbol.toLowerCase()}.omft.near`, minimum: { shown: true, amount: a.minDepositHuman, usd: null } })),
    changed: null,
    route: 'unknown',
    notice: null,
    statusLink: null,
    agentUnavailable: null,
    agentNotice: null,
  };
}

async function boot(opts: { mode?: AppConfig['mode']; routeHealth?: RouteHealth; seed?: (keysPath: string) => void } = {}) {
  const dataDir = tempDir('phosphor-vault-');
  const token = crypto.randomBytes(32).toString('hex');
  process.env.PHOSPHOR_WINDOW_TOKEN = token;
  const keysPath = path.join(dataDir, 'keys', 'keys.json');
  // A key file already on disk when the app starts, which this process has never opened.
  opts.seed?.(keysPath);
  const keystore = createKeystore({ keysPath, mode: opts.mode ?? 'demo', kdf: fast });
  const transport = crypto.randomBytes(32);
  const relaySecret = crypto.randomBytes(32).toString('hex');
  const vault = createVaultRelay({ transportKey: transport, secret: relaySecret });
  const cfg: AppConfig = {
    mode: opts.mode ?? 'demo',
    port: 0,
    addresses: {},
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
    ...(opts.routeHealth === undefined ? {} : { routeHealth: opts.routeHealth }),
    intentsReceive: async () => {
      const report = keystore.addressReport();
      return {
        account: report.addresses.evm,
        verified: report.verified,
        tampered: report.tampered,
        networks: [
          network('sol', 'Dep0s1tSoLaNaAddre55', [{ symbol: 'SOL', minDeposit: '10000000', minDepositHuman: '0.01', decimals: 9, contract: null }]),
          network('base', '0xbridge', [{ symbol: 'USDC', minDeposit: '1000000', minDepositHuman: '1', decimals: 6, contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }]),
          network('btc', 'bc1qbridge', [{ symbol: 'BTC', minDeposit: '5000', minDepositHuman: '0.00005', decimals: 8, contract: null }]),
        ],
      };
    },
    audit,
    store: createStore(dataDir),
    keystore,
    riskRows: [],
    ledger: { snapshot, intents: () => undefined, hyperliquid: () => undefined, refresh: async () => snapshot() },
    market: createMarketData({
      fetchImpl: (async () => ({ ok: true, json: async () => [], text: async () => '', headers: new Headers() })) as unknown as typeof fetch,
    }),
    proposals: {
      proposePolicyChange: async () => { throw new Error('unused'); },
      proposeSwap: async () => { throw new Error('unused'); },
      proposeHlDeposit: async () => { throw new Error('unused'); },
      proposeHlWithdraw: async () => { throw new Error('unused'); },
      proposeSend: async () => { throw new Error('unused'); },
      proposeTrade: async () => { throw new Error('unused'); },
      proposeTradeChange: async () => { throw new Error('unused'); },
      approve: async () => { throw new Error('unused'); },
      refuse: async () => { throw new Error('unused'); },
      get: () => undefined,
      list: () => [],
      view: (p) => stubView(p),
      markStalled: () => 0,
      sessionSpentUsd: () => 0,
      releaseQueued: async () => {
        releases += 1;
        return 0;
      },
      reconcileOnBoot: () => [],
      reconcileOpen: async () => 0,
      settled: async () => { throw new Error('unused'); },
      reconcile: () => Promise.reject(new Error('not wired in this stub')),
      acknowledge: () => Promise.reject(new Error('not wired in this stub')),
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
  /* The shell's two routes carry the relay secret, never the window token. */
  async function relayPost(route: string, body: Record<string, unknown>) {
    return post(route, { relay: relaySecret, ...body }, false);
  }
  async function get(route: string) {
    const res = await fetch(`${url}${route}`, { headers: { origin: url, 'x-phosphor-token': token } });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  }

  /* The fake shell. `mac` is the enclave it answers with; a request wrapped to a different
     enclave fails as the real one would, with crypto_failed. */
  const mac = enclave();
  /* `refuse` answers every request but the probe with that code and message, as the service or a
     relay refuses: the message is the kind of text the service writes for its logs. */
  const dialog: { mode: Mode; refuse: { error: string; message: string } | null } = { mode: 'answer', refuse: null };
  let running = true;
  const seen: string[] = [];
  const shell = (async () => {
    while (running) {
      const pending = await relayPost('/api/vault/pending', { waitMs: 200 });
      if (pending.status !== 200) break;
      const request = pending.json?.request;
      if (!request) continue;
      seen.push(`${request.op}:${request.reason ?? ''}`);
      if (dialog.refuse !== null && request.op !== 'probe') {
        await relayPost('/api/vault/answer', { id: request.id, ok: false, ...dialog.refuse });
        continue;
      }
      if (dialog.mode === 'cancel') {
        await relayPost('/api/vault/answer', { id: request.id, ok: false, error: 'user_cancel', message: 'cancelled' });
        continue;
      }
      if (request.op === 'probe') {
        await relayPost('/api/vault/answer', { id: request.id, ok: true, secureEnclave: true, biometry: 'touchid', canAuthenticate: true });
      } else if (request.op === 'create') {
        await relayPost('/api/vault/answer', { id: request.id, ok: true, keyBlob: crypto.randomBytes(64).toString('base64'), publicKey: mac.pub, binding: 'device' });
      } else if (request.op === 'presence') {
        await relayPost('/api/vault/answer', { id: request.id, ok: true });
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
          await relayPost('/api/vault/answer', { id: request.id, ok: false, error: 'foreign_key', message: 'not this enclave' });
          continue;
        }
        const nonce = crypto.randomBytes(12);
        const c = crypto.createCipheriv('aes-256-gcm', transport, nonce);
        c.setAAD(Buffer.from(request.id, 'utf8'));
        const ct = Buffer.concat([c.update(dek), c.final()]);
        await relayPost('/api/vault/answer', { id: request.id, ok: true, dekSealed: Buffer.concat([nonce, ct, c.getAuthTag()]).toString('base64') });
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
    relayPost,
    get,
    seen,
    releases: () => releases,
    setMode: (m: Mode) => {
      dialog.mode = m;
    },
    refuseWith: (error: string | null, message = '') => {
      dialog.refuse = error === null ? null : { error, message };
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

test('the relay routes take the relay secret and refuse the window token, which the page holds', async () => {
  const b = await boot();
  try {
    const pending = await b.post('/api/vault/pending', { waitMs: 0 }, false);
    assert.equal(pending.status, 403);
    const answer = await b.post('/api/vault/answer', { id: 'x', ok: true }, false);
    assert.equal(answer.status, 403);
    const withToken = await b.post('/api/vault/pending', { waitMs: 0 });
    assert.equal(withToken.status, 403, 'the window token is not the relay secret');
    const answerWithToken = await b.post('/api/vault/answer', { id: 'x', ok: true });
    assert.equal(answerWithToken.status, 403, 'a page cannot answer a request');
    const nothing = await b.relayPost('/api/vault/answer', { id: 'x', ok: true });
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

    const forAddress = await b.post('/api/vault/unlock', { purpose: 'address' });
    assert.equal(forAddress.json.ok, true, JSON.stringify(forAddress.json));
    assert.equal(b.keystore.state(), 'locked', 'showing an address opens no session');
    assert.equal(b.keystore.addressReport().verified, true, 'but the addresses are now verified');
    assert.equal(b.releases(), 0, 'and nothing queued was released');
    assert.ok(b.seen.includes('unwrap:Show your deposit address'));

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
    const [a, c, d]: number[] = revealed.json.prove;
    const wrong = await b.post('/api/vault/backup-proven', { words: [{ index: a, word: 'zebra' }, { index: c, word: words[c] }, { index: d, word: words[d] }] });
    assert.equal(wrong.json.ok, false);
    assert.equal(wrong.json.code, 'wrong_words');
    assert.equal((await b.get('/api/vault')).json.backedUp, false);

    const tooFew = await b.post('/api/vault/backup-proven', { words: [{ index: 0, word: words[0] }] });
    assert.equal(tooFew.json.ok, false);

    const right = await b.post('/api/vault/backup-proven', { words: [{ index: a, word: ` ${words[a].toUpperCase()} ` }, { index: c, word: words[c] }, { index: d, word: words[d] }] });
    assert.equal(right.json.ok, true);
    assert.equal((await b.get('/api/vault')).json.backedUp, true);

    // Nothing in the audit log carries the phrase, or any two of its words in order. One word
    // alone proves nothing: the list is plain English, and a random draw lands on "wallet"
    // or "window" about one run in four, which are audit keys and sentences.
    const log = JSON.stringify(b.audit.tail(200));
    assert.ok(!log.includes(words.join(' ')));
    for (let i = 0; i + 1 < words.length; i += 1) assert.ok(!log.includes(`${words[i]} ${words[i + 1]}`));

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

    await b.post('/api/vault/create', {});
    const shown = await b.post('/api/deposit/show', { chain: 'sol', symbol: 'sol', address: 'Attacker' });
    assert.equal(shown.json.ok, true, JSON.stringify(shown.json));
    assert.equal(shown.json.deposit.phase, 'watching');
    assert.equal(shown.json.deposit.symbol, 'SOL');
    assert.equal(shown.json.deposit.address, 'Dep0s1tSoLaNaAddre55', 'the address is the bridge\'s for this account, never the body\'s');
    const notCredited = await b.post('/api/deposit/show', { chain: 'sol', symbol: 'USDC' });
    assert.equal(notCredited.status, 409);
    assert.equal((await b.get('/api/deposit')).json.deposit.chain, 'sol');
    assert.equal((await b.get('/api/state')).json.deposit.phase, 'watching');
    // Any registry id opens the card, not only the five the app was born with.
    const bitcoin = await b.post('/api/deposit/show', { chain: 'btc', symbol: 'btc' });
    assert.equal(bitcoin.json.ok, true, JSON.stringify(bitcoin.json));
    assert.equal(bitcoin.json.deposit.chain, 'btc');
    assert.equal(bitcoin.json.deposit.address, 'bc1qbridge');
    assert.equal((await b.get('/api/deposit')).json.deposit.chain, 'btc');
    const nope = await b.post('/api/deposit/show', { chain: 'bitcoin', symbol: 'BTC' });
    assert.equal(nope.status, 400, 'the route takes registry ids, not names');
    const stopped = await b.post('/api/deposit/stop', {});
    assert.equal(stopped.json.ok, true);
    assert.equal((await b.get('/api/deposit')).json.deposit.phase, 'stopped');
  } finally {
    await b.close();
  }
});

test('the window asks the route for the exact asset before it draws an address: a closed one is refused with route and status page, by the read and by show', async () => {
  const usdc = 'nep141:base-usdc.omft.near';
  const asked: RouteAsk[] = [];
  const routeHealth: RouteHealth = {
    check: async (ask) => {
      asked.push(ask);
      const state = ask.asset === usdc ? 'closed' : 'open';
      return { network: ask.network, direction: ask.direction, state, reasons: [{ source: 'oneclick', state, text: '' }], checkedAt: 0 };
    },
  };
  const b = await boot({ routeHealth });
  try {
    await b.post('/api/vault/create', {});
    const open = await b.get('/api/deposit/route?chain=sol&symbol=sol');
    assert.equal(open.status, 200, JSON.stringify(open.json));
    assert.deepEqual(open.json, { ok: true, chain: 'sol', symbol: 'SOL', notice: null, statusLink: null });

    const closed = await b.get('/api/deposit/route?chain=base&symbol=usdc');
    assert.equal(closed.status, 409);
    assert.equal(closed.json.error, 'NEAR Intents has paused Base deposits right now, so no address is shown. Money sent now may not arrive.');
    assert.equal(closed.json.route, 'closed');
    assert.equal(closed.json.statusLink, STATUS_LINK);
    assert.deepEqual(asked.at(-1), { network: 'base', direction: 'in', account: asked.at(-1)?.account, asset: usdc, waitMs: ADDRESS_WAIT_MS });
    assert.equal((await b.get('/api/deposit')).json.deposit, null, 'the read started a watch');

    // Show refuses the same way, so the window can tell a pause from any other refusal.
    const shown = await b.post('/api/deposit/show', { chain: 'base', symbol: 'USDC' });
    assert.equal(shown.status, 409);
    assert.equal(shown.json.route, 'closed');
    assert.equal(shown.json.statusLink, STATUS_LINK);
    assert.equal((await b.get('/api/deposit')).json.deposit, null, 'a watch started on a closed route');

    const unknown = await b.get('/api/deposit/route?chain=base&symbol=DOGE');
    assert.equal(unknown.status, 409);
    assert.equal(unknown.json.route, undefined);
  } finally {
    await b.close();
  }
});

test('with no shell relaying, the enclave verbs say so and the password path is untouched', async () => {
  const dataDir = tempDir('phosphor-vault-bare-');
  const keysPath = path.join(dataDir, 'keys', 'keys.json');
  const keystore = createKeystore({ keysPath, kdf: fast });
  const token = crypto.randomBytes(32).toString('hex');
  const cfg: AppConfig = { mode: 'demo', port: 0, addresses: {}, candleProducts: [], dataDir, keysPath };
  const server = createServer({
    cfg,
    token,
    audit: createAudit(dataDir),
    store: createStore(dataDir),
    keystore,
    riskRows: [],
    ledger: { snapshot, intents: () => undefined, hyperliquid: () => undefined, refresh: async () => snapshot() },
    market: createMarketData({ fetchImpl: (async () => ({ ok: true, json: async () => [], text: async () => '', headers: new Headers() })) as unknown as typeof fetch }),
    proposals: {
      proposePolicyChange: async () => { throw new Error('unused'); },
      proposeSwap: async () => { throw new Error('unused'); },
      proposeHlDeposit: async () => { throw new Error('unused'); },
      proposeHlWithdraw: async () => { throw new Error('unused'); },
      proposeSend: async () => { throw new Error('unused'); },
      proposeTrade: async () => { throw new Error('unused'); },
      proposeTradeChange: async () => { throw new Error('unused'); },
      approve: async () => { throw new Error('unused'); },
      refuse: async () => { throw new Error('unused'); },
      get: () => undefined,
      list: () => [],
      view: (p) => stubView(p),
      markStalled: () => 0,
      sessionSpentUsd: () => 0,
      releaseQueued: async () => 0,
      reconcileOnBoot: () => [],
      reconcileOpen: async () => 0,
      settled: async () => { throw new Error('unused'); },
      reconcile: () => Promise.reject(new Error('not wired in this stub')),
      acknowledge: () => Promise.reject(new Error('not wired in this stub')),
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
    const status = await (await fetch(`${url}/api/vault`, { headers: { 'x-phosphor-token': token } })).json() as { enclave: { attached: boolean; ready: boolean } };
    assert.equal(status.enclave.attached, false);
    assert.equal(status.enclave.ready, false);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------- a touch opens only what it was asked for ----------

/* The runner the way src/main.ts wires it: an unlock the keystore announces starts reconcile,
   which re-arms a plan whose signing session ended while locked and forks a child with the
   trading key. The child here is a stand-in that records the key it was handed. */
class RecordingChild extends EventEmitter {
  connected = true;
  stderr = null;
  readonly keys: string[] = [];
  readonly stdin = Object.assign(new EventEmitter(), {
    write: (text: string): boolean => {
      this.keys.push(String(text).trim());
      return true;
    },
    end: (): void => {},
  });
  send(message: unknown): boolean {
    const m = message as ToChild;
    if (m.cmd === 'arm') setImmediate(() => this.emit('message', { ev: 'armed', seq: m.seq, id: m.plan.id } satisfies FromChild));
    return true;
  }
  kill(): boolean {
    this.connected = false;
    return true;
  }
}

const TRADING_KEY = `0x${'7a'.repeat(32)}` as const;

async function walletWithLockedPlan(b: Awaited<ReturnType<typeof boot>>) {
  assert.equal((await b.post('/api/vault/create', {})).json.ok, true);
  b.keystore.updatePayload((p) => ({ ...p, hyperliquidAgents: { mainnet: { privateKey: TRADING_KEY, address: '0x3333333333333333333333333333333333333333' } } }));
  b.keystore.lock();
  useKeystore(b.keystore);
  const store = createPlanStore(tempDir('phosphor-plans-'));
  const at = new Date().toISOString();
  store.put({
    id: 'p1', symbol: 'SOL', side: 'long', sizeUsd: 100, leverage: 2, entry: { type: 'market', maxSlippageBps: 30 }, stop: 90,
    when: [{ type: 'time', after: '2999-01-01T00:00:00.000Z' }], expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    status: 'waiting', locked: true, hash: 'hash-p1', cloids: {}, gen: 0, createdAt: at, updatedAt: at,
  } as PlanRow);
  const children: RecordingChild[] = [];
  const session = createSession({ isUnlocked: () => b.keystore.isUnlocked(), lock: () => b.keystore.lock() });
  const runner = createRunnerHost({
    apiWalletKey: async () => await readApiWalletKey(b.keysPath),
    baseUrl: 'https://api.hyperliquid.xyz',
    user: '0x2222222222222222222222222222222222222222',
    killSwitch: () => false,
    // As src/main.ts wires it.
    walletOpen: () => !isLocked(),
    onEvent: () => {},
    session,
    store,
    meta: () => ({ assetId: 1, szDecimals: 4, maxLeverage: 25 }),
    mark: () => 100,
    free: () => 1000,
    replyMs: 500,
    forkImpl: (() => {
      const child = new RecordingChild();
      children.push(child);
      return child as unknown as ChildProcess;
    }) as never,
  });
  runner.onAccount({ atMs: Date.now(), freeUsd: 1000, positions: [], orders: [], fills: [] });
  b.keystore.onChange((state) => {
    if (state === 'unlocked') void runner.reconcile(1_000).catch(() => undefined);
  });
  return { runner, session, store, children };
}

test('"Show your deposit address" verifies the address and re-arms nothing: no runner, no trading key, no session', async () => {
  const b = await boot({ mode: 'live' });
  try {
    const w = await walletWithLockedPlan(b);
    const shown = await b.post('/api/vault/unlock', { purpose: 'address' });
    assert.equal(shown.json.ok, true, JSON.stringify(shown.json));
    assert.ok(b.seen.includes('unwrap:Show your deposit address'));
    assert.equal(b.keystore.addressReport().verified, true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(b.keystore.state(), 'locked');
    assert.equal(b.keystore.keyHeld(), false, 'the touch read the payload once and kept nothing');
    assert.equal(w.children.length, 0, 'no runner was started');
    assert.equal(w.store.get('p1')?.locked, true, 'the plan still waits for an unlock');
    assert.deepEqual(w.session.armed(), [], 'no signing session opened');
    w.runner.stop();

    // The unlock the person asks for is the one that re-arms it.
    assert.equal((await b.post('/api/vault/unlock', {})).json.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(w.children.map((c) => c.keys), [[TRADING_KEY]]);
    assert.equal(w.store.get('p1')?.locked, undefined);
  } finally {
    useKeystore(null);
    await b.close();
  }
});

test('"Reveal your recovery phrase" shows the words and leaves a locked wallet locked, and the proof still works', async () => {
  const b = await boot({ mode: 'live' });
  try {
    const w = await walletWithLockedPlan(b);
    const revealed = await b.post('/api/vault/reveal', {});
    assert.equal(revealed.json.ok, true, JSON.stringify(revealed.json));
    assert.equal(revealed.json.words.length, 12);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(b.keystore.state(), 'locked');
    assert.throws(() => b.keystore.evmPrivateKey(), /locked/, 'no signature can be made off a reveal');
    assert.equal(b.releases(), 0);
    assert.equal(w.children.length, 0);
    w.runner.stop();

    const words: string[] = revealed.json.words;
    const typed = (revealed.json.prove as number[]).map((index) => ({ index, word: words[index] }));
    const right = await b.post('/api/vault/backup-proven', { words: typed });
    assert.equal(right.json.ok, true, 'proven against what the reveal left, with the wallet still locked');
    const again = await b.post('/api/vault/backup-proven', { words: typed });
    assert.equal(again.json.code, 'reveal_again', 'one reveal, one proof');
  } finally {
    useKeystore(null);
    await b.close();
  }
});

// ---------- a wallet with no phrase backs up its private key ----------

const PASSWORD = 'a long enough password';

/* A wallet the way the oldest ones came to be: a plaintext keys.json from the first keygen, an EVM
   key and a NEAR and a Solana key drawn at random beside it, encrypted under a password and then
   moved behind the enclave. No phrase anywhere, and the two older keys still sealed in the file.
   Every key is made fresh per run, so no key-shaped literal sits in the tree. */
async function keyWallet(b: Awaited<ReturnType<typeof boot>>, legacy = true): Promise<{ key: `0x${string}`; evm: string }> {
  const key = generatePrivateKey();
  const evm = privateKeyToAccount(key).address;
  const ed25519 = () => {
    const pair = crypto.generateKeyPairSync('ed25519');
    const seed = Buffer.from(pair.privateKey.export({ format: 'jwk' }).d as string, 'base64url');
    const pub = Buffer.from(pair.publicKey.export({ format: 'jwk' }).x as string, 'base64url');
    return { secret: base58Encode(Buffer.concat([seed, pub])), pub };
  };
  const solana = ed25519();
  const near = ed25519();
  fs.mkdirSync(path.dirname(b.keysPath), { recursive: true });
  fs.writeFileSync(b.keysPath, JSON.stringify({
    evm: { address: evm, privateKey: key },
    ...(legacy
      ? {
          solana: { address: base58Encode(solana.pub), secretKey: solana.secret },
          near: { accountId: near.pub.toString('hex'), secretKey: 'ed25519:' + near.secret },
        }
      : {}),
  }), { mode: 0o600 });
  await b.keystore.migrate(PASSWORD);
  const moved = await b.post('/api/vault/migrate', { password: PASSWORD });
  assert.equal(moved.json.ok, true, JSON.stringify(moved.json));
  const vault = (await b.get('/api/vault')).json;
  assert.deepEqual([vault.custody, vault.hasMnemonic, vault.backedUp], ['secure-enclave', false, false]);
  return { key, evm };
}

/* The key as a person types it back off the paper: the sixteen groups with spaces, and one
   character of group `slipped` changed when given, which is another wallet. */
const typedCopy = (groups: string[], slipped = -1) =>
  groups.map((g, i) => (i === slipped ? `${g.slice(0, 3)}${g[3] === 'a' ? 'b' : 'a'}` : g)).join(' ');

test('"Reveal your private key" shows a wallet with no phrase its key in sixteen groups, behind its own touch, and leaves a locked wallet locked', async () => {
  const b = await boot({ mode: 'live' });
  try {
    const w = await keyWallet(b);
    b.keystore.lock();
    const shown = await b.post('/api/vault/reveal-key', {});
    assert.equal(shown.json.ok, true, JSON.stringify(shown.json));
    const groups: string[] = shown.json.groups;
    assert.equal(groups.length, 16);
    assert.ok(groups.every((g) => /^[0-9a-f]{4}$/.test(g)), JSON.stringify(groups.map((g) => g.length)));
    assert.equal(`0x${groups.join('')}`, w.key, 'the groups are the key, in order');
    assert.equal(shown.json.address, w.evm, 'and they name the wallet they open');
    assert.equal(shown.json.prove, undefined, 'no three positions: the whole copy is what proves a key');
    assert.equal(shown.json.words, undefined);
    assert.deepEqual(b.seen.filter((s) => s === 'unwrap:Reveal your private key'), ['unwrap:Reveal your private key']);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(b.keystore.state(), 'locked', 'a reveal opens nothing');
    assert.equal(b.releases(), 0);

    // An open wallet still takes its own touch.
    assert.equal((await b.post('/api/vault/unlock', {})).json.ok, true);
    const again = await b.post('/api/vault/reveal-key', {});
    assert.deepEqual(again.json.groups, groups);
    assert.equal(b.seen.filter((s) => s === 'unwrap:Reveal your private key').length, 2);
    assert.equal((await b.get('/api/vault')).json.backedUp, false, 'shown is not proven');
  } finally {
    await b.close();
  }
});

/* A key has no checksum: three groups of sixteen pass a copy with one slipped group 13 times in 16,
   and the slip is simply another wallet. So the proof is the whole copy, and a copy one character
   off, in any group, proves nothing. */
test('the whole copy typed back proves the key; one character off in any group is another wallet and proves nothing', async () => {
  const b = await boot({ mode: 'live' });
  try {
    await keyWallet(b, false);
    const shown = await b.post('/api/vault/reveal-key', {});
    const groups: string[] = shown.json.groups;
    const touches = b.seen.length;

    for (const slipped of [0, 5, 9, 15]) {
      const wrong = await b.post('/api/vault/key-proven', { key: typedCopy(groups, slipped) });
      assert.deepEqual(wrong.json, { ok: false, error: 'That copy opens a different wallet. Check it group by group.', code: 'wrong_copy' }, 'the answer is the same whichever group slipped');
    }
    const short = await b.post('/api/vault/key-proven', { key: groups.slice(0, 15).join(' ') });
    assert.equal(short.json.code, 'bad_key');
    const threeGroups = await b.post('/api/vault/key-proven', { groups: [0, 1, 2].map((index) => ({ index, group: groups[index] })) });
    assert.equal(threeGroups.json.code, 'bad_key', 'three groups no longer prove a key');
    assert.equal((await b.get('/api/vault')).json.backedUp, false);

    // As a person copies it off paper: upper case, a line break, a 0x in front.
    const right = await b.post('/api/vault/key-proven', { key: `0X${groups.slice(0, 8).join(' ').toUpperCase()}\n${groups.slice(8).join(' ')}` });
    assert.equal(right.json.ok, true, JSON.stringify(right.json));
    assert.match(right.json.backedUpAt, /^\d{4}-\d{2}-\d{2}T/);
    const vault = (await b.get('/api/vault')).json;
    assert.deepEqual([vault.backedUp, vault.backedUpAt], [true, right.json.backedUpAt]);
    assert.equal((await b.get('/api/state')).json.vault.backedUp, true, 'the state carries the one flag');
    assert.equal(b.seen.length, touches, 'proving the copy asks for no Touch ID');
    const log = JSON.stringify(b.audit.tail(60));
    assert.ok(log.includes('the private key was proven backed up: the whole copy typed back opens this wallet'));
    assert.ok(log.includes('it opens a different wallet, so nothing changed'));
  } finally {
    await b.close();
  }
});

test('the phrase\'s route never proves a key, and a key is proven by its copy with no reveal in this run', async () => {
  const b = await boot({ mode: 'live' });
  try {
    const w = await keyWallet(b, false);
    const groups = w.key.slice(2).match(/.{4}/g) as string[];
    const crossed = await b.post('/api/vault/backup-proven', { words: [0, 1, 2].map((index) => ({ index, word: groups[index] })) });
    assert.equal(crossed.json.ok, false);
    assert.equal(crossed.json.code, 'reveal_again');
    assert.equal((await b.get('/api/vault')).json.backedUp, false);
    // The copy is the proof, so a copy written at another time proves it as well.
    assert.equal((await b.post('/api/vault/key-proven', { key: typedCopy(groups) })).json.ok, true);
    assert.equal((await b.get('/api/vault')).json.backedUp, true);
  } finally {
    await b.close();
  }
});

test('the key reveal is refused without the window token, for a wallet with a phrase before any dialog, and on a cancelled touch', async () => {
  const b = await boot({ mode: 'live' });
  try {
    for (const route of ['/api/vault/reveal-key', '/api/vault/key-proven']) {
      const knock = await b.post(route, { groups: [] }, false);
      assert.equal(knock.status, 403, route);
    }
    assert.ok(JSON.stringify(b.audit.tail(20)).includes('POST /api/vault/reveal-key rejected'), 'a knock without the token is audited');

    const none = await b.post('/api/vault/reveal-key', {});
    assert.equal(none.json.ok, false, 'no wallet, nothing to show');

    await b.post('/api/vault/create', {});
    const phrased = await b.post('/api/vault/reveal-key', {});
    assert.deepEqual(phrased.json, { ok: false, error: 'This wallet has a recovery phrase. Back up the phrase instead.', code: 'has_mnemonic' });
    assert.equal(b.seen.includes('unwrap:Reveal your private key'), false, 'a wallet with a phrase was asked for a touch');
  } finally {
    await b.close();
  }

  const c = await boot({ mode: 'live' });
  try {
    await keyWallet(c, false);
    c.setMode('cancel');
    const cancelled = await c.post('/api/vault/reveal-key', {});
    assert.equal(cancelled.json.ok, false);
    assert.equal(cancelled.json.code, 'user_cancel');
    assert.equal(cancelled.json.groups, undefined);
    c.setMode('answer');
    assert.equal((await c.get('/api/vault')).json.backedUp, false, 'a cancelled reveal proved something');
  } finally {
    await c.close();
  }
});

/* "The key never appears in any log, audit line, frame, state, error or file." Checked as text:
   the key whole, and every run of three groups, which is 48 bits no hash or id here repeats by
   chance. */
test('the key reaches no audit line, no state, no error and no file in the data directory', async () => {
  const b = await boot({ mode: 'live' });
  try {
    const w = await keyWallet(b);
    const shown = await b.post('/api/vault/reveal-key', {});
    const groups: string[] = shown.json.groups;
    const wrong = await b.post('/api/vault/key-proven', { key: typedCopy(groups, 3) });
    assert.equal(wrong.json.code, 'wrong_copy');
    const right = await b.post('/api/vault/key-proven', { key: typedCopy(groups) });
    assert.equal(right.json.ok, true);
    const refusals = [
      await b.post('/api/vault/restore', { key: w.key.slice(0, 60) }),
      await b.post('/api/vault/restore', { key: `${w.key}zz` }),
      await b.post('/api/vault/restore', { key: w.key }),
    ];
    assert.deepEqual(refusals.map((r) => r.json.code), ['bad_key', 'bad_key', 'same_wallet']);

    const hex = w.key.slice(2);
    const runs = groups.slice(0, 14).map((_, i) => groups.slice(i, i + 3).join(''));
    const leaks = (label: string, text: string): void => {
      const lower = text.toLowerCase().replace(/\s+/g, '');
      assert.ok(!lower.includes(hex), `${label} holds the key`);
      for (const run of runs) assert.ok(!lower.includes(run), `${label} holds three groups of the key`);
    };
    leaks('the audit log', JSON.stringify(b.audit.tail(500)));
    leaks('the state', JSON.stringify((await b.get('/api/state')).json));
    leaks('the vault status', JSON.stringify((await b.get('/api/vault')).json));
    leaks('the answers', JSON.stringify([wrong.json, right.json, ...refusals.map((r) => r.json)]));
    const dataDir = path.dirname(path.dirname(b.keysPath));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const at = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(at);
        else files.push(at);
      }
    };
    walk(dataDir);
    assert.ok(files.length > 2, files.join(', '));
    for (const file of files) leaks(path.relative(dataDir, file), fs.readFileSync(file).toString('utf8'));
    assert.ok(JSON.stringify(b.audit.tail(500)).includes('the private key was revealed in the window after a Touch ID'), 'the reveal is audited, as the phrase\'s is');
    assert.ok(JSON.stringify(b.audit.tail(500)).includes('the private key was proven backed up'));
  } finally {
    await b.close();
  }
});

/* The round trip the bind flow depends on: what the backup showed, typed into a new data
   directory, is the same wallet. The older NEAR and Solana keys are not in the backup (they sign
   nothing and no screen shows them), so they do not come back. */
test('restore takes the key back exactly as the backup shows it, and a new data directory holds the same wallet', async () => {
  const first = await boot({ mode: 'live' });
  let shown: { groups: string[]; address: string };
  let evm: string;
  try {
    evm = (await keyWallet(first)).evm;
    shown = (await first.post('/api/vault/reveal-key', {})).json;
    assert.equal((await first.post('/api/vault/key-proven', { key: typedCopy(shown.groups) })).json.ok, true);
  } finally {
    await first.close();
  }

  const copies = [
    shown.groups.join(' '),
    `0x${shown.groups.join('')}`,
    `${shown.groups.slice(0, 8).join(' ').toUpperCase()}\n${shown.groups.slice(8).join(' ').toUpperCase()}`,
  ];
  for (const copy of copies) {
    const next = await boot({ mode: 'live' });
    try {
      assert.equal(next.keystore.state(), 'no_wallet');
      const restored = await next.post('/api/vault/restore', { key: copy });
      assert.equal(restored.json.ok, true, JSON.stringify(restored.json));
      assert.equal(restored.json.addresses.evm, evm, `the same wallet from ${JSON.stringify(copy.slice(0, 4))}...`);
      assert.equal(restored.json.addresses.evm, shown.address);
      assert.deepEqual([restored.json.addresses.solana, restored.json.addresses.near], [null, null]);
      assert.ok(next.seen.includes('unwrap:Restore a wallet from its private key'), 'the restore names itself');
      const vault = (await next.get('/api/vault')).json;
      assert.deepEqual([vault.custody, vault.hasMnemonic, vault.backedUp], ['secure-enclave', false, true]);
      assert.equal(next.keystore.state(), 'unlocked');
      assert.equal(next.keystore.evmPrivateKey(), `0x${shown.groups.join('')}`);
      // And the restored wallet backs up the same key again.
      const again = await next.post('/api/vault/reveal-key', {});
      assert.deepEqual(again.json.groups, shown.groups);
    } finally {
      await next.close();
    }
  }
});

test('a key restore is refused in words that quote none of it, over the same wallet this Mac opens, and over an unbacked one', async () => {
  const b = await boot({ mode: 'live' });
  try {
    for (const key of ['', 'not a key at all', `0x${'00'.repeat(32)}`, `0x${'ab'.repeat(31)}`]) {
      const bad = await b.post('/api/vault/restore', { key });
      assert.equal(bad.json.ok, false);
      assert.equal(bad.json.code, 'bad_key');
      assert.ok(!bad.json.error.includes('abab') && !bad.json.error.includes('not a key'), bad.json.error);
    }
    assert.equal(b.keystore.state(), 'no_wallet', 'a bad key wrote nothing');

    const w = await keyWallet(b, false);
    const same = await b.post('/api/vault/restore', { key: w.key });
    assert.deepEqual(same.json, { ok: false, error: 'This Mac already holds that wallet, and it opens with Touch ID.', code: 'same_wallet' });
    const other = await b.post('/api/vault/restore', { key: generatePrivateKey() });
    assert.equal(other.json.code, 'not_backed_up', 'an unbacked wallet this Mac opens was replaced');
    assert.equal(b.keystore.addresses().evm, w.evm);

    // On another Mac the file cannot be opened, so the same key is how the wallet comes back.
    b.keystore.lock();
    b.swapMac();
    assert.equal((await b.post('/api/vault/unlock', {})).json.code, 'foreign');
    const back = await b.post('/api/vault/restore', { key: w.key });
    assert.equal(back.json.ok, true, JSON.stringify(back.json));
    assert.equal(back.json.addresses.evm, w.evm);
    assert.equal((await b.get('/api/vault')).json.foreign, false);
  } finally {
    await b.close();
  }
});

/* The flag the bind flow reads belongs to the wallet it was proven for. A key file put in place
   from outside the app (here: a password wallet imported over a forgotten one, which no route
   clears the flag for) does not inherit it; forgetting through the app clears it. */
test('a proven backup belongs to its wallet: a different wallet in its place reads as not backed up', async () => {
  const b = await boot({ mode: 'live' });
  try {
    await keyWallet(b, false);
    const shown = await b.post('/api/vault/reveal-key', {});
    assert.equal((await b.post('/api/vault/key-proven', { key: typedCopy(shown.json.groups) })).json.ok, true);
    assert.equal((await b.get('/api/vault')).json.backedUp, true);

    b.keystore.forget();
    const imported = await b.post('/api/wallet/import', { password: PASSWORD, keys: { evm: generatePrivateKey() } });
    assert.equal(imported.json.ok, true, JSON.stringify(imported.json));
    const vault = (await b.get('/api/vault')).json;
    assert.deepEqual([vault.backedUp, vault.backedUpAt], [false, null]);
    assert.equal((await b.get('/api/state')).json.vault.backedUp, false);
    const forget = await b.post('/api/vault/forget', { confirm: 'FORGET' });
    assert.equal(forget.json.code, 'not_backed_up', 'another wallet\'s proof let this one be forgotten');
  } finally {
    await b.close();
  }
});

/* Check my copy is the proof's check again, for a key already proven: it must never be a restore in
   disguise, and never a proof: no Touch ID, nothing written, and the answer is yes or no. */
test('Check my copy says whether a whole key is this wallet\'s, with no Touch ID and nothing written', async () => {
  const b = await boot({ mode: 'live' });
  try {
    const w = await keyWallet(b, false);
    const before = fs.readFileSync(b.keystore.path(), 'utf8');
    const touches = b.seen.length;
    const groups = w.key.slice(2).match(/.{4}/g) as string[];
    for (const copy of [w.key, groups.join(' '), `0X${groups.join(' ').toUpperCase()}`, `${groups.slice(0, 8).join('-')}\n${groups.slice(8).join('-')}`]) {
      const said = await b.post('/api/vault/key-check', { key: copy });
      assert.deepEqual(said.json, { ok: true, matches: true }, JSON.stringify(copy.slice(0, 6)));
    }
    // One character off is another wallet, and the answer does not say where.
    const slip = `${w.key.slice(0, 40)}${w.key[40] === 'a' ? 'b' : 'a'}${w.key.slice(41)}`;
    const wrong = await b.post('/api/vault/key-check', { key: slip });
    assert.deepEqual(wrong.json, { ok: true, matches: false });
    const bad = await b.post('/api/vault/key-check', { key: w.key.slice(0, 50) });
    assert.equal(bad.json.code, 'bad_key');
    assert.equal(b.seen.length, touches, 'a check asked for a Touch ID');
    assert.equal(fs.readFileSync(b.keystore.path(), 'utf8'), before, 'a check wrote the key file');
    assert.equal((await b.get('/api/vault')).json.backedUp, false, 'a check is not a proof');
    const log = JSON.stringify(b.audit.tail(100));
    assert.ok(log.includes('a copy of the private key was checked in the window: it matches this wallet'));
    assert.ok(log.includes('it does not match this wallet'));
    assert.ok(!log.includes(w.key.slice(2)) && !log.includes(slip.slice(2)), 'the audit log holds a key');
    assert.equal((await b.post('/api/vault/key-check', { key: w.key }, false)).status, 403, 'a check without the window token');
  } finally {
    await b.close();
  }

  // A wallet this process has never opened has only its header's address, which nothing has
  // checked, so the check waits for an open rather than answer against it.
  const key = generatePrivateKey();
  const c = await boot({
    mode: 'live',
    seed: (keysPath) => {
      const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' }) as { x: string; y: string };
      const pub = Buffer.concat([Buffer.from([0x04]), Buffer.from(ec.x, 'base64url'), Buffer.from(ec.y, 'base64url')]).toString('base64');
      createKeystore({ keysPath, kdf: fast }).importWithEnclave({ keyBlob: crypto.randomBytes(64).toString('base64'), publicKey: pub, createdAt: new Date().toISOString() }, { keys: { evm: key } });
    },
  });
  try {
    assert.equal(c.keystore.state(), 'locked');
    assert.equal(c.keystore.addressReport().verified, false);
    const unopened = await c.post('/api/vault/key-check', { key });
    assert.equal(unopened.json.ok, false);
    assert.equal(unopened.json.code, 'unverified');
    const unproven = await c.post('/api/vault/key-proven', { key });
    assert.equal(unproven.json.code, 'unverified', 'a proof against a header nothing checked');
    assert.equal((await c.get('/api/vault')).json.backedUp, false);
  } finally {
    await c.close();
  }
});

/* Every code the service or a relay can answer, sent back on a create, an unlock and a reveal: the
   answer is the app's sentence for it, and nothing the service wrote for its logs reaches `error`.
   The review saw "no user present" and "keychain key -25300" on screen this way. */
for (const code of VAULT_REFUSAL_CODES) {
  test(`${code}: a create, an unlock and a reveal answer in the app's words, never the service's own`, async () => {
    const b = await boot();
    try {
      const said = (json: any, want: string, where: string): void => {
        assert.equal(json.ok, false, `${where}: ${JSON.stringify(json)}`);
        assert.equal(json.code, want, where);
        assert.equal(json.error, refusal(want).error, `${where}: the sentence is the one the app has for ${want}`);
        assert.ok(!RAW.test(String(json.error)), `${where}: ${json.error}`);
        for (const part of SERVICE_MESSAGE.split('; ')) assert.ok(!String(json.error).includes(part), `${where}: the service's message reached the window: ${json.error}`);
      };
      const general = code === 'no_relay' || code === 'helper_missing' ? 'enclave_unavailable' : code;

      b.refuseWith(code, SERVICE_MESSAGE);
      said((await b.post('/api/vault/create', {})).json, general, 'create');
      assert.equal(b.keystore.state(), 'no_wallet');

      b.refuseWith(null);
      assert.equal((await b.post('/api/vault/create', {})).json.ok, true);
      b.keystore.lock();

      b.refuseWith(code, SERVICE_MESSAGE);
      said((await b.post('/api/vault/unlock', {})).json, code === 'foreign_key' ? 'foreign' : code === 'crypto_failed' ? 'damaged' : general, 'unlock');
      said((await b.post('/api/vault/reveal', {})).json, code === 'foreign_key' ? 'foreign' : code === 'crypto_failed' ? 'reveal_failed' : general, 'reveal');
    } finally {
      await b.close();
    }
  });
}
