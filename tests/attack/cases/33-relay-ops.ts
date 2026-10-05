// The enclave relay is two routes: the shell takes each request off POST /api/vault/pending and
// posts the service's answer to POST /api/vault/answer. Whoever answers there answers for Touch ID
// and the keychain: a forged unwrap answer is a wallet opened with no finger, a forged chipStatus
// whose marker names the vault is a chip the service never pinned, and a forged signIntent answer
// is a signature the service never made. So the window (its token), an agent (agent.secret), a
// guess (a wrong 64-hex secret) and nobody (no credential) all try to drain the queue and to answer.
//
// Method: the app's own backend (node src/main.ts) with the full five-line handshake (transport
// key, relay secret), on the stand-in Mac and the chain double, no network. It boots with no shell
// polling, so the probe it queues waits; the four strangers poll for it; then the shell (this case,
// holding the relay secret) takes it. While the shell holds an unwrap, a chipStatus whose marker
// would name the vault, and a signIntent, the strangers post forged answers for each, and the shell
// posts one with the right secret and a wrong request id; then the real answer goes back. A plain
// demo (no PHOSPHOR_DEMO_ENCLAVE) is booted beside it and asked to move the vault.
//
// Why: only the shell, holding the relay secret, may take or answer relay requests, and a demo never
// hands out a chip key write (a chip marker is a fact for the whole Mac). The shell's own half, the
// 12 ops it carries and the transport key only on an unwrap, is src-tauri/src/enclave.rs
// relay_tests (cargo test), named in the evidence and not run here.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, sleep } from '../harness.ts';
import { CHIP_WRITES, chipApp, chipState, moveVault, openWallet, secpKey, swiftc } from '../chip-kit.ts';
import type { ChipApp, Request } from '../chip-kit.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';

const RELAY_TEST = 'the_relay_carries_the_twelve_ops_and_the_transport_key_only_to_an_unwrap';

type Stranger = { who: string; body: Record<string, unknown>; headers: Record<string, string | null> };

function strangers(c: ChipApp): Stranger[] {
  const agent = fs.readFileSync(path.join(c.app.dataDir, 'agent.secret'), 'utf8').trim();
  const guess = crypto.randomBytes(32).toString('hex');
  return [
    { who: 'window token', body: { relay: c.app.token, token: c.app.token }, headers: { 'x-phosphor-token': c.app.token } },
    { who: 'agent.secret', body: { relay: agent, token: agent, secret: agent }, headers: { 'x-phosphor-token': agent } },
    { who: 'wrong 64-hex', body: { relay: guess }, headers: {} },
    { who: 'none', body: {}, headers: {} },
  ];
}

