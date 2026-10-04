// Every refusal code a person's Touch ID request can come back with, read off the three places that
// write one: the vault service (src-tauri/se-helper/main.swift, and ChipOps.swift for the chip key's
// ops), the shell's relay (src-tauri/src/enclave.rs) and this process's relay (src/vault/relay.ts,
// src/proposals/lifecycle.ts).
// Read rather than listed, so a code added to any of them without a sentence in src/http/wallet.ts
// fails tests/unit/refusal-words.test.ts and the route tests in tests/unit/vault-routes.test.ts.

import fs from 'node:fs';

const read = (rel: string): string => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

const SERVICE = read('src-tauri/se-helper/main.swift') + read('src-tauri/se-helper/ChipOps.swift');
const SHELL = read('src-tauri/src/enclave.rs');
const RELAY = read('src/vault/relay.ts') + read('src/proposals/lifecycle.ts');

const service = [...SERVICE.matchAll(/Fail\(code: "([a-z_]+)"/g)].map((m) => m[1]!);
const shell = [...SHELL.matchAll(/failure\("([a-z_]+)"/g), ...SHELL.matchAll(/"(helper_[a-z_]+)"/g)].map((m) => m[1]!);
const relay = [...RELAY.matchAll(/error: '([a-z_]+)'/g)].map((m) => m[1]!);

export const VAULT_REFUSAL_CODES: readonly string[] = [...new Set([...service, ...shell, ...relay])].sort();

/* The text each source writes beside its code for logs, the kind the review found on screen:
   "no user present" (an unwrap with nobody at the Mac), "keychain key -25300" (a key the keychain
   does not hold), "access control: ..." and the relay's own words. */
export const SERVICE_MESSAGE = 'no user present; keychain key -25300; access control: SecAccessControlCreate failed; keyBlob names no vault key';

/* What the window may never print: a code, an OS phrase, a status number, and what a disk error
   carries (reaudit1b RA1B-03): the system's code, its words, a path, the key file's name. */
export const RAW = /[a-z]+_[a-z_]+|no user present|-\d{4,5}\b|access control|keyBlob|SecAccess|the enclave answered|\benclave\b|keychain|\bmarker\b|\bpin\b|\bblob\b|\bbind\b|\bbound\b|\bE(?:ACCES|PERM|NOENT|ISDIR|NOTDIR|NOSPC|EXIST|BUSY|IO|ROFS|MFILE|NFILE|XDEV|LOOP|NOTEMPTY|DQUOT)\b|illegal operation|no such file|permission denied|operation not permitted|no space left|(?:^|[\s'"(])(?:\/[\w.@-]+){2,}|keys\.enc\.json|\.tmp\b/i;

/* A disk error as the system raises it while a wallet file is written: the shape the backend is
   handed (code and call beside a message that names the key file's path). Made up, path included. */
export function diskError(): Error {
  const message = "EISDIR: illegal operation on a directory, rename '/Users/someone/Library/Application Support/Phosphor/keys/.keys.enc.json.bind.4242.0a1b2c3d.tmp' -> '/Users/someone/Library/Application Support/Phosphor/keys/keys.enc.json.bind'";
  return Object.assign(new Error(message), { code: 'EISDIR', errno: -21, syscall: 'rename', path: '/Users/someone/Library/Application Support/Phosphor/keys/.keys.enc.json.bind.4242.0a1b2c3d.tmp' });
}
