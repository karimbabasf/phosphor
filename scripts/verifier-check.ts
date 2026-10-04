// Which NEAR Intents verifier is deployed, held against the one the chip vault was spiked on: its
// version (contract_source_metadata) and the hash of its code (view_account), and `spiked: yes`
// only for that exact pair. Exit 0 when spiked, 1 when the verifier is another build or a check
// failed, 2 when the NEAR RPC did not answer.
//
// `--simulate` also runs two bundles through simulate_intents, signed by keys made for this run:
// a secp256k1 key as a throwaway vault's own key (erc191) and a software P-256 key in the chip's
// place (webauthn, in the wrapper src/vault/webauthn.ts builds). The first is the shape of the
// chip's first live proof: the vault's key adds the chip key, and the chip key signs an empty
// payload. The second is the move to the chip: the vault's key adds the chip key and a paper key,
// removes itself and turns off auth by predecessor id, then the paper key and the chip key each
// sign an empty payload. Each passes only when the verifier reports exactly the events
// src/vault/payload.ts expects. simulate_intents is a view: nothing is sent, the throwaway account
// holds nothing, and the keys never leave this process.
//
// Run: node scripts/verifier-check.ts [--simulate]

import crypto from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

import { base58Encode } from '../src/chain/near.ts';
import { ERC191_STANDARD, erc191SignatureField } from '../src/intents-sign.ts';
import { SPIKED_VERIFIER, isSpikedVerifier, liveVerifier } from '../src/relay/verifier.ts';
import type { SignedIntent, VerifierEvent } from '../src/relay/verifier.ts';
import { buildVaultPayload, eventsMismatch, expectedEvents } from '../src/vault/payload.ts';
import type { VaultIntent } from '../src/vault/payload.ts';
import { webauthnMessage, webauthnMultiPayload, webauthnSigned } from '../src/vault/webauthn.ts';

const verifier = liveVerifier();
const short = (hash: string) => `${hash.slice(0, 6)}...${hash.slice(-4)}`;

// The free RPC answers -429 now and then under load: a read that got no answer is asked again.
async function asked<T>(read: () => Promise<T | null>): Promise<T | null> {
  for (let tries = 0; tries < 3; tries += 1) {
    const answer = await read();
    if (answer !== null) return answer;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  return null;
}

function noAnswer(what: string): never {
  console.log(`${what}: the NEAR RPC did not answer`);
  process.exit(2);
}

const source = await asked(() => verifier.sourceMetadata!());
if (source === null) noAnswer('intents.near');
const spiked = isSpikedVerifier(source);
console.log(`intents.near ${source.version} ${short(source.codeHash)} spiked: ${spiked ? 'yes' : 'no'}`);
if (!spiked) console.log(`spiked on ${SPIKED_VERIFIER.version} ${short(SPIKED_VERIFIER.codeHash)}: this build has not been tested`);
if (!process.argv.includes('--simulate')) process.exit(spiked ? 0 : 1);

// ---------- the live simulations ----------

function secpKey() {
  const account = privateKeyToAccount(generatePrivateKey());
  return {
    address: account.address.toLowerCase(),
    // The verifier's spelling: x || y, without the 0x04 an uncompressed key starts with.
    publicKey: `secp256k1:${base58Encode(Buffer.from(account.publicKey.slice(4), 'hex'))}`,
    sign: async (payload: string): Promise<SignedIntent> => ({ standard: ERC191_STANDARD, payload, signature: erc191SignatureField((await account.signMessage({ message: payload })) as Hex) }),
  };
}

function chipStandIn() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const xy = Uint8Array.from(Buffer.concat([Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
  return {
    publicKey: `p256:${base58Encode(xy)}`,
    // The service's answer, then the same check every chip answer passes before a bundle.
    sign: (payload: string) => webauthnMultiPayload(webauthnSigned(payload, xy, crypto.sign('sha256', webauthnMessage(payload), { key: privateKey, dsaEncoding: 'ieee-p1363' }))),
  };
}

function names(events: readonly VerifierEvent[]): string {
  return events.map((e) => (e.event === 'set_auth_by_predecessor_id' ? `${e.event}(enabled=${e.data.enabled})` : e.event)).join(',');
}

const old = secpKey();
const paper = secpKey();
const chip = chipStandIn();
const vault = old.address;
console.log(`throwaway vault ${vault}: its own key, a paper key and a software P-256 key in the chip's place, made for this run`);

const block = await asked(() => verifier.finalBlock!());
const salt = await asked(() => verifier.currentSalt());
if (block === null || salt === null) noAnswer('the final block and the salt');
const [oldOn, chipOn, keys, predecessorAuth] = await Promise.all([
  asked(() => verifier.hasPublicKey!(vault, old.publicKey)),
  asked(() => verifier.hasPublicKey!(vault, chip.publicKey)),
  asked(() => verifier.publicKeysOf!(vault)),
  asked(() => verifier.isAuthByPredecessorIdEnabled!(vault)),
]);
if (oldOn === null || chipOn === null || keys === null || predecessorAuth === null) noAnswer('the views');
const authBefore: boolean = predecessorAuth;
console.log(`views before: has_public_key own key ${oldOn}, chip ${chipOn}; public_keys_of [${keys.join(', ')}]; is_auth_by_predecessor_id_enabled ${predecessorAuth}`);
let failed = !oldOn || chipOn || keys.length !== 0 || !predecessorAuth;
if (failed) console.log('FAIL a fresh vault reads: its own key on by name, no stored keys, predecessor auth on');

// The chain's clock plus 110 s, inside the two minutes the chip's grammar allows.
const deadlineMs = block.atMs + 110_000;
const payloadOf = (intents: VaultIntent[]) => buildVaultPayload({ signerId: vault, intents, deadlineMs, salt });

async function run(label: string, bundle: SignedIntent[]): Promise<void> {
  const sim = await asked(() => verifier.simulate!(bundle));
  if (sim === null) noAnswer(`simulate ${label}`);
  if (!sim.ok) {
    failed = true;
    console.log(`FAIL simulate ${label}: refused, "${sim.refusal}"`);
    return;
  }
  const mismatch = eventsMismatch(sim.events, expectedEvents(bundle, { predecessorAuth: authBefore }));
  if (mismatch !== null) failed = true;
  console.log(`${mismatch === null ? 'PASS' : 'FAIL'} simulate ${label}: executed=${sim.intentHashes.length} events=${names(sim.events ?? [])} exact: ${mismatch === null ? 'yes' : `no, ${mismatch}`}`);
}

const proof = payloadOf([]);
await run('first proof (own key adds the chip; the chip signs an empty payload)', [await old.sign(payloadOf([{ intent: 'add_public_key', public_key: chip.publicKey }])), chip.sign(proof)]);

const move = payloadOf([
  { intent: 'add_public_key', public_key: chip.publicKey },
  { intent: 'add_public_key', public_key: paper.publicKey },
  { intent: 'remove_public_key', public_key: old.publicKey },
  { intent: 'set_auth_by_predecessor_id', enabled: false },
]);
await run('move to the chip (own key adds chip and paper, removes itself, predecessor auth off; paper []; chip [])', [await old.sign(move), await paper.sign(payloadOf([])), chip.sign(payloadOf([]))]);

process.exit(failed || !spiked ? 1 : 0);