export const attack: AttackCase = {
  id: '33-relay-ops',
  title: 'only the shell, holding the relay secret, takes or answers relay requests; a demo hands out no chip key write',
  timeoutMs: 300_000,
  async run(ctx: AttackCtx): Promise<AttackResult> {
    if (!swiftc) return { expected: '', observed: '', pass: true, evidence: '', skipped: 'needs macOS with the developer tools (swiftc)' };
    const fails: string[] = [];
    const forged: { op: string; who: string; status: number }[] = [];
    const wrongId: number[] = [];
    let vault: string | null = null;
    let app: ChipApp | null = null;
    const done = new Set<string>();

    // The shell's hook: while it holds one of these requests, the strangers answer it first.
    const hook = async (r: Request): Promise<{ kind: 'run' }> => {
      const c = app!;
      const forgeries: Record<string, Record<string, unknown>> = {
        unwrap: { ok: true, dekSealed: crypto.randomBytes(60).toString('base64') },
        chipStatus: {
          ok: true,
          keychainHome: true,
          chips: [{ keyRef: `chip:com.karimbabasf.phosphor.chip.${crypto.randomUUID().toUpperCase()}`, publicKey: null, fresh: false, marker: { account: vault, allowance: `0x${'9e'.repeat(20)}`, recovery: secpKey(0x42), at: new Date().toISOString() } }],
        },
        signIntent: { ok: true, keyRef: r.keyRef, sentence: 'move 9,999.00 USDC from your vault to your allowance', signed: { standard: 'webauthn', payload: '{}', public_key: 'p256:1', signature: 'p256:1', client_data_json: '{}', authenticator_data: 'AA' } },
      };
      const forge = forgeries[r.op];
      if (forge === undefined || done.has(r.op) || (r.op === 'chipStatus' && vault === null)) return { kind: 'run' };
      done.add(r.op);
      for (const s of strangers(c)) {
        const res = await c.raw('/api/vault/answer', { ...forge, ...s.body, id: r.id }, s.headers);
        forged.push({ op: r.op, who: s.who, status: res.status });
      }
      // The right secret, the wrong request.
      const res = await c.raw('/api/vault/answer', { ...forge, relay: c.app.relaySecret, id: crypto.randomBytes(12).toString('hex') });
      wrongId.push(res.status);
      return { kind: 'run' };
    };

    const polls: { who: string; status: number }[] = [];
    let waitingBefore = '';
    let waitingAfter = '';
    let firstTaken = '';
    let moved = '';
    const c = await chipApp({ enclave: true, shell: false, scratch: ctx.scratch, hook });
    app = c;
    try {
      // 1. No shell yet: the probe waits. Each stranger polls for it.
      waitingBefore = (await c.get('/api/vault')).json?.waiting?.op ?? 'nothing';
      for (const s of strangers(c)) {
        const res = await c.raw('/api/vault/pending', { ...s.body, waitMs: 300 }, s.headers);
        polls.push({ who: s.who, status: res.status });
      }
      waitingAfter = (await c.get('/api/vault')).json?.waiting?.op ?? 'nothing';
      // 2. The shell, with the relay secret, takes it.
      c.startShell();
      for (let i = 0; i < 100 && c.seen.length === 0; i += 1) await sleep(50);
      firstTaken = c.seen[0]?.op ?? 'nothing';

      // 3. A wallet opened (an unwrap) and moved to the chip (chipStatus, signIntent), every one
      //    of them answered first by the strangers.
      const w = await openWallet(c);
      vault = w.vault;
      moved = (await moveVault(c)).ended;
      // Any request the move did not raise: a chipStatus naming the vault comes with the next state read.
      for (let i = 0; i < 40 && !done.has('chipStatus'); i += 1) {
        await chipState(c);
        await sleep(100);
      }
    } catch (err) {
      fails.push(`the shell's own flow broke: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
    } finally {
      await c.stop();
    }

    // The real answers to the three requests the strangers answered first were all taken.
    const realTaken = c.answers.filter((a) => a.status === 200).length;
    const realRefused = c.answers.filter((a) => a.status !== 200).length;
    if (!polls.every((p) => p.status === 403)) fails.push(`pending polls: ${JSON.stringify(polls)}`);
    if (waitingBefore !== 'probe' || waitingAfter !== 'probe' || firstTaken !== 'probe') fails.push(`the probe: waiting ${waitingBefore}->${waitingAfter}, the shell took ${firstTaken}`);
    if (!['unwrap', 'chipStatus', 'signIntent'].every((op) => done.has(op))) fails.push(`forged only ${[...done].join(',')}`);
    if (!forged.every((f) => f.status === 403)) fails.push(`forged answers: ${JSON.stringify(forged.filter((f) => f.status !== 403))}`);
    if (!wrongId.every((s) => s === 409) || wrongId.length !== 3) fails.push(`right secret, wrong id: ${wrongId.join(',')}`);
    if (moved !== 'done' || realRefused !== 0) fails.push(`the real flow: move ${moved}, ${realRefused} real answers refused`);

    // 4. A plain demo: across its boot and a move asked from the window, the relay hands out no chip write.
    const demo = await chipApp({ enclave: false, scratch: ctx.scratch });
    let demoMove = '';
    let demoOps: string[] = [];
    try {
      for (let i = 0; i < 60 && !demo.seen.some((r) => r.op === 'chipStatus'); i += 1) await sleep(50);
      const r = await demo.post('/api/vault/chip/move');
      demoMove = `${r.status} ${r.json?.code ?? r.json?.error ?? ''}`;
      const made = await demo.post('/api/vault/create');
      demoMove += `; create ${made.json?.ok === true ? 'MADE A KEY' : (made.json?.code ?? made.status)}`;
      await sleep(300);
      demoOps = demo.seen.map((x) => x.op);
    } finally {
      await demo.stop();
    }
    const demoWrites = demoOps.filter((op) => CHIP_WRITES.has(op) || op === 'create' || op === 'commit' || op === 'sweep');
    if (demoWrites.length > 0) fails.push(`the demo relay handed out ${demoWrites.join(',')}`);

    const rust = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'enclave.rs'), 'utf8');
    const shellHalf = rust.includes(`fn ${RELAY_TEST}()`) && rust.includes('assert_eq!(OPS.len(), 12)');
    if (!shellHalf) fails.push('src-tauri/src/enclave.rs no longer holds the 12-op relay test');

    const by = (op: string) => forged.filter((f) => f.op === op).map((f) => f.status).join('/');
    return {
      expected:
        'the window token, agent.secret, a wrong 64-hex secret and no credential get 403 on /api/vault/pending while the probe waits, and the shell still takes it; their forged answers to an unwrap, a chipStatus naming the vault and a signIntent get 403 and the real answers are taken; the right secret with a wrong id gets 409; a plain demo hands out no chipCreate, chipCommit or chipSweep',
      observed: `pending polls ${polls.map((p) => `${p.who} ${p.status}`).join(', ')}; waiting ${waitingBefore}->${waitingAfter}, shell took ${firstTaken}; forged unwrap ${by('unwrap')}, chipStatus ${by('chipStatus')}, signIntent ${by('signIntent')}; right secret wrong id ${wrongId.join('/')}; real answers ${realTaken} taken, ${realRefused} refused; move ${moved}; demo: move ${demoMove}, relay ops ${[...new Set(demoOps)].join(',')}; shell half ${shellHalf ? `relay_tests::${RELAY_TEST} present` : 'MISSING'}${fails.length ? `; FAILED: ${fails.join('; ').slice(0, 700)}` : ''}`,
      pass: fails.length === 0,
      evidence: `POST /api/vault/pending x4 strangers -> ${polls.map((p) => p.status).join('/')}, shell took ${firstTaken}; POST /api/vault/answer forged x4 on unwrap/chipStatus/signIntent -> ${by('unwrap')} ${by('chipStatus')} ${by('signIntent')}; wrong id -> ${wrongId.join('/')}; demo relay ops: ${[...new Set(demoOps)].join(',')}; shell half: src-tauri/src/enclave.rs relay_tests::${RELAY_TEST} (cargo, not run here)`,
    };
  },
};

export default attack;
