// A stranger process goes around the app and asks the enclave XPC service itself for a chip op:
// signIntent, with a well-formed chip keyRef and a top-up payload the grammar would take, and
// chipCreate, which would put a key in Phosphor's keychain home. Case 12 proves the service answers
// only the shell for the probe; this proves the same doors hold for the two chip ops that matter,
// asked by the very callers case 12 plays.
//
// Method: scripts/xpc-attack.sh with its optional request argument, per build: a plain process, a
// stranger beside the shell, a foreign app hosting a byte-identical copy of the service, and that
// foreign app under com.karimbabasf.phosphor each send the chip request (the shell's own
// --enclave-probe still sends the probe). Nothing reaches a real key: on a Developer ID build every
// stranger is refused at the connection, and an ad-hoc build has no Team ID, so its service answers
// every chip op keychain_unavailable before any keychain call (ChipOps.swift chipHome).
//
// Why: the chip key signs only for the shell. A chip op answered for anyone else, even one that
// fails later, is a door into the keychain home.

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { ROOT, teamOf } from '../harness.ts';
import { USDC, transfer, vaultPayload } from '../chip-kit.ts';
import type { AttackCase, AttackCtx, AttackResult } from '../types.ts';

function probe(app: string, request: string): { status: number; out: string } {
  const r = spawnSync('/bin/sh', [path.join(ROOT, 'scripts', 'xpc-attack.sh'), app, request], { cwd: ROOT, encoding: 'utf8', timeout: 170_000 });
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/* The probe's verdict for one chip request: the three strangers refused, the shell answered, no
   FAIL line, and #4 refused, or on an ad-hoc build answered keychain_unavailable and nothing else. */
function verdict(label: string, op: string, p: { status: number; out: string }, signed: boolean): { pass: boolean; line: string; short: string } {
  const lines = p.out.split('\n');
  const step = (n: number): string[] => {
    const at = lines.findIndex((l) => l.startsWith(`${n}. `));
    const end = lines.findIndex((l, i) => i > at && /^\d\. /.test(l));
    return at < 0 ? [] : lines.slice(at + 1, end < 0 ? undefined : end).map((l) => l.trim());
  };
  const fails = lines.filter((l) => /^\s*FAIL\b/.test(l)).map((l) => l.trim());
  const plain = step(2).some((l) => /^ok\s+plain process: REFUSED/.test(l));
  const beside = step(2).some((l) => /^ok\s+in a bundle named .*: REFUSED/.test(l));
  const foreign = step(3).some((l) => /^ok\s+REFUSED/.test(l));
  const four = step(4).find((l) => /^(ok|known|FAIL)\b/.test(l)) ?? '(no line)';
  const fourRefused = /^ok\s+REFUSED/.test(four);
  // Read as JSON, not as text: the service writes its keys sorted.
  const fourKeychain = (() => {
    const json = /^known\s+ANSWERED (\{.*\})\s+<-/.exec(four)?.[1];
    if (json === undefined) return false;
    try {
      const a = JSON.parse(json) as Record<string, unknown>;
      return a.ok === false && a.error === 'keychain_unavailable' && Object.keys(a).every((k) => ['ok', 'error', 'message'].includes(k));
    } catch {
      return false;
    }
  })();
  const shell = step(5).some((l) => /^ok\s+\{.*"ok":true/.test(l));
  const fourOk = signed ? fourRefused : fourRefused || fourKeychain;
  const pass = p.status === 0 && fails.length === 0 && plain && beside && foreign && fourOk && shell;
  const fourSaid = fourRefused ? 'REFUSED' : fourKeychain ? 'answered keychain_unavailable (ad-hoc, no Team ID)' : `"${four.slice(0, 140)}"`;
  return {
    pass,
    line: `${label} ${op}: exit ${p.status}, plain ${plain ? 'REFUSED' : 'NOT REFUSED'}, beside the shell ${beside ? 'REFUSED' : 'NOT REFUSED'}, foreign app ${foreign ? 'REFUSED' : 'NOT REFUSED'}, #4 ${fourSaid}, shell probe answered ${shell}, FAIL ${fails.length}${fails.length ? ` [${fails.join('; ').slice(0, 200)}]` : ''}`,
    short: `${label} ${op} exit ${p.status}, 3 strangers ${plain && beside && foreign ? 'REFUSED' : 'NOT ALL REFUSED'}, #4 ${fourRefused ? 'REFUSED' : fourKeychain ? 'keychain_unavailable' : 'OTHER'}, ${fails.length} FAIL`,
  };
}

export const attack: AttackCase = {
  id: '30-xpc-sign-intent',
  title: 'a stranger asking the enclave XPC service for signIntent or chipCreate is refused: no chip op reaches a key from outside the shell',
  needsBuiltApp: true,
  timeoutMs: 720_000,
  async run(ctx: AttackCtx): Promise<AttackResult> {
    const apps = [...new Set([ctx.builtApp, ctx.signedApp].filter((a): a is string => a !== null))];
    if (apps.length === 0) return { expected: '', observed: '', pass: true, evidence: '', skipped: 'no build' };

    // A keyRef the service would read as a chip's, for a key no Mac holds, and a top-up the grammar
    // would take (seven-day nonce, a deadline a minute out). A stranger that got this signed would
    // hold a vault payload.
    const keyRef = `chip:com.karimbabasf.phosphor.chip.${crypto.randomUUID().toUpperCase()}`;
    const vault = `0x${'5a'.repeat(20)}`;
    const payload = vaultPayload({ signer: vault, deadlineMs: Date.now() + 60_000, intents: [transfer(USDC, '5000000', `0x${'6b'.repeat(20)}`)] });
    const requests: [string, string][] = [
      ['signIntent', JSON.stringify({ op: 'signIntent', keyRef, payload })],
      ['chipCreate', JSON.stringify({ op: 'chipCreate', label: 'attack30' })],
    ];

    let pass = true;
    const parts: string[] = [];
    const shorts: string[] = [];
    for (const app of apps) {
      const team = teamOf(app);
      const label = team ? `Developer ID (${team})` : 'ad-hoc';
      for (const [op, request] of requests) {
        const v = verdict(label, op, probe(app, request), team !== null);
        pass &&= v.pass;
        parts.push(v.line);
        shorts.push(v.short);
      }
    }
    return {
      expected:
        'no FAIL line; for signIntent and chipCreate the plain process, the stranger beside the shell and the foreign app are REFUSED; #4 is REFUSED on Developer ID, and on ad-hoc only an answer of ok false, error keychain_unavailable (and its message) is acceptable; the shell still answers its probe',
      observed: parts.join(' | '),
      pass,
      evidence: `sh scripts/xpc-attack.sh <app> '<chip request>' -> ${shorts.join('; ')}`,
    };
  },
};

export default attack;
