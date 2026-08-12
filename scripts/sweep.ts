// Phosphor secret sweep. Answers one question: if this repo were pushed right now, would
// anything secret go with it? Run: npm run sweep. Exit 0 means no, exit 1 means stop.
//
// The claim under test is Karim's instruction for the remote: config and installable code
// only, no private keys, no addresses, no state. Six checks, all of which must pass:
//
//   1. tracked content   every file `git ls-files` names, scanned for key shaped material.
//   2. local addresses   every identifying value in config.local.json and the keys file,
//                        searched for by literal across the tracked tree and the history.
//                        A real wallet address is information about Karim even though it is
//                        not a secret, and he asked for neither to be published.
//   3. ignored paths     config.local.json, keys.json, .env*, state/ are untracked AND ignored.
//   4. keys outside repo keysPath resolves outside the working copy, so git cannot reach it.
//   5. git history       every blob reachable from every ref, scanned like check 1. A file
//                        deleted from the working tree is still published if a commit holds
//                        it, so scanning the working tree alone proves nothing.
//   6. config load       config.json parses, since it is itself published.
//
// This program never prints a secret it finds. A finding names the file, the line and the
// pattern, plus an eight character sha256 prefix so two findings can be recognised as the
// same value. Printing the match would put the secret in a terminal, a scrollback buffer and
// very likely a CI log, which is the exact outcome the sweep exists to prevent.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function git(args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd: ROOT,
    input,
    maxBuffer: 512 * 1024 * 1024,
    encoding: 'latin1',
  });
}

// ---------- patterns ----------

type Pattern = { name: string; re: RegExp; note: string };

// Every pattern is anchored on both sides against its own character class, so a 64 character
// hex run inside a 100 character one does not report four overlapping findings.
const PATTERNS: Pattern[] = [
  {
    name: 'hex64',
    re: /(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g,
    note: 'a 32 byte value: an EVM private key, an ed25519 seed, a NEAR implicit account id',
  },
  {
    name: 'base58-64byte',
    re: /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{87,88}(?![1-9A-HJ-NP-Za-km-z])/g,
    note: 'a 64 byte base58 value: a Solana or NEAR secret key',
  },
  {
    name: 'ed25519-key',
    // 43 characters is the shortest base58 encoding of 32 bytes, so a documentation
    // placeholder like ed25519:<base58> does not match but a real key always does.
    re: /ed25519:[1-9A-HJ-NP-Za-km-z]{43,88}/g,
    note: 'a NEAR formatted ed25519 key',
  },
  {
    name: 'pem-block',
    re: /-----BEGIN[ A-Z]*(PRIVATE KEY|RSA|EC|OPENSSH)[ A-Z]*-----/g,
    note: 'a PEM encoded private key block',
  },
];

// A BIP39 mnemonic is 12, 15, 18, 21 or 24 words from a fixed list. Matching prose against a
// word count alone fires on every English paragraph, so the test is structural instead: the
// run must be the whole of a line or the whole of a quoted string, all lowercase, no
// punctuation and no digits. That is how a seed phrase is actually stored in a file. The
// limitation is real and worth stating: a mnemonic buried mid sentence in prose is missed.
const MNEMONIC_WORDS = [12, 15, 18, 21, 24];
const WORD_RUN = /^[a-z]{3,8}(?: [a-z]{3,8})+$/;

function isMnemonicRun(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (!WORD_RUN.test(trimmed)) return false;
  return MNEMONIC_WORDS.includes(trimmed.split(' ').length);
}

type Finding = { where: string; file: string; line: number; pattern: string; fingerprint: string };

function fingerprint(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
}

// Values allowed by exact string and nothing else. The allowlist is deliberately not by file
// and not by pattern: a real private key added to keygen.ts still trips, because only these
// exact strings are excused. Every entry names its source, and adding one is a human decision.
const KNOWN_PUBLIC_CONSTANTS = new Map<string, string>([
  // The canonical Ethereum documentation key, published for decades, holding nothing on any
  // chain. keygen.ts asserts it derives 0x2c7536E3605D9C16a7a3D7b1898e529396a65c23 on every
  // run, which is what proves the address derivation is keccak256 and not node's sha3-256.
  ['4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318', 'canonical Ethereum test private key, scripts/keygen.ts self check'],
  ['9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'RFC 8032 ed25519 test vector 1 seed, scripts/keygen.ts'],
  ['d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'RFC 8032 ed25519 test vector 1 public key, scripts/keygen.ts'],
  // A NEAR token contract lives at an account id, and a bridged one is a 64 hex implicit
  // account. Same shape as a private key, opposite meaning: this is a published contract.
  ['17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', 'NEAR USDC token contract account id, data/tokens.json'],
]);

// A 32 byte key drawn from a CSPRNG uses nearly every hex character. A run that uses four or
// fewer is a ruler, a placeholder or a zero address, not key material: the chance a real key
// looks like this is smaller than the chance the disk is lying. Cheaper and more honest than
// listing every padding string in the codebase by hand.
function tooRegularToBeAKey(value: string): boolean {
  return new Set(value).size <= 4;
}

function scanContent(where: string, file: string, content: string, findings: Finding[]): void {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of PATTERNS) {
      pattern.re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.re.exec(line)) !== null) {
        if (KNOWN_PUBLIC_CONSTANTS.has(match[0])) continue;
        if (tooRegularToBeAKey(match[0])) continue;
        findings.push({ where, file, line: i + 1, pattern: pattern.name, fingerprint: fingerprint(match[0]) });
      }
    }
    // Whole line, and separately every quoted string on the line.
    const candidates = [line.replace(/^[\s\-*#>]+/, ''), ...(line.match(/"[^"]{15,220}"/g) ?? []).map((s) => s.slice(1, -1))];
    for (const candidate of candidates) {
      if (isMnemonicRun(candidate)) {
        findings.push({ where, file, line: i + 1, pattern: 'mnemonic', fingerprint: fingerprint(candidate.trim()) });
        break;
      }
    }
  }
}

// ---------- sources of content ----------

function trackedFiles(): string[] {
  return git(['ls-files', '-z']).split('\0').filter((f) => f !== '');
}

type Blob = { sha: string; file: string; content: string };

// Every object reachable from every ref, which is exactly what a push can publish. Unreachable
// objects in the object database are excluded on purpose: they cannot be pushed, and reporting
// them would fail the sweep for a commit that was amended away.
function historyBlobs(): Blob[] {
  const listing = git(['rev-list', '--objects', '--all']).split('\n').filter((l) => l !== '');
  const paths = new Map<string, string>();
  const shas: string[] = [];
  for (const line of listing) {
    const sp = line.indexOf(' ');
    const sha = sp === -1 ? line : line.slice(0, sp);
    if (sha.length !== 40 && sha.length !== 64) continue;
    paths.set(sha, sp === -1 ? '(commit or tree)' : line.slice(sp + 1));
    shas.push(sha);
  }
  if (shas.length === 0) return [];

  // One `git cat-file --batch` process for the whole set. Output frames are
  // "<sha> <type> <size>\n<content>\n"; missing objects answer "<sha> missing\n".
  const raw = Buffer.from(git(['cat-file', '--batch'], shas.join('\n') + '\n'), 'latin1');
  const blobs: Blob[] = [];
  let off = 0;
  while (off < raw.length) {
    const nl = raw.indexOf(0x0a, off);
    if (nl === -1) break;
    const header = raw.toString('latin1', off, nl).split(' ');
    off = nl + 1;
    if (header[1] === 'missing' || header.length < 3) continue;
    const size = Number(header[2]);
    if (header[1] === 'blob') {
      blobs.push({ sha: header[0], file: paths.get(header[0]) ?? '(unknown path)', content: raw.toString('latin1', off, off + size) });
    }
    off += size + 1;
  }
  return blobs;
}

// ---------- identifying values from the local, unpublished files ----------

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out);
}

