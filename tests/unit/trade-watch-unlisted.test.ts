// A focused coin the venue does not list is not subscribed to. 1INCH charted from Coinbase used
// to be watched on Hyperliquid, which answered with an error, and the strip then said Hyperliquid
// was not answering one of its reads (a headless proof, 2026-09-27).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTradeService } from '../../src/trade/service.ts';
import type { TradeRunner } from '../../src/trade/service.ts';
import type { FeedSocket } from '../../src/trade/feed-ws.ts';
import type { InfoClient } from '../../src/hl/info.ts';

const info: InfoClient = {
  post: <T>(): Promise<T> => Promise.resolve({ universe: [{ name: 'ETH', szDecimals: 4, maxLeverage: 25 }, { name: 'BTC', szDecimals: 5, maxLeverage: 40 }] } as T),
  health: () => ({ ok: true, failures: 0, lastError: null, retryAt: null }) as unknown as ReturnType<InfoClient['health']>,
};

const runner = {
  status: () => ({ plans: [], child: 'off', watching: [] }),
  plans: () => [],
  get: () => null,
  onAccount: () => {},
  events: () => [],
} as unknown as TradeRunner;

test('a focus on a coin the venue does not list subscribes to nothing for it', async () => {
  const sent: string[] = [];
  let sock: FeedSocket | null = null;
  const wsImpl = (): FeedSocket => {
    sock = { readyState: 1, send: (d: string) => sent.push(d), close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null };
    return sock;
  };
  const svc = createTradeService({ wsUrl: 'wss://test.invalid/ws', user: '0x1111111111111111111111111111111111111111', info, runner, products: ['ETH-USD'], atrFor: () => null, initialSymbol: 'ETH', wsImpl });
  try {
    (sock as FeedSocket | null)?.onopen?.();
    await new Promise((r) => setTimeout(r, 20));
    svc.payload();
    svc.view.setFocus({ symbol: '1INCH' }, 'agent');
    svc.payload();
    svc.view.setFocus({ symbol: 'BTC' }, 'agent');
    svc.payload();
    const coins = sent.map((d) => JSON.parse(d) as { method?: string; subscription?: { coin?: string } })
      .filter((m) => m.method === 'subscribe')
      .map((m) => m.subscription?.coin)
      .filter((c): c is string => typeof c === 'string');
    assert.ok(coins.includes('BTC'), `a listed focus is watched: ${coins.join(',')}`);
    assert.ok(!coins.includes('1INCH'), `an unlisted focus is not: ${coins.join(',')}`);
  } finally {
    svc.stop();
  }
});
