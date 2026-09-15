// Stages a release: the assets a GitHub Release carries, named the way the site and the
// installed apps expect them, plus the manifest and the checksums.
//
// Tauri writes the Apple silicon build as bundle/dmg/Phosphor_<version>_aarch64.dmg and the
// updater bundle as bundle/macos/Phosphor.app.tar.gz with a .sig beside it. Out of those, this
// writes into --out:
//
//   Phosphor-macOS-arm64.dmg                 the download; a stable name, so the site can link
//                                            /releases/latest/download/... with no JavaScript
//   Phosphor_<version>_aarch64.app.tar.gz    the updater bundle, versioned, because latest.json
//   Phosphor_<version>_aarch64.app.tar.gz.sig  is regenerated per release and must never point
//                                            at a file that a later release replaces
//   latest.json                              what tauri-plugin-updater reads
//   SHA256SUMS                               shasum -a 256 -c against it, after downloading
//
// The pure parts are exported for tests/unit/release-manifest.test.ts. Run from CI as:
//   node scripts/release-manifest.ts --version 0.4.0 --tag v0.4.0 --bundle <dir> --out <dir> [--notes-file <md>]

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = 'karimbabasf/phosphor';
const PLATFORM = 'darwin-aarch64';

export type ManifestInput = {
  version: string;
  tag: string;
  notes: string;
  signature: string;
  tarballName: string;
  repo: string;
  now: Date;
};

export type LatestJson = {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { url: string; signature: string }>;
};

export function buildManifest(input: ManifestInput): LatestJson {
  if (input.tag !== `v${input.version}`) {
    throw new Error(`release-manifest: tag ${input.tag} does not match version ${input.version}`);
  }
  const signature = input.signature.trim();
  if (signature === '') throw new Error('release-manifest: the signature is empty');
  return {
    version: input.version,
    notes: input.notes,
    // RFC 3339 without fractional seconds, which is the form every example in the plugin's
    // documentation uses and the one its parser is exercised against.
    pub_date: input.now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    platforms: {
      [PLATFORM]: {
        url: `https://github.com/${input.repo}/releases/download/${input.tag}/${input.tarballName}`,
        signature,
      },
    },
  };
}

export function checksumLines(files: { name: string; sha256: string }[]): string {
  return files.map((file) => `${file.sha256}  ${file.name}\n`).join('');
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function need(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`release-manifest: --${name} is required`);
  return value;
}

function main(): void {
  const version = need('version');
  const tag = need('tag');
  const bundle = need('bundle');
  const out = need('out');
  const notesFile = arg('notes-file');
  const notes = notesFile ? fs.readFileSync(notesFile, 'utf8').trim() : '';

  const dmgFrom = path.join(bundle, 'dmg', `Phosphor_${version}_aarch64.dmg`);
  const tarFrom = path.join(bundle, 'macos', 'Phosphor.app.tar.gz');
  const sigFrom = `${tarFrom}.sig`;
  for (const file of [dmgFrom, tarFrom, sigFrom]) {
    if (!fs.existsSync(file)) throw new Error(`release-manifest: ${file} is missing; did tauri build run with the signing key set?`);
  }

  const tarballName = `Phosphor_${version}_aarch64.app.tar.gz`;
  const dmgName = 'Phosphor-macOS-arm64.dmg';
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(dmgFrom, path.join(out, dmgName));
  fs.copyFileSync(tarFrom, path.join(out, tarballName));
  fs.copyFileSync(sigFrom, path.join(out, `${tarballName}.sig`));

  const manifest = buildManifest({
    version,
    tag,
    notes,
    signature: fs.readFileSync(sigFrom, 'utf8'),
    tarballName,
    repo: REPO,
    now: new Date(),
  });
  fs.writeFileSync(path.join(out, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const sums = checksumLines(
    [dmgName, tarballName].map((name) => ({ name, sha256: sha256(path.join(out, name)) })),
  );
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), sums);

  console.log(`release: staged ${fs.readdirSync(out).length} files in ${out}`);
  process.stdout.write(sums);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
