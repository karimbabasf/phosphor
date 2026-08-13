// Proves the NEAR signer against the real testnet chain. Run: npm run near:prove
//
// Unit tests cover the serializer against vectors and the signature against node's own
// verifier. They cannot cover the one thing that matters most: whether the NEAR network
// accepts what this app produces. Only the network can answer that, and a borsh encoder that
// is wrong in a way no vector caught fails here and nowhere else.
//
// The round trip is deliberately whole rather than a single send:
//
//   1. Transfer      a token of NEAR to itself. Exercises the Transfer action, which the
//                    wrap path never touches.
//   2. storage       register on wrap.testnet if it is not registered already. Exercises a
//                    FunctionCall with an attached deposit.
//   3. near_deposit  wrap NEAR into wNEAR. This is the asset 1Click actually quotes: its
//                    token list has no native NEAR at all, only nep141:wrap.near.
//   4. near_withdraw unwrap it again, so the script leaves the account as it found it apart
//                    from gas. A proof that costs the balance is one nobody runs twice.
//
// TESTNET ONLY, and the guard is first. There is nothing to learn on mainnet that testnet
// does not teach, and a script whose whole job is to sign should not be pointable at real
// money by editing one config field.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import {
  TGAS,
  YOCTO_PER_NEAR,
  formatNear,
  ftBalance,
  ftStorageRegistered,
  functionCall,
  nativeBalance,
  readNearSigner,
  selfCheck,
  sendTx,
  transfer,
} from '../src/chain/near.ts';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOKEN = 'wrap.testnet';
const WRAP_AMOUNT = YOCTO_PER_NEAR / 10n; // 0.1 NEAR
const PROBE_AMOUNT = 1n; // one yoctoNEAR, to itself

// Reads after a send have to ask for optimistic state. sendTx returns at
// EXECUTED_OPTIMISTIC, which is ahead of finality, so a read at 'final' taken straight
// afterwards returns the state from before the transaction and looks exactly like a
// silent failure. This cost an hour the first time.
const AFTER_SEND = { finality: 'optimistic' as const };

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(16)} ${value}`);
}

async function step(
  name: string,
  run: () => Promise<{ ok: boolean; hash?: string; explorer?: string; gasBurnt?: string; error?: string }>,
): Promise<boolean> {
  process.stdout.write(`\n${name}\n`);
  const out = await run();
  if (!out.ok) {
    line('FAILED', out.error ?? 'unknown error');
    return false;
  }
  line('tx', out.hash ?? '(none)');
  line('explorer', out.explorer ?? '(none)');
  line('gas burnt', out.gasBurnt ?? '(none)');
  return true;
}

async function main(): Promise<void> {
  const cfg = loadConfig(ROOT);

  if (cfg.network !== 'testnet') {
    console.error(`refusing to run on ${cfg.network}. This script signs real transactions and exists to`);
    console.error('prove the signer on testnet. Point config.json at testnet to run it.');
    process.exit(1);
  }

  // Vectors before keys, the same order scripts/keygen.ts uses: a broken primitive stops the
  // program rather than producing a signature nobody can verify.
  selfCheck();
  console.log('self check: PASS (base58, sha256, borsh widths, ed25519 RFC 8032 vectors)');

  const signer = readNearSigner(cfg.keysPath);
  console.log('');
  line('account', signer.accountId);
  line('public key', signer.publicKey);
  line('network', cfg.network);

  const startNative = await nativeBalance('testnet', signer.accountId);
  const startWrapped = (await ftStorageRegistered('testnet', TOKEN, signer.accountId))
    ? await ftBalance('testnet', TOKEN, signer.accountId)
    : 0n;
  console.log('');
  line('NEAR', formatNear(startNative));
  line('wNEAR', formatNear(startWrapped));

  if (startNative < YOCTO_PER_NEAR / 2n) {
    console.error(`\n${signer.accountId} holds too little NEAR to pay gas. Fund it from the testnet faucet.`);
    process.exit(1);
  }

  // 1. Transfer, the action the wrap path never uses.
  const transferred = await step(`1. Transfer ${PROBE_AMOUNT} yocto to itself (proves the Transfer action)`, () =>
    sendTx({
      network: 'testnet',
      keysPath: cfg.keysPath,
      receiverId: signer.accountId,
      actions: [transfer(PROBE_AMOUNT)],
    }),
  );
  if (!transferred) process.exit(1);

  // 2. Storage, only when it is actually missing.
  if (!(await ftStorageRegistered('testnet', TOKEN, signer.accountId, AFTER_SEND))) {
    const registered = await step(`2. storage_deposit on ${TOKEN} (proves an attached deposit)`, () =>
      sendTx({
        network: 'testnet',
        keysPath: cfg.keysPath,
        receiverId: TOKEN,
        actions: [
          functionCall(
            'storage_deposit',
            { account_id: signer.accountId, registration_only: true },
            30n * TGAS,
            1250000000000000000000n, // storage_balance_bounds.min on wrap.testnet
          ),
        ],
      }),
    );
    if (!registered) process.exit(1);
  } else {
    console.log(`\n2. storage_deposit on ${TOKEN}\n  already registered, skipped`);
  }

  // 3. Wrap.
  const wrapped = await step(`3. near_deposit ${formatNear(WRAP_AMOUNT)} NEAR -> wNEAR`, () =>
    sendTx({
      network: 'testnet',
      keysPath: cfg.keysPath,
      receiverId: TOKEN,
      actions: [functionCall('near_deposit', {}, 30n * TGAS, WRAP_AMOUNT)],
    }),
  );
  if (!wrapped) process.exit(1);

  const afterWrap = await ftBalance('testnet', TOKEN, signer.accountId, AFTER_SEND);
  line('wNEAR now', formatNear(afterWrap));
  if (afterWrap < startWrapped + WRAP_AMOUNT) {
    console.error('\nthe wrap reported success but the balance did not move. Stopping before unwrapping.');
    process.exit(1);
  }

  // 4. Unwrap, so the script is repeatable.
  const unwrapped = await step(`4. near_withdraw ${formatNear(WRAP_AMOUNT)} wNEAR -> NEAR`, () =>
    sendTx({
      network: 'testnet',
      keysPath: cfg.keysPath,
      receiverId: TOKEN,
      actions: [functionCall('near_withdraw', { amount: WRAP_AMOUNT.toString() }, 30n * TGAS, 1n)],
    }),
  );
  if (!unwrapped) process.exit(1);

  const endNative = await nativeBalance('testnet', signer.accountId, AFTER_SEND);
  const endWrapped = await ftBalance('testnet', TOKEN, signer.accountId, AFTER_SEND);

  console.log('');
  line('NEAR', formatNear(endNative));
  line('wNEAR', formatNear(endWrapped));
  line('gas cost', formatNear(startNative - endNative) + ' NEAR');
  console.log('');
  console.log('PROVEN on chain: borsh serialization, ed25519 signing, nonce and block hash');
  console.log('selection, transaction broadcast, and receipt-level failure detection.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
