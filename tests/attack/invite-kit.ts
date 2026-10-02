// Shared kit for the 13- invite cases. Not a case (it lives outside cases/, so the runner never
// loads it as one). Everything here is throwaway: codes come from src/invite/code.ts's own
// generator, are never issued and never funded, and the only "network" a booted backend sees is
// the demo invite world (src/invite/demo.ts, PHOSPHOR_DEMO_INVITE), which is in memory and
// reaches nothing. No intent is ever published anywhere real.

import fs from 'node:fs';
import path from 'node:path';

import { bytesToHex } from 'viem';

import { bootBackend } from './harness.ts';
import type { Backend, BootOpts } from './harness.ts';
import { DEMO_INVITE_ENV } from '../../src/invite/demo.ts';
import { codeAddress, deriveKey, formatCode, generateSecret, inviteLink, looksLikeInviteCode } from '../../src/invite/code.ts';

export type TestCode = {
  code: string; // PHOS-XXXXX-XXXXX-XXXXX-XXXXX-XXXXXXX
  data: string; // the 27 data characters, no prefix, no hyphens
  address: string; // the code's account, lowercase
  secretHex: string; // 16 bytes, hex, no 0x
  keyHex: string; // the derived private key, hex, no 0x
  forms: Record<string, string>; // every form the contract names
};

export function makeCode(): TestCode {
  const secret = generateSecret();
  const code = formatCode(secret);
  const address = codeAddress(secret)!;
  const keyHex = deriveKey(secret)!.slice(2);
  const secretHex = bytesToHex(secret).slice(2);
  secret.fill(0);
  const data = code.slice(5).replace(/-/g, '');
  return {
    code,
    data,
    address,
    secretHex,
    keyHex,
    forms: {
      upper: code,
      lower: code.toLowerCase(),
      'no hyphens': 'PHOS' + data,
      spaces: code.replace(/-/g, ' '),
      'no-break spaces': code.replace(/-/g, ' '),
      PH0S: code.replace('PHOS', 'PH0S'),
      link: inviteLink(code),
      'after prose': 'phosphorus is used in matches ' + code,
      'after shaped prose': 'phosphorus is used in fertilizer and in matches ' + code,
    },
  };
}

// The needles a surface must not carry: the code in its forms, its data run, its secret and key.
export function needlesOf(c: TestCode): Record<string, string> {
  return {
    code: c.code.toLowerCase(),
    'code PH0S': c.code.toLowerCase().replace('phos', 'ph0s'),
    'data run': c.data.toLowerCase(),
    'first 3 groups': c.code.slice(5, 22).toLowerCase(),
    'spaced data': c.code.replace(/-/g, ' ').toLowerCase(),
    secret: c.secretHex.toLowerCase(),
    key: c.keyHex.toLowerCase(),
  };
}

// [needle name] hits in one surface (case-insensitive), plus a hit on anything the app's own guard
// reads as a code: the shape and two literal digits, which every issued code has (CONTRACTS.md, Code
// shape). The shape alone reads prose, this suite's own phos-attack-* temp paths included.
export function scan(surface: string, needles: Record<string, string>): string[] {
  const hay = surface.toLowerCase();
  const hits = Object.entries(needles)
    .filter(([, n]) => hay.includes(n))
    .map(([name]) => name);
  if (looksLikeInviteCode(surface)) hits.push('shape');
  return hits;
}

export type WorldRow = { usdc: string; landMs?: number; locked?: boolean; offline?: boolean; refusal?: string };

export function writeWorld(dir: string, accounts: Record<string, WorldRow>): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `invite-world-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ accounts }));
  return file;
}

export async function bootInvite(worldFile: string, opts: BootOpts = {}): Promise<Backend> {
  return bootBackend({ ...opts, mode: 'demo', env: { ...(opts.env ?? {}), [DEMO_INVITE_ENV]: worldFile } });
}

// The event stream, read as the window reads it (with its token), into a buffer.
export function openStream(app: Backend): { text(): string; frames(): any[]; close(): void } {
  const ac = new AbortController();
  const chunks: string[] = [];
  void (async () => {
    try {
      const res = await fetch(`${app.base}/api/events`, { signal: ac.signal, headers: { 'x-phosphor-token': app.token } });
      if (res.status !== 200) chunks.push(`[the stream answered ${res.status}]`);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(dec.decode(value, { stream: true }));
      }
    } catch {
      // aborted
    }
  })();
  return {
    text: () => chunks.join(''),
    frames: () =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => {
          try {
            return JSON.parse(l.slice(5).trim());
          } catch {
            return null;
          }
        })
        .filter((f) => f !== null),
    close: () => ac.abort(),
  };
}

export async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, ms: number, every = 150): Promise<T | null> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await probe();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, every));
  }
  return null;
}

export async function inviteState(app: Backend): Promise<any> {
  return (await app.get('/api/state')).json?.invite ?? null;
}

// Every file under a directory, path and utf8 text (binary read as latin1 so bytes still match).
export function filesUnder(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          out.push({ file: p, text: fs.readFileSync(p).toString('latin1') });
        } catch {
          // unreadable
        }
      }
    }
  };
  walk(dir);
  return out;
}

export function findKeystore(...roots: string[]): string | null {
  for (const root of roots) {
    const hit = filesUnder(root).find((f) => path.basename(f.file) === 'keys.enc.json');
    if (hit) return hit.file;
  }
  return null;
}

export function claimRecords(dataDir: string): any[] {
  const hit = filesUnder(dataDir).find((f) => path.basename(f.file) === 'invites.json');
  if (!hit) return [];
  try {
    return JSON.parse(hit.text).claims ?? [];
  } catch {
    return [];
  }
}
