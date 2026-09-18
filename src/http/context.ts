// The context object the whole HTTP surface hangs off.
//
// server.ts used to be one createServer closure over about thirty mutable bindings, which is
// why it could not be split by moving functions alone: a moved function loses its reads. So
// the bindings became this object, every handler became a free function taking it, and
// createServer shrank to assembling the Ctx and wiring the router.
//
// Ctx is ServerDeps plus the things the server itself owns: the per-boot approval token, the
// SSE hub, the chat registry, the chart and drawing stores, the team board, the lazy worker
// crew, the bounded audit tail the basic screen reads, and the small mutable holders (theme,
// prices, gas fill, the duplicate guard, the seat-refusal log) that used to be `let` bindings
// inside the closure.

import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AppConfig, ChainId, LogEvent, Policy, ProposalService, RiskRow, Screen, ScreenBy, ViewMode } from '../types.ts';
import type { PriceReading } from '../view/basic.ts';
import type { Audit } from '../audit.ts';
import type { Store } from '../store.ts';
import type { Ledger } from '../ledger/index.ts';
import type { Candle } from '../types.ts';
import type { MarketData } from '../market/index.ts';
import type { TradeService } from '../trade/service.ts';
import type { Driver, DriverEvent } from '../driver.ts';
import type { AgentPresence } from '../agents.ts';
import type { createChartStore } from '../chart.ts';
import type { ChartSlots } from '../charts.ts';
import type { SnapshotBroker } from '../snapshot.ts';
import type { CustomIndicators } from '../indicators-custom/loader.ts';
import type { Theme } from '../view/theme.ts';
import type { DrawingStore } from '../drawings.ts';
import type { Board } from '../board.ts';
import type { Crew } from '../crew.ts';
import type { DuplicateGuard } from '../duplicates.ts';
import type { Keystore, LockState } from '../keystore/index.ts';
import type { Session } from '../keystore/session.ts';
import type { VaultRelay } from '../vault/relay.ts';
import type { IntentsReceiveReport } from './wallet.ts';
import type { VaultPrefs } from '../vault/prefs.ts';
import type { Terms } from '../terms.ts';
import type { DepositWatch } from '../vault/watch.ts';
import type { JsonBody } from './respond.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_DIR = path.join(__dirname, '..', '..');

export const LOG_LIMIT_MAX = 2000;
export const CANDLE_LIMIT_MAX = 5000; // one page of history: what the deep venue answers in one call

// How far back the basic screen's "what the assistant did" list is willing to look for
// five distinct sentences. Runs collapse, so an assistant that read the wallet two
// hundred times in a row still fills one line, and past this it shows fewer lines rather
// than reading further: the list is a glance, not the log.
export const BASIC_EVENT_SCAN = 300;

export const SCAN_TIMEFRAMES_MAX = 6;

