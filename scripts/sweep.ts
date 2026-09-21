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
  ['fe1a043dc1f5b7e5bd361b397a615f8f791a317cf2d7c28e483746020cf2dd04', 'sendAsset mainnet signature r for the SDK fixture, docs/superpowers/prompts/ready-for-people/evidence-b/sendasset-research.md'],
  ['3dbf449f1d7dc7c819e04c8f88e30edc762abbc69351d278e851c2b7c1fd9d39', 'sendAsset mainnet signature s for the SDK fixture, docs/superpowers/prompts/ready-for-people/evidence-b/sendasset-research.md'],
  ['99a9ac7337378f56543cb5a762b710d4afd8925abf644bb6ec03ed9669c8f60e', 'sendAsset testnet signature r for the SDK fixture, docs/superpowers/prompts/ready-for-people/evidence-b/sendasset-research.md'],
  ['5d2db4547b8b54c9c54ce80a4948031566e5e78267eb3d9fe811960f59a7dcc0', 'sendAsset testnet signature s for the SDK fixture, docs/superpowers/prompts/ready-for-people/evidence-b/sendasset-research.md'],
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
  // Demo rail hashes from node B's evidence (docs/superpowers/prompts/ready-for-people/evidence-b, the kill -9 and withdraw walks on a demo backend): minted by the demo rail, real nowhere.
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
  // the launch evidence under docs/superpowers/prompts/ready-for-people/evidence-g records them.
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
