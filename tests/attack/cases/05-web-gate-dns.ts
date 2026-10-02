// Attack 05, DNS rebinding: the attacker's name answers a public address when it is checked and a
// private one when it is used. A guard that resolves once to check and lets the connection resolve
// again (or caches the earlier "public" verdict) connects to the private service.
//
// Seam: src/web-page.ts httpsTransport with an injected Resolve, the only DNS seam the page reader
// has (the app's own is dns.promises.lookup; the system resolver cannot be steered without root).
// The resolver is the attacker's zone, TTL 0: it flips its answer on every call. A local TCP server
// on 127.0.0.1 stands in for the internal service a rebind would reach; the URL names its port.
// A socket observer (diagnostics_channel net.client.socket) records the address each socket was
// handed after its lookup and destroys the socket right there, so a public answer never becomes a
// real outbound connection. An observer control (a direct connect to the local server) proves the
// observer and the server's counter both see a connection when one happens.
//
// Held means: one resolve per connection, the socket handed exactly the answer the guard checked,
// every private answer refused, a mixed answer refused whole, and the local service never touched.

import dc from 'node:diagnostics_channel';
import net from 'node:net';

import type { AttackCase, AttackResult } from '../types.ts';
import { httpsTransport, readPage } from '../../../src/web-page.ts';
import type { Resolve } from '../../../src/web-page.ts';

const PUBLIC = '1.1.1.1';
const PRIVATE = '127.0.0.1';
const ZONE = '.attacker-dns.net';

type Seen = { host: string; address: string };

export const attack: AttackCase = {
  id: '05-web-gate-dns',
  title: 'web gate: a DNS answer that changes between check and fetch (rebinding) never reaches a private address',
  timeoutMs: 60_000,
  async run(): Promise<AttackResult> {
    let inbound = 0;
    const server = net.createServer((s) => {
      inbound++;
      s.destroy();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as net.AddressInfo).port;

    const handed: Seen[] = [];
    const attempts: string[] = [];
    const onSocket = (m: unknown): void => {
      const s = (m as { socket: net.Socket }).socket;
      s.on('lookup', (err: Error | null, address: string | Array<{ address: string }>, _family: unknown, host: string) => {
        if (err !== null || !host.endsWith(ZONE)) return;
        const list = Array.isArray(address) ? address.map((a) => a.address) : [address];
        for (const a of list) handed.push({ host, address: a });
        // Stop here: the address the socket would connect to is recorded; no packet leaves.
        s.destroy();
      });
      s.on('connectionAttempt', (ip: string, p: number) => attempts.push(`${ip}:${p}`));
    };
    dc.subscribe('net.client.socket', onSocket);

    try {
      // Observer control: a real connection is seen by both the observer and the server.
      await new Promise<void>((resolve) => {
        const c = net.connect(port, '127.0.0.1', () => {
          c.destroy();
          resolve();
        });
        c.on('error', () => resolve());
      });
      await new Promise((r) => setTimeout(r, 50));
      const controlSeen = attempts.length >= 1 && inbound >= 1;
      attempts.length = 0;
      inbound = 0;

      const calls = new Map<string, number>();
      const flip: Resolve = async (host) => {
        const n = (calls.get(host) ?? 0) + 1;
        calls.set(host, n);
        if (host.startsWith('mixed.')) return [{ address: PUBLIC, family: 4 }, { address: PRIVATE, family: 4 }];
        // Odd calls public, even calls private: TTL 0, flipping every time.
        return [{ address: n % 2 === 1 ? PUBLIC : PRIVATE, family: 4 }];
      };
      const transport = httpsTransport(flip);
      const one = async (host: string): Promise<string> => {
        try {
          await transport(new URL(`https://${host}:${port}/`), { deadline: Date.now() + 3_000, maxBytes: 1024 });
          return 'ANSWERED';
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          return e.code ?? e.message;
        }
      };

      // R1 + R2: six reads of one name; answers alternate public, private, public, ...
      const flipName = `flip${ZONE}`;
      const reads: string[] = [];
      for (let i = 0; i < 6; i++) reads.push(await one(flipName));
      const flipCalls = calls.get(flipName) ?? 0;
      const flipHanded = handed.filter((h) => h.host === flipName).map((h) => h.address);
      // R3: one answer with both.
      const mixed = await one(`mixed${ZONE}`);
      const mixedHanded = handed.filter((h) => h.host.startsWith('mixed.')).length;
      // R4: through readPage, a first answer private.
      calls.set(`page${ZONE}`, 1); // next call is even: private
      const page = await readPage(new URL(`https://page${ZONE}/`), { transport });
      await new Promise((r) => setTimeout(r, 50));

      const privateRefused = reads.filter((_, i) => i % 2 === 1).every((r) => r === 'EPRIVATE');
      const pinned = flipCalls === 6 && flipHanded.length === 3 && flipHanded.every((a) => a === PUBLIC);
      const mixedRefused = mixed === 'EPRIVATE' && mixedHanded === 0;
      const pageRefused = !page.ok && /private or local address/.test(page.failed);
      const untouched = inbound === 0 && attempts.length === 0 && !handed.some((h) => h.address === PRIVATE);
      const pass = controlSeen && privateRefused && pinned && mixedRefused && pageRefused && untouched;

      return {
        expected: 'one resolve per connection; socket handed only the checked public answer; every private answer EPRIVATE; mixed answer refused whole; local service never connected',
        observed:
          `observer control ${controlSeen ? 'saw the direct connect' : 'SAW NOTHING'}; 6 flipping reads -> [${reads.join(', ')}]; ` +
          `resolver calls=${flipCalls}; addresses handed to sockets=[${flipHanded.join(', ')}]; mixed [${PUBLIC},${PRIVATE}] -> ${mixed} (handed ${mixedHanded}); ` +
          `readPage private answer -> ${page.ok ? 'READ' : page.failed}; inbound to 127.0.0.1:${port}=${inbound}; connection attempts=${attempts.length}`,
        pass,
        evidence: `httpsTransport(flipping resolver) x6 + mixed + readPage; diagnostics_channel net.client.socket lookup addresses=${flipHanded.join('/') || 'none'}, local server inbound=${inbound}`,
      };
    } finally {
      dc.unsubscribe('net.client.socket', onSocket);
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
};

export default attack;
