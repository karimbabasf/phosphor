// The window's answer to a snapshot frame: the picture the human sees, as one small JPEG.
//
// chart_snapshot asks the window over SSE ({ type: 'snapshot', slot, reqId }) and waits three
// seconds. The window composes the scene and the hud of slot 0, or a comparison chart's own
// canvas, into an offscreen canvas at most 1024 px wide, encodes it as JPEG at 0.7, and posts
// { token, reqId, jpeg } back through the one fetch path every window write uses. Nothing here
// may block the paint: the compose runs on the next frame and the encode is toBlob, which is
// asynchronous by design.
//
// Run against the REAL ui/chart/chart.js over stand-in canvases that record what was drawn.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

type Any = Record<string, any>;

const SOURCE = readFileSync(new URL('../../ui/chart/chart.js', import.meta.url), 'utf8');

function fakeCanvas(width: number, height: number): Any {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const canvas: Any = { width, height, calls, tagName: 'canvas' };
  canvas.getContext = () => ({
    calls,
    fillStyle: '',
    fillRect: (...args: unknown[]) => calls.push({ op: 'fillRect', args }),
    drawImage: (...args: unknown[]) => calls.push({ op: 'drawImage', args }),
    setTransform: () => {},
  });
  // The encoder hands back a blob whose bytes start with the JPEG magic, as a real one would.
  canvas.toBlob = (cb: (blob: Any) => void, type: string, quality: number) => {
    calls.push({ op: 'toBlob', args: [type, quality] });
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    cb({ arrayBuffer: async () => bytes.buffer });
  };
  return canvas;
}

type World = { s: Any; posts: Any[]; offscreen: Any[]; scene: Any; hud: Any; frames: number };

function build(opts: { w?: number; h?: number; dpr?: number; mini?: Any } = {}): World {
  const w = opts.w ?? 1600;
  const h = opts.h ?? 900;
  const dpr = opts.dpr ?? 2;
  const scene = fakeCanvas(w * dpr, h * dpr);
  const hud = fakeCanvas(w * dpr, h * dpr);
  const posts: Any[] = [];
  const offscreen: Any[] = [];
  const world: World = { s: {}, posts, offscreen, scene, hud, frames: 0 };
  const sandbox: Any = {
    window: {
      requestAnimationFrame: (fn: () => void) => {
        world.frames += 1;
        fn();
        return 1;
      },
      matchMedia: () => ({ matches: false }),
      addEventListener: () => {},
      localStorage: { getItem: () => null, setItem: () => {} },
      devicePixelRatio: dpr,
      PhosphorNet: {
        postJson: async (path: string, body: Any) => {
          posts.push({ path, body });
          return { ok: true };
        },
      },
      PhosphorMini: { canvasOf: (slot: number) => (opts.mini && slot === 1 ? opts.mini : null) },
    },
    document: {
      getElementById: (id: string) => (id === 'chart' ? scene : id === 'chart-hud' ? hud : null),
      createElement: (tag: string) => {
        const node = tag === 'canvas' ? fakeCanvas(0, 0) : { tagName: tag };
        if (tag === 'canvas') offscreen.push(node);
        return node;
      },
      addEventListener: () => {},
    },
    btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
    fetch: async () => {
      throw new Error('these tests never reach the network');
    },
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    },
    clearTimeout: () => {},
    setInterval: () => 0,
    console,
  };
  createContext(sandbox);
  runInContext(SOURCE, sandbox, { filename: 'ui/chart/chart.js' });
  sandbox.CHART_SIZE = { w, h, dpr };
  world.s = sandbox;
  return world;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

test('slot 0 is the scene and the hud composed into a canvas at most 1024 wide, encoded as JPEG at 0.7', async () => {
  const world = build();
  world.s.chartSnapshot(0, 'req1');
  await settle();
  assert.equal(world.offscreen.length, 1);
  const out = world.offscreen[0];
  assert.equal(out.width, 1024);
  assert.equal(out.height, 576, 'the aspect was not kept');
  const draws = out.calls.filter((c: Any) => c.op === 'drawImage');
  assert.equal(draws.length, 2);
  assert.equal(draws[0].args[0], world.scene, 'the scene goes down first');
  assert.equal(draws[1].args[0], world.hud, 'then the hud over it');
  assert.deepEqual(draws[0].args.slice(1), [0, 0, 1024, 576]);
  const [encode] = out.calls.filter((c: Any) => c.op === 'toBlob');
  assert.deepEqual(encode.args, ['image/jpeg', 0.7]);
  assert.equal(world.posts.length, 1);
  assert.equal(world.posts[0].path, '/api/chart/snapshot');
  assert.equal(world.posts[0].body.reqId, 'req1');
  // Base64 of bytes that begin FF D8 FF, which is what the route checks for.
  assert.ok(String(world.posts[0].body.jpeg).startsWith('/9j/'), world.posts[0].body.jpeg);
  assert.equal(world.posts[0].body.token, undefined, 'the token is net.js\'s to add, never this file\'s');
});

test('a chart narrower than 1024 is captured at its own size, never scaled up', async () => {
  const world = build({ w: 640, h: 400 });
  world.s.chartSnapshot(0, 'req2');
  await settle();
  assert.equal(world.offscreen[0].width, 640);
  assert.equal(world.offscreen[0].height, 400);
});

test('the compose waits for the next frame rather than running inside the frame that asked', async () => {
  const world = build();
  world.s.chartSnapshot(0, 'req3');
  await settle();
  assert.ok(world.frames >= 1, 'the capture ran synchronously on the SSE frame');
});

test('a comparison chart is captured from its own canvas', async () => {
  const mini = fakeCanvas(1800, 600);
  const world = build({ mini });
  world.s.chartSnapshot(1, 'req4');
  await settle();
  const out = world.offscreen[0];
  assert.equal(out.width, 1024);
  assert.equal(out.height, 341);
  const draws = out.calls.filter((c: Any) => c.op === 'drawImage');
  assert.equal(draws.length, 1);
  assert.equal(draws[0].args[0], mini);
  assert.equal(world.posts[0].body.reqId, 'req4');
});

test('a slot with no chart, or a chart with no size, posts nothing and lets the server time out', async () => {
  const empty = build({ w: 0, h: 0 });
  empty.s.chartSnapshot(0, 'req5');
  await settle();
  assert.equal(empty.posts.length, 0);
  const none = build();
  none.s.chartSnapshot(2, 'req6');
  await settle();
  assert.equal(none.posts.length, 0);
});

test('the trade screen hands a snapshot frame to the engine', () => {
  const trade = readFileSync(new URL('../../ui/screens/trade.js', import.meta.url), 'utf8');
  assert.ok(/events\.on\('snapshot'/.test(trade), 'nothing listens for the snapshot frame');
  assert.ok(/chartSnapshot\(/.test(trade), 'the frame reaches no capture');
});
