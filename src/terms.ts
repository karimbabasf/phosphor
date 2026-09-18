// What the person agreed to, and when.
//
// The window does not go past its terms screen until the person has accepted the terms of use
// at their current version, and this is where that acceptance is kept: state/terms.json, beside
// the vault's own prefs and outside the key file for the same reason (src/vault/prefs.ts). The
// version is the date the terms last changed on the site, so a change there brings the screen
// back once, and the acceptance names the version it was given to.
//
// Nothing here is a control. The file gates a screen, not a key: a process that edits it skips
// or repeats the screen and reaches nothing else.

import fs from 'node:fs';
import path from 'node:path';

import { atomicWrite } from './fsatomic.ts';

export const TERMS_VERSION = '2026-09-17';
export const TERMS_URL = 'https://phosphor.karimbabasf.com/terms/';
export const PRIVACY_URL = 'https://phosphor.karimbabasf.com/privacy/';

export type TermsData = {
  // The version the app asks for, and the one the person accepted, if any.
  version: string;
  acceptedVersion: string | null;
  acceptedAt: string | null;
  // True when the two versions agree. The window keys off this and nothing else.
  accepted: boolean;
  urls: { terms: string; privacy: string };
};

export type Terms = {
  get(): TermsData;
  accept(now?: () => number): TermsData;
};

export function createTerms(dataDir: string, version: string = TERMS_VERSION): Terms {
  const file = path.join(dataDir, 'terms.json');

  function read(): TermsData {
    let acceptedVersion: string | null = null;
    let acceptedAt: string | null = null;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { acceptedVersion?: unknown; acceptedAt?: unknown };
      if (typeof raw.acceptedVersion === 'string') acceptedVersion = raw.acceptedVersion;
      if (typeof raw.acceptedAt === 'string') acceptedAt = raw.acceptedAt;
    } catch {
      // no file yet, or one that is not ours: nothing accepted
    }
    return {
      version,
      acceptedVersion,
      acceptedAt,
      accepted: acceptedVersion === version,
      urls: { terms: TERMS_URL, privacy: PRIVACY_URL },
    };
  }

  return {
    get: read,
    accept(now = Date.now) {
      const acceptedAt = new Date(now()).toISOString();
      atomicWrite(file, JSON.stringify({ acceptedVersion: version, acceptedAt }, null, 2) + '\n', { mode: 0o600 });
      return read();
    },
  };
}
