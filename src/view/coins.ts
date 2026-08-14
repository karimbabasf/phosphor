// Which coins the basic screen tracks, persisted across restarts.
//
// Karim, 2026-08-14: "if I don't want Bitcoin, on Ether it changes to whatever I ask it
// to change it to, and it's saved as my current favorites". So this is a preference the
// owner sets by asking the assistant, and it outlives the process that heard the ask.
//
// Written atomically (tmp file + rename) the same way view/mode.ts writes the view mode,
// so a crash mid-write cannot leave a half-file that reads as no list at all.
//
// Every failure path returns the default three. That direction is deliberate and it is
// the opposite of mode.ts's: there, failing safe means showing MORE, because pro is a
// superset of basic. Here there is no superset, only a list, and a screen with no prices
// on it looks exactly like a screen whose prices could not be read. Three known coins is
// the answer to "we could not tell".

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FILE = 'coins.json';

// What the screen shows until somebody asks for something else (Karim, 2026-08-14:
// "btc, sol, and eth"), and what it falls back to when the file cannot be read.
export const DEFAULT_COINS = ['BTC-USD', 'SOL-USD', 'ETH-USD'];

// One row is a wasted band and five do not fit beside the wallet without the history
// underneath giving up the room it needs. The cap is a layout fact, so it is enforced
// where the list is set rather than where it is drawn: a refusal the assistant can read
// beats four rows drawn and the fifth silently dropped.
export const MIN_COINS = 1;
export const MAX_COINS = 4;

function filePathFor(dataDir: string): string {
  return path.join(dataDir, FILE);
}

// A product id, not a free-form string: it is handed to loadCandles, and the catalog is
// what decides whether it resolves. This only filters out what could never be one.
function isProductId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z0-9]{1,15}-[A-Z]{3,5}$/.test(value);
}

export function readCoins(dataDir: string): string[] {
  try {
    const raw = fs.readFileSync(filePathFor(dataDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const coins = (parsed as { coins?: unknown } | null)?.coins;
    if (!Array.isArray(coins)) return [...DEFAULT_COINS];
    const clean = [...new Set(coins.filter(isProductId))];
    // A file holding one good entry and three broken ones is a file somebody edited by
    // hand and got wrong. Taking the good entry alone would show them a screen they did
    // not ask for and no reason why, so the whole list has to be sound or none of it is.
    if (clean.length !== coins.length || clean.length < MIN_COINS || clean.length > MAX_COINS) {
      return [...DEFAULT_COINS];
    }
    return clean;
  } catch {
    // absent, unreadable, or not JSON: all of them mean the default three
    return [...DEFAULT_COINS];
  }
}

export function writeCoins(dataDir: string, coins: string[]): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmpPath = path.join(dataDir, `.${FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify({ coins }, null, 2));
  fs.renameSync(tmpPath, filePathFor(dataDir));
}
