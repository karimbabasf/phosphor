// The published vectors for the keys derived from the owner key (src/keystore/derived.ts,
// docs/security-model.md). Both owner keys are public test keys already on the sweep allowlist:
// the canonical Ethereum documentation key and the hyperliquid-python-sdk signing fixture. Every
// value below was checked outside this code when it was written down: HKDF with Python's hmac
// (itself checked against RFC 5869 test case 1), each ALLOWANCE address with foundry's
// `cast wallet address`, each GAS public key with the OpenSSL command line.

export type DerivedVector = { old: string; vault: string; allowanceKey: string; allowance: string; gasSeed: string; gas: string };

export const DERIVED_VECTORS: DerivedVector[] = [
  {
    old: '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
    vault: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23',
    allowanceKey: 'c96e3431c7fe5789854eb223ffab755b902c08bb34fdf40bfcb9839589d3faa1',
    allowance: '0xF6BEEE2877DC58331cFa06c66Cc47B5F2535A379',
    gasSeed: 'f393907ec2ad1db656b6bd3d8e4804ad70d12ed136c76f46dac1549606a6c64d',
    gas: 'e4d620800228e29d21a180cc305b9541c170631df3b5b513b795947a27520108',
  },
  {
    old: '0123456789012345678901234567890123456789012345678901234567890123',
    vault: '0x14791697260E4c9A71f18484C9f997B308e59325',
    allowanceKey: '7ee7c33929bff790cd5b87813289af4628ae027f0a5bdcdb3f4d196ef5ea4f9a',
    allowance: '0x619f9D371128BED76934C04434Bf9C43b904bE36',
    gasSeed: 'fcda8770013610a5a890531e5a67a8d96dbe3d6ef142f2494999a58ba4743879',
    gas: 'ca541826c952a550f599949160d91d6dcd82616f0a07cd5488cb8e30ab62b5f7',
  },
];
