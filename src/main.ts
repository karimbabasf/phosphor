// Phosphor app entrypoint: wires config, audit, store, policy, ledger, composition,
// cost, candles, proposals and the HTTP server into one process.
// This is the authoritative state owner. The MCP process (src/mcp.ts) is a thin
// client of the HTTP surface this file boots.

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { Candle, Policy, RiskRow, Screen, ScreenBy, ViewMode } from './types.ts';
import { readScreen, writeScreen } from './view/mode.ts';
import { readTheme, writeTheme, type Theme } from './view/theme.ts';
import { loadConfig } from './config.ts';
import { createAudit } from './audit.ts';
import { recordAuditChain } from './http/health.ts';
import { createKeystore, useKeystore } from './keystore/index.ts';
import { createSession } from './keystore/session.ts';
import { createStore } from './store.ts';
import { installCrashHandlers } from './crash.ts';
import { acquireInstanceLock } from './instancelock.ts';
import type { InstanceLock } from './instancelock.ts';
import { installShutdownHandlers } from './shutdown.ts';
import { beginDraining } from './draining.ts';
import { loadPolicy, savePolicy, defaultPolicy } from './policy/file.ts';
import { renderSentences } from './policy/render.ts';
import { missingVenues, proposeVenueGap } from './policy/venues.ts';
import { createRails, venueAllowlist } from './rails/index.ts';
import { demoStallSweep } from './rails/demo.ts';
import { usdcCreditedSince } from './rails/hl-user-signed.ts';
import { createLedger, intentsAccountId, REFRESH_PERIOD_MS } from './ledger/index.ts';
import { oneClickClient, type OneClickStatus, type TokensFile } from './intents.ts';
import { createMarketData } from './market/index.ts';
import { lineAt } from './analysis/trendline.ts';
import { createProposalService } from './proposals.ts';
import { addressActivity } from './chainscan/index.ts';
import { hlDepositCredited } from './proposals/reconcile.ts';
import { MAX_AGENTS, RESERVED_SEATS, createAgents, seatSecretPath } from './agents.ts';
import { atomicWrite } from './fsatomic.ts';
import { createRunnerHost } from './runner/host.ts';
import { readApiWallet, readApiWalletKey } from './runner/keys.ts';
import { createTradeService } from './trade/service.ts';
import type { TradeService } from './trade/service.ts';
import { createPlanStore } from './trade/plans.ts';
import type { TradeDeps } from './trade/rail.ts';
import { createInfoClient } from './hl/info.ts';
import { createServer } from './server.ts';
import { createVaultRelay } from './vault/relay.ts';
import { mintToken, readWindowToken } from './http/auth.ts';
import { refreshRegistration } from './http/mutation.ts';
import { useIdentityValue } from './http/respond.ts';
import { sweepOrphans, useSeatSecret } from './driver.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cfg = loadConfig(root);

const audit = createAudit(cfg.dataDir);

/* Before anything that can throw. See src/crash.ts: without these two handlers Node ends the
   process on any unhandled rejection, and the shell above inherits stdio to nowhere, so the
   window simply stops answering. */
installCrashHandlers({ audit });

/* One Phosphor per data directory. Taken before the store is read, because the damage two
   backends do is to that file: store.put rewrites the whole proposal list, so the second writer
   silently drops the first writer's proposals. See src/instancelock.ts. */
let instanceLock: InstanceLock;
try {
  instanceLock = acquireInstanceLock(cfg.dataDir);
} catch (err) {
  const why = err instanceof Error ? err.message : String(err);
  console.error(`phosphor: ${why}`);
  try {
    audit.append('error', `refused to boot: ${why}`);
  } catch {
    // stderr already carries it.
  }
  process.exit(4);
}
// Released on any ordinary exit, including the crash handler's. A SIGKILL leaves the file
// behind, which is what the pid inside it is for: the next boot sees a dead pid and clears it.
process.on('exit', () => instanceLock.release());

/* The audit chain's anchor, on the same event and for the same reason. It is written on a one
   second timer rather than per line (src/audit.ts, TIP_FLUSH_MS), so every way out this process
   gets to run code on has to put it down: the shutdown path and the crash handler both end in
   process.exit, and this is the one listener that covers both without either of them knowing
   about the audit log. A SIGKILL still leaves the anchor lagging, which is exactly the case
   verifyChain was built to accept. */
process.on('exit', () => audit.flushTip());

const store = createStore(cfg.dataDir);

/* The keys, and the lock over them. Installed before anything that could ask for a signature,
   because src/keystore/index.ts is the door every signer in this app knocks on and an
   uninstalled keystore means every one of them falls back to reading a plaintext file.
   Booting never asks for a password: the app comes up locked (or with no wallet at all) and
   the window is where a person unlocks it. */
const keystore = createKeystore({ keysPath: cfg.keysPath, mode: cfg.mode });
useKeystore(keystore);

/* THE SHELL'S HANDSHAKE, off the pipe and before the port opens.
   Five lines, in this order, written by src-tauri/src/backend.rs and then the pipe is closed:

     1. the window token, which every write from the control page carries
     2. the boot nonce, which this process echoes in its x-phosphor header so the shell can tell
        its OWN backend from anything else that took the port
     3. the roster seat secret, which reaches the agents this app spawns and nothing else
     4. the enclave transport key, under which the Secure Enclave sidecar seals the wallet's data
        key on its way back here over loopback; see src/vault/relay.ts
     5. the relay secret, which the two relay routes take instead of the window token, so the
        page (which holds the token) can never play the shell

   Why a pipe and not the environment: `ps eww <pid>` prints the environment of any process this
   user owns, which is the attacker this app is built against. A local process read the token back
   that way and drove the kill switch, the idle beacon and approve on a real pending proposal,
   which the audit then recorded as a human's click. Same channel and same argument as the runner's
   Hyperliquid key. See src/http/auth.ts.

   A bare `npm run app` has nobody above it to send any of this. It gets a terminal on stdin, reads
   nothing, mints its own token and says so on stderr, and answers the identity header with the
   fixed word. Nothing is weakened: a backend with no nonce is a backend no shell is waiting on. */