// Only values that identify a wallet or open one. Config also holds "testnet", "state" and
// "BTC-USD", which appear in tracked files for good reasons and must not fail the sweep.
function looksIdentifying(v: string): boolean {
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) return true; // EVM address
  if (/^0x[0-9a-fA-F]{64}$/.test(v)) return true; // EVM private key
  if (/^[0-9a-f]{64}$/.test(v)) return true; // NEAR implicit account id, raw seed
  if (/^ed25519:/.test(v)) return true;
  if (/^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(v)) return true; // Solana address or secret key
  if (/^[a-z0-9_-]{2,60}\.(testnet|near)$/.test(v)) return true; // named NEAR account
  return v.length >= 40 && !/\s/.test(v); // catch all: any long opaque token
}

function localIdentifyingValues(keysPath: string): string[] {
  const found: string[] = [];
  for (const file of [path.join(ROOT, 'config.local.json'), keysPath]) {
    if (!fs.existsSync(file)) continue;
    try {
      collectStrings(JSON.parse(fs.readFileSync(file, 'utf8')), found);
    } catch {
      // A corrupt local file is not the sweep's problem to fix, but it must not be treated as
      // "nothing to check", so fall back to scanning its raw text for the same shapes.
      const raw = fs.readFileSync(file, 'utf8');
      for (const m of raw.match(/[A-Za-z0-9:_.-]{20,120}/g) ?? []) found.push(m);
    }
  }
  return [...new Set(found.filter(looksIdentifying))];
}

// ---------- checks ----------

type Check = { name: string; ok: boolean; detail: string; findings: Finding[] };
const checks: Check[] = [];

function add(name: string, ok: boolean, detail: string, findings: Finding[] = []): void {
  checks.push({ name, ok, detail, findings });
}

let keysPath = '';
try {
  keysPath = loadConfig(ROOT).keysPath;
  add('config load', true, 'config.json parses and resolves');
} catch (err) {
  add('config load', false, err instanceof Error ? err.message : String(err));
}

