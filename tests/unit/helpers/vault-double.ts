// The test-only service double for the custody flows: the vault service's own rules
// (src-tauri/se-helper/main.swift) compiled with the stand-in keychain, enclave and clock
// (tests/swift/VaultTestPlatform.swift), and a shell loop that relays to it the way
// src-tauri/src/enclave.rs does: it polls POST /api/vault/pending with the relay secret, adds the
// transport key to an unwrap and nothing else, and posts the service's answer back.
//
// It cannot reach a shipped build. The stand-in compiles to nothing without PHOSPHOR_TESTSEAM,
// which no build script passes; the binary is built here, into a test's temp folder, and the backend
// meets it only through the relay, which is the shell's job in the app
// (tests/unit/vault-service.test.ts, "the stand-in keychain is never in a shipped build").

import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir } from './tmp.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SERVICE = path.join(ROOT, 'src-tauri/se-helper/main.swift');
export const SEAM = path.join(ROOT, 'tests/swift/VaultTestPlatform.swift');
export const TEAM = 'TEAM4TESTS';
export const GROUP = `${TEAM}.com.karimbabasf.phosphor.vault`;
export const T0 = 1_800_000_000;

const work = tempDir('phosphor-vault-double-');
export const swiftc = process.platform === 'darwin' && spawnSync('swiftc', ['--version'], { env: { ...process.env, TMPDIR: work } }).status === 0;

let built: string | null = null;

/* One compile per test file, into its own temp folder with the module cache beside it. */
export function doubleBinary(): string {
  if (built !== null) return built;
  const out = path.join(work, 'vault-double');
  const args = ['-Onone', '-D', 'PHOSPHOR_STDIO', '-D', 'PHOSPHOR_TESTSEAM', '-module-name', 'se_helper', '-module-cache-path', path.join(work, 'mc'), '-o', out, SERVICE, SEAM];
  const run = spawnSync('swiftc', args, { encoding: 'utf8', env: { ...process.env, TMPDIR: work } });
  assert.equal(run.status, 0, `swiftc: ${run.stderr}`);
  built = out;
  return out;
}

export type Answer = Record<string, unknown> & { ok: boolean; error?: string };
export type Request = Record<string, unknown> & { id: string; op: string; reason?: string; keyBlob?: string };

type Stored = { keys: { tag: string; group: string; created: number }[]; markers: { tag: string; group: string; body: string }[]; calls: string[]; blobs: number };

/* One Mac: its keychain is a JSON file that outlives any backend started against it. */
export class VaultDouble {
  readonly store: string;
  team = TEAM;
  now = T0;
  fail: string | undefined;
  touch: 'cancel' | undefined;

  constructor(store?: string) {
    this.store = store ?? path.join(tempDir('phosphor-vault-mac-'), 'keychain.json');
  }

  run(request: Record<string, unknown>): Answer {
    // The service answers presence with the real Touch ID: no stand-in covers it, so it would put a
    // system dialog in front of whoever runs the tests. A test answers presence itself (a hook).
    assert.notEqual(request.op, 'presence', 'presence would open a real Touch ID dialog on this Mac: answer it in the test');
    const env: Record<string, string> = {
      PATH: '/usr/bin:/bin',
      PHOSPHOR_TEST_STORE: this.store,
      PHOSPHOR_TEST_TEAM: this.team,
      PHOSPHOR_TEST_NOW: String(this.now),
    };
    if (this.fail !== undefined) env.PHOSPHOR_TEST_FAIL = this.fail;
    if (this.touch !== undefined) env.PHOSPHOR_TEST_TOUCH = this.touch;
    const run = spawnSync(doubleBinary(), [], { input: JSON.stringify(request) + '\n', env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout) as Answer;
  }

  state(): Stored {
    if (!fs.existsSync(this.store)) return { keys: [], markers: [], calls: [], blobs: 0 };
    return JSON.parse(fs.readFileSync(this.store, 'utf8')) as Stored;
  }

  touches(): string[] {
    return this.state().calls.filter((c) => c.startsWith('agree'));
  }
}

/* What the shell does with one request, decided by a test before the service sees it:
   - run: the service answers, and that answer is posted;
   - answer: this answer is posted and the service is never asked;
   - after: the service answers, and the test may replace the answer before it is posted (not `then`: a hook is awaited);
   - drop: nothing is posted (the backend waits, or the test kills it). */
export type Hook =
  | { kind: 'run' }
  | { kind: 'answer'; answer: Answer }
  | { kind: 'after'; edit: (answer: Answer) => Answer | 'drop' | Promise<Answer | 'drop'> }
  | { kind: 'drop' };

export type Post = (route: string, body: Record<string, unknown>) => Promise<{ status: number; json: any }>;

export type Shell = { seen: Request[]; stop(): Promise<void> };

/* `post` sends to the backend with the relay secret, the way the shell does. */
export function relayTo(post: Post, double: VaultDouble, transport: Buffer, hook: (request: Request) => Hook | Promise<Hook> = () => ({ kind: 'run' })): Shell {
  const seen: Request[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      let pending: { status: number; json: any };
      try {
        pending = await post('/api/vault/pending', { waitMs: 200 });
      } catch {
        break;
      }
      if (pending.status !== 200) break;
      const request = pending.json?.request as Request | null;
      if (!request) continue;
      seen.push(request);
      const what = await hook(request);
      if (what.kind === 'drop') continue;
      let answer: Answer | 'drop';
      if (what.kind === 'answer') answer = what.answer;
      else if (request.op === 'presence') {
        // Never handed to the service, which would open a real Touch ID dialog (VaultDouble.run):
        // refused in words a test's assertion shows, rather than a loop that dies and a 150 s wait.
        answer = { ok: false, error: 'interaction_required', message: 'tests never open a real Touch ID dialog: answer presence in the hook' };
      } else {
        const asked = { ...request, ...(request.op === 'unwrap' ? { transportKey: transport.toString('base64') } : {}) };
        const ran = double.run(asked);
        answer = what.kind === 'after' ? await what.edit(ran) : ran;
      }
      if (answer === 'drop') continue;
      try {
        await post('/api/vault/answer', { ...answer, id: request.id });
      } catch {
        break;
      }
    }
  })();
  return {
    seen,
    stop: async () => {
      running = false;
      await loop.catch(() => undefined);
    },
  };
}
