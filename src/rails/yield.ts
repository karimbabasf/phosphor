// The yield rails: put a stablecoin to work in a lending venue, and take it back.
//
// Three rules, the same three src/rails/uniswap.ts keeps:
//   1. This module never signs. Calldata is built by the venue adapter and handed to
//      chain/evm.ts, which is the only module in the app holding a private key.
//   2. simulate() touches nothing but eth_call. It reads the reserve's own flags and its own
//      rate, so the number in the approval gate is the venue's answer and not our guess.
//   3. The destination is never an argument. `supply` credits our own address and `withdraw`
//      pays our own address, both derived from the key this app holds, so there is no field
//      here that a hijacked agent could point somewhere else.

import { formatUnits } from 'viem';
import type {
  AppConfig,
  Rail,
  RailResult,
  SimulationResult,
  YieldDepositDraft,
  YieldWithdrawDraft,
} from '../types.ts';
import { erc20Balance, evmAddress, sendTx } from '../chain/evm.ts';
import { getAddress } from 'viem';
import type { Address, Hex } from 'viem';
import {
  aaveDepositCalls,
  aaveHealth,
  aaveAsset,
  aavePosition,
  aaveRate,
  aaveWithdrawCalls,
  marketFor,
  VENUE_ID,
} from '../yield/aave.ts';
import type { VenueCall } from '../yield/venue.ts';
import { fromBaseUnits } from '../yield/venue.ts';

export const YIELD_VENUE = VENUE_ID;

// Same shape as requireVenue in uniswap.ts and oneclick.ts. The registry routes on kind and
// each rail still checks its own venue, so the router is a router and not the check.
function requireVenue(venue: string): void {
  if (venue !== YIELD_VENUE) {
    throw new Error(`yield rail is ${YIELD_VENUE}; this draft names venue '${venue}'`);
  }
}

// A reserve that is frozen, paused or inactive still answers getReserveData and still reports
// a rate. A rail that read only the rate would quote a number into the approval gate and then
// fail at signing with a bare revert code, which is the worst of both: the human approved
// something, and what came back said nothing. Reading the flags lets the refusal name the flag.
async function refuseUnhealthy(draft: { chain: YieldDepositDraft['chain']; symbol: string }): Promise<string | null> {
  const health = await aaveHealth(draft.chain, draft.symbol);
  if (!health.active) return `the Aave ${draft.symbol} reserve on ${draft.chain} is not active`;
  if (health.paused) return `the Aave ${draft.symbol} reserve on ${draft.chain} is paused`;
  if (health.frozen) return `the Aave ${draft.symbol} reserve on ${draft.chain} is frozen: no new supply is accepted`;
  return null;
}

async function runCalls(cfg: AppConfig, chain: YieldDepositDraft['chain'], calls: VenueCall[]): Promise<RailResult> {
  const txids: string[] = [];
  const done: string[] = [];

  for (const call of calls) {
    const out = await sendTx({
      chain,
      keysPath: cfg.keysPath,
      to: call.to as Address,
      data: call.data as Hex,
    });
    if (!out.ok) {
      // Report what DID happen before the failure, not just the failure.
      //
      // A deposit is an approve then a supply, and an approve that landed followed by a
      // supply that reverted leaves a real allowance on chain. A result that said only
      // "supply failed" would hide a state change the wallet is now carrying.
      const sofar = done.length > 0 ? ` Completed before this: ${done.join(', ')}.` : '';
      return { ok: false, detail: `${call.label} failed: ${out.error ?? 'unknown error'}.${sofar}`, txids };
    }
    if (out.hash) txids.push(out.hash);
    done.push(call.label);
  }

  return { ok: true, detail: done.join(', '), txids };
}

