// Signing Hyperliquid L1 actions: orders, cancels, modifies, leverage changes.
//
// This is the THIRD signing site in the repo and the only one that holds a key which cannot
// move funds. src/chain/evm.ts signs EVM transactions with the master key.
// src/rails/hyperliquid-withdraw.ts signs user actions with the master key and is reachable
// only from scripts/. This file signs with an API wallet, which the venue permits to trade and
// forbids from withdrawing, transferring, or approving another agent. That split is why the
// key in the hot path is allowed to be online at all.
//
// It is emphatically NOT the scheme hyperliquid-withdraw.ts uses. That one is real EIP-712 over
// the action's own fields, domain 'HyperliquidSignTransaction', with the real chain id. This one
// is msgpack, then keccak, then a "phantom agent" wrapper signed as EIP-712 with a domain whose
// chain id is the literal 1337 on BOTH networks. Copy that module's rigour, none of its bytes.
//
// The venue reports a bad signature as "User or API Wallet 0x... does not exist", with a garbage
// recovered address and no hint about which of the five documented traps you hit. So each one is
// handled explicitly below and pinned by a test:
//
//   1. Two schemes exist. This file implements one and says which.
//   2. msgpack field ORDER is part of the hash. src/hl/msgpack.ts preserves insertion order and
//      the action builders in src/hl/exchange.ts construct keys in the documented order.
//   3. Trailing zeroes change the hash. Numbers reach here already as wire strings from
//      src/hl/format.ts, never as JS numbers.
//   4. Upper case in an address changes the hash. Every address is lowercased here.
//   5. A local recover returning the right address proves nothing, because the payload you
//      recovered from may not be the payload the L1 rebuilds. The test therefore pins the action
//      hash itself against a fixed byte string, so a msgpack regression fails loudly here rather
//      than silently at the venue.

import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { packb } from './msgpack.ts';

export type Signature = { r: string; s: string; v: number };

function u64be(n: number): Uint8Array {
  const out = new Uint8Array(8);
  // Nonces are unix milliseconds, which exceed 32 bits, so this goes through BigInt rather
  // than bit shifts. A shift here would silently truncate and produce a valid signature over
  // the wrong nonce.
  let v = BigInt(n);
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function addressBytes(address: string): Uint8Array {
  const hex = address.toLowerCase().replace(/^0x/, '');
  if (hex.length !== 40) throw new Error(`address must be 20 bytes, got ${address}`);
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// keccak( msgpack(action) || nonce as 8 bytes BE || vault marker || optional expiresAfter )
//
// The vault marker is a single 0x00 when there is no vault, or 0x01 followed by the 20 address
// bytes when there is. expiresAfter, when present, appends its own 0x00 separator before the
// eight bytes. Both of those little framing bytes are load-bearing and neither is guessable.
export function actionHash(
  action: unknown,
  nonce: number,
  vaultAddress: string | null,
  expiresAfter: number | null,
): `0x${string}` {
  const parts: Uint8Array[] = [packb(action), u64be(nonce)];

  if (vaultAddress === null || vaultAddress === undefined) parts.push(new Uint8Array([0x00]));
  else parts.push(new Uint8Array([0x01]), addressBytes(vaultAddress));

  if (expiresAfter !== null && expiresAfter !== undefined) {
    parts.push(new Uint8Array([0x00]), u64be(expiresAfter));
  }

  return keccak256(toHex(concat(parts)));
}

const AGENT_TYPES = {
  Agent: [
    { name: 'source', type: 'string' },
    { name: 'connectionId', type: 'bytes32' },
  ],
} as const;

export async function signL1Action(
  privKey: `0x${string}`,
  action: unknown,
  nonce: number,
  isMainnet: boolean,
  vaultAddress: string | null = null,
  expiresAfter: number | null = null,
): Promise<Signature> {
  const connectionId = actionHash(action, nonce, vaultAddress, expiresAfter);
  const account = privateKeyToAccount(privKey);

  const signature = await account.signTypedData({
    // chainId is the literal 1337 on mainnet and testnet alike. The network is carried ONLY by
    // `source` below. Swapping those two produces a perfectly valid signature for the other
    // network, which the venue reports as a wallet that does not exist.
    domain: {
      name: 'Exchange',
      version: '1',
      chainId: 1337,
      verifyingContract: '0x0000000000000000000000000000000000000000',
    },
    types: AGENT_TYPES,
    primaryType: 'Agent',
    message: { source: isMainnet ? 'a' : 'b', connectionId },
  });

  // viem returns a packed 65-byte signature; the venue wants the parts named.
  const r = `0x${signature.slice(2, 66)}`;
  const s = `0x${signature.slice(66, 130)}`;
  let v = Number.parseInt(signature.slice(130, 132), 16);
  // Normalise a 0/1 recovery id to the 27/28 the venue expects.
  if (v < 27) v += 27;

  return { r, s, v };
}
