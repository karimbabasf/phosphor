// Loads config.json from the repo root into AppConfig, then merges config.local.json
// over it when present. config.json is the committed template and carries no addresses;
// config.local.json is gitignored and carries the real ones, so the remote never learns
// which wallets these are. Env vars PHOSPHOR_PORT, PHOSPHOR_MODE, PHOSPHOR_DATA_DIR and
// PHOSPHOR_KEYS override both (ACC_* names still work), and
// PHOSPHOR_CONFIG_DIR moves config.local.json off the root for the installed .app.
//
// dataDir is resolved relative to root and created if missing, so every other module
// can assume it exists. keysPath is derived from dataDir (see defaultKeysPath) and is
// REQUIRED to sit outside the working copy: see assertOutsideRepo below.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { AppConfig, ChainId, Mode } from './types.ts';
// The keystore owns where a keystore file sits. Imported rather than restated, because a second
// copy of that filename is a second thing to keep in step with the first.
import { keystorePathFor } from './keystore/store.ts';
// The address rules, imported from the modules that already own them rather than restated here.
// addressProblem decodes an EVM or Solana address instead of matching a regex over it, and
// isSettlableNearAccount is the shape a NEAR account has to have before anything can pay out to
// it. A second copy of either is a second thing that goes out of step with the first.
import { addressProblem } from './rails/intents-withdraw.ts';
import { isNearAccountId, isSettlableNearAccount } from './chain/near.ts';

// addresses is overridden rather than intersected: an intersection keeps the required
// fields from AppConfig and defeats the whole point of a partial file.
type PartialConfig = Omit<Partial<AppConfig>, 'addresses'> & { addresses?: Partial<AppConfig['addresses']> };

/* The shape of a config file on disk, strict everywhere, exactly as patchSchema in
   policy/engine.ts is strict about a policy patch: an unknown key is an invalid config rather
   than a silently ignored one.

   The old loader named the fields it read and dropped the rest, which is how the live
   config.local.json came to carry "approvalGate": false and "network": "mainnet". Neither
   appears anywhere in src, ui or tests. approvalGate is the dangerous shape of a dead key: it
   reads as a switch that turns the approval gate off, so an owner could believe either polarity
   meant something, and both beliefs were wrong. A config key that does nothing has to say so at
   boot, because there is no later moment when anybody finds out. */
const skillNames = z.array(z.string());
const addressBookSchema = z
  .object({
    evm: z.array(z.string()).optional(),
    solana: z.array(z.string()).optional(),
    near: z.array(z.string()).optional(),
  })
  .strict();

