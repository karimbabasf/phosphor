// What the MCP proxy hands the client for one app answer.
//
// Every answer used to be one text block holding the JSON. The chart snapshot is the one tool
// whose answer is a picture, and a base64 JPEG inside a JSON string is something a model reads
// as several thousand tokens of noise rather than as an image. So an answer carrying `image`
// becomes an image block, with the digest beside it as text; everything else stays exactly the
// text it was. Its own module because src/mcp.ts connects a transport at import time and cannot
// be loaded by a test.
//
// The image is checked again here, on the proxy's side of the wire. The route already refuses
// anything that is not base64 with a JPEG head, so this is the case where the app is not the app
// this proxy was built against: a picture the model's API could not decode is dropped and the
// digest goes out alone, rather than half a megabyte of it going out as text.
//
// Every answer also names the screen the window is on, when the app said which (the
// x-phosphor-screen header on every /api/mcp answer). The human's tabs move the window and no
// tool used to say so, so an agent went on describing the screen it remembered from `start`.
// A JSON answer gets `screen: { view }` as its last key, unless it already carries the fuller
// record (`start`, `switch`: { view, since, by }); a digest beside a picture gets the line
// `screen: trade` under it. Inside the JSON rather than after it, because the e2e script and
// the injection suite parse the text block, and a line after the object would turn every
// answer into a string for them. An answer that is not an object (log_tail's array, the trade
// batch) goes out as it is.

import { isBase64 } from './snapshot.ts';

type Block = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

const IMAGE_TYPE = /^image\/[a-z0-9.+-]+$/;
const SCREENS = new Set(['basic', 'pro', 'trade']);

function screenOf(screen: string | null | undefined): string | null {
  return typeof screen === 'string' && SCREENS.has(screen) ? screen : null;
}

export function contentFor(json: unknown, screen?: string | null): { content: Block[] } {
  const view = screenOf(screen);
  const line = view === null ? '' : `\nscreen: ${view}`;
  if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
    const payload = json as { image?: unknown; mimeType?: unknown; digest?: unknown; screen?: unknown };
    if (typeof payload.image === 'string' && payload.image.length > 0) {
      const digest = typeof payload.digest === 'string' ? payload.digest : '';
      if (!isBase64(payload.image)) {
        return { content: [{ type: 'text', text: `${digest}. No picture: the window sent something that was not base64${line}` }] };
      }
      const mimeType = typeof payload.mimeType === 'string' && IMAGE_TYPE.test(payload.mimeType) ? payload.mimeType : 'image/jpeg';
      return {
        content: [
          { type: 'image', data: payload.image, mimeType },
          { type: 'text', text: `${digest}${line}` },
        ],
      };
    }
    const named = view !== null && payload.screen === undefined ? { ...payload, screen: { view } } : payload;
    return { content: [{ type: 'text', text: JSON.stringify(named) }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(json) }] };
}