const HANDSHAKE_WAIT_MS = 2_000;

function readHandshake(
  stdin: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  waitMs = HANDSHAKE_WAIT_MS,
): Promise<string[]> {
  // A terminal is nobody about to pipe a secret, so there is nothing to wait for.
  if (stdin.isTTY === true) return Promise.resolve([]);
  return new Promise((resolve) => {
    let buffered = '';
    let done = false;

    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.off('data', onData);
      stdin.off('end', finish);
      stdin.off('error', finish);
      // Read no further. The handshake is the only thing this process ever wants from stdin.
      stdin.pause?.();
      resolve(buffered.split('\n').map((line) => line.trim()));
    };

    const onData = (chunk: Buffer | string): void => {
      buffered += String(chunk);
      // Five values means five newlines, because the shell writes one after the last of them.
      if (buffered.split('\n').length > 5) finish();
    };

    const timer = setTimeout(finish, waitMs);
    timer.unref?.();
    stdin.on('data', onData);
    stdin.on('end', finish);
    stdin.on('error', finish);
    stdin.resume?.();
  });
}

const handshake = await readHandshake();

/* The token still goes through readWindowToken, which owns the rules around it: the length floor,
   the refusal to mint one when the shell started this process, and the single stderr print for the
   developer case. It is handed the first line as a stream of its own rather than the real stdin,
   because the real stdin has already been read to the end of the handshake by then. */
const windowTokenValue = await readWindowToken({
  stdin: Readable.from([`${handshake[0] ?? ''}\n`]) as NodeJS.ReadableStream,
});

// The identity header answers with this boot's nonce from here on. Set before the port opens, so
// there is no window in which this app answers with the fixed word the shell would refuse.
useIdentityValue(handshake[1] ?? '');

/* The roster seat secret, and a minted one when nobody sent it.
   Minting here rather than doing without is what keeps a `npm run app` install working the same
   way as an installed one: the app's own driver child is recognised because it carries this value,
   and a developer running the app by hand has an in-app driver too. It is never served, never
   logged and never printed. It goes to the agents this app spawns, through childEnv, and to one
   file: EVERY op on /api/mcp needs it now (src/http/mcp.ts), and a proxy a human started by hand
   (`npm run mcp`, the `claude mcp` registration) has no childEnv to get it from. So it is written
   to <dataDir>/agent.secret before the port opens, owner-readable only, one line, and rewritten
   on every boot so a copy taken from an earlier run opens nothing. src/mcp.ts reads it from there
   when PHOSPHOR_SEAT is absent.
   Mode 0600 keeps out another account on this Mac and nothing else. The attacker http/auth.ts
   names, a process this same user owns, reads it and takes a seat; what that costs it is a line
   in the audit log, a row on the roster and the presence light. The seat is not the wall. The
   human click is, and no seat reaches one. src/mcp.ts says the same thing where it reads this. */
const seatSecret = (handshake[2] ?? '').length >= 32 ? (handshake[2] as string) : mintToken();
useSeatSecret(seatSecret);
atomicWrite(seatSecretPath(cfg.dataDir), `${seatSecret}\n`, { mode: 0o600 });

/* The enclave transport key, line 4, and the relay built over it. Absent (a bare `npm run app`,
   an older shell) means a relay with no key, which answers every ask with no_relay: the wallet
   stays on the password path and nothing here changes. Present, the shell will start polling
   the moment the port answers, and the first thing asked of it is a probe, so the window knows
   whether this Mac has an enclave before anyone clicks Create. */
const transportHex = handshake[3] ?? '';
const transportKey = /^[0-9a-f]{64}$/i.test(transportHex) ? Buffer.from(transportHex, 'hex') : null;
const relaySecret = /^[0-9a-f]{64}$/i.test(handshake[4] ?? '') ? (handshake[4] as string) : null;
// No relay secret means no relay: a transport key with nothing to gate the routes would let the
// page play the shell, so both must arrive or neither counts.
const vault = createVaultRelay({ transportKey: relaySecret !== null ? transportKey : null, secret: relaySecret });
if (transportKey !== null) {
  void vault.ask({ op: 'probe' }).then((probe) => {
    if (probe.ok && probe.op === 'probe') {
      audit.append('app_start', probe.capability.secureEnclave ? 'the Secure Enclave is reachable through the shell' : 'this Mac has no Secure Enclave the shell can reach', { ...probe.capability });
    } else if (!probe.ok) {
      audit.append('app_start', `the enclave probe failed: ${probe.error}`, { error: probe.error });
    }
  });
}

const agents = createAgents(Date.now, MAX_AGENTS, { reserved: RESERVED_SEATS, secret: seatSecret });

/* The lock's clock, and the signing sessions armed rules hold, in one object because they are
   two halves of one question: how long may this process keep a key. It is built here rather
   than inside createServer because the runner needs it too, and there must be exactly one.
   `announceLock` is filled once the server exists, since the frame it sends needs SSE clients
   to send it to. Until then a lock is still a lock, it is simply not narrated. */
