// web_read: the one way the in-app agent reads a web page (src/web-gate.ts says why there is one).
//
// The address is checked against the seat's provenance and the wallet's own prints BEFORE anything
// is looked up or connected, the seat is marked as having read a stranger's text before a byte of
// the page arrives (src/web-read.ts), and the page comes back stripped and quoted
// (src/web-page.ts). A refused address is a 200 with `refused` and the reason, the way a dead chain
// source is: the agent asked properly, and the answer is no, with what to do instead.

import { baseUnitsToDecimal } from '../../intents.ts';
import { buildWallet } from '../../wallet.ts';
import { admitPage, readsLeft, walletPrints } from '../../web-gate.ts';
import type { WalletPrints } from '../../web-gate.ts';
import { readPage } from '../../web-page.ts';
import type { Transport } from '../../web-page.ts';
import { markWebRead } from '../../web-read.ts';
import { sendJson } from '../respond.ts';
import type { Ctx, ReadTable } from '../context.ts';

const MONEY_KEY = /size|szi|notional|pnl|margin|value|collateral|amount/i;

/* This wallet's own addresses and figures, as the app holds them right now: the keystore's
   addresses, the intents account, every holding exact and rounded, the trading account and the
   size of each position. Each source is read on its own, so one that throws costs only its prints. */
export function printsOf(ctx: Ctx): WalletPrints {
  const addresses: unknown[] = [];
  const amounts: unknown[] = [];
  const attempt = (read: () => void): void => {
    try {
      read();
    } catch {
      /* a source this install does not have, or one that is not ready */
    }
  };
  attempt(() => {
    const a = ctx.keystore.addressReport().addresses;
    addresses.push(a.evm, a.solana, a.near, a.nearPublicKey);
  });
  attempt(() => addresses.push(...Object.values((ctx.cfg.addresses ?? {}) as Record<string, unknown>)));
  attempt(() => {
    const intents = ctx.ledger.intents();
    if (intents === undefined || !intents.ok) return;
    for (const h of intents.holdings) {
      addresses.push(h.accountId);
      amounts.push(h.amount);
      if (h.amountBase !== undefined && /^\d+$/.test(h.amountBase)) amounts.push(baseUnitsToDecimal(BigInt(h.amountBase), h.decimals));
    }
  });
  attempt(() => {
    const hl = ctx.ledger.hyperliquid();
    if (hl === undefined || !hl.ok) return;
    addresses.push(hl.account);
    amounts.push(hl.collateralUsdc, hl.availableUsdc, hl.marginUsedUsd);
  });
  attempt(() => {
    const wallet = buildWallet(ctx.ledger.snapshot(), ctx.ledger.intents(), ctx.ledger.hyperliquid());
    amounts.push(wallet.totalUsd);
    for (const row of wallet.rows) amounts.push(row.quantity, row.valueUsd);
  });
  attempt(() => {
    for (const p of (ctx.trade.payload().positions ?? []) as unknown as Record<string, unknown>[]) {
      for (const [key, value] of Object.entries(p)) if (typeof value === 'number' && MONEY_KEY.test(key)) amounts.push(Math.abs(value));
    }
  });
  return walletPrints({ addresses, amounts });
}

export function webReadsWith(deps: { transport?: Transport; prints?: (ctx: Ctx) => WalletPrints } = {}): ReadTable {
  return {
    web_read: async (ctx, body, args, res) => {
      const seat = typeof body.session === 'string' ? body.session : '';
      const verdict = admitPage(seat, args.url, (deps.prints ?? printsOf)(ctx));
      if (!verdict.ok) {
        sendJson(res, 200, { ok: false, refused: verdict.code, reason: verdict.reason, readsLeft: readsLeft(seat) });
        return;
      }
      // The page is about to be in the agent's context: every move it asks for from here on waits
      // for the person's click, for the rest of this session.
      markWebRead(seat);
      const lookFor = typeof args.look_for === 'string' && args.look_for.trim() !== '' ? args.look_for : undefined;
      const page = await readPage(verdict.url, { transport: deps.transport, lookFor });
      sendJson(res, 200, { ...page, readsLeft: readsLeft(seat) });
    },
  };
}

export const webReads: ReadTable = webReadsWith();
