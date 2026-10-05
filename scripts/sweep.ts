// Phosphor secret sweep. Answers one question: if this repo were pushed right now, would
// anything secret go with it? Run: npm run sweep. Exit 0 means no, exit 1 means stop, exit 2
// means the command line was wrong.
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
//   5. git history       every blob in the history a push can publish, scanned like check 1.
//                        A file deleted from the working tree is still published if a commit
//                        holds it, so scanning the working tree alone proves nothing.
//   6. config load       config.json parses, since it is itself published.
//
// "The history a push can publish" is HEAD (the branch being released), every remote-tracking
// branch (what the remote holds, and what it held before a branch was deleted there: published
// once is published) and every tag (a tag push is one flag away, and refs/tags cannot tell a
// fetched tag from a local one). Local branches that never left this clone are not in it: in a
// shared clone they are other agents' scratch work, and a release that fails on them is failing
// on something no push of this branch would send. GitHub also keeps every pull request's head
// under refs/pull/*, which a clone does not fetch; fetching them as remote-tracking branches
// (git fetch origin '+refs/pull/*/head:refs/remotes/origin/pull/*') puts them in this scope too.
// Two flags change the scope:
//
//   --history=all         every ref in the clone, before pushing more than the current branch
//   --history=<revision>  one revision and everything behind it, e.g. --history=origin/main
//
// A shallow clone fails check 5: its history is not there to scan, and a pass on the tip alone
// would claim what it never looked at.
//
// What this sweep does NOT see, stated so nobody reads a pass as more than it is: a mnemonic
// in single quotes or separated by commas (the mnemonic check reads whole lines and double
// quoted strings only), and vendor credentials with no fixed shape here (sk- API keys, ghp_
// tokens, bearer tokens, JWTs). Those are gitleaks' job, run beside this.
//
// This program never prints a secret it finds. A finding names the file, the line and the
// pattern, plus an eight character sha256 prefix so two findings can be recognised as the
// same value. Printing the match would put the secret in a terminal, a scrollback buffer and
// very likely a CI log, which is the exact outcome the sweep exists to prevent.
//
// The scanner is exported so tests/unit/sweep.test.ts can hold its rules to their word; the
// checks below only run when this file is the program.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { english } from 'viem/accounts';
import { assertOutsideRepo, loadConfig } from '../src/config.ts';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function git(args: string[], input?: string, cwd = ROOT): string {
  return execFileSync('git', args, {
    cwd,
    input,
    maxBuffer: 512 * 1024 * 1024,
    encoding: 'latin1',
    stdio: ['pipe', 'pipe', 'pipe'],
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
    // The header alone is the finding. When the END marker sits on the same line (a block
    // written as one string literal, `\n` escapes and all), the match runs to it, so the whole
    // block is the value the allowlist judges: a fake block in a test can be excused by exact
    // value while the header still trips on every real key, whose body is never that one.
    re: /-----BEGIN[ A-Z]*(PRIVATE KEY|RSA|EC|OPENSSH)[ A-Z]*-----(?:.*?-----END[ A-Z]*-----)?/g,
    note: 'a PEM encoded private key block',
  },
];

// A BIP39 mnemonic is 12, 15, 18, 21 or 24 words from a fixed list of 2048. Matching prose
// against a word count alone fires on every English paragraph, so the test is structural
// first: the run must be the whole of a line or the whole of a quoted string, all lowercase,
// no punctuation and no digits. That is how a seed phrase is actually stored in a file. Then
// every word must be on the list, which is what makes it a mnemonic and not a sentence: a
// comment that happened to be twelve short words ("already receives every waiting row and
// the twenty most recent decided ones") failed the sweep for days on the shape alone. The
// list is the one the keystore derives from (viem ships it), so the sweep and the wallet
// agree on what a seed word is. The limitation is real and worth stating: a mnemonic buried
// mid sentence in prose is missed.
const MNEMONIC_WORDS = [12, 15, 18, 21, 24];
const WORD_RUN = /^[a-z]{3,8}(?: [a-z]{3,8})+$/;
const SEED_WORDS = new Set<string>(english);

export function isMnemonicRun(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (!WORD_RUN.test(trimmed)) return false;
  const words = trimmed.split(' ');
  if (!MNEMONIC_WORDS.includes(words.length)) return false;
  return words.every((w) => SEED_WORDS.has(w));
}

export type Finding = { where: string; file: string; line: number; pattern: string; fingerprint: string };

function fingerprint(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
}

// The one PEM fixture in history, assembled from pieces so this file does not itself hold a
// PEM header for the pattern to find. The `\\n` are the two characters of a JS escape, which is
// how the literal sat on one line in the committed test.
export const FAKE_PEM_FIXTURE = ['-----BEGIN', 'EC PRIVATE KEY-----'].join(' ') + '\\nMHQCAQEEIBc\\n' + ['-----END', 'EC PRIVATE KEY-----'].join(' ');

// Values allowed by exact string and nothing else. The allowlist is deliberately not by file
// and not by pattern: a real private key added to keygen.ts still trips, because only these
// exact strings are excused. Every entry names its source, and adding one is a human decision.
// Hex is written lowercase here and compared lowercase, because hex carries no meaning in its
// case and the same public hash travels checksummed in one test and lowercased in the next.
export const KNOWN_PUBLIC_CONSTANTS = new Map<string, string>([
  // The canonical Ethereum documentation key, published for decades, holding nothing on any
  // chain. keygen.ts asserts it derives 0x2c7536E3605D9C16a7a3D7b1898e529396a65c23 on every
  // run, which is what proves the address derivation is keccak256 and not node's sha3-256.
  ['4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318', 'canonical Ethereum test private key, scripts/keygen.ts self check'],
  ['9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'RFC 8032 ed25519 test vector 1 seed, scripts/keygen.ts'],
  ['d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'RFC 8032 ed25519 test vector 1 public key, scripts/keygen.ts'],
  // A NEAR token contract lives at an account id, and a bridged one is a 64 hex implicit
  // account. Same shape as a private key, opposite meaning: this is a published contract.
  ['17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', 'NEAR USDC token contract account id, data/tokens.json'],
  // A transaction hash is 32 bytes of hex, exactly like a private key, and nothing about the
  // string distinguishes them. This one is public and permanent: it is the deposit whose input
  // decodes to transfer(bridge, 10000000), cited as the evidence that the Hyperliquid bridge
  // takes a plain ERC-20 transfer with no signed payload.
  // Cited in src/rails/hypercore-deposit.ts and its tests.
  ['d5a06833f3e299cce32a957e4078d473d14954b3aa9ec55cd966abc527015c03', 'public tx hash, evidence for the HL bridge deposit shape'],
  // The official hyperliquid-python-sdk's own signing fixture, published in that repo at
  // tests/signing_test.py. It is a sequential counting pattern, holds nothing, and is the key
  // tests/unit/hyperliquid-withdraw.test.ts signs its withdrawal fixture with.
  ['0123456789012345678901234567890123456789012345678901234567890123', 'hyperliquid-python-sdk published test key, signing fixture'],
  // The r and s that key must produce for the fixture withdrawal. Signature halves, not keys:
  // they are an ASSERTION about output, and are worthless to anyone who has them. Computed
  // here rather than taken from the SDK, which signs a domain this app no longer produces.
  ['a155eccb6deecc343d5ce1d69ca20a6b8959cc3f21ffff6b82790e2e9f7fe888', 'expected signature r for the withdrawal fixture'],
  ['6e78708de0806beceab552e1a97378fa80090d902bfffa8b6ee6b35d713f58c4', 'expected signature s for the withdrawal fixture'],
  // The SDK's own r and s for the same fixture, which the test asserted before the domain
  // changed. Gone from the tree, still in history.
  ['8363524c799e90ce9bc41022f7c39b4e9bdba786e5f9c72b20e43e1462c37cf9', 'superseded SDK fixture signature r, tests/unit/hyperliquid-withdraw.test.ts in history'],
  ['58b1411a775938b83e29182e8ef74975f9054c8e97ebf5ec2dc8d51bfc893881', 'superseded SDK fixture signature s, tests/unit/hyperliquid-withdraw.test.ts in history'],
  // The RFC 8032 vector again, in NEAR's base58 encoding rather than hex. The seed and public
  // key above are the same key written the other way, and tests/unit/near-chain.test.ts needs
  // this form because that is the shape a NEAR keys file actually holds. Allowing one encoding
  // of a published constant and tripping on the other would only teach a reader to ignore the
  // sweep, which is the failure mode a security check cannot afford.
  ['49W385L4rePHy6PAaQUovbD2aacgN4HsKXSMeUzRg4fmwXszN91JuMFrQRj3vMDpZuRF3ZknQBuRBoWQJEfXstMw', 'RFC 8032 ed25519 test vector 1 secret, base58, tests/unit/near-chain.test.ts'],
  ['ed25519:49W385L4rePHy6PAaQUovbD2aacgN4HsKXSMeUzRg4fmwXszN91JuMFrQRj3vMDpZuRF3ZknQBuRBoWQJEfXstMw', 'RFC 8032 ed25519 test vector 1 secret, NEAR prefixed form'],
  ['ed25519:FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z', 'RFC 8032 ed25519 test vector 1 public key, NEAR prefixed form'],
  // near-api-js's published test secret for its signed transfer ("serialize and sign transfer tx",
  // @near-js/transactions@1.3.0 test/serialize.test.ts), which tests/unit/near-tx.test.ts signs with
  // to reproduce the published signature. Prefixed as published, and the bare base58 inside it.
  ['ed25519:3hoMW1HvnRLSFCLZnvPzWeoGwtdHzke34B2cTHM8rhcbG3TbuLKtShTv3DvyejnXKXKBiV7YPkLeqUHN1ghnqpFv', 'near-api-js published test secret, tests/unit/near-tx.test.ts'],
  ['3hoMW1HvnRLSFCLZnvPzWeoGwtdHzke34B2cTHM8rhcbG3TbuLKtShTv3DvyejnXKXKBiV7YPkLeqUHN1ghnqpFv', 'the same near-api-js test secret without its prefix'],
  // sha256 of the empty string, the NIST vector. src/chain/near.ts asserts it on every boot to
  // prove the hash in use is really sha256, the same way keygen proves keccak256.
  ['e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'NIST sha256 of the empty string, src/chain/near.ts self check'],
  // Two DIGESTS, which are outputs rather than inputs. Each is what its test computes from
  // fixed inputs on the same line, so the value is an assertion about behaviour and is
  // worthless to anyone holding it. They trip only because a digest is 32 bytes of hex, which
  // is exactly the shape of a key: the pattern working, not failing.
  ['541d8d72f5be9fff46961907b996638b37dc2efba9fe865e35684c5526592c57', 'expected NEAR transaction digest, tests/unit/near-chain.test.ts'],
  ['58909135e0c2d203cce3f7f0ff53d44ee2851fffe37c9d1f569ebcc83f2d5c4c', 'expected NEP-413 digest, tests/unit/near-chain.test.ts'],
  // NEAR implicit accounts and 1Click deposit handles are 64 hex, the same shape again. All
  // of these are public identifiers INSIDE the verifier, not addresses on a chain and not
  // keys: an implicit account id is a public key written as hex, and a deposit handle is the
  // account a solver told us to credit. None can spend anything.
  ['aec6b4afd08c0ace0f392c4d1b8aa9c44ce9bbd558903c4b702ce1cb1ea941b2', 'NEAR implicit account example, a test fixture'],
  ['a7d101a893efccc5e560badd89b55325c99a4da76f2ec584d6a355415e388058', 'deposit handle from a live 1Click quote, tests/unit/intents-withdraw.test.ts'],
  ['86abbc463f08f6244071c17f4cd3471285b24179a4f029fe54a1979d2de7f806', 'deposit handle from a live 1Click quote that FAILED, tests/unit/decision-dock-ui.test.ts and reconcile-oneclick.test.ts'],
  ['81aee1ec126b2b0f041fe080b2195d4ff63c88c13f23da1859b4b6f203cb885a', 'a made-up 1Click deposit handle, tests/unit/hypercore-deposit.test.ts and receipts.test.ts'],
  ['5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd', '1Click app fee recipient in a captured staging quote, a NEAR implicit account, tests/unit/quote-signature.test.ts'],
  ['7f2a9c4e1b8d3f6a0c5e2b9d4f7a1c8e3b6d9f2a5c8e1b4d7f0a3c6e9b2d5f8a', 'a made-up NEAR implicit account in the proof fixtures, scripts/deposit-proof.ts and tests/unit/netpick-ui.test.ts'],
  // The BIP39 vector every wallet agrees on (the twelve "abandon" words), as the 64 byte seed
  // it stretches to and the NEAR implicit account this app derives from it. The seed is the
  // most published secret in the industry and holds nothing anywhere.
  ['5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1', 'BIP39 test vector seed, first 32 bytes, tests/unit/keystore.test.ts'],
  ['9a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4', 'BIP39 test vector seed, second 32 bytes, tests/unit/keystore.test.ts'],
  ['5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412', 'NEAR implicit account the BIP39 test vector derives to, tests/unit/keystore.test.ts'],
  // 1Click's quote signing public keys, production and staging, as its SDK publishes them, and
  // the production key with its last character changed for the wrong-key case. Public keys
  // verify; they cannot sign.
  ['ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc', '1Click production quote signing public key, src/quote-signature.ts'],
  ['ed25519:5J5tkaxyPoR3Q9S8LXfo5bWnXK5Z2bctJ4mB9gENh7co', '1Click staging quote signing public key, tests/unit/quote-signature.test.ts'],
  ['ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifd', 'the production key with its last character changed, the wrong-key case, tests/unit/quote-signature.test.ts'],
  // Signatures on captured 1Click staging quotes, each in the prefixed form the quote carries
  // and the bare base58 the pattern also finds inside it. A signature is an output.
  ['ed25519:53wcpim7FDNLbBHVezUpakthWq2TR9Lag3PwW3e8Cxmz4bFEodcc4rui5BiVHRRaHocYE9URVapzJD8JxLNDs8K9', 'signature on a captured 1Click staging quote, tests/unit/quote-signature.test.ts'],
  ['53wcpim7FDNLbBHVezUpakthWq2TR9Lag3PwW3e8Cxmz4bFEodcc4rui5BiVHRRaHocYE9URVapzJD8JxLNDs8K9', 'the same staging quote signature without its prefix'],
  ['ed25519:3yVRcYGXRVj2YqrUng4Ne2yiWgh9YQfer46KW6sXiWzoyRHgsifwDp1HSZW7VLRTdKXoMgxJce22LQ9dcoihyfu5', 'signature on a captured 1Click staging quote (dry), tests/unit/quote-signature.test.ts'],
  ['3yVRcYGXRVj2YqrUng4Ne2yiWgh9YQfer46KW6sXiWzoyRHgsifwDp1HSZW7VLRTdKXoMgxJce22LQ9dcoihyfu5', 'the same dry staging quote signature without its prefix'],
  ['ed25519:5fVqoCrPgqS9WPqnX5xvHKNYBqRZPkXvEqM9VaHZXgBbPYp7qZzx5HkNvZxQK1hBkD2qT8GJfXwR9nL4mS6vYt2', 'a signature that must fail to verify, tests/unit/quote-signature.test.ts'],
  ['5fVqoCrPgqS9WPqnX5xvHKNYBqRZPkXvEqM9VaHZXgBbPYp7qZzx5HkNvZxQK1hBkD2qT8GJfXwR9nL4mS6vYt2', 'the same failing signature without its prefix'],
  // Hyperliquid signing vectors from hyperliquid-python-sdk tests/signing_test.py, and the r
  // and s halves this app's signer must reproduce for them and for its own user-signed
  // fixtures. A connection id is a digest; a signature half is an output.
  ['0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908', 'hyperliquid-python-sdk connectionId vector, tests/unit/hl-sign.test.ts'],
  ['d65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e', 'expected signature half, hyperliquid-python-sdk vectors, tests/unit/hl-sign.test.ts'],
  ['2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e', 'expected signature half, hyperliquid-python-sdk vectors, tests/unit/hl-sign.test.ts'],
  ['3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da', 'expected signature half, hyperliquid-python-sdk vectors, tests/unit/hl-sign.test.ts'],
  ['98343f2b5ae8e26bb2587daad3863bc70d8792b09af1841b6fdd530a2065a3f9', 'expected signature half, hyperliquid-python-sdk vectors, tests/unit/hl-sign.test.ts'],
  ['6b5bb6bb0633b710aa22b721dd9dee6d083646a5f8e581a20b545be6c1feb405', 'expected signature half, hyperliquid-python-sdk vectors, tests/unit/hl-sign.test.ts'],
  ['755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8', 'expected signature half, hyperliquid-python-sdk vectors, tests/unit/hl-sign.test.ts'],
  ['4d402be7396ce74fbba3795769cda45aec00dc3125a984f2a9f23177b190da2c', 'expected signature half, hyperliquid-python-sdk vectors, tests/unit/hl-sign.test.ts'],
  ['609cb20c737945d070716dcc696ba030e9976fcf5edad87afa7d877493109d55', 'expected signature half, hyperliquid-python-sdk vectors, tests/unit/hl-sign.test.ts'],
  ['16c685d63b5c7a04512d73f183b3d7a00da5406ff1f8aad33f8ae2163bab758b', 'expected signature half, hyperliquid-python-sdk vectors, tests/unit/hl-sign.test.ts'],
  ['d252d0750b676ec0f7f8d4f2cf8f0a376055f190cd4e0e13644aa62e28896722', 'expected signature half for a user-signed fixture, tests/unit/hl-user-signed.test.ts'],
  ['64fa8a36a959a7e4f91fcdb52b8862f7c2ace8b6054446220a9e82e6b0954c13', 'expected signature half for a user-signed fixture, tests/unit/hl-user-signed.test.ts'],
  ['37d681227977cbab573e55b1e9c486b7f03c18d6f4dc13fd635de58b48c701f9', 'expected signature half for a user-signed fixture, tests/unit/hl-user-signed.test.ts'],
  ['5ec891bc0345ada05f8147334aebf9fcc2aa8f155d58bf98b87692a11317da73', 'expected signature half for a user-signed fixture, tests/unit/hl-user-signed.test.ts'],
  ['7000485fd96b213d769e6f07fc859c2683f52f4bcf24209f4a40379be9336e40', 'expected signature half for a user-signed fixture, tests/unit/hl-user-signed.test.ts'],
  ['0eca63d4e42e247ca9d7b3e4ffd8b72e73237a74cec0c0d9a490bd05dc3a7153', 'expected signature half for a user-signed fixture, tests/unit/hl-user-signed.test.ts'],
  // The sendAsset vectors the SDK produces for its own fixture key on mainnet and testnet,
  // reproduced in the Hyperliquid exit research of 2026-09-20 and asserted by the same test.
  ['fe1a043dc1f5b7e5bd361b397a615f8f791a317cf2d7c28e483746020cf2dd04', 'sendAsset mainnet signature r for the SDK fixture, docs/superpowers/prompts/ready-for-people/evidence-b/sendasset-research.md in history'],
  ['3dbf449f1d7dc7c819e04c8f88e30edc762abbc69351d278e851c2b7c1fd9d39', 'sendAsset mainnet signature s for the SDK fixture, docs/superpowers/prompts/ready-for-people/evidence-b/sendasset-research.md in history'],
  ['99a9ac7337378f56543cb5a762b710d4afd8925abf644bb6ec03ed9669c8f60e', 'sendAsset testnet signature r for the SDK fixture, docs/superpowers/prompts/ready-for-people/evidence-b/sendasset-research.md in history'],
  ['5d2db4547b8b54c9c54ce80a4948031566e5e78267eb3d9fe811960f59a7dcc0', 'sendAsset testnet signature s for the SDK fixture, docs/superpowers/prompts/ready-for-people/evidence-b/sendasset-research.md in history'],
  // Public transaction hashes used to prove the chain readers validate and lowercase them.
  ['5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060', 'the first Ethereum transaction ever mined (block 46147), tests/unit/chainscan-*.test.ts'],
  ['a6494142e2e565b5e672d41a37a3eafec2fe5594f22efbb07f421a6cedf473c5', 'a public Bitcoin transaction id, tests/unit/chainscan-networks.test.ts'],
  // Made-up hashes and addresses with a visible pattern, drawn on cards in the proof scripts,
  // the eval scenarios and the UI tests. Nothing was ever mined or minted under them.
  ['9c1e7b2d4f60a8c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1', 'a made-up transaction hash the proof scripts draw a deposit card with, scripts/deposit-proof.ts and scripts/firstrun-proof.ts'],
  ['b3f0a2c1d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f', 'a made-up transaction hash in the eval scenario fixtures, tests/eval/S2 to S6 and S23'],
  ['7d4e1f0a2c9b8e6d3f5a1c7b9e0d2f4a6c8b0e1d3f5a7c9b1e3d5f7a9c1b3e5d', 'a made-up venue-minted deposit address, tests/unit/decision-dock-ui.test.ts'],
  ['a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90', 'a made-up address in the window fixtures, ui/core/fixtures.js in history'],
  ['9f2c1ae4b7d05c8813fbd2a6e0417cc9de5b6a1f8340d7e2b5c9018a3f6de274', 'a made-up transaction hash in the window fixtures, ui/core/fixtures.js in history'],
  ['c7e1d3a95b40f826d1c9e4a7b3086f52dc1a9e4b7350f28cd6a1b93e5074cf81', 'a made-up transaction hash in the window fixtures, ui/core/fixtures.js in history'],
  ['41ba7cd9e2f80516a3c7d84be91f0c25d7a6b3e8420fc19d5e7a80b3c6f19d42', 'a made-up transaction hash in the window fixtures, ui/core/fixtures.js in history'],
  ['9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0', 'a made-up intent hash inside a rail sentence, tests/unit/agent-cards-ui.test.ts (the one card pass, 2026-09-20)'],
  // Demo rail hashes from node B's evidence (docs/superpowers/prompts/ready-for-people/evidence-b in history, the kill -9 and withdraw walks on a demo backend): minted by the demo rail, real nowhere.
  ['9c250bdf641fe43ea36928778a6d31ccd649ed8da6b9e6bbd4a4c6f2d72b72cf', 'demo rail hash, evidence-b/demo-kill9-4202.txt'],
  ['e35b1abf83cf884f9b1b6250a86726f0993982479bb3a17971a6ad9bf3ff6d18', 'demo rail hash, evidence-b/demo-withdraw-walk-4202.txt'],
  ['6da6ffb54f84da34ec3b078ceb6c2ce840d57ce1e5b38ca7f69152b252b56b94', 'demo rail hash, evidence-b/demo-withdraw-walk-4202.txt'],
  // Made-up transaction hashes with a visible pattern in the anxiety harness's scene fixtures (node F, scripts/anxiety/scenes.ts, 2026-09-20).
  ['9c2b7e4f1a6d3c8b5e0f2a7d4c1b8e6f3a0d9c2b7e4f1a6d3c8b5e0f2a7d4c1b', 'a made-up hash in a scene fixture, scripts/anxiety/scenes.ts'],
  ['5b1d9e3a7c2f8d6b4a0e1c9f3d7b5a2e8c6f4d1b9a3e7c5f2d8b6a4e0c1f9d3b', 'a made-up hash in a scene fixture, scripts/anxiety/scenes.ts'],
  ['7a3c9e1f5b2d8a6c4e0f9b3d7a1c5e8f2b6d0a4c9e3f7b1d5a8c2e6f0b4d9a3c', 'a made-up hash in a scene fixture, scripts/anxiety/scenes.ts'],
  ['1f4b8d2c6e0a9f3b7d5c1e8a2f6b0d4c9e3a7f1b5d8c2e6a0f4b9d3c7e1a5f8b', 'a made-up hash in a scene fixture, scripts/anxiety/scenes.ts'],
  // Arbitrum Sepolia transaction hashes from the yield rail proof of 2026-08-20, in a spec that
  // left the tree with that rail. Testnet, public, permanent.
  ['862edaf1467c6e608c233b9e4d47bb7ac207329e8586f421e144e682e5d2564a', 'testnet approve tx, docs/superpowers/specs/2026-08-20-stablecoin-yield.md in history'],
  ['80fb07e72153761770b00e0b90ad6cbac7605fb4dd80f07ad4b7b405a4d8fd2d', 'testnet swap tx, docs/superpowers/specs/2026-08-20-stablecoin-yield.md in history'],
  ['8c68a76ca6faff874c1c224bf5c1466d5b224ede3aa5c14b56a05f8732fe3127', 'testnet approve tx, docs/superpowers/specs/2026-08-20-stablecoin-yield.md in history'],
  ['f4ad8744d03e2a48eb020642b3d4f51833acc326b39fbafdd314d0ac8363d426', 'testnet supply tx, docs/superpowers/specs/2026-08-20-stablecoin-yield.md in history'],
  ['0363b7e37ab10c3381c84c924c7028bda82a18642b9153aa60dcb7a4b70e5632', 'testnet withdraw tx, docs/superpowers/specs/2026-08-20-stablecoin-yield.md in history'],
  // A PEM block with an eleven character body, which no key has: the fixture the log tail
  // redaction test was first committed with (tests/unit/log-tail.test.ts in history; the tree
  // now assembles it at runtime). Excused as the exact block; the header alone still trips.
  [FAKE_PEM_FIXTURE, 'a fake PEM block, tests/unit/log-tail.test.ts in history'],
  // sha256 of the published release files, as SHA256SUMS on the release page lists them and as
  // the launch evidence under docs/superpowers/prompts/ready-for-people/evidence-g (in history) records them.
  ['211b95fc39d380218e835b12a4d6a6feb516353a0103b9acd70a5aa4db79f48c', 'sha256 of Phosphor-macOS-arm64.dmg, release v0.7.0'],
  ['65b5564e47d96ec4b20640b74e1386112854e47d017b7551c315ef9516931506', 'sha256 of Phosphor_0.7.0_aarch64.app.tar.gz, release v0.7.0'],
  ['7350f574186227f6a1e3b084e6cec3eb8beb198a6735186bf1d74095c089d52f', 'sha256 of Phosphor-macOS-arm64.dmg, release v0.6.0'],
  ['809ad3e45ac4d33b7af72d3c3cbc95aa98638c59269e88c26f64b4030bcdfc33', 'sha256 of Phosphor_0.6.0_aarch64.app.tar.gz, release v0.6.0'],
  // sha256 of two vendored three.js files, recorded so a reader could verify the copy.
  ['979c1ae4b0579c9901eacf797602c0b46df129d87102c6443d14be4a1f790b70', 'sha256 of three.module.min.js, ui/vendor/README.md in history'],
  ['295a28f4a9786dd24a2a357a4ce90921eb041127e53a508335b9a0556c1e0875', 'sha256 of three.core.min.js, ui/vendor/README.md in history'],
  // A Claude Code config file from a throwaway probe, committed in cf82665 and removed in
  // 3e50c07 the same day (2026-09-07), both already on origin. Its machineID and userID are
  // hashed telemetry identifiers of a fresh, never signed in install: not keys, not accounts,
  // able to spend nothing. Removing them from history is a rewrite, which is Karim's call.
  ['b8f850b066486a3574eb181f7e79cbf0fdcc321a76bdca151373afc7b3de1662', 'Claude Code machineID from a probe config, data/claude/.claude.json in history'],
  ['ea34155cf36033448c04e0712ddb24f7276ceb2000a1dab145b51b726d053c56', 'Claude Code userID from a probe config, data/claude/.claude.json in history'],
  // One transaction (and, on the Move chains, one address) per network the chain reader knows,
  // all seen on mainnet on 2026-09-26: the SAMPLES in scripts/chain-reader-live.ts, which the
  // chainscan tests reuse as real inputs. That script read each one back from its own chain on
  // 2026-10-01, except the Fogo signature, which the Fogo RPC no longer serves. The Fogo and
  // Solana signatures are 64 bytes whose second half is not the public key of the first, so
  // neither is a Solana or NEAR secret key.
  ['2e29090c0097b06b32c6746b097dc1357d4322198db89df46932084ea33027bd', 'Ethereum transaction, scripts/chain-reader-live.ts'],
  ['4c3d4f1b8d30bc5722cfed81a335600145a17d0c43cc0ef3255767b51c27802e', 'Base transaction, scripts/chain-reader-live.ts'],
  ['c4ad481119309747661c4b913a6ce0d28fcc209926fc1a610b9b6517f0f37b12', 'Arbitrum transaction, scripts/chain-reader-live.ts'],
  ['5emE5TiSbzeRZFjvFkpBEBnzZAU7ZqatrYAStBUz364L72stKfsFb5rD1zzioTAjW9guRCzGHuQEVQe8M5gKT6k4', 'Solana transaction signature, scripts/chain-reader-live.ts'],
  ['4e09836ddf2f1a49508a6181a78a0dc170016224f43a05129903cf3316500fde', 'Bitcoin transaction, scripts/chain-reader-live.ts'],
  ['46e0a62630b76fbb65b819669b28a95c77b1b4f16bb52a07f3faffae904b1895', 'Optimism transaction, scripts/chain-reader-live.ts and tests/unit/chainscan-families.test.ts'],
  ['38bdfb1abee2ece95845c72194baf3c49fa942cf8dc97eadaacef83d07de3df9', 'Gnosis transaction, scripts/chain-reader-live.ts'],
  ['591fec0abd1a7c40754e05292017e5f528dcb3a626f3e91534d80c59b9440385', 'Polygon transaction, scripts/chain-reader-live.ts'],
  ['0982d3d27997b552d00f5ea70626052fbb0ba99c9914b9f66dcbbda89dbb4e13', 'BNB Chain transaction, scripts/chain-reader-live.ts'],
  ['9ab09bd15683efb94858ec2e0dc3609c849af6250ed231f8062977c2111c0636', 'Avalanche transaction, scripts/chain-reader-live.ts'],
  ['e8be4457d1327cd36d07e08bb57490de2f1bc8b2e91146137dea41f499488ce1', 'Scroll transaction, scripts/chain-reader-live.ts'],
  ['28fdd09caf98395aed98cb4547c510751dda179a56f049881bfff853843ff707', 'Berachain transaction, scripts/chain-reader-live.ts'],
  ['3fe3136305364b3e0e6dd5664aee7268e9a9e6e715137cfc7b598931894099ab', 'Monad transaction, scripts/chain-reader-live.ts'],
  ['27ef092c9d18a52fab43f474a12aa762f643006910ba80586ae67f72582db55f', 'X Layer transaction, scripts/chain-reader-live.ts'],
  ['13c8d1c88d29c18e74492a13a7a39bce368d04e583db8ac966b7e0a8d90284c7', 'Plasma transaction, scripts/chain-reader-live.ts'],
  ['3c2331f2ec3903724ebfd622bbd116148a2bda9cf39d6ba16b9905dcecae380e', 'Robinhood Chain transaction, scripts/chain-reader-live.ts'],
  ['bd3958ff02027a51569f1c21a0e69cd19c79ce0b863c8feef877761b25e45dff', 'ADI transaction, scripts/chain-reader-live.ts'],
  ['768f34c44582a7fc18e7f1c52e508fae5f91573141402440b9a1227675bf8ad1', 'Abstract transaction, scripts/chain-reader-live.ts'],
  ['2e4667ba841af8b12fc004454b56f30202c200a01f1e1783d20f130d431ed29b', 'Hyperliquid L1 transaction, scripts/chain-reader-live.ts and tests/unit/chainscan-families.test.ts'],
  ['vfMydTVszQJtB1zNYGYFNqFm2bqvLHwLTmomZbjnteaPPvdaDmfunQCRvCwuQzM5jMCqPBqtJB3UBUM3hDuP3Go', 'Fogo transaction signature, scripts/chain-reader-live.ts'],
  ['68a604e3579424305614eb07869139df2a5c9a158a4a0e98c62f6461ad3c9724', 'Litecoin transaction, scripts/chain-reader-live.ts'],
  ['13acf8ceaf9f5d8e32361a28392becbf3feeb2b593f6b35bd32ff36cf1933dca', 'Bitcoin Cash transaction, scripts/chain-reader-live.ts and tests/unit/chainscan-families.test.ts'],
  ['f7f07e2b888cdb0cb0de8ebcaf39a3f8c5422160f9c1d98001033e0540592897', 'Dogecoin transaction, scripts/chain-reader-live.ts and tests/unit/chainscan-families.test.ts'],
  ['6b84b20907756c4be508a73fb9abadebb98779beb6c8eac62c8d19132688aad7', 'Dash transaction, scripts/chain-reader-live.ts and tests/unit/chainscan-families.test.ts'],
  ['007db4da82228d6fedd94c72e736d6b49cdaa63b3b316a57a5cc82c17accc700', 'XRP Ledger transaction, scripts/chain-reader-live.ts and tests/unit/chainscan-*.test.ts'],
  ['0d5f10a46f0d71fecba5fa19fc555388fd35f1ab9d059e2a793ac0a1c90dfb8c', 'Tron transaction, scripts/chain-reader-live.ts and tests/unit/chainscan-families.test.ts'],
  ['34729f8dd6d4e9bf5243b327c6462552a2d092808c537b9bbae7ee1a0e080a39', 'Sui address, scripts/chain-reader-live.ts and tests/unit/chainscan-families.test.ts'],
  ['d503b95164384a5ebbccbb5c4bdc8b4a5893d9651e9953abda8e1c22fcc1181d', 'Aptos address, scripts/chain-reader-live.ts and tests/unit/chainscan-families.test.ts'],
  ['f73224c5e8676111cc26cb38b0ae2d7be81a0c9ed4ca4e62767548ae13e02824', 'Aptos transaction, scripts/chain-reader-live.ts and tests/unit/chainscan-families.test.ts'],
  ['28d7c00a7b57148312bd9a44c020e9a1763fb41658d412f9817b5c1d9c12dbf3', 'Movement address, scripts/chain-reader-live.ts'],
  ['deb99ca7ed0b2f57ad2bcb85ba697306d96db193276f0cba02f97ddc458e679d', 'Movement transaction, scripts/chain-reader-live.ts'],
  ['50c13ecc7b73ce186f4a70a9bf691c3e745b28a63348b4bb82a0ab80086ee40f', 'Cardano transaction, scripts/chain-reader-live.ts and tests/unit/chainscan-families.test.ts'],
  ['27d5a9d7f9874932e163ce3cf97e7317c62059ed4e7abfb8ed07e4c1fc6b112c', 'Stellar transaction, scripts/chain-reader-live.ts and tests/unit/chainscan-families.test.ts'],
  // The same public values in the spelling a reader normalises them to, and one more Tron
  // transaction (read back on 2026-10-01) that the hash validator tests use as a plain id.
  ['7227a8086aaf513b81eab6ba0fd38944cfa1e929c63a006c66d9aa0b92b499ef', 'the TON sample transaction in hex (scripts/chain-reader-live.ts holds its base64), tests/unit/chainscan-*.test.ts'],
  ['0492e0d1794ac2f17437c82fabf003674f5e2ed8ab8248d0fee74f78ab4d6d15', 'the Starknet sample transaction zero padded to 64, tests/unit/chainscan-decoders.test.ts'],
  ['04678eb497e96599c92b45f342c2bd284321fe219c60a9b6293d80f0fbfa61b5', 'the Starknet sample address zero padded to 64, tests/unit/chainscan-families.test.ts'],
  ['5d5a9d1667b84d5f2d457392781cb5974736d16cceaf2b428aa02d55ac9df282', 'Tron transaction in block 86603298, tests/unit/chainscan-decoders.test.ts'],
  // Deposit addresses the POA bridge answered on 2026-09-26, kept whole in
  // tests/fixtures/poa-deposit-addresses.ts. On Sui, Aptos, Starknet and Movement an address is
  // 32 bytes of hex and a NEAR implicit account is a public key in hex: places to send to, which
  // cannot sign anything.
  ['b3548ec172bd95ce13945a452a4559e86ba580671dc6c06ddd039f527ac955a4', 'POA deposit address on Sui, tests/fixtures/poa-deposit-addresses.ts, chain-pay and agent-cards-ui tests'],
  ['25e6559870641564220645a8cac7f5841135cfaf8512f325285f5487624726e5', 'POA deposit address on Aptos, tests/fixtures/poa-deposit-addresses.ts'],
  ['057ea27e45e07ee0bcab6f045e656c782a6789d14a25e8e70309c35b2ff6082d', 'POA deposit address on Starknet, tests/fixtures/poa-deposit-addresses.ts, chain-pay and agent-cards-ui tests'],
  ['186ed8e9c9214d39b0d25d5b6bb120e235c56e814764b662a2b2a34f1c1d9f5e', 'POA deposit address on Movement, tests/fixtures/poa-deposit-addresses.ts'],
  ['fae3c94f710b683fd6b0580853dc8f20ed395f4325f57a0759a013839dc726f9', 'POA deposit address on NEAR, tests/fixtures/poa-deposit-addresses.ts'],
  ['160d5538216a4befb92bedffce42d43f6dd27c9b035f2978a2a82f35f505a437', 'the fixture TON deposit address in raw form (0:<hex>), tests/unit/chain-pay.test.ts'],
  // 1Click deposit handles (the account a solver names for one swap, inside the verifier) and
  // receivers drawn in tests, none with any history on its own chain. Read as a private key or a
  // seed, no hex one derives an Ethereum, NEAR or Solana account with any history either (checked
  // 2026-10-01), and the Fogo signature is 64 bytes that are not a keypair.
  ['840ade2d6a0f3a5b8d9c4e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b59da', 'a 1Click deposit handle, tests/unit/swap-reads.test.ts, swap-reasons and swap-exact-amounts'],
  ['fd16a579c2e84b1d9a3f6e0c7b5d2a8f4e1c9b3d7a6f0e2c8b4d1a9f3e7c5b2d', 'the deposit handle of a swap 1Click reported FAILED, scripts/anxiety/scenes.ts'],
  ['3f9c2a7b1e4d5c6f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f', 'a deposit handle in the chat proof fixtures, scripts/chat-proof.ts'],
  ['917148ec47923f2e0e3d73142ac4f94ec4c73078865ba6d29f0ea172cd6f4bf3', 'a NEAR implicit account receiver, tests/unit/send-gate.test.ts and agent-cards-ui.test.ts'],
  ['1f40fc92da241694750979ee6cf582f2d5d7d28e18335de05abc54d0560e0f53', 'an Aptos receiver, tests/unit/agent-cards-ui.test.ts'],
  ['c88ad1876cac0814f7295123207711a9e42e0f10aa6fc2ae3b61d0a1cce504f5', 'a Movement receiver, tests/unit/agent-cards-ui.test.ts'],
  ['LaoihSchWpZatv2FMDT22viNx84CWekqNaM4UDhLMpSSc5UJV6n2nJSvXi1PKrssfe9peAwmp1HCUX19zxS4xCf', 'a Fogo signature in a mocked RPC answer, tests/unit/chainscan-families.test.ts'],
  // The order of the secp256k1 group, a curve constant published in SEC 2.
  ['fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', 'secp256k1 group order n, src/invite/code.ts (invite branch)'],
  // The order of the P-256 group, the same kind of constant, and a run of 87 hex digits with no 0 in
  // one of spike2's Secure Enclave signatures (keys never stored, gone with their process), which
  // the base58 pattern reads as a key.
  ['ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551', 'P-256 group order n, tests/unit/intent-grammar.test.ts'],
  ['581b8bed9d27df3b4332b9f26e42e4586373c7f328489fd4ab87bd99362c37f44f71aef24d261f3df76f58f', 'part of a spike2 chip signature, tests/fixtures/intent-grammar/chip-der.json'],
  // HMAC-SHA256 test vectors. RFC 4231 test case 2 ("Jefe"), and the identity proof of the made-up
  // nonce "a1b2c3d4" x 8 for the challenge "0123456789abcdef" x 4, which pins the shell and the
  // backend to the same MAC. Neither keys anything.
  ['5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843', 'RFC 4231 HMAC-SHA256 test case 2, src-tauri/src/backend.rs'],
  ['a12aa33231a6d44541d89e7db2589e4bc49d9c5d92fc4faa2208ab845a607375', 'identity proof test vector, src-tauri/src/backend.rs and tests/unit/boot-nonce.test.ts'],
  // The read key of the made-up token "f00d" x 16, which pins the shell's read key to the one
  // src/http/auth.ts derives. Keys nothing.
  ['6c06cb123fcf6903ddd78df2a8ab62b9b5a4cfb58bb031186751a07701b97eb1', 'read key test vector, src-tauri/src/backend.rs'],
  // The published vectors of the keys derived from the owner key (src/keystore/derived.ts), from
  // two owner keys already above: the canonical Ethereum test key and the hyperliquid-python-sdk
  // fixture. Each is an ALLOWANCE key, a GAS seed or a GAS account derived from a public test key,
  // so it holds nothing and anyone can derive it again (tests/fixtures/derived-keys.ts).
  ['c96e3431c7fe5789854eb223ffab755b902c08bb34fdf40bfcb9839589d3faa1', 'ALLOWANCE key derived from the canonical Ethereum test key, tests/fixtures/derived-keys.ts'],
  ['f393907ec2ad1db656b6bd3d8e4804ad70d12ed136c76f46dac1549606a6c64d', 'GAS seed derived from the canonical Ethereum test key, tests/fixtures/derived-keys.ts'],
  ['e4d620800228e29d21a180cc305b9541c170631df3b5b513b795947a27520108', 'GAS account derived from the canonical Ethereum test key, tests/fixtures/derived-keys.ts'],
  ['7ee7c33929bff790cd5b87813289af4628ae027f0a5bdcdb3f4d196ef5ea4f9a', 'ALLOWANCE key derived from the hyperliquid-python-sdk test key, tests/fixtures/derived-keys.ts'],
  ['fcda8770013610a5a890531e5a67a8d96dbe3d6ef142f2494999a58ba4743879', 'GAS seed derived from the hyperliquid-python-sdk test key, tests/fixtures/derived-keys.ts'],
  ['ca541826c952a550f599949160d91d6dcd82616f0a07cd5488cb8e30ab62b5f7', 'GAS account derived from the hyperliquid-python-sdk test key, tests/fixtures/derived-keys.ts'],
  // The Hyperliquid trading keys derived from the same two public test keys, versions 1 and 2
  // (src/keystore/derived.ts, HL-AGENT): published vectors, keyed to nothing (tests/fixtures/hl-agent-keys.ts).
  ['9bd79f6143f38e7148895138bc777a7f1713871b372118ee6fd1905ab541cdcc', 'trading key v1 derived from the canonical Ethereum test key, tests/fixtures/hl-agent-keys.ts'],
  ['b019392723d9eff17f3a6e27b6ee0fb604d2867b076c996e225da6bcb30aa966', 'trading key v2 derived from the canonical Ethereum test key, tests/fixtures/hl-agent-keys.ts'],
  ['15e2354fbbd2692b68388e3bde1fff440cf9ba7033b26ca7483970a5cca118c6', 'trading key v1 derived from the hyperliquid-python-sdk test key, tests/fixtures/hl-agent-keys.ts'],
  ['883dae3c8b464ef6a145bc1033d034d8dea7bf0632c2d455eff327a21f0e8bf2', 'trading key v2 derived from the hyperliquid-python-sdk test key, tests/fixtures/hl-agent-keys.ts'],
  // The two halves of the canonical test key's approval of trading key v1 for 90 days, checked with
  // foundry's `cast wallet sign --data`: a signature over public data by a public key.
  ['c69b4759bde4d0e04b326f5db34d1cbb4e4753f7e11c9108290b51d1e9d1c88e', 'approveAgent signature half (r), canonical Ethereum test key, tests/unit/hl-agent-allow.test.ts'],
  ['31c689da930e4f5180e8baa6856b930b0d14f950e6632edd80f92a9706eb462a', 'approveAgent signature half (s), canonical Ethereum test key, tests/unit/hl-agent-allow.test.ts'],
  // The order n of the P-256 group, a curve constant published in SEC 2. src/vault/webauthn.ts
  // folds a signature's S below n / 2 with it, the only form the NEAR Intents verifier accepts.
  ['ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551', 'P-256 group order n, src/vault/webauthn.ts'],
  // simulate_intents answers recorded live against the deployed verifier on 2026-10-04, kept
  // whole as the chip vault's fixture. Public keys and signatures of keys made for that run and
  // thrown away: the secp256k1 keys lived in memory only, the P-256 keys inside a Secure Enclave
  // and were never stored. They hold nothing and sign for no account.
  ['5WuawsxE5gsuyvotVXSapBJB5mq6KufujFdaeugXVR9PXuuZbunAkSmshNyCmp5cZ1XorUs8YKJCWfxw5smXwB64', 'a throwaway Secure Enclave P-256 public key, recorded simulate answers (run 1), tests/fixtures/verifier/simulate-0.4.4.json'],
  ['3AomBcGG1HZkx73RBXLZaDNYfFK8D5w98JiP8GxMpXVj6mm9LNbiJK7tbo4BTLBoEBsdGMFd5J9hs2Xp4qAj57wU', 'a P-256 signature by a throwaway Secure Enclave key, recorded simulate answers (run 1), tests/fixtures/verifier/simulate-0.4.4.json'],
  ['5QiqLU12BYv5UM1CMAo9C1da3iWPYmjp4gXuHTWBTF51ukmffkPVAUigEm5i4iZQGtG4FTDm4j2AxftkaMbHC86e', 'a throwaway secp256k1 public key, recorded simulate answers (run 1), tests/fixtures/verifier/simulate-0.4.4.json'],
  ['5FYEWeTaeHk1d7RM7u24jpZFdrfT2y8syvZZbqpGJS5DGeoTzvNwp3cT25tin8SPumzbWZviPu3KoMCkDFU47XMa', 'a throwaway secp256k1 public key, recorded simulate answers (run 1), tests/fixtures/verifier/simulate-0.4.4.json'],
  ['3AomBcGG1HZkx73RBXLZaDNYfFK8D5w98JiP8GxMpXVjLjYHeQpB749dYvp8hipnruJ24zbvGC9NTpWK4ecPMkMF', 'a P-256 signature by a throwaway Secure Enclave key, recorded simulate answers (run 1), tests/fixtures/verifier/simulate-0.4.4.json'],
  ['5AGcHbjAXzm4KSBjRNftiW98QVb2s68GB6hQLfaPYwpKkvNWMZegY6M9sirGBQW4SrdL2LBjHhsZ6EpYQsB1zaJr', 'a P-256 signature by a throwaway Secure Enclave key, recorded simulate answers (run 1), tests/fixtures/verifier/simulate-0.4.4.json'],
  ['2wxqGkvvttAqDhcQbTzaYoRhUx7jq4P8BVinhVF443cdXDPTKaUFk6gPqMUCK8qAdVQNSXskdNd2QqiuavaZXe9i', 'a P-256 signature by a throwaway Secure Enclave key, recorded simulate answers (run 1), tests/fixtures/verifier/simulate-0.4.4.json'],
  ['2k3f16qsrqLFAaA1sBHL2QkggKNqareVVCYSF7Y6LsLvFU4PwBWhDGRD4rsTRUUhacy6fcprf6bTUyWA3aLjJ6sX', 'a P-256 signature by a throwaway Secure Enclave key, recorded simulate answers (run 1), tests/fixtures/verifier/simulate-0.4.4.json'],
  ['4vWDR2G32pGtTpE24Q85o8zEQ6HJ4jktMw7QGqoYaeWA4Q4KBbDaGEPTqYKJwejkuDpsbnMT6DxRW6kgXyK7Qy3z', 'a P-256 signature by a throwaway Secure Enclave key, recorded simulate answers (run 1), tests/fixtures/verifier/simulate-0.4.4.json'],
  ['4wD6CM6Uwce9Lqk3vuzafHe2MJMgKYbAWeGKqVWBgZn6Jb9utUZPvmSGJcrcMszb43BRvdSH6aDq5uPwxPeL3V7B', 'a throwaway Secure Enclave P-256 public key, recorded simulate answers (run 1), tests/fixtures/verifier/simulate-0.4.4.json'],
  ['enXHbd2CFcq2WtAJwscdzxf71BsFCrGbKRu9i7xYZPE2fTD3mCYFTWjGrfCo1FKy7kNhhe59b6jV8cEjqj9QUpd', 'a throwaway secp256k1 public key, recorded simulate answers (run 1), tests/fixtures/verifier/simulate-0.4.4.json'],
  ['538wkA6uVV7ZR4g3j3kd2KANkfThyrMpNUSmdQV9T1VcFpctq7ttMYmiH6mfvDagTPQjLirdXCREzv7ny67PkGFq', 'a P-256 signature by a throwaway Secure Enclave key, recorded simulate answers (run 1), tests/fixtures/verifier/simulate-0.4.4.json'],
  ['3ipJdQBSAUkyEWBUiszTzPdCkaLwdfi4HyvtVgyP6q8gMSZuXmts9fPbQEVMwVZUSDFwqzgZSemDSxaQ7xtkzVM8', 'a throwaway Secure Enclave P-256 public key, recorded simulate answers (run 2), tests/fixtures/verifier/simulate-0.4.4.json'],
  ['3mrmGkKVSvqG9P3GmGmpA2JTcQq9HMc6FX3vcV1MHrQhYQdcQCmnK7VgyRD3MVpP3nDSigQf2EQSpzsn7uwoSQa5', 'a P-256 signature by a throwaway Secure Enclave key, recorded simulate answers (run 2), tests/fixtures/verifier/simulate-0.4.4.json'],
  ['4g12EaqVtAmRKk5iXY5UbAJbpQvRnY57UGT6CfrcT7A5HC54deC9td5X2yDF162bXgMsaN1eR7oKs8g83iH1XNgd', 'a throwaway secp256k1 public key, recorded simulate answers (run 2), tests/fixtures/verifier/simulate-0.4.4.json'],
  ['41dQd2hdKXSMSGXhYnoh8v6b5qcqHh55SYb9Dg3D4kadzsfKbpeWYrBd2TnkbttJRxZkGiHhia1rQacNwj2tNeD1', 'a throwaway secp256k1 public key, recorded simulate answers (run 2), tests/fixtures/verifier/simulate-0.4.4.json'],
  ['3mrmGkKVSvqG9P3GmGmpA2JTcQq9HMc6FX3vcV1MHrQhajkM5h5feGuUp7gqpFoUt1iKHNymTovokK3aWHwFjZgA', 'a P-256 signature by a throwaway Secure Enclave key, recorded simulate answers (run 2), tests/fixtures/verifier/simulate-0.4.4.json'],
  ['2JGJ2rZP3jgd3PbZWGenoHMFDnP3XcxqmJuEFJteyuryzrgXt5L6FKYGsccgwDSbCiNYxr86F7kEjmCVA8FQq7T8', 'a P-256 signature by a throwaway Secure Enclave key, recorded simulate answers (run 2), tests/fixtures/verifier/simulate-0.4.4.json'],
  ['5SmcrBicueeC3cK6inShCEg8vD9vYaC4agXwbdrL5Ro9zhCFBUnBRjekwPU5p44M8FffrVU2MojVqZRq2XPdFUQL', 'a P-256 signature by a throwaway Secure Enclave key, recorded simulate answers (run 2), tests/fixtures/verifier/simulate-0.4.4.json'],
  ['2jDpBkTuKQM8w3zMc4ZxfeAWH2cGDEQNnJTEbW7WAwxr9vxY4GZaZHT79dCptEg4zHg2K8DsKsy4d35jxRuDCERh', 'a P-256 signature by a throwaway Secure Enclave key, recorded simulate answers (run 2), tests/fixtures/verifier/simulate-0.4.4.json'],
  ['DNKNuwXFjyhYxjHBL72mHsdiUUUrhQ7jC2z1zDrD9gC6qApiodNMyNZuV16K2zTJRnVo5EGEN3Jb6UmL6DmXaNU', 'a P-256 signature by a throwaway Secure Enclave key, recorded simulate answers (run 2), tests/fixtures/verifier/simulate-0.4.4.json'],
  ['3H638KALmLxevCpXzDj8dgxEZdV56z3ubYLoxgtb4fQV6fDurM5dsyzAvc67uCBR9kt23PJdB9Li1p6np3UrsJCk', 'a throwaway Secure Enclave P-256 public key, recorded simulate answers (run 2), tests/fixtures/verifier/simulate-0.4.4.json'],
  ['2REktiAKbn5tivXje8ft42YGY4k45VKaMstFFphFn3pm2MfeBuEn1hwZnWJ4dm3QxrEUCpB93pcSQRUSQnQLd4tT', 'a throwaway secp256k1 public key, recorded simulate answers (run 2), tests/fixtures/verifier/simulate-0.4.4.json'],
  ['2gQC9rghKPCRzZZk2Dypoorz9NhND4BdYfWj3NwLx8Fg5zEHLtxbFLLnMHuUvdcX72Hmgm1JP7nHud2eK6WFPQFX', 'a P-256 signature by a throwaway Secure Enclave key, recorded simulate answers (run 2), tests/fixtures/verifier/simulate-0.4.4.json'],
  ['2ecfPZ65SiMmqiAwQf5zAFbYVK9hASxzTpY54zLfQSgKMn61xN8s3Wvpnj2Qw7wPDXM4wSZKte4jbuTnAhDCgEgv', 'a P-256 signature by a throwaway Secure Enclave key, recorded simulate answers (run 2), tests/fixtures/verifier/simulate-0.4.4.json'],
]);

// Machine-written copies of public data carry digests and addresses by the hundred, and the
// exact allowlist cannot follow them: Cargo writes 518 crate checksums into Cargo.lock today
// and rewrites the set on every `cargo update`, which is why the sweep sat red for days and
// gitleaks became the gate that actually ran. Each entry here names ONE file by its exact path,
// the ONE line shape the file's own format gives that field, and, where the format has one, the
// block the line has to sit in. The whole line has to match and the block has to be real, so a
// value smuggled anywhere else in the same file still trips, and a file of the same name
// somewhere else is not this file. Adding an entry is the same human decision as adding a
// constant, with one more condition: a program writes the file from public data, a person
// never types a value into it.
export type PublicFormat = {
  file: RegExp;
  line: RegExp;
  note: string;
  // The lines above `at` have to prove the line is where the format puts it. Absent, the line
  // shape alone decides.
  block?: (lines: readonly string[], at: number) => boolean;
};

// A crates.io registry source, in the two spellings Cargo has used for it.
const CRATES_IO_SOURCE = /^source = "(registry\+https:\/\/github\.com\/rust-lang\/crates\.io-index|sparse\+https:\/\/index\.crates\.io\/)"$/;

// Walks up from a checksum line to the `[[package]]` header of its block and asks whether that
// block names a crates.io source. A blank line, the file's head, or any other table header
// before the package header means the line is not inside a package block at all. A git or
// path dependency has no checksum, so a checksum line under one is not Cargo's either.
function insideCratesIoPackage(lines: readonly string[], at: number): boolean {
  let source = false;
  for (let i = at - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === '[[package]]') return source;
    if (line.trim() === '' || line.startsWith('[')) return false;
    if (CRATES_IO_SOURCE.test(line)) source = true;
  }
  return false;
}

export const KNOWN_PUBLIC_FORMATS: PublicFormat[] = [
  {
    // `checksum = "<sha256>"` under a [[package]] Cargo took from the registry: the digest of a
    // published crate archive, which anyone can recompute from crates.io. This repo has one
    // lockfile; a second one is a new entry here, decided by a person, not a match on the name.
    file: /^src-tauri\/Cargo\.lock$/,
    line: /^checksum = "[0-9a-f]{64}"$/,
    note: 'crate checksum from the registry index',
    block: insideCratesIoPackage,
  },
  {
    // The POA bridge's supported_tokens answer, kept whole as a fixture (its _comment says
    // when). On the Move chains and Starknet a token contract address is 32 bytes of hex, and
    // the bridge writes the same address into the asset identifier and the origin address of
    // one JSON object per line; the backreference holds the two to the same value.
    file: /^tests\/fixtures\/poa-tokens\.json$/,
    line: /^\s*\{"defuse_asset_identifier":"[a-z]+:mainnet:0x([0-9a-f]{64})(::\w+::\w+)?","origin_chain_address":"0x\1(::\w+::\w+)?","near_token_id":"[a-z0-9._-]+",.*\},?$/,
    note: 'a token contract address in the bridge token list',
  },
];

export function publicFormat(file: string, lines: readonly string[], at: number): PublicFormat | undefined {
  const line = lines[at];
  return KNOWN_PUBLIC_FORMATS.find((f) => f.file.test(file) && f.line.test(line) && (f.block === undefined || f.block(lines, at)));
}

// A 32 byte key drawn from a CSPRNG uses nearly every hex character. A run that uses four or
// fewer is a ruler, a placeholder or a zero address, not key material: the chance a real key
// looks like this is smaller than the chance the disk is lying. Cheaper and more honest than
// listing every padding string in the codebase by hand.
function tooRegularToBeAKey(value: string): boolean {
  return new Set(value).size <= 4;
}

function allowlistKey(value: string): string {
  return /^[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() : value;
}

export function scanContent(where: string, file: string, content: string, findings: Finding[]): void {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (publicFormat(file, lines, i)) continue;
    for (const pattern of PATTERNS) {
      pattern.re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.re.exec(line)) !== null) {
        if (KNOWN_PUBLIC_CONSTANTS.has(allowlistKey(match[0]))) continue;
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

export type Blob = { sha: string; file: string; content: string };

// The scope check 5 reads, as the header describes it: published, all, or one revision.
export function historyScope(argv: readonly string[]): string {
  let scope = 'published';
  for (const arg of argv) {
    if (!arg.startsWith('--history=') || arg === '--history=') {
      throw new Error(`unknown argument ${arg}: the one flag is --history=published, --history=all or --history=<revision>`);
    }
    scope = arg.slice('--history='.length);
  }
  return scope;
}

const SCOPE_TEXT: Record<string, string> = { published: 'HEAD, the remote branches and the tags', all: 'every ref' };

function historyRevs(scope: string): string[] {
  if (scope === 'published') return ['HEAD', '--remotes', '--tags'];
  if (scope === 'all') return ['--all'];
  return [scope];
}

// Every object reachable from the given revisions. Unreachable objects in the object database
// are excluded on purpose: they cannot be pushed, and reporting them would fail the sweep for a
// commit that was amended away.
export function historyBlobs(revs: readonly string[], cwd = ROOT): Blob[] {
  const listing = git(['rev-list', '--objects', ...revs], undefined, cwd).split('\n').filter((l) => l !== '');
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
  const raw = Buffer.from(git(['cat-file', '--batch'], shas.join('\n') + '\n', cwd), 'latin1');
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

export type HistoryResult = { ok: boolean; detail: string; findings: Finding[]; blobs: Blob[] };

export function historyCheck(scope: string, cwd = ROOT): HistoryResult {
  const what = SCOPE_TEXT[scope] ?? scope;
  const refuse = (detail: string): HistoryResult => ({ ok: false, detail, findings: [], blobs: [] });
  // A revision that starts with a dash would reach git as an option.
  if (scope.startsWith('-')) return refuse(`--history takes published, all or a revision, not ${scope}`);
  let blobs: Blob[];
  try {
    if (git(['rev-parse', '--is-shallow-repository'], undefined, cwd).trim() === 'true') {
      return refuse(`shallow clone: the history behind ${what} is not here to scan (fetch it whole, e.g. fetch-depth: 0)`);
    }
    blobs = historyBlobs(historyRevs(scope), cwd);
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim().split('\n')[0];
    return refuse(`cannot list the history of ${what}: ${stderr || (err instanceof Error ? err.message : String(err))}`);
  }
  const findings: Finding[] = [];
  for (const blob of blobs) scanContent(`history ${blob.sha.slice(0, 8)}`, blob.file, blob.content, findings);
  return { ok: findings.length === 0, detail: `${blobs.length} blobs reachable from ${what} scanned`, findings, blobs };
}

// ---------- identifying values from the local, unpublished files ----------

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out);
}

// Only values that identify a wallet or open one. Config also holds "state" and "BTC-USD",
// which appear in tracked files for good reasons and must not fail the sweep.
function looksIdentifying(v: string): boolean {
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) return true; // EVM address
  if (/^0x[0-9a-fA-F]{64}$/.test(v)) return true; // EVM private key
  if (/^[0-9a-f]{64}$/.test(v)) return true; // NEAR implicit account id, raw seed
  if (/^ed25519:/.test(v)) return true;
  if (/^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(v)) return true; // Solana address or secret key
  if (/^[a-z0-9_-]{2,60}\.near$/.test(v)) return true; // named NEAR account
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

function main(): void {
  let scope: string;
  try {
    scope = historyScope(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }

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
  const history = historyCheck(scope);
  add('git history', history.ok, history.detail, history.findings);
  const blobs = history.blobs;

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
    const mustBeHidden = ['config.local.json', 'keys.json', 'keys.enc.json', '.env', '.env.local', '.env.production', 'state/', 'state/audit.jsonl', 'secret.key'];
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
      /* The app's own check, called rather than copied. The copy that used to live here compared
         strings, so it reported the same false pass the app did for a differently-cased spelling
         of the repo root or a symlink pointing into it: a sweep that agrees with the bug it is
         sweeping for is worse than no sweep. */
      let inside = false;
      let why = `keysPath resolves to ${keysPath}`;
      try {
        assertOutsideRepo(keysPath, ROOT);
      } catch (err) {
        inside = true;
        why = err instanceof Error ? err.message : String(err);
      }
      add('keys outside repo', !inside, why);
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
    console.log('  a machine-written   add its file and line shape to KNOWN_PUBLIC_FORMATS, only when a');
    console.log('  public digest       program writes that file from public data');
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
