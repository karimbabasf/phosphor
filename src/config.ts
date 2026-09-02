// Loads config.json from the repo root into AppConfig, then merges config.local.json
// over it when present. config.json is the committed template and carries no addresses;
// config.local.json is gitignored and carries the real ones, so the remote never learns
// which wallets these are. Env vars PHOSPHOR_PORT, PHOSPHOR_MODE, PHOSPHOR_DATA_DIR and
// PHOSPHOR_KEYS override both (ACC_* names still work), and
// PHOSPHOR_CONFIG_DIR moves config.local.json off the root for the installed .app.
//
// dataDir is resolved relative to root and created if missing, so every other module
// can assume it exists. keysPath is resolved against $HOME and is REQUIRED to sit
// outside the working copy: see assertOutsideRepo below.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig, Mode } from './types.ts';

// addresses is overridden rather than intersected: an intersection keeps the required
// fields from AppConfig and defeats the whole point of a partial file.
type PartialConfig = Omit<Partial<AppConfig>, 'addresses'> & { addresses?: Partial<AppConfig['addresses']> };

function readJsonIfPresent(file: string): PartialConfig {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as PartialConfig;
  } catch (err) {
    // A corrupt local override is a mistake worth stopping for, not one to paper over
    // by silently running against the template's empty address list.
    throw new Error(`${path.basename(file)} is present but unparseable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

// Where the key lives when nothing overrides it. Two goals, both asked for: the key should be
// TIED TO THIS PROJECT rather than one global ~/.phosphor/keys.json blob shared by everything,
// and an existing setup must not break. So the default prefers a per-project directory keyed by
// the repo's own folder name, and falls back to the legacy global file when that is still where
// the key lives, so no migration is forced. A fresh setup gets a per-project key from the start.
// It stays OUTSIDE the working copy either way, so assertOutsideRepo still holds. An explicit
// PHOSPHOR_KEYS or a keysPath in config overrides all of this.
function defaultKeysPath(baseDir: string): string {
  const home = os.homedir();
  const slug = path.basename(baseDir) || 'default';
  const perProject = path.join(home, '.phosphor', slug, 'keys.json');
  const legacy = path.join(home, '.phosphor', 'keys.json');
  if (fs.existsSync(perProject)) return perProject;
  if (fs.existsSync(legacy)) return legacy; // an existing global key keeps working, no migration
  return perProject; // nothing yet: a new key is created project-local, not global
}

// Private keys inside a git working copy are one `git add -f` away from being published.
// Keeping them outside it is the structural guarantee, not the .gitignore entry.
function assertOutsideRepo(keysPath: string, root: string): void {
  const rel = path.relative(root, keysPath);
  const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (inside) {
    throw new Error(
      `keysPath must sit outside the repo working copy (got ${keysPath} inside ${root}). ` +
        'Keys in the working copy can be committed by accident; keys outside it cannot.',
    );
  }
}

// Where config.local.json lives. Normally it sits beside config.json at the root, and that
// is still the answer for a repo checkout. Installed, the root is inside a read-only .app
// bundle, so the writable half has to move: PHOSPHOR_CONFIG_DIR points at it. config.json
// itself never moves, because it is the committed template and nothing ever writes to it.
function configLocalPath(baseDir: string): string {
  const override = env('PHOSPHOR_CONFIG_DIR');
  return path.join(override !== undefined ? path.resolve(override) : baseDir, 'config.local.json');
}

export function loadConfig(root?: string): AppConfig {
  const baseDir = root ?? process.cwd();
  const base = readJsonIfPresent(path.join(baseDir, 'config.json'));
  const local = readJsonIfPresent(configLocalPath(baseDir));
  const parsed: PartialConfig = {
    ...base,
    ...local,
    addresses: { ...(base.addresses ?? {}), ...(local.addresses ?? {}) },
  };

  const mode = (env('PHOSPHOR_MODE', 'ACC_MODE') as Mode | undefined) ?? parsed.mode ?? 'live';


  const portRaw = env('PHOSPHOR_PORT', 'ACC_PORT');
  const port = portRaw !== undefined ? Number(portRaw) : (parsed.port ?? 4177);
  const dataDirInput = env('PHOSPHOR_DATA_DIR', 'ACC_DATA_DIR') ?? parsed.dataDir ?? 'state';
  const dataDir = path.resolve(baseDir, dataDirInput);

  const keysInput = env('PHOSPHOR_KEYS') ?? parsed.keysPath ?? defaultKeysPath(baseDir);
  const keysPath = path.resolve(keysInput.replace(/^~(?=$|\/)/, os.homedir()));
  assertOutsideRepo(keysPath, baseDir);

  const cfg: AppConfig = {
    mode,
    port,
    addresses: {
      evm: parsed.addresses?.evm ?? [],
      solana: parsed.addresses?.solana ?? [],
      near: parsed.addresses?.near ?? [],
    },
    economicTransferUsd: parsed.economicTransferUsd ?? 0,
    candleProducts: parsed.candleProducts ?? [],
    dataDir,
    keysPath,
    // The allocator reads rates either way; autoAllocate is only whether it may act on them.
    // Defaulting it off means an install that has never been configured watches and reports
    // and files nothing, which is the safe half of the loop.
    yield: {
      // Opt IN, and the polarity matters more here than anywhere else in this file.
      //
      // The obvious form, `!== 'false'`, turns the money-moving loop ON for every value
      // except that one literal string: PHOSPHOR_YIELD_AUTO=0, =off, =no and =disabled would
      // all enable it. For a flag whose whole design is "off unless a human said otherwise",
      // anything but an explicit yes has to mean no.
      autoAllocate: env('PHOSPHOR_YIELD_AUTO') !== undefined
        ? ['true', '1', 'yes', 'on'].includes(String(env('PHOSPHOR_YIELD_AUTO')).toLowerCase())
        : (parsed.yield?.autoAllocate ?? false),
      intervalMs: parsed.yield?.intervalMs ?? 60_000,
      dustUsd: parsed.yield?.dustUsd ?? 5,
    },
  };

  fs.mkdirSync(dataDir, { recursive: true });

  return cfg;
}
