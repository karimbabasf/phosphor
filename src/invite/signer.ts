// The second signer: a key that is not the wallet's, signing erc191 intents for one account
// inside intents.near. An invite code's key in the app, the treasury's in the operator script.
//
// THE STATED EXCEPTION (docs/security-model.md, "What signs, and with what"). src/keystore/index.ts
// holds every signer to one rule: it takes key material from the keystore and fails while the
// wallet is locked. That rule protects the wallet's key, and this key is not the wallet's: the
// code is the key, and the person typed it. The claim still runs only while the wallet is open,
// because the receiver it pays must be a decrypted address (src/invite/claim.ts).
//
// What is here touches the key and nothing else, the way src/intents-sign.ts is built: it signs
// the string it is handed. Building and checking that string is src/invite/payload.ts.

import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';

import { erc191SignatureField } from '../intents-sign.ts';
import type { IntentsSignerPort } from '../intents-sign.ts';
import { deriveKey } from './code.ts';

export type KeySigner = {
  // The account inside intents.near, lowercased the way the verifier keys an erc191 signer.
  address: string;
  // erc191 personal_sign over the exact string, in the verifier's encoding. Throws once dropped.
  sign(payload: string): Promise<string>;
  // Forget the key. A dropped signer signs nothing again.
  drop(): void;
};

export function keySigner(privateKey: Hex): KeySigner {
  let account: PrivateKeyAccount | null = privateKeyToAccount(privateKey);
  const address = account.address.toLowerCase();
  return {
    address,
    async sign(payload) {
      if (account === null) throw new Error('this signer has been dropped');
      return erc191SignatureField(await account.signMessage({ message: payload }));
    },
    drop() {
      account = null;
    },
  };
}

/* The code's own signer, or null for a secret whose key is out of range (never issued). The
   secret is wiped here: from this point the key exists only inside the signer, until drop(). */
export function codeSigner(secret: Uint8Array): KeySigner | null {
  try {
    const key = deriveKey(secret);
    return key === null ? null : keySigner(key);
  } finally {
    secret.fill(0);
  }
}

/* The same signer in the shape the 1Click spend path takes (src/rails/intents-spend.ts), for
   Plan B and the operator's convert. The keys path that port carries names the wallet's key file,
   and this signer never reads one: the key is already in hand. `beforeSign` and `afterSign` may
   throw to stop the spend before anything is sent: a record that could not be written. */
export function signerPort(
  signer: KeySigner,
  beforeSign?: (payload: string) => void,
  afterSign?: (payload: string, signature: string) => void,
): IntentsSignerPort {
  return {
    address: () => signer.address as Address,
    async signErc191(_keysPath, payload) {
      beforeSign?.(payload);
      const signature = await signer.sign(payload);
      afterSign?.(payload, signature);
      return signature;
    },
  };
}