let announceLock: (() => void) | null = null;
const session = createSession({
  isUnlocked: () => keystore.isUnlocked(),
  lock: (reason) => {
    keystore.lock();
    audit.append(
      'app_start',
      reason === 'sleep'
        ? 'the wallet locked: this machine was asleep'
        : 'the wallet locked after fifteen minutes with nobody at the window',
      { reason },
    );
    announceLock?.();
  },
});

/* THE AUDIT CHAIN, CHECKED, and behind the port rather than in front of it.
   verify() had no caller outside the tests: nothing on boot, no route, not health, so the hash
   chain that exists to detect tampering was never actually read in production. The answer is
   reported through /api/health rather than being made a refusal to boot: a damaged record is a
   thing the owner has to be told about, and refusing to start would take away the app they would
   read it in.

   It used to run HERE, before listen, and it walks the whole file: measured at 1.0 ms on a 1k line
   log, 7.4 ms at 10k, 37.2 ms at 50k and 154.0 ms at 200k. That is directly in front of first
   paint, and it is the one boot cost that grows every month the app is used, so an old data
   directory booted slower than a new one for a reason nobody was waiting on.

   Not a setImmediate, and the difference matters. An immediate scheduled from the listen callback
   runs in the same loop iteration, before the poll phase takes the first connection, so the socket
   opens earlier and the first request still waits behind the walk: the port would be open and the
   window would not be drawn. A delay lets the window's first reads through and spends the walk
   while the app is idle. Health says `checking` until it lands, which is a different fact from
   `not checked` and from `ok`, and the window reads all three. */
export const AUDIT_VERIFY_DELAY_MS = 2_000;

recordAuditChain('checking');

/* Not a frozen answer. verify() used to run once at boot and /api/health served that string for
   the life of the process, so a log tampered with an hour later read ok until a restart. The walk
   runs again every five minutes, unref'd so it never keeps the process alive. */
export const AUDIT_REVERIFY_MS = 5 * 60_000;