const files = trackedFiles();

// 1. tracked content
{
  const findings: Finding[] = [];
  for (const file of files) {
    const abs = path.join(ROOT, file);
    if (!fs.existsSync(abs)) continue; // staged deletion; the history check still covers it
    scanContent('worktree', file, fs.readFileSync(abs, 'latin1'), findings);
  }
  add('tracked content', findings.length === 0, `${files.length} tracked files scanned`, findings);
}

// 5. git history
let blobs: Blob[] = [];
{
  const findings: Finding[] = [];
  blobs = historyBlobs();
  for (const blob of blobs) scanContent(`history ${blob.sha.slice(0, 8)}`, blob.file, blob.content, findings);
  add('git history', findings.length === 0, `${blobs.length} reachable blobs scanned`, findings);
}

// 2. local addresses, across the tracked tree and the history
{
  const findings: Finding[] = [];
  const values = keysPath === '' ? [] : localIdentifyingValues(keysPath);
  const haystacks: Array<{ where: string; file: string; content: string }> = [
    ...files
      .filter((f) => fs.existsSync(path.join(ROOT, f)))
      .map((f) => ({ where: 'worktree', file: f, content: fs.readFileSync(path.join(ROOT, f), 'latin1') })),
    ...blobs.map((b) => ({ where: `history ${b.sha.slice(0, 8)}`, file: b.file, content: b.content })),
  ];
  for (const value of values) {
    // Hex is compared case insensitively because an EVM address travels both checksummed and
    // lowercased; base58 is not, because case carries meaning there.
    const hexish = /^(0x)?[0-9a-fA-F]+$/.test(value);
    const needle = hexish ? value.toLowerCase() : value;
    for (const hay of haystacks) {
      const content = hexish ? hay.content.toLowerCase() : hay.content;
      const at = content.indexOf(needle);
      if (at === -1) continue;
      findings.push({
        where: hay.where,
        file: hay.file,
        line: content.slice(0, at).split('\n').length,
        pattern: 'local-address',
        fingerprint: fingerprint(value),
      });
    }
  }
  const detail =
    values.length === 0
      ? 'no local config or keys file present, nothing to match'
      : `${values.length} identifying values checked against ${haystacks.length} tracked files and history blobs`;
  add('local addresses', findings.length === 0, detail, findings);
}

// 3. ignored paths
{
  const mustBeHidden = ['config.local.json', 'keys.json', '.env', '.env.local', '.env.production', 'state/', 'state/audit.jsonl', 'secret.key'];
  const tracked = new Set(files);
  const problems: string[] = [];
  for (const p of mustBeHidden) {
    const isTracked = tracked.has(p) || (p.endsWith('/') && files.some((f) => f.startsWith(p)));
    if (isTracked) problems.push(`${p} is TRACKED`);
    let ignored = false;
    try {
      execFileSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: ROOT, stdio: 'ignore' });
      ignored = true;
    } catch {
      ignored = false;
    }
    if (!ignored) problems.push(`${p} is not gitignored`);
  }
  add('ignored paths', problems.length === 0, problems.length === 0 ? `${mustBeHidden.length} sensitive paths untracked and ignored` : problems.join('; '));
}

// 4. keys outside the working copy
{
  if (keysPath === '') {
    add('keys outside repo', false, 'config did not load, keysPath unknown');
  } else {
    const rel = path.relative(ROOT, keysPath);
    const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    add('keys outside repo', !inside, inside ? `keysPath ${keysPath} is INSIDE the working copy` : `keysPath resolves to ${keysPath}`);
  }
}

// ---------- report ----------

const ORDER = ['config load', 'tracked content', 'local addresses', 'ignored paths', 'keys outside repo', 'git history'];
checks.sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name));

console.log('');
console.log('PHOSPHOR SWEEP');
console.log(`repo ${ROOT}`);
console.log('');
for (const check of checks) {
  console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name.padEnd(20)}  ${check.detail}`);
  for (const f of check.findings) {
    console.log(`        ${f.file}:${f.line}  pattern=${f.pattern}  seen=${f.where}  sha256:${f.fingerprint}`);
  }
}

const failed = checks.filter((c) => !c.ok);
console.log('');
if (failed.length === 0) {
  console.log(`SWEEP PASS: ${checks.length} checks, nothing secret is reachable from the remote.`);
} else {
  console.log(`SWEEP FAIL: ${failed.length} of ${checks.length} checks failed (${failed.map((c) => c.name).join(', ')}). Do not push.`);
  console.log('');
  console.log('Findings name the file, the line and the pattern. The matched text is never printed,');
  console.log('so open the file at that line to see what it is, then:');
  console.log('  a secret            remove it, and rewrite the history if a commit already holds it');
  console.log('  a public constant   add the exact value to KNOWN_PUBLIC_CONSTANTS in this file,');
  console.log('                      with a note saying what it is and where it came from');
}
process.exit(failed.length === 0 ? 0 : 1);
