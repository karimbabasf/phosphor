// What the MCP proxy hands the client for one app answer.
//
// Every answer used to be one text block holding the JSON. The chart snapshot is the one tool
// whose answer is a picture, and a base64 JPEG inside a JSON string is something a model reads
// as several thousand tokens of noise rather than as an image. So an answer carrying `image`
// becomes an image block, with the digest beside it as text; everything else stays exactly the
// text it was. Its own module because src/mcp.ts connects a transport at import time and cannot
// be loaded by a test.

type Block = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export function contentFor(json: unknown): { content: Block[] } {
  if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
    const payload = json as { image?: unknown; mimeType?: unknown; digest?: unknown };
    if (typeof payload.image === 'string' && payload.image.length > 0) {
      return {
        content: [
          { type: 'image', data: payload.image, mimeType: typeof payload.mimeType === 'string' ? payload.mimeType : 'image/jpeg' },
          { type: 'text', text: typeof payload.digest === 'string' ? payload.digest : '' },
        ],
      };
    }
  }
  return { content: [{ type: 'text', text: JSON.stringify(json) }] };
}
