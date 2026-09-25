// GET /api/day: each coin's last 24 hours, for Pro's line and change.
//
// Off the day feed (src/ledger/day.ts), which asks CoinGecko for every coin 1Click lists, on a
// clock of its own. `?assets=` names the asset ids the window holds, comma-joined, and they are
// only looked up in what the feed already brought back: this route reaches no network, so naming
// the held coins here tells nobody anything. No `assets` is every listed asset. Demo mode builds
// no feed, and the answer is then no days at all, which Pro reads as "draw the candles".

import type http from 'node:http';

import type { DayAnswer } from '../ledger/day.ts';
import { sendJson } from './respond.ts';
import type { Ctx } from './context.ts';

// More than the list holds (197 on 2026-09-25), and a bound on what one request can make it do.
const ASSETS_MAX = 256;
const ASSET_ID_MAX = 200;

export function sendDay(ctx: Ctx, url: URL, res: http.ServerResponse): void {
  const raw = url.searchParams.get('assets');
  const assets =
    raw === null
      ? undefined
      : raw
          .split(',')
          .map((a) => a.trim())
          .filter((a) => a !== '' && a.length <= ASSET_ID_MAX)
          .slice(0, ASSETS_MAX);
  const answer: DayAnswer = ctx.day === undefined ? { at: null, entries: {} } : ctx.day.answer(assets);
  sendJson(res, 200, answer);
}
