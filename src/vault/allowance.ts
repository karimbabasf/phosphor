// The allowance: what the agent spends with no click once the vault has moved to this Mac's Touch
// ID key, kept near the size the person picked (PHASE2-PLAN.md section 1, C8, P2.6).
//
// Two moves, both inside the verifier, both sent by the gas account through the vault submitter
// (src/vault/submit.ts: the exact events simulated before anything leaves, one signature per move,
// and nothing signed again while an earlier move may still run):
//   TOP-UP, vault to allowance. The vault's chip key signs (src/vault/chip.ts) behind one Touch ID,
//     and the vault service writes the sentence from the payload it signs ("move 5.00 USDC from
//     your vault to your allowance"). Always behind a click (src/policy/engine.ts), never the
//     agent's: it has no tool for one. A move bigger than the allowance gets one for its exact
//     shortfall, of the coin the move spends (src/proposals/execute.ts).
//   SWEEP, allowance to vault. The allowance key signs (erc191), no touch, whenever the allowance
//     is worth more than its size plus 10 %: USDC first, then the other coins by dollar value, down
//     to the size (src/rails/allowance-sweep.ts decides when). A coin the app cannot price never
//     moves this way, and with no price at all nothing does.
// The allowance key and the gas seed are derived from the owner key at every open (src/keystore/
// derived.ts) and live only in the open session, so a sweep runs only while the wallet is open.

import { randomUUID } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';

import { baseUnitsToDecimal, decimalToBaseUnits, toBaseUnits, truncateToBaseUnits } from '../intents.ts';
import { ERC191_STANDARD, erc191SignatureField, railAccounts } from '../intents-sign.ts';
import { allowanceKey } from '../keystore/index.ts';
import type { DerivedAccounts } from '../keystore/derived.ts';
import type { Ledger } from '../ledger/index.ts';
import type { IntentsRead } from '../ledger/intents.ts';
import type { FinalBlock, VerifierPort } from '../relay/verifier.ts';
import type { WriteDraft } from '../types.ts';
import { buildWallet } from '../wallet.ts';
import type { Accounts, AccountsPort } from './accounts.ts';
import { CHIP_PAYLOAD_LIFE_MS, chipSign } from './chip.ts';
import { buildVaultPayload } from './payload.ts';
import type { VaultRelay } from './relay.ts';
import type { BalanceSeen, JournalEntry, VaultResult, VaultSubmitter } from './submit.ts';

// Sweep once the allowance is worth more than its size by this share (PHASE2-PLAN.md call 1).
export const SWEEP_MARGIN = 0.1;
// And look every ten minutes while the wallet is open (C8), beside every settled move.
export const SWEEP_EVERY_MS = 10 * 60_000;
// The window offers a top-up once the allowance falls under this share of its size (call 14).
export const LOW_SHARE = 0.25;
// Transfers in one sweep: the rest goes at the next, USDC always first.
export const MAX_SWEEP_COINS = 4;
// Both payloads live as long as a chip payload may (the service's grammar takes a deadline in
// (now, now + 120 s]): a short life settles an ambiguous send soonest.
export const MOVE_LIFE_MS = CHIP_PAYLOAD_LIFE_MS;
// How long a move whose send came back without a final answer is waited on before the row is left
// to settle by its balance: its deadline, the two minute floor and a margin.
export const SETTLE_WAIT_MS = MOVE_LIFE_MS + 3 * 60_000;

// ---------- what a move spends ----------

// One coin by the verifier's id, in base units.
export type CoinAmount = { asset: string; symbol: string; decimals: number; base: bigint };

/* What a rail draft spends from the intents balance, computed the way its rail computes it before
   signing (src/rails/intents-relay.ts, intents-native.ts, intents-send.ts, intents-pay.ts,
   hypercore-deposit.ts): the coin the card pinned and the exact base units. Null for a draft that
   spends nothing there (a trade, a withdrawal, a policy change, a top-up), or one from before the
   coins were pinned, which its rail judges alone. */
