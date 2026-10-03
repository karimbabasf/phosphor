// Every refusal code a person's Touch ID request can come back with, read off the three places that
// write one: the vault service (src-tauri/se-helper/main.swift), the shell's relay
// (src-tauri/src/enclave.rs) and this process's relay (src/vault/relay.ts, src/proposals/lifecycle.ts).
// Read rather than listed, so a code added to any of them without a sentence in src/http/wallet.ts
// fails tests/unit/refusal-words.test.ts and the route tests in tests/unit/vault-routes.test.ts.

import fs from 'node:fs';

const read = (rel: string): string => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

const SERVICE = read('src-tauri/se-helper/main.swift');
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

/* What the window may never print: a code, an OS phrase, a status number. */
export const RAW = /[a-z]+_[a-z_]+|no user present|-\d{4,5}\b|access control|keyBlob|SecAccess|the enclave answered|\benclave\b|keychain|\bmarker\b|\bpin\b|\bblob\b|\bbind\b|\bbound\b/i;
