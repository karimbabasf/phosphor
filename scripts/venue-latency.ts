// What the venue costs from here, read straight off mainnet, unsigned.
//
// Five REST round trips and two websocket channels, timed with nothing but globalThis.fetch and
// globalThis.WebSocket. No key is opened and nothing is signed: the one /exchange POST carries
// a signature of zeros on an empty cancel, which the venue refuses, because the number wanted is
// the round trip of the write path and not a write. Every line prints p50, min and max in ms,
// nearest rank, so the app's own numbers (the harness in tests/unit/runner-latency.test.ts, the
// venueMs on every runner event) can be read against the venue's.
//
// Run: npm run venue-latency [-- --user 0x... --coin BTC --samples 10 --seconds 20]
// The user defaults to the first EVM address in config.local.json or config.json, else zero.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REST = 'https://api.hyperliquid.xyz';
const WS = 'wss://api.hyperliquid.xyz/ws';
const ZERO = '0x0000000000000000000000000000000000000000';
const TIMEOUT_MS = 10_000;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] !== undefined ? String(process.argv[i + 1]) : fallback;
}

function configuredUser(): string {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  for (const file of ['config.local.json', 'config.json']) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')) as { addresses?: { evm?: unknown[] } };
      const first = cfg.addresses?.evm?.[0];
      if (typeof first === 'string' && /^0x[0-9a-fA-F]{40}$/.test(first)) return first;
    } catch {
      // Absent or unreadable: the next file, then the zero address.
    }
  }
  return ZERO;
}

const user = arg('user', configuredUser());
const coin = arg('coin', 'BTC').toUpperCase();
const samples = Math.max(1, Number(arg('samples', '10')) || 10);
const seconds = Math.max(1, Number(arg('seconds', '20')) || 20);

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(1, Math.ceil((p / 100) * sorted.length)) - 1] as number;
}

function line(name: string, values: number[], note: string): void {
  const p50 = percentile(values, 50);
  const min = Math.min(...values);
  const max = Math.max(...values);
  console.log(`${name.padEnd(26)} p50 ${p50.toFixed(0).padStart(5)} ms   min ${min.toFixed(0).padStart(5)}   max ${max.toFixed(0).padStart(5)}   ${note}`);
}

let failed = 0;

// One POST, timed from the request leaving to the whole body being read.
async function post(pathname: string, body: unknown): Promise<{ ms: number; status: number; text: string }> {
  const started = performance.now();
  const res = await fetch(`${REST}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  return { ms: performance.now() - started, status: res.status, text };
}

async function rest(name: string, pathname: string, body: unknown): Promise<void> {
  const times: number[] = [];
  let first: { status: number; text: string } | null = null;
  try {
    for (let i = 0; i < samples; i += 1) {
      const out = await post(pathname, body);
      times.push(out.ms);
      if (first === null) first = { status: out.status, text: out.text };
    }
  } catch (err) {
    failed += 1;
    console.log(`${name.padEnd(26)} FAILED after ${times.length} of ${samples}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const status = first === null ? '' : `${first.status}`;
  // The venue's own words on the write it refused, so the reader can see it was the write path.
  const words = pathname === '/exchange' && first !== null ? `, ${first.text.replace(/\s+/g, ' ').slice(0, 60)}` : '';
  line(name, times, `(${samples} samples, HTTP ${status}${words})`);
}

// The gaps between frames on one channel, over a fixed window, from one socket.
async function socket(): Promise<void> {
  const arrivals: Record<string, number[]> = { activeAssetCtx: [], candle: [] };
  const wanted = [
    { type: 'activeAssetCtx', coin },
    { type: 'candle', coin, interval: '1m' },
  ];
  let opened: number | null = null;
  // Set before this side closes: the venue drops the link without a close frame, which the
  // runtime reports as an error, and that is not a failure of anything measured.
  let closing = false;
  await new Promise<void>((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(WS);
    } catch (err) {
      failed += 1;
      console.log(`ws ${WS}                 FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return resolve();
    }
    const close = (): void => {
      closing = true;
      ws.close();
    };
    const timer = setTimeout(() => {
      if (opened === null) {
        failed += 1;
        console.log(`ws ${WS}                 FAILED: no open within ${TIMEOUT_MS} ms`);
      }
      close();
    }, TIMEOUT_MS);
    ws.onopen = () => {
      clearTimeout(timer);
      opened = performance.now();
      for (const subscription of wanted) ws.send(JSON.stringify({ method: 'subscribe', subscription }));
      setTimeout(close, seconds * 1000);
    };
    ws.onmessage = (ev) => {
      const at = performance.now();
      let msg: { channel?: unknown } = {};
      try {
        msg = JSON.parse(String(ev.data)) as { channel?: unknown };
      } catch {
        return;
      }
      const channel = typeof msg.channel === 'string' ? msg.channel : '';
      if (channel === 'error') console.log(`ws error: ${JSON.stringify(msg).slice(0, 120)}`);
      if (arrivals[channel] !== undefined) arrivals[channel].push(at);
    };
    ws.onerror = (ev) => {
      if (closing) return;
      failed += 1;
      const why = (ev as { message?: unknown }).message;
      console.log(`ws                         FAILED: ${typeof why === 'string' && why !== '' ? why : 'the socket errored'}`);
    };
    ws.onclose = () => resolve();
  });
  if (opened === null) return;
  for (const [channel, at] of Object.entries(arrivals)) {
    const name = `ws ${channel} ${channel === 'candle' ? '1m ' : ''}${coin}`;
    if (at.length < 2) {
      console.log(`${name.padEnd(26)} ${at.length} frame${at.length === 1 ? '' : 's'} in ${seconds} s, no cadence to report`);
      continue;
    }
    const gaps = at.slice(1).map((t, i) => t - (at[i] as number));
    line(name, gaps, `(${gaps.length} gaps in ${seconds} s, first frame ${(at[0]! - opened).toFixed(0)} ms after open)`);
  }
}

console.log(`venue ${REST}, user ${user}, coin ${coin}, ${samples} samples per REST line, ${seconds} s on the socket\n`);
await rest('info meta', '/info', { type: 'meta' });
await rest('info clearinghouseState', '/info', { type: 'clearinghouseState', user });
await rest(`info l2Book ${coin}`, '/info', { type: 'l2Book', coin });
await rest('info extraAgents', '/info', { type: 'extraAgents', user });
await rest('exchange rejected cancel', '/exchange', {
  action: { type: 'cancel', cancels: [] },
  nonce: Date.now(),
  signature: { r: `0x${'0'.repeat(64)}`, s: `0x${'0'.repeat(64)}`, v: 27 },
  vaultAddress: null,
});
await socket();
if (failed > 0) {
  console.log(`\n${failed} line${failed === 1 ? '' : 's'} failed`);
  process.exit(1);
}