export function moveSpend(draft: WriteDraft): CoinAmount | null {
  try {
    switch (draft.kind) {
      case 'swap': {
        const origin = draft.assets?.origin;
        if (origin === undefined) return null;
        const base =
          draft.amountInExact !== undefined
            ? decimalToBaseUnits(draft.amountInExact, origin.decimals)
            : draft.venue === 'intents-relay'
              ? truncateToBaseUnits(draft.amountIn, origin.decimals)
              : toBaseUnits(draft.amountIn, origin.decimals);
        return { asset: origin.assetId, symbol: draft.fromSymbol, decimals: origin.decimals, base };
      }
      case 'intents_send':
      case 'intents_pay':
      case 'hl_deposit': {
        const origin = draft.assets?.origin;
        if (origin === undefined) return null;
        return { asset: origin.assetId, symbol: draft.symbol, decimals: origin.decimals, base: toBaseUnits(draft.amount, origin.decimals) };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// What the vault has to add for a move: never more than the move is short, never less than zero.
export function shortfallOf(need: bigint, held: bigint): bigint {
  return need > held ? need - held : 0n;
}

/* The card's line for a move bigger than the allowance: what the allowance holds, and the two Touch
   IDs its Approve asks, in the order they come (wave 3's touch order, tests/unit/wave3-wiring.test.ts):
   the move's own approval first, which opens the session the allowance key and the gas account live
   in, then the vault's for the difference, whose dialog reads "move ... from your vault to your
   allowance". swap_quote says the same amount to the agent (src/proposals/swap-reads.ts). */
export function shortfallSentence(coin: Pick<CoinAmount, 'symbol' | 'decimals'>, held: bigint, short: bigint): string {
  const name = coin.symbol.toUpperCase() === 'WNEAR' ? 'NEAR' : coin.symbol;
  return `Your allowance holds ${baseUnitsToDecimal(held, coin.decimals)} ${name}, less than this move spends. Approve asks for two Touch IDs: the first approves this move, the second moves ${baseUnitsToDecimal(short, coin.decimals)} ${name} from your vault to your allowance.`;
}

// ---------- the sweep plan ----------

// A coin the allowance holds, with the app's own price for one unit, or null when it has none.
export type HeldCoin = CoinAmount & { priceUsd: number | null };

export type SweepPlan = {
  moves: CoinAmount[];
  // What the priced coins are worth, and the size, in dollars.
  totalUsd: number;
  sizeUsd: number;
  // Coins the sweep left where they are because nothing prices them.
  unpriced: string[];
};

const MICRO = 1_000_000n;

// A coin's worth in millionths of a dollar: exact for a coin at one dollar, else off the price.
function microUsd(coin: HeldCoin): bigint | null {
  const price = coin.priceUsd;
  if (price === null || !Number.isFinite(price) || !(price > 0) || coin.base <= 0n) return null;
  const scale = 10n ** BigInt(coin.decimals);
  if (price === 1) return (coin.base * MICRO) / scale;
  const micro = Math.floor((Number(coin.base) / Number(scale)) * price * 1e6);
  return Number.isFinite(micro) && micro >= 0 ? BigInt(micro) : null;
}

/* What goes home. Nothing while the priced coins are worth at most the size plus 10 %. Past that,
   everything over the size: USDC first, then the rest by dollar value, largest first. A coin taken
   whole is its whole balance, to the base unit; a coin taken in part is cut down, never up, so the
   allowance keeps at least its size. A coin with no price is neither counted nor moved: a sweep
   that cannot value a coin cannot say how much of it is over. */
export function sweepPlan(held: readonly HeldCoin[], sizeUsd: number, maxCoins: number = MAX_SWEEP_COINS): SweepPlan {
  const size = Number.isFinite(sizeUsd) && sizeUsd > 0 ? BigInt(Math.round(sizeUsd * 100)) * 10_000n : 0n;
  const priced: { coin: HeldCoin; value: bigint }[] = [];
  const unpriced: string[] = [];
  for (const coin of held) {
    if (coin.base <= 0n) continue;
    const value = microUsd(coin);
    if (value === null) unpriced.push(coin.symbol);
    else priced.push({ coin, value });
  }
  const total = priced.reduce((sum, p) => sum + p.value, 0n);
  const plan: SweepPlan = { moves: [], totalUsd: Number(total) / 1e6, sizeUsd: Number(size) / 1e6, unpriced };
  if (total * 10n <= size * 11n) return plan;
  const usdc = (c: HeldCoin): boolean => c.symbol.toUpperCase() === 'USDC';
  priced.sort((a, b) => Number(usdc(b.coin)) - Number(usdc(a.coin)) || (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  let excess = total - size;
  for (const { coin, value } of priced) {
    if (excess <= 0n || plan.moves.length >= maxCoins) break;
    const take = value < excess ? value : excess;
    const base = take === value ? coin.base : coin.priceUsd === 1 ? (take * 10n ** BigInt(coin.decimals)) / MICRO : (coin.base * take) / value;
    if (base <= 0n) continue;
    plan.moves.push({ asset: coin.asset, symbol: coin.symbol, decimals: coin.decimals, base: base > coin.base ? coin.base : base });
    excess -= take;
  }
  return plan;
}

// ---------- the payloads ----------

export type PayloadTime = { deadlineMs: number; salt: Uint8Array; random?: (bytes: number) => Uint8Array };

// The vault giving the allowance one coin: the payload the chip key signs.
export function topUpPayload(input: { vault: string; allowance: string; coin: Pick<CoinAmount, 'asset' | 'base'> } & PayloadTime): string {
  return buildVaultPayload({
    signerId: input.vault,
    intents: [{ intent: 'transfer', receiver_id: input.allowance, tokens: { [input.coin.asset]: input.coin.base.toString() } }],
    deadlineMs: input.deadlineMs,
    salt: input.salt,
    random: input.random,
  });
}

// The allowance giving the vault each coin of a sweep, one transfer per coin: what the allowance key signs.
export function sweepPayload(input: { allowance: string; vault: string; moves: readonly Pick<CoinAmount, 'asset' | 'base'>[] } & PayloadTime): string {
  return buildVaultPayload({
    signerId: input.allowance,
    intents: input.moves.map((m) => ({ intent: 'transfer' as const, receiver_id: input.vault, tokens: { [m.asset]: m.base.toString() } })),
    deadlineMs: input.deadlineMs,
    salt: input.salt,
    random: input.random,
  });
}

/* The session's allowance key over one payload, erc191, and only over a payload naming the
   allowance as its signer: the one door a sweep signs through. Never liveIntentsSigner, whose kind
   `key` branch signs with the owner key: a vault.json edited back to `key` must not make the owner
   key sign a sweep. */
export async function signAsAllowance(payload: string): Promise<string> {
  const account = privateKeyToAccount(`0x${allowanceKey().toString('hex')}`);
  let signer: unknown;
  try {
    signer = (JSON.parse(payload) as { signer_id?: unknown }).signer_id;
  } catch {
    signer = null;
  }
  if (typeof signer !== 'string' || signer !== account.address.toLowerCase()) {
    throw new Error(`refusing to sign: the payload is for ${typeof signer === 'string' ? signer : 'no single signer'}, and the allowance key signs only for ${account.address.toLowerCase()}`);
  }
  return erc191SignatureField(await account.signMessage({ message: payload }));
}

// ---------- the state the window reads ----------

export type AllowanceSlice = { account: string; sizeUsd: number; balanceUsd: number | null };

/* C9's `vault.chip.allowance`: the allowance's account, its size and what it holds in dollars as
   the wallet panel values it, or null under kind key (nothing moved, no allowance in use) and
   before this process has opened the wallet (no account to name). balanceUsd is null while the
   verifier read is missing or failed. src/http/state.ts wires it. */
export function allowanceState(ctx: {
  cfg: { keysPath: string };
  keystore: { derivedAccounts(): DerivedAccounts | null };
  vaultPrefs: { get(): { allowance: { sizeUsd: number } } };
  ledger: Pick<Ledger, 'intents' | 'snapshot'>;
}): AllowanceSlice | null {
  if (railAccounts(ctx.cfg.keysPath).kind === 'key') return null;
  const account = ctx.keystore.derivedAccounts()?.allowance?.toLowerCase() ?? null;
  if (account === null) return null;
  const sizeUsd = ctx.vaultPrefs.get().allowance.sizeUsd;
  const read = ctx.ledger.intents();
  if (read === undefined || !read.ok) return { account, sizeUsd, balanceUsd: null };
  const own = read.holdings.filter((h) => h.accountId.toLowerCase() === account);
  return { account, sizeUsd, balanceUsd: buildWallet(ctx.ledger.snapshot(), { ...read, holdings: own }).totalUsd };
}

/* The coins one account holds in the ledger's last verifier read, in exact base units, each with
   the price `price` gives it (the engine's own, src/proposals/draft.ts priceOf). */
export function heldCoins(read: IntentsRead | undefined, account: string, price: (symbol: string, asset: string) => number | null): HeldCoin[] {
  if (read === undefined || !read.ok) return [];
  return read.holdings
    .filter((h) => h.accountId.toLowerCase() === account.toLowerCase())
    .map((h) => {
      let base: bigint;
      try {
        base = h.amountBase !== undefined ? BigInt(h.amountBase) : toBaseUnits(h.amount, h.decimals);
      } catch {
        base = 0n;
      }
      return { asset: h.assetId, symbol: h.symbol, decimals: h.decimals, base, priceUsd: price(h.symbol, h.assetId) };
    });
}

// ---------- the service ----------

// A move that did not go: `code` has a sentence in src/http/wallet.ts REFUSALS, `detail` is the log line.
export type AllowanceRefused = { state: 'refused'; code: string; detail: string; released: false };

export type AllowanceDeps = {
  accounts: AccountsPort;
  // vault.json (src/vault/prefs.ts): the allowance's size in dollars.
  prefs: { get(): { allowance: { sizeUsd: number } } };
  relay: Pick<VaultRelay, 'ask'>;
  verifier: VerifierPort;
  submitter: VaultSubmitter;
  // The allowance key's erc191 signature (signAsAllowance above unless a test hands its own).
  signAsAllowance?: (payload: string) => Promise<string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: (bytes: number) => Uint8Array;
};

export type AllowanceService = {
  accounts(): Accounts;
  sizeUsd(): number;
  // One balance inside the verifier, null when the read failed.
  balance(account: string, asset: string): Promise<bigint | null>;
  /* The vault gives the allowance `coin`: one chip signature, one Touch ID, sent by the gas
     account. `lastCheck` is Freeze, asked right before the touch and again after it, so a freeze
     while the dialog is up sends nothing. */
  topUp(req: { id: string; coin: CoinAmount; lastCheck?: () => void }): Promise<VaultResult>;
  // The allowance gives the vault each coin of `moves`: the allowance key signs, no touch.
  sweep(req: { id: string; moves: readonly CoinAmount[]; lastCheck?: () => void }): Promise<VaultResult>;
  /* A move whose send has no final answer yet, waited on without ever signing again: settled by
     the submitter's rule, its views read once it ran, given up at SETTLE_WAIT_MS. */
  awaitSettled(req: { id: string; account: string; balances: BalanceSeen[] }, first: VaultResult): Promise<VaultResult>;
  pending(account?: string): JournalEntry[];
};

function refused(code: string, detail: string): AllowanceRefused {
  return { state: 'refused', code, detail, released: false };
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/* Freeze, asked inside a sign(): a refusal the submitter passes on with its own code, so the row
   says frozen and never "the bundle was not built right". */
function frozen(lastCheck: (() => void) | undefined): { ok: false; code: string; detail: string } | null {
  if (lastCheck === undefined) return null;
  try {
    lastCheck();
    return null;
  } catch (err) {
    const code = (err as { reason?: unknown }).reason;
    return { ok: false, code: typeof code === 'string' ? code : 'kill_switch', detail: errorText(err) };
  }
}

export function createAllowance(deps: AllowanceDeps): AllowanceService {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.()));
  const sign = deps.signAsAllowance ?? signAsAllowance;

  async function topUp({ id, coin, lastCheck }: { id: string; coin: CoinAmount; lastCheck?: () => void }): Promise<VaultResult> {
    /* The service's chip status is asked again right before every vault signature (p2-integ2 open
       risk 2): a key the service no longer backs, or a marker that no longer names this vault,
       reads `broken` here and nothing is signed. */
    const acc = await deps.accounts.refresh();
    if (acc.kind !== 'chip' || acc.chip === null || acc.vault === null) return refused('chip_missing', `the accounts read ${acc.kind}, not a vault on this Mac's chip key`);
    if (acc.allowance === null) return refused('wallet_locked', 'the allowance is not known until this process has opened the wallet');
    if (coin.base <= 0n) return refused('invalid_request', 'a top-up moves at least one base unit');
    const vault = acc.vault.toLowerCase();
    const allowance = acc.allowance.toLowerCase();
    const pin = { keyRef: acc.chip.keyRef, publicKey: acc.chip.publicKey, account: vault };
    return deps.submitter.move({
      id,
      account: vault,
      async sign() {
        const salt = await deps.verifier.currentSalt().catch(() => null);
        if (salt === null) return { ok: false, code: 'rpc_unavailable', detail: 'the verifier did not answer with its current salt, so no nonce it would take can be made' };
        let payload: string;
        try {
          payload = topUpPayload({ vault, allowance, coin, deadlineMs: now() + MOVE_LIFE_MS, salt, random: deps.random });
        } catch (err) {
          return { ok: false, code: 'vault_bundle', detail: errorText(err) };
        }
        const before = frozen(lastCheck);
        if (before !== null) return before;
        const signed = await chipSign(deps.relay, pin, payload, { now, allowance });
        if (!signed.ok) return { ok: false, code: signed.code, detail: signed.detail };
        // The signature exists here and nowhere else: frozen while the dialog was up, it never leaves.
        const after = frozen(lastCheck);
        if (after !== null) return after;
        return { ok: true, bundle: [signed.signed], before: {} };
      },
      balances: [
        { account: vault, asset: coin.asset },
        { account: allowance, asset: coin.asset },
      ],
    });
  }

  async function sweep({ id, moves, lastCheck }: { id: string; moves: readonly CoinAmount[]; lastCheck?: () => void }): Promise<VaultResult> {
    const acc = deps.accounts.accounts();
    // ALLOWANCE and GAS do not depend on the chip (src/vault/accounts.ts): a `broken` vault still sweeps home.
    if (acc.kind === 'key') return refused('invalid_request', 'nothing sweeps before the vault has moved to the chip');
    if (acc.allowance === null || acc.vault === null) return refused('wallet_locked', 'the allowance is not known until this process has opened the wallet');
    if (moves.length === 0 || moves.some((m) => m.base <= 0n)) return refused('invalid_request', 'a sweep moves at least one base unit of each coin it names');
    const vault = acc.vault.toLowerCase();
    const allowance = acc.allowance.toLowerCase();
    return deps.submitter.move({
      id,
      account: allowance,
      async sign() {
        const salt = await deps.verifier.currentSalt().catch(() => null);
        if (salt === null) return { ok: false, code: 'rpc_unavailable', detail: 'the verifier did not answer with its current salt, so no nonce it would take can be made' };
        let payload: string;
        try {
          payload = sweepPayload({ allowance, vault, moves, deadlineMs: now() + MOVE_LIFE_MS, salt, random: deps.random });
        } catch (err) {
          return { ok: false, code: 'vault_bundle', detail: errorText(err) };
        }
        const stop = frozen(lastCheck);
        if (stop !== null) return stop;
        let signature: string;
        try {
          signature = await sign(payload);
        } catch (err) {
          return { ok: false, code: 'wallet_locked', detail: errorText(err) };
        }
        return { ok: true, bundle: [{ standard: ERC191_STANDARD, payload, signature }], before: {} };
      },
      balances: moves.flatMap((m) => [
        { account: allowance, asset: m.asset },
        { account: vault, asset: m.asset },
      ]),
    });
  }

  /* A move whose send has no final answer, waited on through the submitter's own `move` and nothing
     else: `move` runs in the submitter's queue for the account, so this never races a move that
     writes the journal (`settle` runs outside that queue: p2-rekey's caution in CONTRACTS.md). For
     this id `move` confirms a bundle that ran, says wait while it can still run, and unknown or
     partial once that can no longer be proved; it reaches sign() only once NEAR has proved the
     bundle dead, and the sign() handed in refuses (`vault_dead`), so nothing is signed again here. */
  async function awaitSettled(req: { id: string; account: string; balances: BalanceSeen[] }, first: VaultResult): Promise<VaultResult> {
    const until = now() + SETTLE_WAIT_MS;
    let last = first;
    const account = req.account.toLowerCase();
    const balances = req.balances.map(({ account: a, asset }) => ({ account: a, asset }));
    const dead = async (): Promise<{ ok: false; code: string; detail: string }> => ({ ok: false, code: 'vault_dead', detail: 'the send never ran and never can: nothing moved' });
    while (now() < until && (last.state === 'sent' || last.state === 'checking' || last.state === 'settling')) {
      const notBefore = last.state === 'settling' && last.notBefore !== null ? last.notBefore : now() + 2_000;
      await sleep(Math.max(1_000, Math.min(notBefore - now(), 15_000)));
      last = await deps.submitter.move({ id: req.id, account, sign: dead, balances });
    }
    return last;
  }

  return {
    accounts: () => deps.accounts.accounts(),
    sizeUsd: () => deps.prefs.get().allowance.sizeUsd,
    balance: (account, asset) => deps.verifier.balance(account.toLowerCase(), asset).catch(() => null),
    topUp,
    sweep,
    awaitSettled,
    pending: (account) => deps.submitter.pending(account),
  };
}

// A move's id in the vault journal: a top-up rides its proposal's, a sweep has its own.
export function sweepId(): string {
  return `sweep:${randomUUID()}`;
}

// The block a done move was confirmed at, for a log line.
export function doneAt(block: FinalBlock): string {
  return `${block.hash.slice(0, 8)}... at ${new Date(block.atMs).toISOString()}`;
}

// Words for an amount in a log line: the coin's own units, exact.
export function amountWords(coin: Pick<CoinAmount, 'base' | 'decimals' | 'symbol'>): string {
  return `${baseUnitsToDecimal(coin.base, coin.decimals)} ${coin.symbol}`;
}
