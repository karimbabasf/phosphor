// The test-only service double for the custody flows: the vault service's own rules
// (src-tauri/se-helper/main.swift, and the chip key's ops in ChipOps.swift with the grammar they
// sign by) compiled with the stand-in keychain, enclave and clock
// (tests/swift/VaultTestPlatform.swift), and a shell loop that relays to it the way
// src-tauri/src/enclave.rs does: it polls POST /api/vault/pending with the relay secret, adds the
// transport key to an unwrap and nothing else, and posts the service's answer back. The stand-in's
// chip key is a software P-256 key: signIntent signs with it where the enclave would ask for a
// touch, and keeps the sentence the dialog would have shown.
//
// It cannot reach a shipped build. The stand-in compiles to nothing without PHOSPHOR_TESTSEAM,
// which no build script passes; the binary is built here, into a test's temp folder, and the backend
// meets it only through the relay, which is the shell's job in the app
// (tests/unit/vault-service.test.ts, "the stand-in keychain is never in a shipped build").
//
// It never opens a dialog: presence is refused before the service sees it (./no-dialog.ts).

import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DIALOG_OPS, developerTools, refuseDialog } from './no-dialog.ts';
import { tempDir } from './tmp.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SERVICE = path.join(ROOT, 'src-tauri/se-helper/main.swift');
// What PHOSPHOR_CHIP compiles in beside it, as scripts/build-se-helper.sh does.
export const CHIP_SOURCES = ['ChipOps.swift', 'IntentGrammar.swift', 'TokenTable.swift'].map((f) => path.join(ROOT, 'src-tauri/se-helper', f));
export const SEAM = path.join(ROOT, 'tests/swift/VaultTestPlatform.swift');
export const TEAM = 'TEAM4TESTS';
export const GROUP = `${TEAM}.com.karimbabasf.phosphor.vault`;
export const T0 = 1_800_000_000;

const work = tempDir('phosphor-vault-double-');
export const swiftc = developerTools() && spawnSync('swiftc', ['--version'], { env: { ...process.env, TMPDIR: work } }).status === 0;

let built: string | null = null;

/* One compile per test file, into its own temp folder with the module cache beside it. */
export function doubleBinary(): string {
  if (built !== null) return built;
  const out = path.join(work, 'vault-double');
  const args = ['-Onone', '-D', 'PHOSPHOR_STDIO', '-D', 'PHOSPHOR_TESTSEAM', '-D', 'PHOSPHOR_CHIP', '-module-name', 'se_helper', '-module-cache-path', path.join(work, 'mc'), '-o', out, SERVICE, ...CHIP_SOURCES, SEAM];
  const run = spawnSync('swiftc', args, { encoding: 'utf8', env: { ...process.env, TMPDIR: work } });
  assert.equal(run.status, 0, `swiftc: ${run.stderr}`);
  built = out;
  return out;
}

export type Answer = Record<string, unknown> & { ok: boolean; error?: string };
export type Request = Record<string, unknown> & { id: string; op: string; reason?: string; keyBlob?: string };

type Mark = { tag: string; group: string; body: string; created: number };
type Stored = {
  keys: { tag: string; group: string; created: number }[];
  markers: Mark[];
  calls: string[];
  blobs: number;
  chipMarkers?: Mark[];
  dialogs?: string[];
};

/* One Mac: its keychain is a JSON file that outlives any backend started against it. */
export class VaultDouble {
  readonly store: string;
  team = TEAM;
  now = T0;
  fail: string | undefined;
  touch: 'cancel' | undefined;
  // How the stand-in chip key's signature comes back (VaultTestPlatform.swift, PHOSPHOR_TEST_SIGN).
  sign: 'high' | 'low' | 'garbage' | 'otherkey' | undefined;
  enclave = true;

  constructor(store?: string) {
    this.store = store ?? path.join(tempDir('phosphor-vault-mac-'), 'keychain.json');
  }

  run(request: Record<string, unknown>): Answer {
    refuseDialog(request);
    const env: Record<string, string> = {
      PATH: '/usr/bin:/bin',
      PHOSPHOR_TEST_STORE: this.store,
      PHOSPHOR_TEST_TEAM: this.team,
      PHOSPHOR_TEST_NOW: String(this.now),
    };
    if (this.fail !== undefined) env.PHOSPHOR_TEST_FAIL = this.fail;
    if (this.touch !== undefined) env.PHOSPHOR_TEST_TOUCH = this.touch;
    if (this.sign !== undefined) env.PHOSPHOR_TEST_SIGN = this.sign;
    if (!this.enclave) env.PHOSPHOR_TEST_SE = '0';
    const run = spawnSync(doubleBinary(), [], { input: JSON.stringify(request) + '\n', env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout) as Answer;
  }

  state(): Stored {
    if (!fs.existsSync(this.store)) return { keys: [], markers: [], calls: [], blobs: 0 };
    return JSON.parse(fs.readFileSync(this.store, 'utf8')) as Stored;
  }

  /* Every call that would have put a Touch ID dialog in front of the owner: an unwrap's key
     agreement and a chip signature. */
  touches(): string[] {
    return this.state().calls.filter((c) => c.startsWith('agree') || c.startsWith('sign '));
  }

  /* The sentence each chip signature's dialog would have shown, in order. */
  dialogs(): string[] {
    return this.state().dialogs ?? [];
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
  const refused: string[] = [];
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
      else if (DIALOG_OPS.has(request.op)) {
        // Never handed to the service (refuseDialog). Answered with a refusal so the backend is not
        // left waiting out its 150 seconds, and the test fails when its shell stops.
        refused.push(request.op);
        answer = { ok: false, error: 'interaction_required', message: 'a test never opens a real Touch ID dialog' };
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
      assert.deepEqual(refused, [], `the shell was asked ${refused.join(', ')}, which would open a real Touch ID dialog on this Mac: answer it in the test's relay hook`);
    },
  };
}
