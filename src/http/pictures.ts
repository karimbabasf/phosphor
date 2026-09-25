// GET /api/coin-images and GET /api/coin-image?id=: the coin pictures, from this app's own cache.
//
// The window's logos (ui/design/marks.js) read the first to learn which coins have a picture and
// load the second as an image, so every picture the window draws comes from this server: the
// page's CSP allows images from nowhere else (img-src 'self' data:, src/http/respond.ts). Only
// what is on disk is answered, checked again on its way out (src/ledger/pictures.ts), and nothing
// here reaches the network. Demo mode builds no pictures: no symbols, and nothing more to come.

import type http from 'node:http';

import { coingeckoIdOk } from '../ledger/day.ts';
import type { PicturesManifest } from '../ledger/pictures.ts';
import { fail, sendJson } from './respond.ts';
import type { Ctx } from './context.ts';

export function sendCoinImages(ctx: Ctx, res: http.ServerResponse): void {
  const manifest: PicturesManifest = ctx.pictures?.manifest() ?? { symbols: {}, settled: true };
  sendJson(res, 200, manifest);
}

export function sendCoinImage(ctx: Ctx, url: URL, res: http.ServerResponse): void {
  const id = url.searchParams.get('id');
  const picture = coingeckoIdOk(id) ? (ctx.pictures?.read(id) ?? null) : null;
  if (picture === null) return fail(res, 404, 'there is no picture for that coin');
  res.writeHead(200, {
    // The type its bytes say it is, which the page may not second-guess; and opened on its own it
    // is an image and nothing that can run.
    'content-type': picture.type,
    'content-length': picture.bytes.length,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'",
    // A day in the window's own cache: a picture changes weekly at most.
    'cache-control': 'private, max-age=86400',
  });
  res.end(picture.bytes);
}