const configSchema = z
  .object({
    mode: z.enum(['live', 'demo']).optional(),
    port: z.number().int().positive().optional(),
    addresses: addressBookSchema.optional(),
    economicTransferUsd: z.number().finite().nonnegative().optional(),
    candleProducts: z.array(z.string()).optional(),
    dataDir: z.string().optional(),
    keysPath: z.string().optional(),
    // Read by src/skills.ts straight off the file rather than through AppConfig, which does not
    // make it any less a key of this file: leaving it out of the schema would refuse every
    // install that has one.
    skills: skillNames.optional(),
    driver: z
      .object({
        claudeBin: z.string().optional(),
        systemPrompt: z.string().optional(),
        autostart: z.boolean().optional(),
        model: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// JSON has no comment syntax, so the committed template carries its prose under keys named
// _comment and _skills. That convention predates this schema and is not an unknown key.
function withoutComments(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !key.startsWith('_')));
}

function readJsonIfPresent(file: string): PartialConfig {
  if (!fs.existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // A corrupt local override is a mistake worth stopping for, not one to paper over
    // by silently running against the template's empty address list.
    throw new Error(`${path.basename(file)} is present but unparseable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${path.basename(file)} must hold a JSON object`);
  }

  const parsed = configSchema.safeParse(withoutComments(raw as Record<string, unknown>));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
      .join('; ');
    throw new Error(
      `${path.basename(file)} is not a valid config: ${detail}. ` +
        'Every key this app reads is listed in src/config.ts; fix or remove the ones named above.',
    );
  }
  return parsed.data as PartialConfig;
}

/* Every configured address, checked for the shape its chain actually uses, before anything
   trusts it.

   Nothing checked these, and the policy engine folds all of them into the set of destinations it
   treats as our own. A live config carrying "phosphor.testnet" under addresses.near therefore
   made a testnet account an allowlisted destination for a cross-chain swap: the ERC-20 transfer
   leaves the origin chain and the solver is asked to pay out on NEAR mainnet to an account that
   does not exist. Best case the swap ends REFUNDED and the wallet is down the round trip; worst
   case it stalls past the poll and the receipt says the funds were sent.

   Deleting one string would not have fixed it, because any wrong entry behaves the same way. */
function assertAddressesUsable(addresses: AppConfig['addresses'], mode: Mode, file: string): void {
  const problems: string[] = [];

  const check = (chain: ChainId, list: string[]): void => {
    for (const address of list) {
      const problem = addressProblem(chain, address);
      if (problem !== null) problems.push(problem);
    }
  };
  check('eth', addresses.evm);
  check('sol', addresses.solana);

  /* NEAR goes through its own rule because addressProblem refuses the chain outright: no rail
     withdraws to NEAR, so it has no shape to offer. Live means the settlement shape, a named
     account under .near or a 64-character implicit id, since that is what a solver can pay out
     to. Demo asks only that the id is structurally valid, because demo signs nothing. */
  for (const address of addresses.near) {
    const id = address.trim();
    if (id === '') {
      problems.push('addresses.near carries an empty entry');
      continue;
    }
    if (mode === 'live' ? !isSettlableNearAccount(id) : !isNearAccountId(id)) {
      problems.push(
        `${id} is not a NEAR mainnet account id, so it cannot receive anything: a mainnet account is a name ` +
          'under .near or a 64-character implicit id, and a .testnet account does not exist on the network ' +
          'this app runs against',
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `${file} names an address this app cannot use: ${problems.join('; ')}. ` +
        'A configured address is treated as one of ours by the policy engine, so a wrong one is a destination ' +
        'nobody vetted.',
    );
  }
}

function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

// The data directory the app runs on when nobody says otherwise. Named because the key file
// resolver below has to be able to recognise it.
const DEFAULT_DATA_DIR = 'state';

/* Where the key lives when nothing overrides it. THE DATA DIRECTORY DECIDES, and that is the
   fix: this used to key off the repo folder name alone, so every backend started from this
   checkout shared one key directory whatever data dir it was given. A demo backend on a
   throwaway data dir therefore opened the owner's real wallet, reported it as needing
   migration, and could destroy it. One checkout, several data directories, one key file: the
   scratch instance was never a separate wallet, it was the same wallet with a different name.

   So a data directory the owner did not choose carries its OWN key file, beside its own state.
   A demo run, a test, a second profile: each gets an empty wallet rather than the real one.

   Only the app's own default data directory reaches ~/.phosphor, and there the two earlier
   goals still hold: prefer a per-project file keyed by the repo's folder name, and fall back to
   the legacy global file when that is still where the key lives, so an existing install is not
   forced to migrate. A fresh setup gets a per-project key from the start.

   An explicit PHOSPHOR_KEYS or a keysPath in config overrides all of this, because a person
   naming a path has said which wallet they mean. */
/* Whether a wallet lives at this key path, in EITHER of the two shapes a wallet is stored as.
   `keys.json` is the plaintext one and `keys.enc.json` is what migrating produces beside it.

   Asking only about the plaintext file is what made a migration hide the wallet: migrating
   deletes `keys.json`, so the next boot matched neither candidate, fell through to the
   project-local path and reported no_wallet against a funded mainnet keystore that was sitting
   in the global directory the whole time. Nothing was lost and everything looked lost, which is
   the worst thing a wallet can do. The question is "is there a wallet here", never "is there
   one particular file here". */
function holdsWallet(keysPath: string): boolean {
  return fs.existsSync(keysPath) || fs.existsSync(keystorePathFor(keysPath));
}

function defaultKeysPath(baseDir: string, dataDir: string): string {
  /* PHOSPHOR_APP_DATA=1 is the installed app saying this data directory is its own rather than
     one somebody pointed at. It sits under Application Support and so is not the repo default,
     but the wallet it opens is the same wallet it has always opened, and moving that on upgrade
     would be an installed app coming up as though it had no keys. Set in src-tauri/backend.rs
     and nowhere else. */
  const ownDataDir = dataDir === path.resolve(baseDir, DEFAULT_DATA_DIR) || env('PHOSPHOR_APP_DATA') === '1';
  if (!ownDataDir) {
    return path.join(dataDir, 'keys.json');
  }
  const home = os.homedir();
  const slug = path.basename(baseDir) || 'default';
  const perProject = path.join(home, '.phosphor', slug, 'keys.json');
  const legacy = path.join(home, '.phosphor', 'keys.json');
  if (holdsWallet(perProject)) return perProject;
  if (holdsWallet(legacy)) return legacy; // an existing global key keeps working, no migration
  return perProject; // nothing yet: a new key is created project-local, not global
}

/* The path as the FILESYSTEM sees it, not as it was typed.
   `path.relative` compares strings, and two strings that are not equal can still be one
   directory. On a default APFS volume the filesystem is case insensitive, so
   /Users/x/developer/apps/phosphor/state/keys.json is the repo working copy and reads as
   somewhere else entirely to a string comparison; a symlink pointing into the working copy has
   the same effect and needs no typo at all. realpathSync.native resolves both: it follows
   symlinks and, on macOS, returns the true on-disk spelling of every component.
   The path may not exist yet, which is the normal case for a key file that has not been created.
   So the deepest ancestor that DOES exist is resolved and the remaining components are put back
   on: that is enough, because the components that decide whether this is inside the repo are the
   ones near the root, and those exist. */
function resolveReal(target: string): string {
  let head = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(head), ...tail);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return path.resolve(target);
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

// Private keys inside a git working copy are one `git add -f` away from being published.
// Keeping them outside it is the structural guarantee, not the .gitignore entry.
export function assertOutsideRepo(keysPath: string, root: string): void {
  const rel = path.relative(resolveReal(root), resolveReal(keysPath));
  const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (inside) {
    throw new Error(
      `keysPath must sit outside the repo working copy (got ${keysPath} inside ${root}). ` +
        'Keys in the working copy can be committed by accident; keys outside it cannot. ' +
        'A data directory inside the working copy is one way to land here, because the key file ' +
        'is derived from it: point PHOSPHOR_DATA_DIR or PHOSPHOR_KEYS somewhere outside.',
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
  const dataDirInput = env('PHOSPHOR_DATA_DIR', 'ACC_DATA_DIR') ?? parsed.dataDir ?? DEFAULT_DATA_DIR;
  const dataDir = path.resolve(baseDir, dataDirInput);

  const keysInput = env('PHOSPHOR_KEYS') ?? parsed.keysPath ?? defaultKeysPath(baseDir, dataDir);
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
  };

  // After the merge, because config.local.json overrides the template key by key and it is the
  // merged book every other module reads. The file named is the local one when it carries an
  // address book at all, since that is the file an owner edits.
  assertAddressesUsable(cfg.addresses, mode, local.addresses !== undefined ? 'config.local.json' : 'config.json');

  fs.mkdirSync(dataDir, { recursive: true });

  return cfg;
}