export const CHAINS: readonly string[] = ['eth', 'base', 'arb', 'sol', 'near'];
// Display only: this feeds the "unknown propose kind" error message and gates nothing, so a
// kind missing here is a misleading error rather than a dead tool. Keep it in step with the
// if-chain in the propose handler anyway, since the message is how a caller finds the typo.
export const PROPOSE_KINDS: readonly string[] = [
  'policy_change',
  'swap',
  'hl_deposit',
  'hl_withdraw',
  // One door kind for two rail kinds: `where` picks intents_send or intents_pay in the builder.
  'send',
  // Two door kinds for one rail kind: a plan, and a change to one that is armed.
  'trade',
  'trade_change',
];
export const READ_TOOLS: readonly string[] = [
  // The handshake presentation: the banner a connecting agent prints, the live facts it
  // prints beside it, and the index of everything it can do. A read like any other, so it
  // joins the roster and gets audited exactly as every other call does.
  'start',
  'composition',
  'wallet',
  // Where money comes IN. Opens the deposit card in the window for one asset on one network and
  // hands the agent a fingerprint of the address, never the address. It moves nothing.
  'deposit',
  'policy_show',
  'log_tail',
  'proposal_status',
  'chart_read',
  'chart_scan',
  // A picture of one chart, rendered by the window and handed to the one call waiting for it.
  // A read: it moves nothing and draws nothing.
  'chart_snapshot',
  'chart_batch',
  'market_search',
  // The first tool that leaves this machine. It is a read like the others because that is all it
  // is: the APP fetches from a fixed allowlist and hands back text. The agent never gets a URL
  // it can point anywhere, which is the whole reason this is a Phosphor tool and not WebFetch.
  'research',
  'trade_read',
  'trade_batch',
  // The team. Reading who else is here, what they have said, and what the workers found.
  // Reads like every other: audited, and they move nothing.
  'agent_roster',
  'agent_board',
  'agent_jobs',
  // Public chain data: an address, its transactions, one transaction, an account's intents
  // ledger. Reads that leave the machine the way research does: fixed hosts, a closed network
  // enum, an address or hash that passes its shape before a URL exists, answers that are data.
  'chain_address',
  'chain_transactions',
  'chain_transaction',
  'intents_activity',
];
// Chart writes. They move no money, so they never reach the proposal path and never wait on
// an approval. They are still audited like every other op: an agent that can change what the
// human sees while that human approves a transfer is a surface, not a decoration.
// View tools a worker never gets. The proxy withholds their registration (src/mcp.ts
// registerLeadView) and src/http/view.ts refuses them by seat role, so a worker cannot draw on
// the chart a human is reading, arrange it, put an idea on it, recolour the window, or write into
// the operator's next role text.
export const LEAD_ONLY_VIEW_TOOLS: readonly string[] = ['set_theme', 'chart_draw', 'chart_layout', 'trade_plan', 'profile_learned', 'agent_spawn'];
// The one read a worker never gets: a picture is the window the human is reading, and the proxy
// withholds it the same way (src/mcp.ts registerLeadView). src/http/mcp.ts refuses it by seat role.
export const LEAD_ONLY_READ_TOOLS: readonly string[] = ['chart_snapshot'];

export const VIEW_TOOLS: readonly string[] = [
  // Colour. A write like the rest of this list: it changes what the human sees and moves no
  // money. The one thing it cannot reach is the approval gate's red, which is not a slot.
  'set_theme',
  // The chart's one write: view, indicators (presets included), levels, marks, lines and zones
  // in one call, answered with a digest. Ten tools used to do this one call each.
  'chart_draw',
  // Up to four charts side by side. See src/charts.ts.
  'chart_layout',
  // The team's two writes. A post is one line on a board every agent and the human read; a
  // spawn starts a worker. Neither moves money, both are audited, and both are here rather
  // than on the propose path for exactly that reason.
  'agent_post',
  'agent_spawn',
  // The trading surface's writes. Same category as the chart's: they change what is drawn and
  // what is pointed at, and none of them places, cancels or sizes anything. The verbs that do
  // move a position are on /api/trade/action, which this door does not open onto.
  'trade_focus',
  'trade_highlight',
  'trade_overlay',
  'trade_clear',
  // A plan drawn as an idea. It has no authority and no policy: arming it is propose_trade.
  'trade_plan',
  // The knowledge profile's one write: a concept the agent just taught, appended to the file
  // the next role text is built from. No money, no approval, audited, ten per session.
  'profile_learned',
];
// Human-only controls on the trading window. Each one only ever reduces exposure, which is why
// none of them waits on an approval and none is reachable from the agent's door.
export const TRADE_ACTIONS: readonly string[] = ['cancel', 'close', 'flatten'];

