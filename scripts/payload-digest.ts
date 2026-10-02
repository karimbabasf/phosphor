// The payload's digest: what the shell is built to accept, and what anyone can work out again.
//
// The tree the backend runs from (Contents/Resources/phosphor in the app, the UI it serves
// included) is hashed here when `npm run bundle` stages it, and the shell compiled after that
// carries the result (src-tauri/build.rs). Before it starts the backend, the shell hashes the
// installed tree the same way and starts nothing on a difference (src-tauri/src/payload.rs). The
// rule, which both sides follow byte for byte:
//
//   every regular file under the root except those named .DS_Store, named by its path from the
//   root with / between the parts, in the byte order of those paths; one line per file: the
//   SHA-256 of its content in lowercase hex, two spaces, the path, a newline. The digest is the
//   SHA-256 of all the lines together.
//
// Content and paths only, never modes, owners or times, so a rebuild of the same tag on another
// Mac lands on the same digest. The lines are exactly what `shasum -a 256` prints for the same
// files, so checking a copy needs no Phosphor code (docs/security.md, Check a release yourself).
// .DS_Store is left out because Finder writes one into any folder it shows, and nothing in the
// app ever loads a file by that name.
//
// Refused rather than hashed: anything that is not a file or a folder (a link would point the
// backend at bytes outside the tree), a path with a newline or a backslash (shasum writes those
// lines differently), and any Mach-O file. scripts/notarize-mac.sh signs every Mach-O it finds in
// the app, signing rewrites the file, and the shell would then refuse the copy it was built for.
// The backend runs with --no-addons, so a native file in the payload could never load anyway.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// What the app reads at runtime, copied verbatim from the checkout (scripts/bundle-payload.ts); the
// release gate compares these against the checkout too (scripts/release-check.ts). config.local.json
// is deliberately absent: it is the writable half and lives in Application Support, not in a
// read-only bundle. So is state/, and so are the keys, which have never been in the working copy.
// `operator` carries the two lockdown files. Without it an installed app can still run, and the
// driver would refuse to start rather than spawn an agent whose tool surface it cannot vouch for,
// which is the correct failure and a useless one. It ships.
// docs/changelog.md alone, not docs/ (37 MB of pictures): the agent's whats_new reads it.
export const PAYLOAD = ['src', 'ui', 'data', 'skills', 'operator', 'config.json', 'package.json', 'package-lock.json', 'docs/changelog.md'];

export type PayloadDigest = {
  digest: string;
  files: number;
  // The lines the digest is taken over, one per file.
  manifest: string;
  // Why the tree cannot be shipped as it stands, one sentence per entry. Empty when it can.
  problems: string[];
};

export const SKIPPED = '.DS_Store';

// The first four bytes of a Mach-O file or a universal binary, in either byte order.
const MACHO_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

export function isMachO(body: Buffer): boolean {
  return body.length >= 4 && MACHO_MAGIC.has(body.readUInt32BE(0));
}

function byBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function payloadDigest(root: string): PayloadDigest {
  const files: string[] = [];
  const problems: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (/[\n\\]/.test(rel)) problems.push(`${JSON.stringify(rel)} has a newline or a backslash in its path`);
      else if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (entry.isFile()) {
        if (entry.name !== SKIPPED) files.push(rel);
      } else problems.push(`${rel} is neither a file nor a folder`);
    }
  };
  walk(root, '');
  files.sort(byBytes);
  let manifest = '';
  for (const rel of files) {
    const body = fs.readFileSync(path.join(root, ...rel.split('/')));
    if (isMachO(body)) problems.push(`${rel} is a Mach-O file, which signing would rewrite`);
    manifest += `${crypto.createHash('sha256').update(body).digest('hex')}  ${rel}\n`;
  }
  return { digest: crypto.createHash('sha256').update(manifest).digest('hex'), files: files.length, manifest, problems };
}
