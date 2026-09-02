// What the money is earning, read from the same view the window's yield panel draws from.

import { OBSERVATION_CAVEAT } from '../../yield/positions.ts';
import { sendJson } from '../respond.ts';
import type { ReadTable } from '../context.ts';

export const yieldReads: ReadTable = {
  yield_read: (ctx, _body, _args, res) => {
    const view = ctx.allocator?.view() ?? null;
    if (view === null) {
      // Not an empty position. An empty view reads as "you have nothing supplied", which is
      // a different claim from "this app is not wired for this", and an agent that cannot
      // tell them apart tells its human the wrong one.
      sendJson(res, 200, {
        available: false,
        reason:
          'no lending allocator is running in this app, so there is no position to read. ' +
          'This is how demo mode and a wallet-only install look; it does not mean a supplied balance is empty.',
      });
      return;
    }
    // The caveat travels with the number rather than sitting in the tool description,
    // because the description is read once at connect and the percentage is read every
    // time. An agent quoting the rate out loud should be carrying the same sentence the
    // screen prints under it.
    sendJson(res, 200, { available: true, ...view, caveat: OBSERVATION_CAVEAT });
  },
};