export type ServerDeps = {
  cfg: AppConfig;
  /* The window token, read off the first line of stdin by src/main.ts. Optional because every
     test in this repo builds a server and has no pipe to read one from; absent falls back to
     windowToken(), which is the environment or a minted one. The app always passes it, which is
     what keeps the token out of an environment any process can print. */
  token?: string;
  /* The enclave relay, built by src/main.ts from the shell's handshake. Optional for the same
     reason the token is: a test server has no shell. Absent means a relay with no transport key,
     which answers every ask with no_relay and leaves the wallet on the password path. */
  vault?: VaultRelay;
  /* Where money comes in: the bridge's deposit addresses for this wallet's account. Optional so
     a test can answer without the network; the app reads the bridge. */
  intentsReceive?: () => Promise<IntentsReceiveReport>;
  /* The 1Click price list as assetId -> dollars, so the receive report can say what a floor is
     worth. Optional because a test has no 1Click and demo mode builds no client; absent, every
     floor is printed in the token's own unit alone. A throw here never fails the report. */
  intentsPrices?: () => Promise<Map<string, number>>;
  audit: Audit;
  store: Store;
  ledger: Ledger;
  /* The one refresh seam, refreshNow in src/main.ts: joins a read already in flight instead of
     starting a second, and broadcasts state when it lands. The deposit watch calls it when
     money is credited. Optional because every test in this repo builds a server without
     main.ts; absent, the watch refreshes the ledger itself and broadcasts. */
  refreshLedger?: () => Promise<void>;
  riskRows: RiskRow[];
  market: MarketData;
  proposals: ProposalService;
  getPolicy: () => Policy | null;
  setKill: (on: boolean) => void;
  // Who is driving, and the one-at-a-time rule. See src/agents.ts.
  agents: AgentPresence;
  getView: () => ViewMode;
  setView: (mode: ViewMode, by: ScreenBy) => void;
  /* The screen record behind getView: the same view, plus who put the window there and when.
     Optional for the same reason the theme pair below is: a test that stands a server up with a
     bare getView/setView pair gets a record kept in this process. src/main.ts always passes the
     persisting one. */
  getScreen?: () => Screen;
  // The window's colours. Same contract as the view mode above: held in memory by the
  // caller, mirrored to disk there, read live here.
  //
  // Optional so a test can stand a server up without a data directory. Absent, the pair
  // below holds the theme in this process only, which is exactly what a test wants and
  // exactly what the app must not do: src/main.ts always passes the persisting pair.
  getTheme?: () => Theme;
  setTheme?: (theme: Theme) => void;
  trade: TradeService;
  /* The keys and the lock over them. Optional so a test can stand a server up without one;
     createServer then builds a keystore over cfg.keysPath, which reads that path and writes
     nothing until a wallet route is called. src/main.ts always passes the one it installed as
     the process keystore, so the app has exactly one. */
  keystore?: Keystore;
  /* The lock's clock and the signing sessions. Optional for the same reason: a test that
     brings none gets one that locks nothing, because it also brought no keystore to lock. */
  session?: Session;
  /* Start the in-app agent when the port opens. OPT IN, and deliberately not read from cfg
     here: every test in this repo builds a server and listens on it, and a flag that defaulted
     to on would have each of them spawn a real Claude Code process. main.ts is the one caller
     that passes it, and it is the one caller that is an app. */
  autostart?: boolean;
  /* Injected only so a test can drive the start paths without a real Claude Code process
     appearing on the machine. main.ts never passes it, and nothing here can loosen the
     lockdown through it: the tool surface is fixed in operator/driver.settings.json and
     checked again at runtime inside src/driver.ts. */
  makeDriver?: () => Driver;
};

// http.Server plus an explicit push so the wiring layer can signal the UI after
// a ledger refresh, which no store or audit subscription would otherwise catch.
// broadcastTrade is on this surface because the venue feed is the one thing that changes the
// trading window without anyone touching the app, and until it was exported the feed could
// only reach the window through broadcastState, which the trading page does not listen to.
export type PhosphorServer = http.Server & {
  broadcastState(): void;
  // The contentless nudge, which the REST fallback still sends: a fill landed, come and look.
  broadcastCandles(): void;
  // A bar off a venue socket, carrying the bar. Coalesced in src/market/push.ts, and the reason
  // the browser stopped refetching a hundred kilobytes of JSON to move one close.
  broadcastCandle(product: string, baseSec: number, candle: Candle, provider: string): void;
  broadcastTrade(): void;
  // The chart slots, so the entrypoint can hand the runner a reader for drawn lines without
  // the server importing the runner or the runner importing the server.
  charts: ChartSlots;
};

export type ChartStore = ReturnType<typeof createChartStore>;

// One open conversation with the window's own agent: a Claude Code child, its label on the
// roster, and the transcript a reloading window comes back to. See the seats note in chats.ts.
export type Chat = {
  id: string;
  label: string;
  driver: Driver;
  transcript: Array<DriverEvent & { at: number }>;
};

