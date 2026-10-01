// Attack 05, where a page read may connect: every non-public address class, three ways.
//
// Seam, in three legs, each the real code:
//  A. src/web-page.ts isPublicAddress, the one predicate every DNS answer is held to.
//  B. src/web-page.ts httpsTransport with an injected Resolve (its only DNS seam: the app's own
//     lookup is dns.promises.lookup) answering a public-looking NAME with the hostile address, read
//     through readPage. A socket observer (diagnostics_channel net.client.socket) proves no
//     connection was even attempted.
//  C. The live backend's web_read through an OUTSIDE MCP seat, for every IP-literal and reserved-name
//     spelling, plus src/web-gate.ts checkPage after the person typed the address and a search
//     "returned" it, so provenance is not what refuses it.
// A public control (1.1.1.1, 2606:4700:4700::1111) must read as public, so the predicate is not
// refusing everything.

import dc from 'node:diagnostics_channel';
import type net from 'node:net';

import { bootBackend } from '../harness.ts';
import type { AttackCase, AttackResult } from '../types.ts';
import { httpsTransport, isPublicAddress, readPage } from '../../../src/web-page.ts';
import { checkPage, NO_PRINTS, recordPersonText, recordSearchResult } from '../../../src/web-gate.ts';

const CLASSES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['private-v4', ['10.0.0.1', '172.16.5.4', '192.168.1.1', '100.64.0.1']],
  ['loopback', ['127.0.0.1', '127.255.255.254', '::1', '0.0.0.0', '::']],
  ['link-local', ['169.254.169.254', 'fe80::1', 'fe80::a9fe:a9fe']],
  ['ula-v6', ['fc00::1', 'fd12:3456::1']],
  ['nat64', ['64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b:1::a00:1']],
  ['6to4', ['2002:7f00:1::1', '2002:c0a8:101::1', '2002:a9fe:a9fe::']],
  ['teredo', ['2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001::1']],
  ['v4-mapped', ['::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:10.0.0.1', '::ffff:192.168.0.1']],
  ['v4-compat/translated', ['::127.0.0.1', '::7f00:1', '::ffff:0:7f00:1', '::ffff:0:a9fe:a9fe']],
  ['multicast/reserved', ['224.0.0.1', '255.255.255.255', 'ff02::1', '3fff::1', '2001:db8::1']],
];
const PUBLIC_CONTROL = ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'];

// IP-literal and reserved-name spellings of the same classes, as an agent would hand them to web_read.
const LITERALS = [
  'https://127.0.0.1/', 'https://2130706433/', 'https://0x7f.1/', 'https://127.1/', 'https://[::1]/',
  'https://[::ffff:127.0.0.1]/', 'https://[::ffff:7f00:1]/', 'https://[64:ff9b::7f00:1]/', 'https://[2002:7f00:1::1]/',
  'https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/', 'https://[fe80::1]/', 'https://169.254.169.254/latest/meta-data/',
  'https://10.0.0.1/', 'https://localhost/', 'https://metadata.google.internal/', 'https://router.lan/', 'https://printer.local/',
];

function watchSockets(): { attempts: string[]; stop(): void } {
  const attempts: string[] = [];
  const onSocket = (m: unknown): void => {
    const s = (m as { socket: net.Socket }).socket;
    s.on('connectionAttempt', (ip: string, port: number) => attempts.push(`${ip}:${port}`));
    s.on('connect', () => attempts.push(`connected ${s.remoteAddress}`));
  };
  dc.subscribe('net.client.socket', onSocket);
  return { attempts, stop: () => dc.unsubscribe('net.client.socket', onSocket) };
}

