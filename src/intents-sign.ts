// The one door to the EVM key for a NEAR Intents signature: ERC-191 personal_sign over a
// payload string, encoded the way the verifier contract reads it.
//
// It lived inside src/rails/intents-native.ts, the 1Click swap rail, and the relay swap rail
// (src/rails/intents-relay.ts) signs the same way. Two rails importing each other for a signer
// is how a retired rail keeps a live one alive, so the signer sits here, under neither, and
// both rails and the two Hyperliquid rails read it from one place.
//
// What is here is exactly what touches the key and what shapes its output. Nothing here
// builds a payload, checks one, or talks to a venue: a signer that also decided what to sign
// would be the second copy of every check that guards the key.

import { hexToBytes } from 'viem';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { base58Encode } from './chain/near.ts';
import { evmAddress, evmPrivateKey } from './keystore/index.ts';

// The signing standard, as the relay and 1Click both spell it. erc191 is plain personal_sign
// over the EVM key the app already holds, which is why no rail needs a NEAR key.
export const ERC191_STANDARD = 'erc191';

// viem returns a 65-byte signature with v in {27, 28}, the value Ethereum clients emit. The
// verifier contract expects the recovery byte in {0, 1} and the docs call this out as a
// client responsibility, so a signature normalised wrong is rejected on chain after the
// intent has already been submitted.
export function erc191SignatureField(signatureHex: Hex): string {
  const raw = hexToBytes(signatureHex);
  if (raw.length !== 65) {
    throw new Error(`erc191 signature must be 65 bytes, got ${raw.length}`);
  }
  const v = raw[64];
  const recovery = v === 27 || v === 28 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) {
    throw new Error(`erc191 recovery byte must normalise to 0 or 1, got ${v}`);
  }
  const normalised = Uint8Array.from(raw);
  normalised[64] = recovery;
  return `secp256k1:${base58Encode(normalised)}`;
}

export type IntentsSignerPort = {
  address(keysPath: string): Address;
  // erc191 personal_sign over the exact payload string, returned in the verifier's encoding.
  signErc191(keysPath: string, payload: string): Promise<string>;
};

/* One door, src/keystore, and the property it adds is the one a duplicate reader could not
   have: a locked wallet has no key to hand out, so this signer fails by name rather than
   opening a file that is not there any more. */
export const liveIntentsSigner: IntentsSignerPort = {
  address(keysPath: string): Address {
    // The ADDRESS, so it comes from the keystore header and works while locked.
    return evmAddress(keysPath);
  },
  async signErc191(keysPath: string, payload: string): Promise<string> {
    const account = privateKeyToAccount(evmPrivateKey(keysPath));
    // viem's signMessage is EIP-191 personal_sign: it prefixes the payload and hashes it the
    // way the verifier expects for the erc191 standard.
    const signature = await account.signMessage({ message: payload });
    return erc191SignatureField(signature);
  },
};

/* The first key that appears twice in one object of a JSON text, decoded the way a parser
   decodes it, or null. JSON.parse keeps the last of two equal keys, and a payload is signed
   as the string it is, so a payload carrying `"intents":[theirs],"intents":[ours]` would be
   checked against ours and signed over both, leaving what the signature meant to whichever
   rule the verifier's parser applies. Written for a text JSON.parse has already accepted, so
   the walk trusts the structure and only counts keys. Here beside the signer because it is a
   rule about what may be signed, and both swap rails run it on the string they sign. */
export function duplicateJsonKey(text: string): string | null {
  type Frame = { keys: Set<string> | null; expectKey: boolean };
  const stack: Frame[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const top = stack[stack.length - 1];
    if (ch === '"') {
      const start = i;
      i += 1;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i += 1;
      if (top !== undefined && top.keys !== null && top.expectKey) {
        const key = JSON.parse(text.slice(start, i)) as string;
        if (top.keys.has(key)) return key;
        top.keys.add(key);
        top.expectKey = false;
      }
      continue;
    }
    if (ch === '{') stack.push({ keys: new Set(), expectKey: true });
    else if (ch === '[') stack.push({ keys: null, expectKey: false });
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === ',' && top !== undefined && top.keys !== null) top.expectKey = true;
    i += 1;
  }
  return null;
}
