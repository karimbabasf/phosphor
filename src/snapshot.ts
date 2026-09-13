// The snapshot broker: the server asks the window for a picture of one chart, the window
// posts a JPEG back, and the image is handed to the one tool call waiting for it.
//
// Nothing is stored. An image that arrives for a request nobody is waiting on is dropped, and
// a caller that waited past the TTL gets nothing rather than the next caller's picture. The
// window is the only renderer this app has (the chart is a canvas, and the server holds no
// pixels), which is why the picture has to come back over a route rather than be drawn here.
//
// One outstanding request per chart. A second ask while the window is still rendering the
// first would either race it or double the work, and the answer to "is a snapshot being taken"
// is a refusal the caller can read, not a queue.

import crypto from 'node:crypto';

export type SnapshotFrame = { type: 'snapshot'; slot: number; reqId: string };

// How long the tool waits for the window. Long enough for a canvas to encode at 1024 px on a
// slow machine, short enough that an agent whose window is closed is not stalled for a turn.
export const SNAPSHOT_TTL_MS = 3000;

// The most the window may post back. A 1024 px JPEG of a chart is well under 100 KB; this is
// the cap that makes the route unusable as a way to push a large body at the server.
export const SNAPSHOT_MAX_BYTES = 512 * 1024;

// The shape of the string the model's API will decode: whole quads, padding only at the end.
// Buffer.from() shrugs at padding in the middle or a stray trailing character; the API on the
// far side of the proxy does not, and an image it cannot decode ends the agent's turn with an
// upstream 400 instead of a digest. Checked where the bytes enter (the route) and where they
// leave (the proxy), so neither side has to trust the other.
const BASE64_SHAPE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function isBase64(text: string): boolean {
  return text.length > 0 && BASE64_SHAPE.test(text);
}

export type SnapshotBroker = {
  // Ask for a picture of `slot` and wait up to `timeoutMs` for it. Throws when one is already
  // being taken for that slot; resolves null when the window did not answer in time.
  request(slot: number, timeoutMs: number): Promise<{ jpegBase64: string } | null>;
  // The window's answer. True when a caller was waiting for that id and got it.
  deliver(reqId: string, jpegBase64: string): boolean;
  pending(slot: number): boolean;
};

type Waiting = { reqId: string; slot: number; resolve: (v: { jpegBase64: string } | null) => void; timer: NodeJS.Timeout };

export function createSnapshotBroker(deps: { broadcast: (frame: SnapshotFrame) => void }): SnapshotBroker {
  const bySlot = new Map<number, Waiting>();
  const byId = new Map<string, Waiting>();

  function settle(w: Waiting, value: { jpegBase64: string } | null): void {
    clearTimeout(w.timer);
    bySlot.delete(w.slot);
    byId.delete(w.reqId);
    w.resolve(value);
  }

  return {
    request(slot, timeoutMs) {
      if (bySlot.has(slot)) throw new Error(`a snapshot of chart ${slot} is already being taken`);
      const reqId = crypto.randomBytes(8).toString('hex');
      return new Promise((resolve) => {
        const w: Waiting = {
          reqId,
          slot,
          resolve,
          timer: setTimeout(() => settle(w, null), timeoutMs),
        };
        w.timer.unref();
        bySlot.set(slot, w);
        byId.set(reqId, w);
        deps.broadcast({ type: 'snapshot', slot, reqId });
      });
    },
    deliver(reqId, jpegBase64) {
      const w = byId.get(reqId);
      if (w === undefined) return false;
      settle(w, { jpegBase64 });
      return true;
    },
    pending: (slot) => bySlot.has(slot),
  };
}