function checkAuditChain(): void {
  try {
    const chain = audit.verify();
    if (chain.ok) {
      /* Verified against nothing is not verified. A deleted anchor used to fold into ok, which
         turned a truncated log into a clean boot; it is named now and the window can say so. */
      recordAuditChain(chain.anchored ? 'ok' : 'unanchored');
      if (chain.interleaved > 0) {
        console.error(`phosphor: the audit log verifies, with ${chain.interleaved} run(s) of lines an older build wrote after the chain began`);
      }
    } else {
      const why = `${chain.break.reason} at line ${chain.break.line}: ${chain.break.detail}`;
      recordAuditChain(`broken: ${why}`);
      console.error(`phosphor: the audit log does not verify. ${why}`);
      audit.append('error', `the audit log does not verify: ${why}`, { break: chain.break, lines: chain.lines });
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    recordAuditChain(`broken: the chain could not be read (${why})`);
    console.error(`phosphor: the audit log could not be verified: ${why}`);
  }
}

/* Read the proposal file once, here, before anything else touches it. An unreadable state file
   is a refusal to boot with a sentence, not a silent fresh start on an empty history and not a
   raw stack out of whichever handler happened to read first. readAll has already moved the bad
   bytes aside by the time this catch runs, so the next start comes up clean with the evidence
   kept beside it. */
try {
  store.list();
} catch (err) {
  const why = err instanceof Error ? err.message : String(err);
  console.error(`phosphor: ${why}`);
  try {
    audit.append('error', `refused to boot: ${why}`);
  } catch {
    // The audit file is on the same disk that just failed us. stderr already carries it.
  }
  process.exit(3);
}

/* Anything the last run left behind, before this one can add to it. See the note above
   sweepOrphans in src/driver.ts for why this is safe here and nowhere else: it runs from the
   entrypoint rather than from createServer because every test in this repo builds a server,
   and a sweep that matched this installation's own settings path from inside a test would kill
   a Phosphor agent the developer is actually using. */
const collected = sweepOrphans(root);
if (collected.length > 0) {
  audit.append(
    'app_start',
    `collected ${collected.length} agent process(es) left running by a previous session`,
    { pids: collected },
  );
}

// The picked agent's registration names this boot's node and port, or is written again.
void refreshRegistration(cfg, audit);

// Seed a default policy only when the file is absent. A present-but-corrupt file
// is left in place: loadPolicy returns null and every write refuses (fail closed)
// until a human repairs or deletes it.
//
// The seeded allowlist carries the rail venues. evaluateRail refuses an unlisted
// counterparty outright, never as needs_approval, so without them the rails are not
// gated, they are dead. What the allowlist still governs is size: humanClickAboveUsd
// decides which of these venue calls a human has to click.
//
// An EXISTING policy.json is never rewritten, not even to add a venue. A human may
// have curated it, and an app whose whole claim is that software does not change the
// rules behind your back cannot change the rules behind your back. A missing venue is
// named in the audit log and then ASKED FOR: see the proposal filed further down, which
// is how the app gets a venue added without editing anybody's rules for them.
const venues = venueAllowlist();
// Held for the proposal below, which cannot be filed until the proposal service exists.
let existingPolicy: Policy | null;
if (!fs.existsSync(path.join(cfg.dataDir, 'policy.json'))) {
  const seeded = defaultPolicy();
  seeded.outbound.destinationAllowlist = venues;
  seeded.sentences = renderSentences(seeded); // the human reads the policy actually in force
  savePolicy(cfg.dataDir, seeded);
  audit.append(
    'policy_changed',
    `seeded default policy on first boot, allowing ${venues.length} rail venue(s)`,
    { destinationAllowlist: venues },
  );
  existingPolicy = null;
} else {
  existingPolicy = loadPolicy(cfg.dataDir);
  const missing = missingVenues(existingPolicy, venues);
  if (missing.length > 0) {
    audit.append(
      'error',
      `policy.json does not allow ${missing.length} rail venue(s), so those rails refuse every proposal until a human adds them: ${missing.join(', ')}`,
      { missing },
    );
  }
}

const riskRows = (JSON.parse(fs.readFileSync(path.join(root, 'data', 'risk-table.json'), 'utf8')) as { rows: RiskRow[] }).rows;
const tokens = JSON.parse(fs.readFileSync(path.join(root, 'data', 'tokens.json'), 'utf8')) as TokensFile;

const ledger = createLedger(cfg);

// The market data layer: the venue catalogue, the candle cache, and the folding that lets
// any timeframe be asked for. It owns the render path now, which is what took the exchange
// round trip out from in front of the first pixel. See src/market/index.ts.
// Assigned once the server exists, because the server is what has the SSE clients to tell.
// Until then a fill that lands simply has nobody to announce it to, which is correct.
let marketUpdated: () => void = () => {};
// The same, for the live rail. A socket bar carries the bar itself rather than a nudge, so
// the browser repaints without refetching a hundred kilobytes of JSON to move one close.
let marketLive: (product: string, baseSec: number, candle: Candle, provider: string) => void = () => {};

const market = createMarketData({
  cachePath: path.join(cfg.dataDir, 'market-catalog.json'),
  onUpdate: () => marketUpdated(),
  onLive: (product, baseSec, candle, provider) => marketLive(product, baseSec, candle, provider),
  // The venue sockets. On in the app, off in every test that builds a market service, because
  // dialling a venue is not something a unit test should do by accident.
  live: { enabled: true },
});

// The catalogue is what makes a symbol beyond the config list reachable. A cold start with
// no network still runs: resolution falls back to the product id as typed.
void market.refreshCatalog().catch((err: unknown) => {
  console.error(`market catalogue unavailable, falling back to literal product ids: ${String(err)}`);
});

// Owns the plans and the child process that places them. Constructed before the rails
// because the trade rail only arms, changes and closes through it and holds no state of its own.
//
// The key it hands the child is the API wallet, never the master. Reading it lazily, at arm
// time rather than at boot, means an install with no agent approved yet starts fine and fails
// with a sentence that says what to do instead of failing at startup.
const HL_BASE_URL = 'https://api.hyperliquid.xyz';
const HL_WS_URL = 'wss://api.hyperliquid.xyz/ws';

/* The venue facts a plan is priced against live on the trade service, which is built after the
   rails because it needs the runner. These closures read through to it once it exists; until
   then a plan cannot be priced, which is the honest answer before the venue has spoken. */
let tradeService: TradeService | null = null;
const tradeInfo = createInfoClient({ baseUrl: HL_BASE_URL });
/* The trading account is the wallet's own address, read from the keystore on every ask, the
   same way the ledger names the intents account. It used to be the config address book, read
   once at boot: a fresh install has neither, so the feed asked the venue about user '' on every
   spot poll, the venue answered 422, and the Trade tab said "No route to the venue" until a
   restart. The config address is the fallback for an install that only reads. */
function hlUser(): string {
  return intentsAccountId(cfg) ?? cfg.addresses.evm ?? '';
}

function productFor(coin: string): string {
  return cfg.candleProducts.find((p) => p.split('-')[0].toUpperCase() === coin.toUpperCase()) ?? `${coin.toUpperCase()}-USD`;
}

const runner = createRunnerHost({
  apiWalletKey: async () => await readApiWalletKey(cfg.keysPath),
  // The one signing session in this process. A waiting plan keeps the trading key across a
  // lock, and only until the expiry the human set when they approved it, a day at most.
  session,
  baseUrl: HL_BASE_URL,
  user: hlUser,
  // Fail closed: a policy file that will not load reads as the kill switch being ON, so an
  // unreadable policy can never be the reason a plan was allowed to arm.
  killSwitch: () => loadPolicy(cfg.dataDir)?.killSwitch ?? true,
  store: createPlanStore(cfg.dataDir),
  meta: (coin) => tradeService?.meta(coin) ?? null,
  mark: (coin) => tradeService?.mark(coin) ?? null,
  free: () => tradeService?.free() ?? null,
  // Closed bars for the watcher, from the same store the chart draws from.
  bars: async (coin, tf, count) => (await market.warm(productFor(coin), tf, count)).candles,
  // A read is what keeps the live rail subscribed to a coin, so the watcher's minute frames
  // keep arriving while a plan waits.
  follow: (coin) => {
    market.read(productFor(coin), '1m', 30);
  },
  approval: (proposalId) => {
    const p = store.get(proposalId);
    if (p === undefined || p.draft.kind !== 'trade' || p.draft.op !== 'open') return null;
    return { hash: p.draft.hash, status: p.status };
  },
  /* Whether the runner's API wallet is still approved on the venue, asked once per child before
     the first fire. An address this app cannot read is not a refusal: it is a check that cannot
     be made, and the venue's own refusal of the order is what follows. */
  agentApproved: async () => {
    const address = readApiWallet(cfg.keysPath).address;
    const user = hlUser();
    if (address === null || user === '') return true;
    const agents = await tradeInfo.post<{ address?: string }[]>({ type: 'extraAgents', user });
    return Array.isArray(agents) && agents.some((a) => String(a.address ?? '').toLowerCase() === address.toLowerCase());
  },
  onEvent: (e) => {
    const failed = e.type === 'error' || (e.type === 'done' && e.reason.startsWith('failed:'));
    audit.append(
      failed ? 'error' : 'executed',
      `runner: ${e.type}${'id' in e && e.id !== null ? ` ${e.id}` : ''}` +
        ('reason' in e ? `: ${e.reason}` : 'message' in e ? `: ${e.message}` : 'detail' in e ? `: ${e.detail}` : '') +
        // Written into the sentence rather than left in the data, because "how long does this
        // plan hold a key that can trade" is the question somebody reads this line to answer.
        (e.type === 'armed' ? `: it holds the trading key until ${e.signingExpiresAt}` : '') +
        // Same reason: "was it the venue or was it us" is answered by the line, not by the data.
        ('venueMs' in e && e.venueMs !== undefined ? `: the venue took ${e.venueMs} ms` : ''),
      e,
    );
  },
});

// What the trade rail and the proposal service price a plan against.
const tradeDeps: TradeDeps = {
  runner,
  meta: (coin) => tradeService?.meta(coin) ?? null,
  mark: (coin) => tradeService?.mark(coin) ?? null,
  free: () => tradeService?.free() ?? null,
};

/* The dispatch table for swap, the two Hyperliquid moves and the two sends. In demo mode it
   holds the demo rails instead (src/rails/demo.ts): the same five kinds, walking the same
   stages against the fixture, signing nothing and reaching for no chain. `refresh` is theirs:
   a demo move changes the fixture's balances and the row waiting on them is judged against the
   read that shows it. */
const rails = createRails({
  cfg,
  tokens,
  trade: tradeDeps,
  prices: () => ledger.snapshot().prices,
  refresh: () => ledger.refresh(),
});

/* How reconcile re-checks a 1Click order by the quote handle a rail recorded. The same client
   the rails hold; only the read is used here, and it never signs. Absent in demo mode, where
   the intents client is not built, so reconcile falls back to the chain. */
const oneClickStatus =
  cfg.mode === 'live'
    ? (handle: string): Promise<OneClickStatus> => oneClickClient().status(handle)
    : undefined;

/* What a deposit floor is worth, for the receive report: 1Click's token list carries a dollar
   price per asset id, and the bridge's rows name the same ids. A fresh client per read, because
   the client caches its list for its lifetime and a price is only good for a while; the report
   itself keeps the answer a minute. Absent in demo mode, where every floor is printed in the
   token's own unit alone. */
const intentsPrices =
  cfg.mode === 'live'
    ? async (): Promise<Map<string, number>> => {
        const prices = new Map<string, number>();
        for (const token of await oneClickClient().tokens()) {
          if (typeof token.price === 'number' && Number.isFinite(token.price) && token.price > 0) prices.set(token.assetId, token.price);
        }
        return prices;
      }
    : undefined;

/* And how it tells a Hyperliquid deposit 1Click calls SUCCESS from one the venue has credited:
   the account's own ledger of credits, read with no key over the same public endpoint the
   wallet panel reads. 1Click's word is the solver's delivery; only this is the money. */
const venueCredited =
  cfg.mode === 'live'
    ? hlDepositCredited({
        credited: (account, sinceMs) => usdcCreditedSince({ keysPath: cfg.keysPath }, account, sinceMs),
        rows: () => store.list(),
      })
    : undefined;

const proposals = createProposalService({
  cfg,
  audit,
  store,
  ledger,
  riskRows,
  rails,
  trade: tradeDeps,
  dataDir: cfg.dataDir,
  oneClickStatus,
  venueCredited,
  vault,
  keystore,
  /* What the chain says about a send's receiver (transaction count, balance, contract or
     not), read once at propose time so the card can say "never used on Ethereum, check it
     twice". Live only: a demo holds nothing and asks nobody. Bounded to eight seconds because
     it runs inside the spend queue, and a chain that will not answer leaves the receiver
     unchecked rather than the send undecided. */
  recipientActivity:
    cfg.mode === 'live'
      ? (network, address) => addressActivity(network, address, { deadline: Date.now() + 8_000 })
      : undefined,
});

/* ASKING for the venues an existing policy.json does not list, rather than adding them.
   The block above will not rewrite somebody's rules, and the consequence was that every install
   predating a venue had rails that were not gated but dead: evaluateRail refuses an unlisted
   counterparty outright. So the app files one proposal, a person clicks it, and the decision
   card carries the exact addresses as a policy diff. It cannot approve itself, because a policy
   change is always needs_approval, and it is deduplicated by content so a second boot does not
   file a second copy. See src/policy/venues.ts.
   Not awaited: it writes one row and the window is what reads it. */
void proposeVenueGap({
  policy: existingPolicy,
  seeded: venues,
  list: () => store.list(),
  propose: (params) => proposals.proposePolicyChange(params),
  audit,
}).catch((err: unknown) => {
  audit.append('error', `could not ask for the missing rail venues: ${err instanceof Error ? err.message : String(err)}`);
});

/* Before the port opens, and before anything renders. A proposal left `executing` by a process
   that is gone is unactionable (requirePending refuses every verb on it) and it holds the 24h
   spend cap for the whole window. It becomes `needs_reconciliation` here: honest about not
   knowing, out of the budget, and re-checkable through POST /api/reconcile. */
const stranded = proposals.reconcileOnBoot();
if (stranded.length > 0) {
  console.error(
    `phosphor: ${stranded.length} proposal(s) were mid-execution when this app last stopped and may or may not have sent. ` +
      `Open the window to re-check them.`,
  );
}

/* And then it asks 1Click about them, so a FAILED deposit refunded at the deadline or a SUCCESS
   the app never saw settles itself instead of waiting for a human to press Reconcile. Once at
   boot, right after the sweep above turns the stranded rows into handled ones, and every ten
   minutes after. Not awaited and never fatal: it reads the venue and writes rows, and a boot
   must not block on a network call. */
const RECONCILE_SWEEP_MS = 10 * 60 * 1000;
function sweepOpenProposals(): void {
  void proposals.reconcileOpen().catch((err: unknown) => {
    audit.append('error', `the scheduled reconcile sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}
sweepOpenProposals();
setInterval(sweepOpenProposals, RECONCILE_SWEEP_MS).unref?.();

/* And a faster tick that asks nothing of anybody: a row past its deadline with nothing having
   changed says so itself. The venue sweep above reads 1Click over the network and runs every
   ten minutes for that reason; this reads the rows already on disk, so it can run often enough
   that "late" appears on the card near the minute it becomes true rather than nine minutes
   after. It writes a stamp and never a verdict: the status underneath is untouched and a later
   credit still settles the row forward. */
/* Demo mode can be told to call a row late in seconds rather than in the ten minutes a real
   move is given, so the stalled card can be looked at without waiting out a real deadline. It
   is the sweep's clock that moves, never DEADLINE_SEC: the shipped table is what a mainnet
   install runs on and nothing here can reach it. Null in every other mode, whatever the
   environment says (src/rails/demo.ts). */
const demoStall = demoStallSweep(cfg);
const STALL_SWEEP_MS = demoStall?.everyMs ?? 30_000;
setInterval(() => {
  try {
    proposals.markStalled(demoStall?.now());
  } catch (err) {
    audit.append('error', `the stall sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}, STALL_SWEEP_MS).unref?.();

// Who is driving, plural. The roster, the roles and the per-member TTL live in
// src/agents.ts; what lives here is the sweep that turns a silent expiry into a line in the
// log and a push to the window.
//
// The heartbeat itself is deliberately absent from the audit log, and the edges stand in
// for it: one agent_connected when an agent attaches, one agent_disconnected when it goes.
// Two lines per session instead of 240 an hour, and the transcript still answers "was an
// agent attached at 19:52".

// The drop is swept for because a killed MCP process has no request to ride on. mcp.ts does
// send a bye on a clean shutdown, so this is the backstop for a SIGKILL rather than the
// normal path, and it runs often enough that the backstop is still fast: the status bar
// used to hold "connected" for up to a minute after an agent was terminated (45s TTL swept
// every 15s, then up to another 15s waiting for an SSE state frame). Every part of that is
// now shorter, and the push below is what closes the last of it.
const AGENT_SWEEP_MS = 2_000;

function getPolicy(): Policy | null {
  return loadPolicy(cfg.dataDir);
}

// Held in memory and mirrored to disk, so a restart does not silently change what the
// human is looking at. Read once on boot rather than per request: the file is the
// durable copy, this is the live one. The record carries who put the window there and
// when, because the agent reads it back: a tab the human clicked is a switch too.
let screen: Screen = readScreen(cfg.dataDir);
function getView(): ViewMode {
  return screen.view;
}
function getScreen(): Screen {
  return screen;
}
function setView(mode: ViewMode, by: ScreenBy): void {
  screen = { view: mode, since: new Date().toISOString(), by };
  writeScreen(cfg.dataDir, screen);
}

// Same shape, same reason: the file is the durable copy and this is the live one, so a
// window that reloads comes back the colour the conversation left it.
let theme: Theme = readTheme(cfg.dataDir);
function getTheme(): Theme {
  return theme;
}
function setTheme(next: Theme): void {
  theme = next;
  writeTheme(cfg.dataDir, next);
}

function setKill(on: boolean): void {
  const p = getPolicy();
  if (p === null) {
    audit.append('error', 'kill toggle ignored: policy file unreadable (writes already refused)');
    return;
  }
  p.killSwitch = on;
  savePolicy(cfg.dataDir, p);
  audit.append('kill_switch', on ? 'kill switch ON: all writes refused' : 'kill switch off');
  /* Anchored now rather than on the next tick of the timer. This is the line somebody goes
     looking for straight after pulling the switch, and what usually follows a kill switch is
     somebody stopping the app in a hurry. */
  audit.flushTip();

  // Stop what is already running, not just what tries to start next.
  //
  // The switch used to be consulted only when a plan armed, so flipping it while a plan held a
  // position refused future proposals and left the plan running: the one situation a kill
  // switch exists for. setKilled stops any fire from now on; stopAll cancels every resting
  // order, closes every position and takes the child out whether or not it answered.
  runner.setKilled(on);
  if (on) void runner.stopAll('kill switch');
}

// ATR per coin, refreshed on a slow timer and served from a cache.
//
// The risk panel asks for this while it renders, and rendering must not wait on a network read.
// Volatility on an hourly bar is also not a number that changes meaningfully inside a minute,
// so a cache costs nothing real and a synchronous read is what the caller actually needs.
// Fourteen periods of hourly bars is the standard Wilder window, which is what the chart draws.
// It comes off the market store, the same cache the chart draws from: there used to be a
// second candle cache and a second venue client behind this one number.
const atrCache = new Map<string, number>();

async function refreshAtr(): Promise<void> {
  for (const product of cfg.candleProducts) {
    try {
      const last = await market.atr(product, 3600, 120, 14);
      if (last !== null) atrCache.set(product.split('-')[0].toUpperCase(), last);
    } catch {
      // A market whose candles will not load keeps whatever it had, and the surface reports
      // the distance in the two units that do not need it. Missing is better than stale-wrong.
    }
  }
}

function atrForCoin(coin: string): number | null {
  return atrCache.get(coin.toUpperCase()) ?? null;
}

void refreshAtr();
setInterval(() => void refreshAtr(), 300_000).unref?.();

// The trading surface. Reads over a websocket rather than a poll, because Hyperliquid's own
// rate-limit guidance is that a chatty /info loop blows the weight budget long before orders do,
// and a trading screen refreshing positions, orders, fills, mark and funding is that loop.
//
// The ATR it uses for the liquidation-distance figure comes from the same indicator engine the
// chart draws with, on purpose. Two implementations of volatility would mean the risk panel and
// the candles could disagree about how much a market moves, and the person would have no way to
// tell which one was lying.
const trade = createTradeService({
  wsUrl: HL_WS_URL,
  user: hlUser,
  info: tradeInfo,
  runner,
  products: cfg.candleProducts,
  atrFor: (coin) => atrForCoin(coin),
  initialSymbol: (cfg.candleProducts[0] ?? 'BTC-USD').split('-')[0],
});
tradeService = trade;

/* Everything on disk, checked against the venue and the proposal store, once the feed has
   answered. A waiting plan re-arms only if its proposal executed with the same hash; placed and
   open rows are read against the venue by cloid. The same path runs on every unlock, because
   a plan whose signing session ended stays waiting, locked, until the key is readable again. */
void runner.reconcile().catch((err: unknown) => {
  audit.append('error', `plan reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
});
keystore.onChange((state) => {
  if (state !== 'unlocked') return;
  void runner.reconcile(1_000).catch((err: unknown) => {
    audit.append('error', `plan reconcile after unlock failed: ${err instanceof Error ? err.message : String(err)}`);
  });
});

/* The window token is read off the shell's pipe far above, beside the boot nonce and the seat
   secret. It is passed in rather than resolved inside createServer because every test in this repo
   builds a server and none of them has a pipe to read. See readHandshake and src/http/auth.ts. */
const server = createServer({
  cfg,
  token: windowTokenValue,
  vault,
  audit,
  store,
  ledger,
  refreshLedger: refreshNow,
  riskRows,
  market,
  proposals,
  getPolicy,
  setKill,
  agents,
  getView,
  getScreen,
  setView,
  getTheme,
  setTheme,
  keystore,
  session,
  trade,
  intentsPrices,
  /* Default OFF, and the window opens with the assistant panel waiting to be started.
     Karim, 2026-08-20: with no agent attached yet, the idle panel is what the app opens on,
     always. (It said "the turning globe" when that was written. ui/screens/agent.js now opens
     with "The globe is gone."; the decision recorded here is about spawning, not the drawing.)
     Spawning a Claude Code process because a window opened was the app making a decision on
     the user's behalf, and paying for it: a session nobody had a question for still holds the
     seat and still spends the subscription. The press is cheap and it is the user's. Anyone
     who wants an agent started for them sets `driver.autostart: true` in config.json. */
  autostart: cfg.driver?.autostart === true,
});

/* Now that there are clients to tell, an automatic lock says so on the wire.
   The `lock` frame itself is not sent from here. The server subscribes to the keystore, so the
   whole-screen answer follows the state change wherever it comes from; this line is the state
   frame that goes behind it, and it goes second on purpose. See createServer. */
announceLock = () => {
  server.broadcastState();
};

/* A plan may wait on a drawn line ("1h close above tl_3"). The lines live in the primary chart's
   drawing store, which the server owns, so the runner is handed a reader here rather than the
   store: it asks for a price at a time and gets one, or null for an id that no longer exists,
   which the watcher reads as "does not hold" and never as "fire". */
runner.onLines((id, t) => {
  const drawn = server.charts.primary.drawings.get(id);
  return drawn?.line ? lineAt(drawn.line, t) : null;
});
session.start();

setInterval(() => {
  // Plural since the roster: one tick can find several members cold at once, and each is its
  // own line in the log because "two agents dropped" is not a sentence anyone can act on.
  const gone = agents.sweep();
  if (gone.length === 0) return;
  for (const member of gone) {
    audit.append('agent_disconnected', `${member.label} stopped sending heartbeats`, {
      client: member.client,
      role: member.role,
      lastSeen: member.lastSeen,
      ttlMs: member.ttlMs,
    });
  }
  // Without this the light stayed on until the next state frame, whatever the TTL said.
  server.broadcastState();
}, AGENT_SWEEP_MS);

// A background fill that lands is worth exactly one SSE frame: the browser is holding the
// previous candles and needs to be told there are better ones, not polled at.
marketUpdated = () => server.broadcastCandles();

// A bar off a venue socket. It goes down the same stream carrying the bar itself, coalesced at
// 120 ms in src/market/push.ts, which is what deleted the browser's hundred-kilobyte refetch.
// The same minute bar feeds the watcher: the runner folds it into the timeframes a plan waits
// on, so a bar close reaches the plan from the socket the chart already holds, not from a poll.
marketLive = (product, baseSec, candle, provider) => {
  server.broadcastCandle(product, baseSec, candle, provider);
  if (baseSec === 60 && provider === 'hyperliquid') runner.onMarket(product.split('-')[0].toUpperCase(), candle);
};

// The feed moving is the only thing that makes the trading surface change without anyone
// touching it, so it is what drives the push. Coalesced by the feed already.
//
// BOTH channels, and the second one is the bug fix. This called broadcastState alone, and the
// trading window does not listen to state: ui/screens/trade.js refetches the position book on
// {type:'trade'} and nothing else. So a fill arriving on the websocket repainted no position,
// no PnL and no health bar. It corrected on the next unrelated 'trade' frame, which in
// practice was the agent's next tool call, which is why the staleness read as "a couple of
// seconds" and was really unbounded: on a quiet agent the book could sit wrong indefinitely.
trade.onUpdate(() => {
  server.broadcastState();
  server.broadcastTrade();
});

/* Registered unconditionally, and this is the change. `armExitGuard` in driver.ts used to hold
   the only signal handlers in the process, and it is called from `start()`, which runs only when
   somebody opens a chat, and `driver.autostart` defaults false. On an ordinary install the
   shell's SIGTERM therefore hit node's default action and the process died wherever it was: mid
   rail, mid write. See src/shutdown.ts for the three steps and why they are in that order. */
installShutdownHandlers({
  audit,
  drain: () => beginDraining(),
  settle: (capMs) => proposals.settle(capMs),
  close: async () => {
    // The runner child holds a key that can place orders. It goes first. The plans stay as they
    // are: the venue holds every placed and open one, and the boot reconcile re-arms the rest.
    await runner.shutdown();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  },
});

/* A port already in use used to be an uncaught exception with a raw stack, and the shell then
   reported the generic "The control app stopped while starting up", naming neither the port nor
   the conflict. It is the single most likely startup failure on this app, because the most
   common cause of it is a second Phosphor. */
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    const msg = `127.0.0.1:${cfg.port} is already in use, so this instance did not start. Another Phosphor is probably already running on that port.`;
    console.error(`phosphor: ${msg}`);
    try {
      audit.append('error', msg, { code: err.code, port: cfg.port });
    } catch {
      // stderr already carries it.
    }
    process.exit(2);
  }
  const msg = `the HTTP server failed: ${err.message}`;
  console.error(`phosphor: ${msg}`);
  try {
    audit.append('error', msg, { code: err.code ?? null });
  } catch {
    // as above
  }
  process.exit(2);
});

server.listen(cfg.port, '127.0.0.1', () => {
  audit.append('app_start', `phosphor up on http://127.0.0.1:${cfg.port} (${cfg.mode} mode)`);
  console.log(`phosphor: http://127.0.0.1:${cfg.port} (${cfg.mode} mode)`);
  // Say where the signing key is read from and what state it is in, every boot. The path only,
  // never a byte of the key. "I don't know where my private key is" should not survive a single
  // startup. `npm run keys:where` prints the same, with permissions, on demand.
  const lockState = keystore.state();
  console.log(`phosphor: wallet ${lockState} at ${lockState === 'needs_migration' ? cfg.keysPath : keystore.path()}`);
  audit.append('app_start', `wallet ${lockState}`, { state: lockState });

  // The chain walk, now that there is a window to report it in. See AUDIT_VERIFY_DELAY_MS.
  const chainTimer = setTimeout(checkAuditChain, AUDIT_VERIFY_DELAY_MS);
  setInterval(checkAuditChain, AUDIT_REVERIFY_MS).unref();
  // Never a reason on its own for this process to stay up.
  chainTimer.unref?.();
});

// Ledger refresh loop. Demo mode is static between writes but the refresh also
// re-marks chain staleness in live mode.
//
// The old shape was a bare 30s interval that did not tell anyone it had finished, so a
// balance that changed waited up to 30s to be read and then up to another 15s for the SSE
// heartbeat to mention it: 45s worst case to see money that had already arrived. The read
// now pushes as soon as it lands, and the poll is the floor rather than the mechanism.
// The period lives with the ledger, because the wallet report's idea of "too old" is two of it.
const REFRESH_IDLE_MS = REFRESH_PERIOD_MS;

// Two refreshes at once would be two sets of RPC calls racing to write the same snapshot,
// and the loser's answer is the older one. A caller arriving mid-flight joins the read
// already running instead of starting a second. This is THE seam: the deposit watch gets it
// through createServer (refreshLedger) rather than refreshing the ledger on its own, which
// is how a 3 s watch loop and this 15 s loop used to race each other into a flashing warning.
let refreshing: Promise<void> | null = null;

/* THE GUARD IS ARMED BEFORE THE READ, not after it. `refreshing = ledger.refresh()...` assigns
   only once refresh() has returned, and a refresh is not always asynchronous: demo mode tells
   its listeners inside the call. One of those listeners settles a proposal, settling writes an
   audit line, and the subscriber below turns an `executed` line back into a refresh, which
   arrived here while `refreshing` was still null and started another pass. 820 settles of one
   deposit in 103 ms, and the app answered nothing for thirteen seconds at the moment the money
   landed. */
function refreshNow(): Promise<void> {
  if (refreshing !== null) return refreshing;
  let finished: () => void = () => {};
  refreshing = new Promise<void>(resolve => {
    finished = resolve;
  });
  void ledger
    .refresh()
    .then(() => {
      server.broadcastState();
    })
    .catch(() => undefined)
    .finally(() => {
      refreshing = null;
      finished();
    });
  return refreshing;
}

void refreshNow();
setInterval(() => {
  void refreshNow();
}, REFRESH_IDLE_MS);

// The moment money actually moves, read it back rather than waiting out the poll. This is
// what makes a deposit or a swap show up as soon as it settles: the rails already announce
// themselves on the audit log, so this needs no new seam and no rail has to remember to
// call it. An intents deposit is exactly the case that used to look broken, because the
// funds leave the wallet immediately and the balance that replaces them is one the app
// only learns about on a refresh.
audit.subscribe(event => {
  if (event.type === 'executed') void refreshNow();
});