export function yieldDepositRail(cfg: AppConfig): Rail<YieldDepositDraft> {
  return {
    kind: 'yield_deposit',

    valueUsd: (draft) => draft.amountUsd,

    async simulate(draft): Promise<SimulationResult> {
      try {
        requireVenue(draft.venue);

        const asset = aaveAsset(draft.chain, draft.symbol);
        if (asset === null) {
          return { ok: false, summary: '', error: `Aave v3 does not take ${draft.symbol} on ${draft.chain}` };
        }

        const unhealthy = await refuseUnhealthy(draft);
        if (unhealthy !== null) return { ok: false, summary: '', error: unhealthy };

        const amountBase = BigInt(draft.amountBase);
        if (amountBase <= 0n) return { ok: false, summary: '', error: 'deposit amount must be above zero' };

        const owner = evmAddress(cfg.keysPath);
        const held = await erc20Balance(draft.chain, getAddress(asset.address), owner);
        if (held < amountBase) {
          return {
            ok: false,
            summary: '',
            error:
              `wallet holds ${formatUnits(held, asset.decimals)} ${draft.symbol} on ${draft.chain} and the ` +
              `deposit is ${formatUnits(amountBase, asset.decimals)}`,
          };
        }

        const [rate, calls] = await Promise.all([
          aaveRate(draft.chain, draft.symbol),
          aaveDepositCalls({
            chain: draft.chain,
            symbol: draft.symbol,
            owner,
            amountBase,
          }),
        ]);

        // The rate is stated as what the venue pays NOW, and labelled that way. It is not a
        // promise about the window this deposit will live through, and the approval gate is
        // exactly where overstating it would do the most damage.
        const steps = calls.map((c) => c.label).join(', then ');
        return {
          ok: true,
          summary:
            `Supply ${formatUnits(amountBase, asset.decimals)} ${draft.symbol} to Aave v3 on ${draft.chain}. ` +
            `The pool pays ${(rate.apy * 100).toFixed(2)}% right now, which is a rate observed at this moment ` +
            `and not a rate promised for this deposit. You receive ${asset.receiptSymbol}, whose balance grows ` +
            `as interest accrues, and you can withdraw at any time with no lock and no queue. ` +
            `Steps: ${steps}.`,
        };
      } catch (err) {
        return { ok: false, summary: '', error: err instanceof Error ? err.message : String(err) };
      }
    },

    async execute(draft): Promise<RailResult> {
      try {
        requireVenue(draft.venue);
        const asset = aaveAsset(draft.chain, draft.symbol);
        if (asset === null) return { ok: false, detail: `Aave v3 does not take ${draft.symbol} on ${draft.chain}` };

        // Re-read the flags here, not only in simulate().
        //
        // A deposit can sit in the approval gate for as long as a human takes to look at it,
        // and a reserve can freeze in that time. Without this the rail runs anyway, lands the
        // APPROVE on chain (a real allowance and real gas) and then reverts on the supply. One
        // eth_call in front of a path that spends money is the cheapest check in the file.
        const unhealthy = await refuseUnhealthy(draft);
        if (unhealthy !== null) return { ok: false, detail: `refused before signing: ${unhealthy}` };

        const owner = evmAddress(cfg.keysPath);
        const amountBase = BigInt(draft.amountBase);
        const calls = await aaveDepositCalls({
          chain: draft.chain,
          symbol: draft.symbol,
          owner,
          amountBase,
        });

        const result = await runCalls(cfg, draft.chain, calls);
        if (!result.ok) return result;

        // Read the position back rather than asserting the supply worked because the receipt
        // came back ok. src/rails/hypercore-deposit.ts finishes by looking too, for the same
        // reason: a transaction that succeeded is not the same claim as the money arriving
        // where it was meant to.
        const after = await aavePosition(draft.chain, draft.symbol, owner);
        return {
          ok: true,
          detail:
            `${result.detail}. Position is now ${formatUnits(after.balanceBase, asset.decimals)} ` +
            `${asset.receiptSymbol} on ${draft.chain}.`,
          txids: result.txids,
        };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export function yieldWithdrawRail(cfg: AppConfig): Rail<YieldWithdrawDraft> {
  return {
    kind: 'yield_withdraw',

    valueUsd: (draft) => draft.amountUsd,

    async simulate(draft): Promise<SimulationResult> {
      try {
        requireVenue(draft.venue);

        const asset = aaveAsset(draft.chain, draft.symbol);
        if (asset === null) {
          return { ok: false, summary: '', error: `Aave v3 does not take ${draft.symbol} on ${draft.chain}` };
        }

        const owner = evmAddress(cfg.keysPath);
        const position = await aavePosition(draft.chain, draft.symbol, owner);
        if (position.balanceBase === 0n) {
          return { ok: false, summary: '', error: `no Aave v3 ${draft.symbol} position on ${draft.chain} to withdraw` };
        }

        // A paused reserve blocks withdrawals as well as supply, and this is the one place
        // where that has to be said out loud: the whole promise of this feature is that the
        // money can come back, so the moment it cannot, the human hears it in plain words.
        const health = await aaveHealth(draft.chain, draft.symbol);
        if (health.paused) {
          return {
            ok: false,
            summary: '',
            error: `the Aave ${draft.symbol} reserve on ${draft.chain} is paused, so withdrawals are blocked right now`,
          };
        }

        const whole = draft.amountBase === null;
        const amountBase = whole ? position.balanceBase : BigInt(draft.amountBase as string);
        if (!whole && amountBase > position.balanceBase) {
          return {
            ok: false,
            summary: '',
            error:
              `position is ${formatUnits(position.balanceBase, asset.decimals)} ${draft.symbol} and the ` +
              `withdrawal is ${formatUnits(amountBase, asset.decimals)}`,
          };
        }

        return {
          ok: true,
          summary:
            `Withdraw ${whole ? 'the whole position, ' : ''}${formatUnits(amountBase, asset.decimals)} ` +
            `${draft.symbol} from Aave v3 on ${draft.chain} back to this wallet. ` +
            (whole
              ? 'The exact amount is read at execution rather than now, because the balance grows every block and a number quoted here would leave dust behind. '
              : '') +
            'No lock, no queue, no exit fee.',
        };
      } catch (err) {
        return { ok: false, summary: '', error: err instanceof Error ? err.message : String(err) };
      }
    },

    async execute(draft): Promise<RailResult> {
      try {
        requireVenue(draft.venue);
        const asset = aaveAsset(draft.chain, draft.symbol);
        if (asset === null) return { ok: false, detail: `Aave v3 does not take ${draft.symbol} on ${draft.chain}` };

        const owner = evmAddress(cfg.keysPath);
        const before = await erc20Balance(draft.chain, getAddress(asset.address), owner);

        const calls = await aaveWithdrawCalls({
          chain: draft.chain,
          symbol: draft.symbol,
          owner,
          amountBase: draft.amountBase === null ? null : BigInt(draft.amountBase),
        });

        const result = await runCalls(cfg, draft.chain, calls);
        if (!result.ok) return result;

        const after = await erc20Balance(draft.chain, getAddress(asset.address), owner);
        const arrived = after > before ? after - before : 0n;
        return {
          ok: true,
          detail:
            `${result.detail}. ${formatUnits(arrived, asset.decimals)} ${draft.symbol} arrived in the wallet ` +
            `on ${draft.chain}.`,
          txids: result.txids,
        };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export function yieldRails(cfg: AppConfig): {
  deposit: Rail<YieldDepositDraft>;
  withdraw: Rail<YieldWithdrawDraft>;
} {
  return { deposit: yieldDepositRail(cfg), withdraw: yieldWithdrawRail(cfg) };
}

// Every counterparty the yield rails can hand funds to, lowercased, taken from the verified
// deployment table and nowhere else. Same contract as venueAllowlist.
export function yieldCounterparties(): string[] {
  const out: string[] = [];
  for (const chain of ['arb', 'base', 'eth'] as const) {
    try {
      out.push(marketFor(chain).pool.toLowerCase());
    } catch {
      // No deployment on this chain for this network. Absent is the normal answer.
    }
  }
  return out;
}

export { fromBaseUnits };