// Everything the SSE fan-out owns: the client set, every broadcast, the heartbeat and the
// candle push timer. Implemented by createSseHub in sse.ts.
export type SseHub = {
  // One frame to every open client. The driver's per-chat events are the only caller
  // outside this hub, because they are the one frame that carries a body.
  broadcast(payload: unknown): void;
  clientCount(): number;
  broadcastState(): void;
  broadcastTransactions(): void;
  // Which proposal moved. The object rides in GET /api/state.proposals[].view; this is the push.
  broadcastProposal(id: string): void;
  // Which chart moved. The window redraws one slot rather than all four; 0 is the primary.
  broadcastChart(slot?: number): void;
  // Ask the window for a picture of one chart. It answers on POST /api/chart/snapshot with the
  // request id, and the broker hands the image to the tool call waiting on that id.
  broadcastSnapshot(slot: number, reqId: string): void;
  broadcastTrade(): void;
  broadcastActivity(): void;
  broadcastCandles(): void;
  broadcastLock(state: LockState): void;
  open(req: http.IncomingMessage, res: http.ServerResponse): void;
  stop(): void;
};

// The window's conversations. Implemented by createChatRegistry in chats.ts.
export type ChatRegistry = {
  size(): number;
  all(): Chat[];
  byId(id: unknown): Chat | null;
  primary(): Chat;
  event(chat: Chat, event: DriverEvent): void;
  start(how: 'human' | 'app'): string | null;
  open(): { ok: true; chat: Chat } | { ok: false; error: string };
  close(chat: Chat): void;
  payload(): Record<string, unknown>;
  stopAll(): void;
};

// The window's colours, resolved. ServerDeps carries the pair as optional so a test can stand
// a server up without a data directory; this is the resolved pair every handler reads.
export type ThemeSlot = { get(): Theme; set(theme: Theme): void };

// The three prices the basic screen tracks. Mutable because the assistant can be asked for a
// different coin, and both halves have to change together: a reading left under a new coin's
// name is a price for the wrong asset.
export type PriceCache = { coins: string[]; readings: PriceReading[] };

/* ServerDeps minus the optional theme pair, because `theme` below is the resolved one and a
   handler reading ctx.getTheme() would crash on the install that did not pass it. The screen
   record is resolved the same way. */
export type Ctx = Omit<ServerDeps, 'getTheme' | 'setTheme' | 'getScreen' | 'keystore' | 'session'> & {
  token: string;
  getScreen: () => Screen;
  keystore: Keystore;
  // The idle clock and the signing sessions. See src/keystore/session.ts.
  session: Session;
  vault: VaultRelay;
  intentsReceive: () => Promise<IntentsReceiveReport>;
  // What the window remembers about the vault that is not a key: backed up, idle minutes.
  vaultPrefs: VaultPrefs;
  // Whether the person has accepted the terms of use at their current version. See src/terms.ts.
  terms: Terms;
  // The deposit watcher: one address at a time, until landed or a day.
  deposits: DepositWatch;
  /* Re-decide everything an agent proposed while the wallet was locked. Wired by the server
     rather than imported, because the proposal service is what knows how to land a proposal
     and the HTTP layer only knows when to ask. Returns how many were released. */
  releaseQueued: () => Promise<number>;
  theme: ThemeSlot;
  sse: SseHub;
  chats: ChatRegistry;
  // Slot 0 of `charts`, kept under its old names so every call site that predates slots still
  // reaches the primary. See src/charts.ts.
  chart: ChartStore;
  drawings: DrawingStore;
  charts: ChartSlots;
  // The snapshot broker: one outstanding picture per chart, a TTL, nothing stored.
  snapshots: SnapshotBroker;
  // The human's own indicators, compiled from <dataDir>/indicators. Optional because the
  // tests that build a Ctx by hand predate it; see src/indicators-custom/loader.ts.
  customIndicators?: CustomIndicators;
  board: Board;
  crew: () => Crew;
  // The bounded audit tail the basic screen's activity list reads. Seeded once at
  // construction and appended by the audit subscription, because audit.tail() re-reads the
  // whole append-only file and buildState runs on every broadcast and every heartbeat.
  recent: LogEvent[];
  // The lazily built crew, when one exists. `crew()` above makes one; this reads what is
  // already there without resolving the claude binary on an install that never spawned one.
  crewIfAny: () => Crew | null;
  prices: PriceCache;
  duplicates: DuplicateGuard;
  // One audit line per refused session or client, then silence. See firstRefusal in mcp.ts.
  seats: Set<string>;
};

// One read tool: it answers on `res` and moves nothing. `body` carries the calling session and
// `args` the tool's own arguments, already unwrapped, because every handler wanted both.
export type ReadTable = Record<
  string,
  (ctx: Ctx, body: JsonBody, args: JsonBody, res: http.ServerResponse) => void | Promise<void>
>;

export type { ChainId };
