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

import { isBase64 } from './snapshot.ts';

type Block = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

const IMAGE_TYPE = /^image\/[a-z0-9.+-]+$/;

export function contentFor(json: unknown): { content: Block[] } {
  if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
    const payload = json as { image?: unknown; mimeType?: unknown; digest?: unknown };
    if (typeof payload.image === 'string' && payload.image.length > 0) {
      const digest = typeof payload.digest === 'string' ? payload.digest : '';
      if (!isBase64(payload.image)) {
        return { content: [{ type: 'text', text: `${digest}. No picture: the window sent something that was not base64` }] };
      }
      const mimeType = typeof payload.mimeType === 'string' && IMAGE_TYPE.test(payload.mimeType) ? payload.mimeType : 'image/jpeg';
      return {
        content: [
          { type: 'image', data: payload.image, mimeType },
          { type: 'text', text: digest },
        ],
      };
    }
  }
  return { content: [{ type: 'text', text: JSON.stringify(json) }] };
}