export const attack: AttackCase = {
  id: '05-web-gate-addresses',
  title: 'web gate: private, link-local, NAT64, 6to4, Teredo and IPv4-mapped addresses are never read',
  timeoutMs: 90_000,
  async run(): Promise<AttackResult> {
    // ---- A: the predicate ----
    const legA = CLASSES.map(([name, ips]) => {
      const leaks = ips.filter((ip) => isPublicAddress(ip));
      return { name, total: ips.length, leaks };
    });
    const controlPublic = PUBLIC_CONTROL.filter((ip) => isPublicAddress(ip));

    // ---- B: a public name resolving to each address, through the real transport ----
    const watch = watchSockets();
    const legB: { name: string; total: number; read: string[] }[] = [];
    try {
      for (const [name, ips] of CLASSES) {
        const read: string[] = [];
        for (const ip of ips) {
          const transport = httpsTransport(async () => [{ address: ip, family: ip.includes(':') ? 6 : 4 }]);
          const page = await readPage(new URL('https://innocent-looking.attacker-dns.net/'), { transport });
          if (page.ok || !/private or local address/.test(page.failed)) read.push(`${ip}=>${page.ok ? 'READ' : page.failed}`);
        }
        legB.push({ name, total: ips.length, read });
      }
    } finally {
      watch.stop();
    }

    // ---- C: literals through the live backend, and through the gate with provenance granted ----
    const app = await bootBackend();
    const legC: string[] = [];
    let legCOk = true;
    try {
      const { client, close } = await app.mcpOutside();
      try {
        for (const url of LITERALS) {
          const r = await app.callTool(client, 'web_read', { url });
          const code = r && typeof r === 'object' ? r.refused : undefined;
          if (code !== 'host') {
            legCOk = false;
            legC.push(`${url}=>${JSON.stringify(r).slice(0, 80)}`);
          }
        }
      } finally {
        await close();
      }
    } finally {
      await app.stop();
    }
    const seat = 'attack-05-addresses-seat';
    recordPersonText(seat, `please read ${LITERALS.join(' ')}`);
    recordSearchResult(seat, { query: 'x', results: [{ content: LITERALS.map((url) => ({ title: 't', url })) }] });
    const gateLeaks = LITERALS.filter((u) => {
      const v = checkPage(seat, u, NO_PRINTS);
      return v.ok || v.code !== 'host';
    });

    const aHeld = legA.every((c) => c.leaks.length === 0);
    const bHeld = legB.every((c) => c.read.length === 0) && watch.attempts.length === 0;
    const controlOk = controlPublic.length === PUBLIC_CONTROL.length;
    const pass = aHeld && bHeld && legCOk && gateLeaks.length === 0 && controlOk;

    const perClass = CLASSES.map(([name], i) => {
      const a = legA[i]!;
      const b = legB[i]!;
      const verdict = a.leaks.length === 0 && b.read.length === 0 ? 'refused' : `LEAK(${[...a.leaks, ...b.read].join(',')})`;
      return `${name} ${verdict} ${a.total - a.leaks.length}/${a.total}`;
    });
    return {
      expected: 'every class refused by the predicate and by the transport (no socket attempt); every literal refused "host" by web_read and by the gate even with provenance; public control reads public',
      observed:
        `${perClass.join('; ')}; socket attempts=${watch.attempts.length}${watch.attempts.length ? ` [${watch.attempts.join(',')}]` : ''}; ` +
        `web_read literals ${legCOk ? `${LITERALS.length}/${LITERALS.length} refused host` : `NOT REFUSED: ${legC.join(' | ')}`}; ` +
        `gate with person+search provenance ${gateLeaks.length === 0 ? `${LITERALS.length}/${LITERALS.length} refused host` : `LEAK: ${gateLeaks.join(',')}`}; ` +
        `control public ${controlPublic.length}/${PUBLIC_CONTROL.length}`,
      pass,
      evidence: `isPublicAddress + readPage(httpsTransport(resolver->addr)) over ${CLASSES.reduce((n, [, ips]) => n + ips.length, 0)} addresses; OUTSIDE MCP web_read over ${LITERALS.length} literals -> refused:"host"`,
    };
  },
};

export default attack;
