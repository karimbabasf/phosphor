// Attack 05, redirects: a public page the gate let through answers 302 to somewhere private. Both
// outbound fetchers that follow redirects are attacked.
//
// Seam:
//  A. Page reads, src/web-page.ts readPage. The first hop (the public page) is a stand-in transport,
//     because a real public site cannot be made to redirect on demand; every later hop goes to the
//     REAL httpsTransport with an injected Resolve, so a Location that is a public-looking name
//     resolving private meets the real guarded lookup. A socket observer proves no connection was
//     attempted to any target.
//  B. Chain reads, src/chainscan/fetch.ts chainFetch, with its own injected fetchImpl (the seam its
//     tests use: deps.fetchImpl), the allowlisted explorer answering 302 to each target. A refused
//     hop must never reach fetchImpl.
// Controls: a public same-site redirect is followed to a 200 page, and a chain redirect to another
// allowlisted host is followed, so "refused" is not "redirects are broken".

import dc from 'node:diagnostics_channel';
import type net from 'node:net';

import type { AttackCase, AttackResult } from '../types.ts';
import { httpsTransport, readPage } from '../../../src/web-page.ts';
import type { Hop, Transport } from '../../../src/web-page.ts';
import { chainFetch, createChainFetchState } from '../../../src/chainscan/fetch.ts';

const START = 'https://public.example.org/start';
// Names the attacker owns whose DNS answers private.
const RESOLVES: Record<string, string> = {
  'inside.attacker-dns.net': '10.0.0.5',
  'meta.attacker-dns.net': '169.254.169.254',
  'mapped.attacker-dns.net': '::ffff:127.0.0.1',
  'nat64.attacker-dns.net': '64:ff9b::a9fe:a9fe',
  'teredo.attacker-dns.net': '2001:0:4136:e378:8000:63bf:3fff:fdd2',
};
const PAGE_TARGETS = [
  'https://127.0.0.1/', 'https://[::1]/', 'https://169.254.169.254/latest/meta-data/', 'https://localhost/admin',
  'https://[::ffff:7f00:1]/', '//10.0.0.1/x', 'http://public.example.org/plain', 'https://public.example.org:8443/',
  'https://user:pw@public.example.org/', 'file:///etc/passwd',
  ...Object.keys(RESOLVES).map((h) => `https://${h}/`),
  'CHAIN', // public -> public -> 127.0.0.1
];
const CHAIN_TARGETS = [
  'https://169.254.169.254/latest/meta-data/', 'https://127.0.0.1/', 'https://localhost/', 'https://[::ffff:7f00:1]/',
  '//10.0.0.1/', 'http://eth.blockscout.com/api/v2/stats', 'https://eth.blockscout.com@127.0.0.1/',
  'https://eth.blockscout.com.attacker.net/', 'https://eth.blockscout.com:8443/', 'file:///etc/passwd',
];

function hop(status: number, location: string | null, body = '', contentType = 'text/plain'): Hop {
  return { status, location, contentType, body: Buffer.from(body) };
}

function watchSockets(): { attempts: string[]; stop(): void } {
  const attempts: string[] = [];
  const onSocket = (m: unknown): void => {
    const s = (m as { socket: net.Socket }).socket;
    s.on('connectionAttempt', (ip: string, port: number) => attempts.push(`${ip}:${port}`));
  };
  dc.subscribe('net.client.socket', onSocket);
  return { attempts, stop: () => dc.unsubscribe('net.client.socket', onSocket) };
}

