// One door to Hyperliquid's /info endpoint, for every reader in the process.
//
// This exists because of a specific failure. Hyperliquid's testnet went to ~16 seconds per
// call while the runner's feed polled every 2 seconds. Nothing in the poller bounded a
// request, so eight of them stacked per symbol, the venue started refusing, and an armed
// mandate sat there logging `fetch failed` and never seeing a book. The venue being slow was
// not the bug. A poller that answers a slow venue by asking harder is the bug.
//
// Three properties, each one of the three things that were missing:
//
//   TIMEOUT   every request carries an AbortSignal. A hung socket fails in bounded time with
//             a sentence that says how long it waited, instead of holding a slot forever.
//   DEDUPE    identical requests already in flight share one promise. This is what turns a
//             pile-up back into a queue: eight polls for the same book become one question.
//             In-flight only, never a cache: see below.
//   BACKOFF   after a run of failures the client fails fast without spending a request, so a
//             venue that is refusing is not hammered into refusing harder. One success clears
//             it, because a single flake should not cost a second of blindness.
//
// Deliberately NOT a response cache. Holding a mark price for even a second means the runner
// could size an order against a price the venue has already moved past, and a stale price that
// arrives fast is more dangerous than a fresh price that arrives slow. Sharing an in-flight
// promise has no such hazard: every joiner gets an answer that was current when it asked.

export type InfoHealth = {
  ok: boolean;
  consecutiveFailures: number;
  lastError: string | null;
  lastLatencyMs: number | null;
  backoffUntilMs: number | null;
};

export type InfoDeps = {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  backoffMs?: number;
  failuresBeforeBackoff?: number;
};

export type InfoClient = {
  post<T>(body: unknown): Promise<T>;
  health(): InfoHealth;
};

// Long enough that a merely slow venue still answers, short enough that a wedged socket does
// not outlive the poll interval it was fired from.
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_BACKOFF_MS = 5000;
const DEFAULT_FAILURES_BEFORE_BACKOFF = 3;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createInfoClient(deps: InfoDeps): InfoClient {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const backoffMs = deps.backoffMs ?? DEFAULT_BACKOFF_MS;
  const failuresBeforeBackoff = deps.failuresBeforeBackoff ?? DEFAULT_FAILURES_BEFORE_BACKOFF;

  const inFlight = new Map<string, Promise<unknown>>();
  let consecutiveFailures = 0;
  let lastError: string | null = null;
  let lastLatencyMs: number | null = null;
  let backoffUntilMs: number | null = null;

  async function send<T>(key: string, body: unknown): Promise<T> {
    const started = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${deps.baseUrl}/info`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: key,
        signal: controller.signal,
      });
      if (!res.ok) {
        // The body is included because the venue puts the actual reason there. A bare 422 is
        // unactionable; "422 Failed to deserialize" names the mistake.
        throw new Error(`hyperliquid /info ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const value = (await res.json()) as T;
      consecutiveFailures = 0;
      lastError = null;
      backoffUntilMs = null;
      lastLatencyMs = now() - started;
      return value;
    } catch (err) {
      // An abort is reported as a timeout rather than as whatever the runtime called it,
      // because "aborted" reads like someone cancelled it and nobody did.
      const aborted = controller.signal.aborted;
      const message = aborted ? `hyperliquid /info timed out after ${timeoutMs}ms` : errText(err);
      consecutiveFailures += 1;
      lastError = message;
      lastLatencyMs = now() - started;
      if (consecutiveFailures >= failuresBeforeBackoff) backoffUntilMs = now() + backoffMs;
      throw new Error(message);
    } finally {
      clearTimeout(timer);
      inFlight.delete(key);
      void body;
    }
  }

  return {
    post<T>(body: unknown): Promise<T> {
      if (backoffUntilMs !== null && now() < backoffUntilMs) {
        const left = Math.round((backoffUntilMs - now()) / 100) / 10;
        return Promise.reject(
          new Error(
            `hyperliquid /info backing off for ${left}s after ${consecutiveFailures} failures: ${lastError ?? 'unknown'}`,
          ),
        );
      }
      // The serialised body IS the identity of the request, which makes dedupe exact rather
      // than a guess at which fields matter.
      const key = JSON.stringify(body);
      const existing = inFlight.get(key);
      if (existing !== undefined) return existing as Promise<T>;
      const started = send<T>(key, body);
      inFlight.set(key, started);
      return started;
    },

    health: () => ({
      ok: consecutiveFailures === 0,
      consecutiveFailures,
      lastError,
      lastLatencyMs,
      backoffUntilMs,
    }),
  };
}
