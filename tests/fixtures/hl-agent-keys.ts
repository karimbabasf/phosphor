// The published vectors for the Hyperliquid trading key derived from the owner key
// (src/keystore/derived.ts, HL-AGENT; docs/trading.md). The owner keys are the two public test keys
// of tests/fixtures/derived-keys.ts. Every value below was checked outside this code when it was
// written down: HKDF with Python's hmac (itself checked against RFC 5869 test case 1, and against the
// ALLOWANCE vectors already published) and again with `openssl kdf ... HKDF`, each address with
// foundry's `cast wallet address`.

export type HlAgentVector = { old: string; version: number; key: string; address: string };

export const HL_AGENT_VECTORS: HlAgentVector[] = [
  {
    old: '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
    version: 1,
    key: '9bd79f6143f38e7148895138bc777a7f1713871b372118ee6fd1905ab541cdcc',
    address: '0xCa9AAd7B7e6D078718298039b40ef289C52F1E04',
  },
  {
    old: '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
    version: 2,
    key: 'b019392723d9eff17f3a6e27b6ee0fb604d2867b076c996e225da6bcb30aa966',
    address: '0x4b1495fD164fE42D80718ece02b34019fbc3aF0d',
  },
  {
    old: '0123456789012345678901234567890123456789012345678901234567890123',
    version: 1,
    key: '15e2354fbbd2692b68388e3bde1fff440cf9ba7033b26ca7483970a5cca118c6',
    address: '0x1C9493880Bb881Dff05705d8bf8B683797e63409',
  },
  {
    old: '0123456789012345678901234567890123456789012345678901234567890123',
    version: 2,
    key: '883dae3c8b464ef6a145bc1033d034d8dea7bf0632c2d455eff327a21f0e8bf2',
    address: '0x29C579b2b3915F698938d22a271FfCfFcb003c69',
  },
];