async function pageVia(location: string): Promise<{ answer: string; realHops: string[] }> {
  const realHops: string[] = [];
  const real = httpsTransport(async (h) => {
    const ip = RESOLVES[h];
    // A name not in the attacker's zone: answer loopback, so a hop the guard missed is refused here
    // too and would show up as a socket attempt rather than a real outbound connection.
    const address = ip ?? '127.0.0.1';
    return [{ address, family: address.includes(':') ? 6 : 4 }];
  });
  const transport: Transport = async (url, opts) => {
    if (url.hostname === 'public.example.org' && url.pathname === '/start' && url.port === '') {
      if (location === 'CHAIN') return hop(302, 'https://public.example.org/two');
      if (location === 'CONTROL') return hop(302, 'https://public.example.org/final');
      return hop(302, location);
    }
    if (location === 'CHAIN' && url.hostname === 'public.example.org' && url.pathname === '/two') return hop(301, 'https://127.0.0.1/');
    if (location === 'CONTROL' && url.href === 'https://public.example.org/final') return hop(200, null, 'hello from the final page');
    realHops.push(url.href);
    return real(url, opts);
  };
  const page = await readPage(new URL(START), { transport });
  return { answer: page.ok ? `READ ${page.url}` : page.failed, realHops };
}

async function chainVia(location: string): Promise<{ answer: string; calls: string[] }> {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location } });
    return new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await chainFetch('https://eth.blockscout.com/api/v2/stats', {}, { fetchImpl, state: createChainFetchState(), deadline: Date.now() + 5_000 });
    return { answer: 'FOLLOWED', calls };
  } catch (err) {
    return { answer: err instanceof Error ? err.message : String(err), calls };
  }
}

export const attack: AttackCase = {
  id: '05-web-gate-redirect',
  title: 'web gate: a redirect from a public page (or chain explorer) to a private target is refused',
  timeoutMs: 60_000,
  async run(): Promise<AttackResult> {
    const watch = watchSockets();
    const page: { to: string; answer: string; realHops: string[] }[] = [];
    let control: { answer: string; realHops: string[] };
    try {
      for (const to of PAGE_TARGETS) page.push({ to, ...(await pageVia(to)) });
      control = await pageVia('CONTROL');
    } finally {
      watch.stop();
    }
    // Refused: not read, and nothing reached a socket. A literal or a reserved name must be refused
    // before the real transport is even called; a name resolving private may reach the real transport,
    // whose guarded lookup refuses it.
    const pageLeaks = page.filter((p) => p.answer.startsWith('READ'));
    const literalHops = page.filter((p) => !(new URL(p.to, START).hostname in RESOLVES) && p.realHops.length > 0);
    const pageHeld = pageLeaks.length === 0 && literalHops.length === 0 && watch.attempts.length === 0;
    const controlOk = control.answer === 'READ https://public.example.org/final' && control.realHops.length === 0;

    const chain: { to: string; answer: string; calls: string[] }[] = [];
    for (const to of CHAIN_TARGETS) chain.push({ to, ...(await chainVia(to)) });
    const chainLeaks = chain.filter((c) => c.calls.length !== 1 || c.answer === 'FOLLOWED');
    const chainControl = await chainVia('https://base.blockscout.com/api/v2/stats');
    const chainControlOk = chainControl.answer === 'FOLLOWED' && chainControl.calls.length === 2;

    const pass = pageHeld && controlOk && chainLeaks.length === 0 && chainControlOk;
    const short = (s: string) => s.replace(/^the site redirected to an address that is never read: /, 'never read: ').slice(0, 60);
    return {
      expected: 'every page redirect target refused with no socket attempt; every chain redirect target refused with fetchImpl called once; both controls follow',
      observed:
        `page ${page.length - pageLeaks.length}/${page.length} refused [${page.map((p) => `${p.to} -> ${short(p.answer)}`).join('; ')}]; ` +
        `socket attempts=${watch.attempts.length}; literal hops reaching transport=${literalHops.length}; page control: ${control.answer}; ` +
        `chain ${chain.length - chainLeaks.length}/${chain.length} refused [${chain.map((c) => `${c.to} -> ${c.answer.slice(0, 50)} (calls=${c.calls.length})`).join('; ')}]; ` +
        `chain control: ${chainControl.answer} calls=${chainControl.calls.length}`,
      pass,
      evidence: `readPage(${START} -> 302 target) via real httpsTransport+resolver; chainFetch(eth.blockscout.com -> 302 target, fetchImpl stub): leaks page=${pageLeaks.length} chain=${chainLeaks.length}`,
    };
  },
};

export default attack;
