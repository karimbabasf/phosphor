# Phosphor UI contract

What the window (`ui/`) and the backend (`src/`) actually exchange, on branch `fix/window-never-opens`,
read from the code on 2026-09-07. Every claim carries a `file:line`. Facts only: where the window and
the server disagree, section 12 says so rather than picking a side.

The window is vanilla JavaScript. There is no framework, no build step and no module system. Every
file is a classic script loaded in order by `ui/index.html:73-99`, assigns one `window.Phosphor*`
namespace, and does nothing until `ui/app.js` boots it. `ui/chart/chart.js`, `ui/chart/trade-overlay.js`
and `ui/split.js` are the exception: they are top-level scripts whose `var` and `function` declarations
become bare globals.

---

## 1. Static serving

### What is served, and from where

`src/http/router.ts:125` is the only static branch. It is the fallback after every `/api/` path has
been tried, and it runs for `GET` and `HEAD` only (`src/http/router.ts:114`). Anything under `/api/`
that is not in the route table answers 404 before reaching it (`src/http/router.ts:120`).

`serveStatic` (`src/http/respond.ts:158-195`) resolves the request path against one root:

```
const UI_DIR = path.join(__dirname, '..', '..', 'ui');   // src/http/respond.ts:18
```

`__dirname` is the directory of the running `src/http/respond.ts`, so the root is the **working tree's
`ui/`**, not a copy under `src-tauri/payload`. No path in `src/` mentions a payload directory. The
files are read from disk on every request, deliberately, so an edit shows up on reload
(`src/http/respond.ts:183-184`).

`/` rewrites to `/index.html` (`src/http/respond.ts:161`). Traversal is refused: the resolved target
must be `UI_DIR` itself or start with `UI_DIR + path.sep` (`src/http/respond.ts:167`), and a path that
fails `decodeURIComponent` is a 404 (`src/http/respond.ts:162-164`).

### Extension allowlist

Only four extensions are served. Anything else is 404 even if the file exists
(`src/http/respond.ts:26-31, 171-175`):

| Extension | `content-type` |
|---|---|
| `.html` | `text/html; charset=utf-8` |
| `.js` | `text/javascript; charset=utf-8` |
| `.css` | `text/css; charset=utf-8` |
| `.woff2` | `font/woff2` |

`.svg`, `.png`, `.json`, `.map` and `.ico` are not on the list. The favicon is therefore an inline
`data:image/svg+xml` URI in the document (`ui/index.html:8`) rather than a file.

### Headers on every static response

`src/http/respond.ts:187-193`:

| Header | Value |
|---|---|
| `content-type` | from the table above |
| `content-length` | byte length of the file |
| `cache-control` | `public, max-age=31536000, immutable` for `font/woff2`; `no-store` for everything else (`src/http/respond.ts:186`) |
| `x-phosphor` | `control` (the constants are `IDENTITY_HEADER` / `IDENTITY_VALUE`, `src/http/respond.ts:155-156`) |
| `content-security-policy` | HTML responses only (`src/http/respond.ts:192`) |

### The handshake header

`x-phosphor: control` is sent on **every** static response, not only the document
(`src/http/respond.ts:191`). The Tauri shell polls the port and opens the window only once it sees it
(`src/http/respond.ts:148-154`); `src-tauri/src/backend.rs` reads it. It replaced a match on the page's
`<title>`, which made a cosmetic retitle a 45-second boot failure. It is a fixed word rather than the
version so a bump cannot break a boot (`src/http/respond.ts:153-154`). `tests/unit/shell-handshake.test.ts`
holds the two halves together.

### CSP

Sent on HTML only, joined with `; ` (`src/http/respond.ts:135-146`):

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none';
frame-ancestors 'none'
```

Consequences a rewrite must respect:

- **No inline `<script>`.** `script-src 'self'` carries no `'unsafe-inline'`. Every script in
  `ui/index.html:73-99` is a `src`. The shell's token injection is a webview initialization script,
  not a tag in the document, so it needs no exemption (`src/http/respond.ts:129-131`).
- **Inline `style` attributes are allowed** (`'unsafe-inline'` on `style-src`), and the window uses
  them: `ui/screens/basic.js:271-275`, `ui/screens/pro.js:226`, `ui/screens/moneyin.js:251-252`.
- **`img-src 'self' data:`** is what lets the `data:` favicon load (`ui/index.html:8`).
- **`connect-src 'self'`** confines `fetch` and `EventSource` to the app's own origin.
- **No external font, script or style host is reachable.** `font-src 'self'` means the two `woff2`
  files must be served from `ui/`.

### Fonts

Two variable fonts, preloaded from the document with `crossorigin`
(`ui/index.html:10-11`):

```
./fonts/Geist-Variable.woff2
./fonts/GeistMono-Variable.woff2
```

They are named in the token stacks at `ui/design/tokens.css:43-44`:

```css
--font-ui:   "Geist", ui-sans-serif, system-ui, sans-serif;
--font-mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
```

The `@font-face` rules themselves live in `ui/design/type.css`, which the document loads at
`ui/index.html:15`. Fonts are the only asset with a real cache header
(`public, max-age=31536000, immutable`, `src/http/respond.ts:186`), so a font refetch does not re-run
the swap on every window boot.

### Stylesheets, in load order

`ui/index.html:13-18`: `design/tokens.css`, `design/reset.css`, `design/type.css`,
`design/components.css`, `design/layout.css`, `design/screens.css`.

### Host gate, before any route

`src/http/router.ts:110-113` refuses a forged `Host` with `403 request refused: this app answers
only on 127.0.0.1`. `hostIsLocal` (`src/http/auth.ts:172-177`) accepts `127.0.0.1`, `localhost`, and
an absent `Host` (an HTTP/1.0 client, which a browser cannot be). This is what closes DNS rebinding
for the read routes, which carry no `Origin`.

---

## 2. The window token

### How the page gets it

`ui/core/net.js:29-31`:

```js
var token = typeof window.__PHOSPHOR_TOKEN__ === 'string' ? window.__PHOSPHOR_TOKEN__ : '';
var devToken = new URLSearchParams(window.location.search).get('token');
if (devToken) token = devToken;
```

Two sources, in this precedence: `?token=` in the query string wins over the injected global.

`window.__PHOSPHOR_TOKEN__` is set by the Tauri shell as a webview initialization script, before any
document script runs (`src/http/respond.ts:122-123`, `ui/core/net.js:19-22`). The token is minted
outside the backend process and arrives on the backend's **stdin**, first line
(`src/http/auth.ts:64-85`). It is served by no route: `GET /api/session` was deleted, and that is
what stops another local process from reading it and approving (`src/http/auth.ts:6-9`).

`PHOSPHOR_WINDOW_TOKEN` is retired. It survives as an exported constant (`src/http/auth.ts:37`) only so
a test can assert it is not set: `ps eww <pid>` prints any process's environment to the same user, which
is the attacker this app is built against (`src/http/auth.ts:11-17`).

### The dev-mode case (`npm run app`, no shell)

A bare run has nobody to pipe a token, so `readWindowToken` mints one and prints it once to stderr
(`src/http/auth.ts:81-84, 125-129`):

```
phosphor: no window token arrived on stdin, so this boot minted one: <hex>
```

A process started **by the shell** (`PHOSPHOR_APP_DATA=1`) that receives no token throws and refuses
to boot rather than minting a second one (`src/http/auth.ts:74-79`).

In a browser pointed at a bare dev backend, `window.__PHOSPHOR_TOKEN__` is undefined, so `token` is
`''` until `?token=<the stderr value>` is supplied. With an empty token every write route answers
403 and every read route still works. `ui/core/net.js:24-28` names this as the only reason `?token=`
exists.

### Window API

`ui/core/net.js:196-208` exports `getToken()`, `ensureToken()` (a resolved promise, kept for callers
written against the old fetch, `ui/core/net.js:37-41`) and `setToken(value)`.

`ui/app.js:13-15` copies the value onto a bare `window.TOKEN` global because
`ui/chart/chart.js:1920` reads `TOKEN` directly for its own POST.

### Which routes need it, and in which field

The token always travels in the **JSON body** as `token`. There is no header form.
`ui/core/net.js:158-168` adds it to every `postJson` unless `options.token === false`:

```js
if (opts.token !== false && !payload.token) payload.token = value;
```

No caller in `ui/` passes `token: false`.

Every POST route checks it, plus a same-origin check:

| Route | Guard | Refusal |
|---|---|---|
| `/api/approve`, `/api/refuse`, `/api/kill`, `/api/yield/withdraw`, `/api/driver`, `/api/reconcile` | `src/http/mutation.ts:64-94` | 403 `{ error: 'invalid approval token' }` |
| `/api/unlock`, `/api/lock`, `/api/activity`, `/api/wallet/create`, `/api/wallet/import`, `/api/wallet/migrate`, `/api/wallet/reveal`, `/api/wallet/export` | `guarded`, `src/http/wallet.ts:47-76` | 403 `{ error: 'the window token is missing or wrong' }` or `'cross-origin request'` |
| `/api/chart` (POST) | `src/http/chart.ts:272-273` | 403 `{ error: 'invalid approval token' }` |
| `/api/trade` (POST) | `src/http/trade.ts:69-70` | 403 `{ error: 'invalid approval token' }` |
| `/api/trade/action` | `src/http/trade.ts:21-28` | 403 `{ error: 'invalid approval token' }` |

Two writes bypass `ui/core/net.js` and build the body themselves:

- `ui/activity.js:25-28` posts `{ token }` to `/api/activity` with a bare `fetch`, and returns early
  when the token is empty (`ui/activity.js:22-23`).
- `ui/chart/chart.js:1919-1932` posts `{ token, view, geometry }` to `/api/chart` with a bare `fetch`.

`GET` routes need no token. `GET /api/wallet/reveal/<nonce>` is authorised by the nonce plus the
fetch-metadata check in `revealSameOrigin` (`src/http/wallet.ts:369-375`).

### The comparison

`tokenMatches` (`src/http/auth.ts:149-154`) SHA-256s both sides before `timingSafeEqual`, so the
comparison is constant length as well as constant time and the token length does not leak. A refusal
logs the token's 12-hex-character fingerprint, never the token (`src/http/auth.ts:160-162`,
`src/http/mutation.ts:81-91`).

### Same-origin

`sameOrigin` (`src/http/auth.ts:195-201`) requires a **present** `Origin` equal to `http://<host>`.
It refuses the literal string `null` (an opaque origin from a sandboxed iframe) and refuses an absent
`Origin` (a local process posting with none). This is why `GET /api/wallet/reveal/<nonce>` cannot use
it: a browser sends no `Origin` on a same-origin GET (`src/http/wallet.ts:355-357`).

---

## 3. HTTP routes the window uses

### The fetch layer

`ui/core/net.js` is the only fetch path for everything except `ui/activity.js` and
`ui/chart/chart.js`.

`getJson(path, options)` (`ui/core/net.js:105-139`):
- Resolves `{ data, fresh, status }`. `fresh` is `false` on a 304, so a renderer can skip work.
- Holds an ETag per path and sends `if-none-match` unless `options.noCache` (`ui/core/net.js:111`).
- Dedups in-flight requests by path (`ui/core/net.js:108, 137`), so an SSE burst does not fan out.
- Ten-second timeout (`ui/core/net.js:10, 115`).
- On a non-OK status, throws an `Error` whose `.message` is the body's `error` field when the body
  parses as JSON, else the raw text, and whose `.status` is the HTTP status
  (`ui/core/net.js:141-151`).

`postJson(path, body, options)` (`ui/core/net.js:155-177`): thirty-second timeout, adds the token,
sends `content-type: application/json`, throws the same shaped error on non-OK, returns `{}` on an
empty or unparseable body.

`readable(err, nothingLeft)` (`ui/core/net.js:181-189`) turns a throw into a sentence, and appends
`" Nothing left your wallet."` when the caller passes `true`.

`busy(key, label)` (`ui/core/net.js:49-64`) is a refcounted spinner contract; `onBusy(fn)` subscribes.

Content type is a security boundary, not a formality: `readBody` refuses anything but
`application/json` with 415, reading no body at all (`src/http/respond.ts:205-218`). The three types a
browser can post cross-origin without a preflight are all excluded, and the app answers no CORS
headers, so a cross-origin post never arrives. The body cap is 1 MB, answered 413
(`src/http/respond.ts:20, 224-227`).

### The single error shape

`fail(res, status, message, extra?)` (`src/http/respond.ts:85-88`) is the one door every refusal goes
through:

```json
{ "error": "<a sentence>", ...extra }
```

`error` is always first and always non-empty; an empty message becomes
`'the request was refused and no reason was recorded'`. Two responses on `/api/trade/action`
deliberately do not use it and are marked TRACK B in the source (`src/http/trade.ts:52-56`).

The custody routes are the other exception: a refusal there is **HTTP 200** with
`{ ok: false, error: <sentence>, code: <machine code>, retryInSec? }` (`src/http/wallet.ts:88-115`).
The status stays 200 because these are answers the window renders into its own screen, and a 4xx would
send it down the network-failure path.

---

### `GET /api/state`

Called by `ui/screens/shell.js:230` through `api.state` (`ui/core/api.js:30-32`). The only route with
conditional caching: `sendJsonConditional` (`src/http/respond.ts:104-120`) sends a SHA-1 ETag and
answers 304 with no body when `if-none-match` matches. `cache-control` is `no-store` on both paths, so
the browser's own HTTP cache never holds a wallet balance; the conditional request is driven by an ETag
the page holds in memory and loses on reload.

Built by `buildState` (`src/http/state.ts:36-146`), synchronously. Every top-level key:

| Key | Type | Notes |
|---|---|---|
| `ledger` | `LedgerSnapshot` | `src/http/state.ts:61`. Not read by any screen. |
| `wallet` | `WalletView` | `src/http/state.ts:64`. See below. |
| `composition` | `CompositionView` | `src/http/state.ts:65`. Kept for the policy engine's `byIssuer` and `freezableShare`; no screen reads it. |
| `policy` | `Policy \| null` | `src/http/state.ts:66`. |
| `gate` | `{ required: true, banner: null }` | `src/http/state.ts:68`. Unconditional; in the payload so the window states it rather than assuming it. No screen reads it. |
| `lock` | `{ state, idleLocksInSec, addresses }` | `src/http/state.ts:72-76`. |
| `sentences` | `string[]` | `src/http/state.ts:77`, built by `sentencesOf` (`src/http/state.ts:20-34`). |
| `proposals` | `Proposal[]` | `src/http/state.ts:78`. |
| `mode` | `'live' \| 'demo'` | `src/http/state.ts:79`. |
| `dailyLimit` | `{ capUsd, spentUsd, resetsAt } \| null` | `src/http/state.ts:88`. |
| `agents` | object | `src/http/state.ts:93-117`. See below. |
| `candleProducts` | `string[]` | `src/http/state.ts:118`. |
| `yield` | `YieldView \| null` | `src/http/state.ts:124`. |
| `view` | `'basic' \| 'pro' \| 'trade'` | `src/http/state.ts:125`. |
| `theme` | `Theme` | `src/http/state.ts:128`. |
| `basic` | `BasicView` | `src/http/state.ts:132-144`. |

**`lock`** (`src/http/state.ts:72-76`):

```
state:          'unlocked' | 'locked' | 'no_wallet' | 'needs_migration'
idleLocksInSec: number | null
addresses:      { evm, solana, near, nearPublicKey }, each string | null
```

`StoredAddresses` is at `src/keystore/store.ts:75`. Consumed by `ui/screens/shell.js:246-259`
(the lock chip), `ui/screens/lock.js:24-43` (the lock and migration screens) and
`ui/screens/shell.js:96` (the pattern field's intensity). `addresses` is not read by any screen; the
window gets addresses from `/api/receive` instead.

**`dailyLimit`** (`src/proposals/lifecycle.ts:345, 353-366`):

```
capUsd:   number      // policy.outbound.maxPerSessionUsd
spentUsd: number      // executed + executing in the last 24h, excluding policy_change
resetsAt: string|null // ISO, when the oldest counted spend leaves the window; null when nothing counted
```

Rolling 24 hours, not midnight. `needs_reconciliation` is deliberately excluded from the cap
(`src/proposals/lifecycle.ts:347-351`). Rendered by `ui/screens/pro.js:277-299`.

**`gate`** is always `{ required: true, banner: null }`.

**`proposals`** — each `Proposal` (`src/types.ts:445-470`):

```
id, kind, createdAt, status, draft, simulation, verdict,
decidedBy?: 'human'|'policy', decidedAt?, result?: { ok, detail, txids? },
balances?: { beforeUsd: number, afterUsd: number|null }
```

`ProposalStatus` (`src/types.ts:424-439`): `pending`, `pending_unlock`, `approved`, `refused`,
`executing`, `needs_reconciliation`, `executed`, `failed`, `policy_refused`. Statuses are set at
`src/proposals/lifecycle.ts:208, 239, 250, 253, 298, 332`.

`simulation` is `SimulationResult | null` (`src/types.ts:409-422`): `{ ok, summary, depositAddresses?,
postComposition?, policyDiff?: { before, after }, error? }`. The decision card additionally reads
`simulation.feeUsd`, `gasUsd`, `priceImpact`, `amountOut` and `destinations`
(`ui/screens/decision.js:201-202, 312-319, 341-348`), which are not on the declared type.

**`view`** — the server owns which window is up. `ui/app.js:26-28` follows it unless the window is
pinned by `?view=`.

**`theme`** — `Record<'accent'|'background'|'up'|'down'|'agent', string>`
(`src/view/theme.ts:31-33`), each a `#rgb` or `#rrggbb` hex. Applied by `ui/theme.js:73-142`.

**`wallet`** (`src/types.ts:132-141`):

```
rows:       WalletRow[]      // value descending, only things actually held
totalUsd:   number
byChain:    Record<string, number>
stale:      WalletPlace[]    // places whose last read failed; never silently zero
emptyCount: number
```

`WalletRow` (`src/types.ts:103-131`): `{ kind: 'token'|'lp'|'intents'|'yield', chain, symbol, tokenId,
quantity, priceUsd, valueUsd, share, native, lp?, intents?: { accountId, assetId },
yield?: { venue, receiptSymbol, receipt, principalUsd, earnedUsd } }`.
Rendered by `ui/screens/pro.js:149-215`.

**`yield`** — `YieldView` (`src/yield/allocator.ts:49-66`):

```
chain, positions[], venues[], totalPrincipalUsd, totalValueUsd, totalEarnedUsd,
basisUnknown, best: { chain, apy } | null, autoAllocate, lastTickAt, decisions[], stale, error
```

**`basic`** — `BasicView` (`src/types.ts:563-589`):

```
tone: 'calm'|'asking'|'working'|'stopped'|'frozen'|'broken'
totalUsd: number | null          // never 0 as a stand-in
totalLine, placesLine, headline, agentLine, footer: string
ask: BasicAsk | null
warning: string | null
holdings: BasicHolding[]         // { name, quantityLine, valueLine, valueUsd, share }
prices: BasicPrice[]
recent: BasicRecent[]
actions: BasicAction[]
earning: string | null
```

`ui/screens/basic.js:204-257` reads `totalLine`, `headline`, `placesLine`, `footer`, `warning`,
`holdings` and `earning`. It reads no other key.

**`agents`** (`src/http/state.ts:93-117`):

```
connected:      boolean
holder:         the lead member
members:        [{ session, label, client, role, parent, since, ops }]
capacity:       number
workers:        [{ id, label, state }]
board:          last 12 posts
lastActivityAt: timestamp
```

Every string in this block is agent-authored and is rendered as text, never markup. No screen reads
`state.agents`; the assistant panel reads `/api/driver` instead.

---

### `GET /api/driver`

`src/http/router.ts:60`, answered by `driverPayload` (`src/http/chats.ts:199-213`). Called via
`api.driverState()` with `noCache: true` (`ui/core/api.js:34-36`), from `ui/screens/agent.js:407`.

```
{ state, sessionId, running,        // the first chat's flat fields
  chats: [{ id, label, state, sessionId, running, transcript: DriverEvent[] }],
  max: 4 }
```

With nothing open the list holds one placeholder that does not exist yet:
`{ id: '', label: 'AGENT 1', state: 'off', sessionId: '', running: false, transcript: [] }`
(`src/http/chats.ts:206-208`). The app must be able to serve the window without spawning an agent, so
answering here must not create one.

`ui/screens/agent.js:409-414` reads `data.state` and `data.chats[0].transcript`.

### `POST /api/driver`

`src/http/mutation.ts:96-207`. Body always carries `token`, and every action except `connection` and
`open` carries `chat` (naming a chat that is not open is refused 404, `src/http/mutation.ts:134-137`;
an empty or absent `chat` falls back to the oldest open one, `src/http/mutation.ts:138`).

| `action` | Extra body | Response |
|---|---|---|
| `connection` | none | `{ command: 'claude mcp add phosphor -- node <abs>/src/mcp.ts', connected: [{ name, role, calls }] }` (`src/http/mutation.ts:107-116`) |
| `open` | none | `{ ok: true, id, label, state, sessionId, running }`; 409 with a sentence when 4 chats are already open (`src/http/mutation.ts:120-129`) |
| `start` | `chat` | `{ ok: true, dropped: string\|null, id, state, sessionId, running }`. On the sole chat it evicts the whole roster first (`src/http/mutation.ts:141-156`) |
| `close` | `chat` | `{ ok: true, id }` (`src/http/mutation.ts:158-161`) |
| `prompt` | `chat`, `text` | `{ ok: true, id, state, sessionId, running }`. 400 when text is empty or over 8000 characters; 409 when the driver refuses to take it (`src/http/mutation.ts:163-178`) |
| `interrupt` | `chat` | `{ ok: true, id, interrupted: boolean, state, sessionId, running }` (`src/http/mutation.ts:185-197`) |
| `stop` | `chat` | `{ ok: true, id, state, sessionId, running }` (`src/http/mutation.ts:199-204`) |
| anything else | | 400 `{ error: 'unknown driver action: <x>' }` (`src/http/mutation.ts:206`) |

`status()` is `{ state, sessionId, running }` (`src/driver.ts:623`).

Window callers: `ui/screens/agent.js:219` (`prompt`, with `chat: ''`), `:251` (`start`),
`:263` (`interrupt` and `stop`), `ui/screens/firstrun.js:374` (`start`),
`ui/core/api.js:76-80` (`connection`, wrapped so a 404 or any throw becomes `{ missing: true }` and
never an error the person cannot act on).

`interrupt` deliberately emits no extra driver event: `interrupt()` sets the state itself and its own
status event is already on the way, and pushing a second one printed the line twice
(`src/http/mutation.ts:187-189`).

---

### `POST /api/approve` and `POST /api/refuse`

`src/http/router.ts:80-81`, both through `handleMutation`. Body `{ token, id }`; `id` is required
(400 `{ error: 'id is required' }`, `src/http/mutation.ts:248-251`). The response is the whole updated
`Proposal` (`src/http/mutation.ts:269-271`); on a throw, 400 with the error text
(`src/http/mutation.ts:272-274`). Both broadcast `state` over SSE.

Called from `ui/screens/decision.js:274-275` (as `api.approve` / `api.refuse` passed to `decide`) and
`ui/screens/decision.js:246`. Both are declared with a `busy` key of `'decision'`
(`ui/core/api.js:42-48`).

### `POST /api/kill`

Body `{ token, on: boolean }` (`on` is `body.on === true`, so anything else is false).
Response `{ ok: true, killSwitch: boolean }` (`src/http/mutation.ts:235-246`). Audited as
`kill_switch`. Called from `ui/screens/shell.js:293` and `ui/screens/basic.js:136`, both behind a
`PhosphorConfirm.ask` (`ui/screens/shell.js:277-286`, `ui/screens/basic.js:128-134`).

### `POST /api/reconcile`

Body `{ token, id }`. Response `{ ok: true, status, detail: string|null, id }`
(`src/http/mutation.ts:256-265`). Re-checks a `needs_reconciliation` proposal against the chain. It
decides nothing and signs nothing; it carries the token because it changes a row a human is reading.
Called from `ui/screens/receipt.js:79`.

### `POST /api/yield/withdraw`

Body `{ token, chain }`. `chain` must be `eth`, `base` or `arb`, else
400 `{ error: "chain must be one of eth, base, arb; got '<x>'" }` (`src/http/mutation.ts:220-223`).
On success it files a `yield_withdraw` proposal and returns the whole `Proposal`
(`src/http/mutation.ts:226-228`). No amount is accepted from the request: omitting it means the whole
position (`src/http/mutation.ts:217-219`).

Called from `ui/screens/basic.js:294` and `ui/screens/pro.js:263`, **both as `api.yieldWithdraw({})`**
with no chain. See section 12.

---

### `POST /api/unlock`

Body `{ token, password }`. Always HTTP 200 (`src/http/wallet.ts:147-162`).

```
{ ok: true, released: <what releaseQueued returned> }
{ ok: false, error: '<sentence>', code: 'wrong_password'|'no_wallet'|'locked_out'|'damaged', retryInSec? }
```

An empty password short-circuits to the `wrong_password` refusal without touching the keystore
(`src/http/wallet.ts:151`). One unlock is in flight at a time and a second caller is handed the first
one's answer, because a disabled button is a courtesy and not a control
(`src/http/wallet.ts:119-128, 153`). The request does not return until every proposal queued behind the
lock has been re-decided, which is a rail apiece and can take a minute
(`src/http/wallet.ts:141-144`).

Called from `ui/screens/lock.js:103`. The window maps `code` to its own sentence at
`ui/screens/lock.js:135-146` because it can say it better in context.

### `POST /api/lock`

Body `{ token, reason? }`. Response `{ ok: true }` (`src/http/wallet.ts:164-171`). **No screen calls
it**; it is declared at `ui/core/api.js:95-97` and unused.

### `POST /api/activity`

Body `{ token }`. Response `{ ok: true, idleLocksInSec }` (`src/http/wallet.ts:176-181`).

This is the **only** thing that pushes the auto-lock out. The timer lives in
`src/keystore/session.ts` and is fed by nothing else, deliberately: if any request refreshed it, an
assistant reading balances every two seconds would hold a funded wallet open all night
(`ui/activity.js:1-13`, `src/http/wallet.ts:173-175`).

`ui/activity.js:35-55` listens for `pointermove`, `pointerdown`, `keydown`, `wheel` and `touchstart`,
posts at most once every 30 seconds (`ui/activity.js:17, 41`), stops while `document.hidden`
(`ui/activity.js:40`), and posts immediately on `visibilitychange` back to visible
(`ui/activity.js:51-53`) and once at start (`ui/activity.js:54`). A failed beacon is swallowed
(`ui/activity.js:29-32`). Started from `ui/app.js:33-35` with `PhosphorNet.getToken` as the getter.

### `POST /api/wallet/create`

Body `{ token, password }`, minimum 8 characters else 400
(`src/http/wallet.ts:35, 78-81, 189`). Response
`{ ok: true, mnemonic: string[], addresses: { evm, solana, near, nearPublicKey } }`
(`src/http/wallet.ts:198`). The words come back exactly once and are never served again; they live in
the page's memory until the flow ends (`ui/screens/firstrun.js:165-168`). Called from
`ui/screens/firstrun.js:158`.

### `POST /api/wallet/import`

Body `{ token, password, mnemonic?: string, keys?: { evm?, solana?, near? } }`. One of `mnemonic` or
`keys` is required else 400 `bring twelve words or at least one private key`
(`src/http/wallet.ts:216`). A bad phrase is refused with `mnemonicProblem`'s own sentence
(`src/http/wallet.ts:211-214`). Response `{ ok: true, addresses }` (`src/http/wallet.ts:225`).
Called from `ui/screens/firstrun.js:273` as `{ password, mnemonic: words.join(' ') }`.

### `POST /api/wallet/migrate`

Body `{ token, password }`. Refused outright in demo mode with 403 before the password is looked at,
because migrating destroys a plaintext key file (`src/http/wallet.ts:239-241`). Response:

```
{ ok: true, destroyed: string[], addresses, note: 'Overwritten and deleted. A Time Machine or
  APFS snapshot taken before now may still hold a copy, so move to a fresh wallet later if that
  matters.' }
```

(`src/http/wallet.ts:252-259`.) Called from `ui/screens/lock.js:211`; the window renders its own
version of the snapshot caveat at `ui/screens/lock.js:242-245` and ignores `note`.

### `POST /api/wallet/reveal` then `GET /api/wallet/reveal/<nonce>`

Two halves on purpose. The POST proves the password and hands back a nonce and no material; the GET
spends that nonce once, so an unattended unlocked window is not a key dump and a reveal cannot be
replayed out of a log (`ui/core/api.js:119-122`, `src/http/wallet.ts:297-303`).

POST body `{ token, password, what: 'mnemonic'|'keys' }` (anything but `'keys'` reads as
`'mnemonic'`, `src/http/wallet.ts:307`). Response `{ ok: true, nonce, expiresInSec: 30 }`
(`src/http/wallet.ts:39, 352`), or a 200 refusal with `code` `wrong_password`, `no_wallet` or
`no_mnemonic`. The password is checked against the file rather than against the fact that the wallet
happens to be open (`src/http/wallet.ts:311-312`). This route **does** unlock, and announces it, and
releases the queue in the background rather than awaiting it, because the nonce dies in thirty seconds
(`src/http/wallet.ts:318-336`).

GET response (`src/http/wallet.ts:388-400`):

```
{ ok: true, what: 'mnemonic', mnemonic: string[] }
{ ok: true, what: 'keys', keys: { evm: string|null, solana: string|null, near: string|null } }
```

Failures: 403 cross-origin, 404 spent or never issued, 410 expired, 409 the wallet locked before the
reveal was read (`src/http/wallet.ts:378-385`). The nonce is deleted on sight, before anything can go
wrong further down (`src/http/wallet.ts:382`).

`ui/core/api.js:128-131` calls it with `noCache: true` and unwraps `result.data`. Called from
`ui/screens/moneyin.js:105-108`. Only `'mnemonic'` is ever asked for
(`ui/screens/moneyin.js:90`); `showMaterial` can render `'keys'` (`ui/screens/moneyin.js:143-151`) but
nothing reaches it.

### `POST /api/wallet/export`

Body `{ token, password, path }`. `path` must be absolute else 400
(`src/http/wallet.ts:271`). The password **verifies** rather than unlocks: writing a backup is not a
reason to open a wallet (`src/http/wallet.ts:272-285`). Response `{ ok: true, path }`, or a 200
refusal. Called from `ui/screens/moneyin.js:172`; the target comes from the password dialog's extra
field (`ui/screens/moneyin.js:167, 170`).

### `GET /api/receive`

No token. Works while locked, deliberately: money arriving is the one thing a person should never have
to unlock for, and the addresses come from the keystore's plaintext header
(`src/http/router.ts:61-63`, `src/http/wallet.ts:413-414`).

```
{ chains: [{ id, name, address, warning }], state: <keystore state> }
```

`id` and `name` are drawn from a fixed table of five (`src/http/wallet.ts:405-411`): `eth`/Ethereum,
`base`/Base, `arb`/Arbitrum (all three sharing the EVM address), `sol`/Solana, `near`/NEAR. A chain
whose address is null is filtered out (`src/http/wallet.ts:417`).

Called via `api.receive()` with `noCache: true` (`ui/core/api.js:111-113`) from
`ui/screens/moneyin.js:20`, which caches the answer for the life of the page
(`ui/screens/moneyin.js:14-29`). `state` is not read.

### `GET /api/receipts?limit=`

No token. `limit` defaults to 25 and is capped at 200 (`src/http/receipts.ts:22-23, 101`).
Response `{ receipts: Receipt[] }` (`src/http/receipts.ts:102`), each (`src/http/receipts.ts:27-45`):

```
id, kind, at, summary,
fromChain, toChain,
amount:   number | null,   // null when the size is not an amount of a token
symbol:   string | null,
feesUsd:  number | null,   // venue fee + gas read back so far; null is not zero
txids:    [{ chain, hash, url: string|null }],
balanceBefore: number | null,
balanceAfter:  number | null,
status: 'executed' | 'failed' | 'needs_reconciliation'
```

`executing` is never a receipt status: a card for an action still in flight would be a receipt for
something that has not happened (`src/http/receipts.ts:47-55`). Gas is filled in behind the response
by the same background reader the history uses (`src/http/router.ts:71`), which is why a receipt read a
second later shows a larger fee.

Called from `ui/screens/receipts.js:45` with a hard-coded limit of 25.

### `GET /api/transactions`

No token. `{ entries: TxEntry[], gasPending: number }` (`src/http/state.ts:155-170`). Declared at
`ui/core/api.js:58-60` and **called by no screen**.

### `GET /api/chart`

No token. `chartPayload` (`src/http/chart.ts:184-236`):

```
rev, lastDriver: 'agent'|'human', view,
candles: [{ t, o, h, l, c, v }],
meta: { source, stale, built, fetchedAt, filling, feed: 'live'|'delayed'|'offline', note, error },
indicators: [{ id, type, label, pane, source, plots, guides, range, state }],
levels, marks, drawings, agentObjects, products, timeframes, limits
```

The render path never awaits: it reads memory and any refill happens behind it, announced over SSE
(`src/http/chart.ts:98-105, 186-188`). `meta.error` is set only when there are no candles and none are
being fetched (`src/http/chart.ts:194-197`); the browser writes its own fetch failures into the same
field (`ui/chart/chart.js:1785`).

`api.chart` is declared at `ui/core/api.js:62-64` and **called by no screen**. The chart engine fetches
it directly at `ui/chart/chart.js:1780`, applies it in `applyChart` (`ui/chart/chart.js:1822-1894`),
and has its own 15-second floor timer (`ui/chart/chart.js:2617-2620`).

### `POST /api/chart`

Built and sent by `ui/chart/chart.js:1917-1958`, never through `ui/core/api.js`:

```json
{ "token": "<or null>",
  "view": { "product", "provider", "granularitySec", "barCount", "panOffset",
            "priceScale": "auto|manual", "priceLow": "?", "priceHigh": "?" },
  "geometry": { "width", "height", "plotWidth", "priceHeight", "pxPerBar", "panes", "dropped",
                "reportedAt" } }
```

Optional extra keys merged in by the caller (`ui/chart/chart.js:1933-1935`): `addIndicator`,
`removeIndicator`, `clear`.

Response `{ ok: true, rev, view, notes: string[] }` (`src/http/chart.ts:306`), or 400 with a
sentence from `resolveViewPatch` / `setView` / `addIndicator`
(`src/http/chart.ts:282, 284, 291, 296, 300`). The window applies the returned view rather than
refetching, because a refresh it fired itself can land before the write does and snap the gesture back
(`src/http/chart.ts:303-305`, `ui/chart/chart.js:1946-1948`).

The write is debounced 150 ms (`ui/chart/chart.js:1913-1914`) and is suppressed entirely until the
first server payload has landed (`CHART_READY`, `ui/chart/chart.js:1912`): without that guard, the
canvas getting its initial size pushed the file's literal default of 1m/120 bars and silently reverted
an agent's change (`ui/chart/chart.js:1900-1911`).

`geometry` is what the renderer can actually show, reported so an agent can tell whether what it asked
for is readable (`ui/chart/chart.js:1972-1991`).

### `GET /api/candles`

No token. `?product=` (default `cfg.candleProducts[0]` then `BTC-USD`), `?granularity=` (default 60,
max 86400), `?limit=` (default 120, capped at `CANDLE_LIMIT_MAX`)
(`src/http/chart.ts:142-145`). The body is a bare `Candle[]`; the staleness markers ride in headers so
the body shape stays exactly what the contract names (`src/http/chart.ts:148-159`):
`x-candle-source`, `x-candle-stale`, `x-candle-fetched-at`, `x-candle-built`. A throw is 502.

**Not called by the window.** Nothing in `ui/` references `/api/candles`.

### `GET /api/trade`

No token. `ctx.trade.payload()` (`src/http/router.ts:59`, `src/trade/service.ts:159-171`).
`TradePayload` (`src/trade/state.ts:177-244`):

```
rev, lastDriver, symbol,
overlays: Record<OverlayName, boolean>,
highlights, note, noteSource,
venue:   { connected, source: 'ws'|'rest'|'none', ageMs, latencyMs, error, degraded },
account: { equityUsd, marginUsedUsd, freeUsd, maintenanceUsd, withdrawableUsd, crossLeverage,
           healthPct, unified, accountKnown, netNotionalUsd, grossNotionalUsd,
           equityAtFivePctAdverse },
collateral: { address, perpUsd, spotUsdcUsd, funded, funding },
markets:   Market[],     // { coin, markPx, oraclePx, midPx, fundingRateHourly, openInterestUsd,
                         //   volume24hUsd, premiumPct, atr, szDecimals, maxLeverage, assetId }
positions: Position[],   // { coin, side, sizeCoin, notionalUsd, entryPx, markPx, liqPx,
                         //   unrealisedUsd, roePct, leverage, leverageType, marginUsedUsd,
                         //   fundingPaidUsd, liqReachable, liqDistancePct, liqDistanceUsd,
                         //   liqDistanceAtr, pnlPriceUsd, pnlFundingUsd, pnlNetUsd }
orders:    Order[],      // { oid, cloid, coin, side, kind, role, px, triggerPx, sizeCoin,
                         //   notionalUsd, reduceOnly, tif, atMs, mandateId }
fills:     Fill[],       // { tid, coin, side, px, sizeCoin, notionalUsd, feeUsd, closedPnlUsd,
                         //   atMs, tSec, liquidation, mandateId }
mandates:  MandateRow[], // { id, symbol, armed, running, since, expiresAt, programHash, english[],
                         //   envelope: { maxNotionalUsd, maxLeverage, maxOrdersPerMin, maxLossUsd,
                         //   allowedActions }, used: { notionalUsd, lossUsd, ordersLastMin,
                         //   msToExpiry }, projected: {...} }
products: string[]
```

Types at `src/trade/state.ts:62-77` (Market), `:79-106` (Position), `:108-123` (Order),
`:125-138` (Fill), `:140-` (MandateRow).

Called from `ui/screens/trade.js:209`, which caches the payload in a module-level `data` and also
assigns it to the bare global `window.TRADE` before rendering, because the overlay projection reads
that and nothing else (`ui/screens/trade.js:214-216`).

### `POST /api/trade`

Body `{ token, focus?, overlay?, note?, clear? }` (`src/http/trade.ts:65-96`). Response
`{ ok: true, notes: string[] }`; a refusal from any of the three setters is 400 with its sentence. A
`focus` also moves the chart onto the matching product and broadcasts `chart`
(`src/http/trade.ts:89-94`). **Not called by the window.**

### `POST /api/trade/action`

Body `{ token, action, id?, coin? }`. `action` must be in `TRADE_ACTIONS` else 400 naming the known
list (`src/http/trade.ts:30-33`). The two failure bodies are the only ones on this surface that do not
go through `fail()` (`src/http/trade.ts:52-56`):

```
200  result                                  (on success)
400  { ...result, error: result.detail }     (the venue's own fields beside the sentence)
500  { ok: false, detail }                   (no `error` key at all)
```

Deliberately not reachable from `/api/mcp`: the agent has no verb for closing a position, and the way
that is guaranteed is that the door it knocks on does not open onto this function
(`src/http/trade.ts:3-5, 14-16`). `api.tradeAction` is declared at `ui/core/api.js:70-72` and
**called by no screen**.

### `GET /api/gas`

No token. `?window=` must be `24h`, `7d`, `30d` or `all`, default `7d`; anything else is a 400 rather
than a 200 carrying an error field, because the window renders whatever body it is handed and an error
object with a success status draws as a report of zero gas
(`src/http/router.ts:55-58`, `src/http/state.ts:208-219`). **Not called by the window.**

### `GET /api/log`

No token. `?limit=` default 200, capped at `LOG_LIMIT_MAX`. Returns the audit tail as an array
(`src/http/router.ts:45-46`). **Not called by the window.**

### `GET /api/health`

No token, no secret, and deliberately the only unauthenticated proof of life
(`src/http/router.ts:65-66`, `src/http/health.ts:1-12`). Response (`src/http/health.ts:22-35, 74-88`):

```
{ ok: true, version, killSwitch, pending, locked, auditChain, lastError: string|null, uptimeSec }
```

`killSwitch` fails closed: an unreadable policy reads as the switch being ON
(`src/http/health.ts:58`). `locked` is narrowly `state === 'locked'`, so `needs_migration` and
`no_wallet` are both false here and `/api/state`'s `lock.state` is the four-way answer
(`src/http/health.ts:79-84`). `auditChain` is what the boot-time chain walk found, held for the life of
the process; a poll that re-walked a 10 MB history would be its own denial of service
(`src/http/health.ts:28-32, 37-44`). A store or policy throw becomes the answer rather than a 500
(`src/http/health.ts:46-72`).

`api.health()` is declared with `noCache: true` and deliberately outside the busy contract: a spinner
on the one call that answers "is the app there" would be reporting on itself
(`ui/core/api.js:84-89`). Called only from the shell's health poll (`ui/screens/shell.js:209`), which
runs **only while the SSE stream is down**, every 10 seconds
(`ui/screens/shell.js:185-217`). The window reads `health.lastError` and nothing else
(`ui/screens/shell.js:212`).

### Draining

Every POST is refused with 503 while the process is shutting down; reads keep answering so the window
still renders (`src/http/router.ts:128-133`):

```
Phosphor is shutting down, so nothing new can be written. Start it again and retry.
```

---

## 4. SSE: `GET /api/events`

`src/http/router.ts:64`, opened by `src/http/sse.ts:182-196`. Response headers:
`content-type: text/event-stream; charset=utf-8`, `cache-control: no-store`,
`connection: keep-alive`. The first line written is `retry: 2000`
(`src/http/sse.ts:188`).

Every frame is `data: <json>\n\n` with no event name, so the client uses `onmessage`
(`src/http/sse.ts:54`, `ui/core/events.js:115`). A client whose write buffer exceeds 1 MiB is dropped
and destroyed rather than buffered without bound (`src/http/sse.ts:21, 49-53`).

**Frames carry a type and, on three of them, a revision or an event. Nothing else.** The browser
refetches on the signal, so a frame that grew would silently become a second copy of the truth
travelling down a different pipe (`src/http/sse.ts:4-6`).

### Every frame type

| Frame | Emitted by | Cadence | Consumed by |
|---|---|---|---|
| `{ type: 'state' }` | `broadcastState` `src/http/sse.ts:66-79`; heartbeat `:177-180` | Leading edge then a trailing sweep, capped at one per 120 ms; plus an unconditional heartbeat every 15000 ms | `ui/screens/shell.js:174` calls `refresh({})` |
| `{ type: 'lock', state }` | `broadcastLock` `src/http/sse.ts:86-88` | On every custody change (`announce`, `src/http/wallet.ts:83-86`) | `ui/screens/shell.js:176-181` merges it into `store.lock` directly |
| `{ type: 'transactions' }` | `broadcastTransactions` `src/http/sse.ts:93-95`; also on every store change `:133-136`; also when gas lands `src/http/state.ts:188` | Event-driven | **Nothing.** No `events.on('transactions')` exists |
| `{ type: 'chart', rev }` | `broadcastChart` `src/http/sse.ts:100-102` | Event-driven | `ui/screens/trade.js:53-55` calls `window.chartPushed(frame.rev)` |
| `{ type: 'trade', rev }` | `broadcastTrade` `src/http/sse.ts:107-109` | Event-driven | `ui/screens/trade.js:31` calls `refresh()` |
| `{ type: 'activity' }` | `broadcastActivity` `src/http/sse.ts:117-130` | Coalesced at 120 ms | **Nothing.** No `events.on('activity')` exists |
| `{ type: 'log', event }` | audit subscription `src/http/sse.ts:143-147` | One per audit line | **Nothing.** No `events.on('log')` exists |
| `{ type: 'candles' }` | `broadcastCandles` `src/http/sse.ts:158-165`, timer `:166-175` | 250 ms, and only while the live rail is quiet (`candlesQuiet()`) and at least one client is attached | `ui/screens/trade.js:47-49` calls `window.candlesPushed()` |
| `{ type: 'candle', product, provider, baseSec, candle: { t,o,h,l,c,v } }` | `createCandlePush` via `hub.broadcast` (`src/server.ts:82`, `src/market/push.ts:25-31`) | Coalesced at 120 ms, newest bar per series wins | `ui/screens/trade.js:50-52` calls `window.candleLive(frame)` |
| `{ type: 'driver', chat, event }` | `driverEvent` `src/http/chats.ts:79` | One per driver event | `ui/screens/agent.js:393-405` |

`STATE_DEBOUNCE_MS = 120`, `HEARTBEAT_MS = 15000`, `CANDLE_PUSH_MS = 250` (`src/http/sse.ts:16-18`).
The candle timer is skipped entirely while a venue socket is pushing bars: that refetch is exactly what
the delta frame exists to delete (`src/http/sse.ts:166-174`).

**There is no `user`, `text`, `interrupt` or `control_request` SSE frame.** Those four names are the
Claude Code stdin protocol inside `src/driver.ts:478, 497` and never reach the browser.

### The client

`ui/core/events.js` opens exactly one `EventSource` for the whole window
(`ui/core/events.js:101-141`). It exposes `start()`, `on(type, handler)`, `onConnection(fn)` and
`state()` (`ui/core/events.js:147-152`).

Connection states: `connecting`, `reconnecting`, `live`, `stale`, `offline`
(`ui/core/events.js:12, 103, 110, 129`, `:46`).

Two synthetic events fan out beside the server's: `'*'` fires for every frame
(`ui/core/events.js:125`), and `'reattach'` fires on an `onopen` that follows a drop
(`ui/core/events.js:107, 112`). `ui/screens/shell.js:175` refetches state on `reattach`.

The watchdog is the important half. The server sends a state frame every 15 seconds whether or not
anything moved, so silence is information: a killed backend can leave the socket open-but-dead with
`EventSource` staying quiet, which looks exactly like a stream with nothing to report
(`ui/core/events.js:16-29`). After `SILENCE_MS = 30000` (`ui/core/events.js:30-31`) the client moves
to `stale`, **tears the socket down and reopens it**, and the health poll finds out whether the app is
gone (`ui/core/events.js:40-55`). The watchdog itself ticks every 5000 ms.

`onerror` moves to `offline`, closes the source, and retries with a backoff of 1000 to 8000 ms rather
than the browser's own invisible unbounded retry (`ui/core/events.js:128-140`).

### Driver events

`DriverEvent` (`src/driver.ts:47-54`):

```
{ kind: 'status',      state: DriverState, detail?: string }
{ kind: 'said',        text: string }
{ kind: 'text',        text: string }
{ kind: 'tool',        name: string, input: unknown }
{ kind: 'tool_result', name: string, ok: boolean }
{ kind: 'turn_end',    error: boolean, turns: number }
{ kind: 'error',       message: string }
```

`DriverState` (`src/driver.ts:56`): `off`, `starting`, `ready`, `thinking`, `stopped`, `failed`.

Every event is also pushed onto the chat's transcript, capped at 400, with an `at` timestamp added
(`src/http/chats.ts:67-70`). The frame is tagged with the chat id, always: an untagged event was fine
when there was one conversation and would print into whichever one the human happened to be looking at
(`src/http/chats.ts:77-79`).

### How `ui/screens/agent.js` maps them

`ui/screens/agent.js:393-405`:

- `status` sets the phase through `mapState(event.state)` and takes `event.detail` as the note. It is
  **not** pushed to the transcript.
- `tool_result` is dropped entirely (`ui/screens/agent.js:400`).
- `text` and `tool` promote a `connected` phase to `working` before being pushed
  (`ui/screens/agent.js:401-403`).
- Everything else, `said`, `turn_end` and `error` included, is pushed unchanged.

`mapState` (`ui/screens/agent.js:384-390`) collapses six server states into five panel phases:

| Server state | Panel phase | Chip word (`ui/screens/agent.js:87-93`) |
|---|---|---|
| `off`, or missing | `idle` | Not started |
| `starting` (also the string `booting`) | `starting` | Starting |
| `thinking` (also the string `working`) | `working` | Working |
| `failed` (also the string `error`) | `error` | Could not start |
| `ready`, `stopped`, anything else | `connected` | Connected |

Transcript rendering (`ui/screens/agent.js:351-380`) keys rows by `index + ':' + kind` and writes a
`who` and a `text` cell:

| `kind` | who | text |
|---|---|---|
| `said` | `you` | `event.text` |
| `text` | `assistant` | `event.text` |
| `tool` | `▪` | `toolLabel(event.name)` |
| `error` | `stopped` | `event.message` |
| `boot`, `status` | empty | `event.text \|\| event.detail \|\| ''` |
| anything else | untouched | untouched |

`toolLabel` (`ui/screens/agent.js:75-79`) strips an `mcp__phosphor__` prefix and looks the id up in
`TOOL_PHRASES` (`ui/screens/agent.js:19-68`). The lookup uses `typeof phrase === 'string'`, not
truthiness, because the id arrives from a language model and a plain-object lookup hands back
`Object.prototype`'s own members for ids like `constructor` (`ui/screens/agent.js:72-74`).

The transcript renders as text only, never as markup, and never renders an approval control. That is
the property that keeps the trust boundary where it is: nothing an assistant writes can draw a button
that moves money (`ui/screens/agent.js:348-350`). `TRANSCRIPT_CAP` is 400
(`ui/screens/agent.js:70, 297`).

---

## 5. Client state store

`ui/core/state.js:106-112` exports five functions on `window.PhosphorState`:

| Function | Behaviour |
|---|---|
| `get()` | The current payload object (`ui/core/state.js:12-14`) |
| `loaded()` | `true` once `put` has been called at least once (`ui/core/state.js:16-18`) |
| `put(next)` | Replaces the payload, fires changed slices, then every whole-payload subscriber (`ui/core/state.js:24-46`). A non-object is ignored |
| `select(key, handler)` | Subscribes to one top-level key; fires immediately with the current value when the store is already loaded; returns an unsubscribe (`ui/core/state.js:73-89`) |
| `subscribe(handler)` | Subscribes to the whole payload as `(next, previous)`; fires immediately when loaded; returns an unsubscribe (`ui/core/state.js:91-104`) |

Change detection is reference equality on the slice root first, then a `JSON.stringify` comparison
(`ui/core/state.js:34-35, 52-61`). The payload is small and this runs once per frame, so the stringify
is cheaper than the renders it prevents. The 304 path in `ui/core/net.js:118` hands back the cached
object, so an unchanged read short-circuits on reference equality alone.

A throwing handler is caught and logged, never allowed to break the loop
(`ui/core/state.js:41-44, 65-69, 78-81, 95-98`).

### Who writes

Only two places call `put`:

- `ui/screens/shell.js:235`, after `GET /api/state`, with fixtures applied when a `?screen=` flag is
  set (`ui/screens/shell.js:234`). Skipped entirely when the response was a 304 and the store is
  already loaded (`ui/screens/shell.js:232`).
- `ui/screens/shell.js:179`, on a `lock` SSE frame, merging `{ lock: { state, idleLocksInSec: null } }`
  over the current payload.

### Every selection

| Key | Subscriber | What it drives |
|---|---|---|
| `theme` | `ui/app.js:19-21` | `PhosphorTheme.apply` |
| `view` | `ui/app.js:26-28` | `PhosphorShell.setView`, unless pinned |
| `proposals` | `ui/screens/decision.js:139` | The decision overlay |
| `lock` | `ui/screens/lock.js:20` | The lock, migration and first-run screens |

| Whole-payload subscriber | Reads |
|---|---|
| `ui/screens/shell.js:345` (`renderStatus`) | `lock`, `policy.killSwitch`, and `proposals` via `updateField` |
| `ui/screens/basic.js:23` (`render`) | `basic` |
| `ui/screens/pro.js:36` (`render`) | `wallet`, `intents`, `trade`, `yield`, `policy`, `sentences`, `dailyLimit` |

`ui/screens/trade.js` does not subscribe to the store at all. It holds its own `data` from
`/api/trade` and refreshes on the `trade` SSE frame and on becoming visible
(`ui/screens/trade.js:17, 31, 37-45`).

### Receipts: a second, separate store

`ui/screens/receipts.js` keeps its own list because it reads a different route
(`ui/screens/receipts.js:15-17`). It exports `load()`, `render(host, options)`, `get()`,
`onChange(fn)` and `feeTotal()` (`ui/screens/receipts.js:117-123`). Its state machine is
`idle` → `loading` (or `refreshing` when a list is already held) → `ready` or `error`
(`ui/screens/receipts.js:43, 50, 55`). `onChange` fires immediately on subscribe
(`ui/screens/receipts.js:25`).

The global is `PhosphorReceipts` rather than `PhosphorActivity` because `ui/activity.js` is the custody
idle beacon and got there first. Two different things called activity is how one of them silently stops
running (`ui/screens/receipts.js:6-8`).

---

## 6. The decision flow

### How a pending proposal reaches the overlay

`ui/screens/decision.js:139` selects `proposals`. On every change, `render`
(`ui/screens/decision.js:149-160`):

1. Returns immediately if a receipt or a custom card is already open: a pending ask does not evict what
   the person is reading (`ui/screens/decision.js:150`).
2. Filters to `status === 'pending' || status === 'pending_unlock'`.
3. With none pending, closes an open ask and returns.
4. Otherwise opens `{ kind: 'ask', proposal: pending[0], queued: pending.length - 1 }`. One at a time,
   always the first.

`open` (`ui/screens/decision.js:162-172`) clears `#overlay-card`, builds, unhides `#overlay`, calls
`PhosphorShell.updateField()` and focuses the first `button` in the card.

The overlay markup is fixed in the document (`ui/index.html:66-68`):

```html
<div class="overlay" id="overlay" role="dialog" aria-modal="true" aria-label="Waiting for you" hidden>
  <div class="overlay-card" id="overlay-card"></div>
</div>
```

It renders on all three views in the same slot, so a pending click follows the person instead of being
left on the screen they came from (`ui/screens/decision.js:4-6`).

Escape closes a receipt but never an ask: the only ways out of a pending ask are Yes and No
(`ui/screens/decision.js:140-146`).

### The card fields

`buildAsk` (`ui/screens/decision.js:182-276`), in document order:

| Element | Source |
|---|---|
| `p.label` | `'Waiting for you to unlock'` when `status === 'pending_unlock'`, else `'Waiting for you'` (`:187`) |
| `h2.title` | `headlineOf(proposal)` (`:188`) |
| `p.headline.mono` | `dom.usd(amountOf(proposal))`, omitted when null (`:190-195`) |
| fact: What it costs | `costLine(proposal)` (`:199`) |
| fact: Through | `draft.venue` when present (`:200`) |
| fact: You get about | `dom.qty(sim.amountOut) + ' ' + draft.toSymbol` when `sim.amountOut` is a number (`:201-203`) |
| fact: Why you are being asked | `whyLine(proposal)` (`:204`) |
| `.destinations` | `destinationsOf(proposal)`, each in a `p.addr` (`:210-218`) |
| policy diff | only when `draft.kind === 'policy_change'` (`:220`) |
| `p.body.down` | the error line, hidden until a call fails (`:222-224`) |
| actions | see below |
| `p.meta` | `'One more request after this one.'` or `'<n> more requests after this one.'` (`:268-272`) |

`headlineOf` (`ui/screens/decision.js:104-124`) is a sentence per draft kind:

| `draft.kind` | Headline |
|---|---|
| `consolidate` | `Gather <symbol> onto <toChain>` |
| `transfer` (with a `leg`) | `Move <leg.symbol> from <leg.fromChain> to <leg.toChain>` |
| `swap` | `Swap <fromSymbol> for <toSymbol> on <chain>` when the chains match, else `... <chain> to <toChain>` |
| `mandate` | `Arm a rule` |
| `policy_change` | `Change your limits` |
| `yield_deposit` | `Put money to work` |
| `yield_withdraw` | `Bring earnings back` |
| `hl_deposit` | `Fund the trading account` |
| anything else | `String(proposal.kind)` |

`amountOf` (`:126-132`) takes the first of `draft.amountUsd`, `draft.leg.amountUsd`,
`draft.maxTotalUsd`, else null.

`costLine` (`:312-320`) joins whichever of `sim.feeUsd` (`"$x in fees"`), `sim.gasUsd`
(`"$x in network fees"`) and `sim.priceImpact` (`"x% price impact"`) are numbers. With no simulation at
all it says `Still working out what this costs.`; with a simulation and no numbers,
`No fee was quoted.`

`whyLine` (`:322-334`) prefers `proposal.verdict.reason`. Failing that, it compares the amount against
`state.policy.outbound.humanClickAboveUsd` and says
`It is above the $<threshold> you said to ask about.`, else
`Your limits say this one needs a click.`

`destinationsOf` (`:336-350`) collects `draft.to`, `draft.leg.to` and every entry of
`simulation.destinations` (a string, or an object with an `address`), deduplicated. This is the field
with a track record: an amount that was correct while the screen said "your wallet" and the funds went
to a solver-chosen address. **It is never abbreviated** (`ui/screens/decision.js:207-209`).

### The policy diff

`buildPolicyDiff` (`ui/screens/decision.js:352-384`) reads `state.sentences` (falling back to
`state.policy.sentences`) as the before, and `draft.sentences` or `draft.afterSentences` as the after.
It returns early when the after list is empty or the diff is empty.

`diffOf(before, after)` (`:26-35`) is a plain set difference over whole sentences.
`refineDiff(diff)` (`:54-100`) is the part that makes an approval box readable. `policyDiff` carries
rendered **sentences**, not fields, so adding one destination to an allowlist of seven makes one long
string differ from another long string, and printing both in full is sixteen lines of hex with one
change to find by eye (`ui/screens/decision.js:8-11`, `tests/unit/approvals-diff.test.ts:1-9`).

`splitRule` (`:40-52`) splits on the **first** colon: every sentence the server writes puts the rule
name before it and the values after. Anything that does not fit that shape, or that yields fewer than
two comma-separated items, falls through and is printed whole, which is the safe direction.

Entries are one of:

```
{ kind: 'line',    sign: '+' | '-', text }
{ kind: 'changed', label, gained: string[], lost: string[], unchanged: number }
```

Rendered at `:362-382`: a `line` becomes `Added: <text>` in `.up` or `Removed: <text>` in `.down`; a
`changed` becomes a bold label, then `+ <item>` per gain, `- <item>` per loss, then
`<n> unchanged`.

### Approve and refuse

Normal pending (`ui/screens/decision.js:259-275`): two buttons, No (`.btn.btn-danger`) then Yes
(`.btn.btn-primary`), in that DOM order. `open` focuses the first button, so **No takes focus**.

`decide(route, id, buttons, errorNode, pressed, verb)` (`:278-302`):

1. Disables both buttons and hides the error.
2. `PhosphorShell.setPending(pressed, true, verb)` where the verb is `'Approving'` or `'Refusing'`.
3. Calls the route, then `PhosphorShell.refresh({})`, then hides the overlay and re-runs `render()`.
4. On failure, writes `net.readable(err, true)` into the error line and unhides it. The `true` appends
   `" Nothing left your wallet."`
5. Buttons are **re-enabled only on failure**. A click that landed leaves them dead until the next
   state frame, so a second click cannot ride on a stale render (`:294-296`).

### The receipt after execution

`PhosphorDecision.showReceipt(receipt)` (`:392-394`) opens the same overlay slot with
`PhosphorReceipt.fill` (`:388-390`, `ui/screens/receipt.js:25-107`). It is reached from
`ui/screens/receipts.js:102` (clicking an Activity row) and from `ui/app.js:51` under a fixture flag.

`fill` renders, in order (`ui/screens/receipt.js:30-106`):

- Label: `Receipt`, or `This did not go through` when `status === 'failed'`, or
  `We cannot tell what happened` when `status === 'needs_reconciliation'`.
- Title: `receipt.summary`, else `Something moved`.
- Facts: What moved (`dom.qty(amount) + ' ' + symbol`), From/To or On (chain names from the table at
  `ui/screens/receipt.js:13-19`), Fees (`dom.fee`), When (`dom.ago`), Your money before / after.
- Transactions: one `.tx-row` per `txids` entry, each with the chain name, a Copy button that writes
  `tx.hash` to the clipboard and flips its label to `Copied` for 1600 ms, the hash in a `p.hash.addr`,
  and an `Open in a block explorer` link with `target="_blank" rel="noreferrer noopener"` when
  `tx.url` is set.
- An error line, hidden.
- Actions.

**Hex lives here and nowhere else.** Every other surface says what moved in words; this is where a
person goes when they want the hash (`ui/screens/receipt.js:4-5`).

### The unknown outcome (`needs_reconciliation`)

Same card, one state a person cannot act on alone (`ui/screens/receipt.js:1-2`). It adds a warn banner
(`ui/screens/receipt.js:33-38`):

> We sent this and we cannot read what happened to it. Do not send it again. Check it again below, or
> open it in a block explorer.

and a `Check it again` primary button ahead of Close (`ui/screens/receipt.js:73-101`). Pressing it
calls `api.reconcile(receipt.id)` and branches on the answer's `status`:

- Still `needs_reconciliation`: the card **stays open** with
  `Still no answer from the chain. Nothing has changed. Do not send it again.` in the error line.
  Closing would look like it had been settled (`ui/screens/receipt.js:82-88`).
- Anything else: a toast reading `Checked. It is <word>.` plus `answer.detail` when present, then the
  card closes. `readableStatus` (`:109-114`) maps `executed` to `done`, `failed` to
  `not done, and nothing left your wallet`, `needs_reconciliation` to `still unreadable`, anything else
  to `no longer waiting`.

### The `pending_unlock` case

A request that arrived while the wallet was shut. It was authored and checked against the limits; what
is missing is the ability to sign (`ui/screens/decision.js:227-229`).

The card (`ui/screens/decision.js:230-257`) adds a warn banner:

> The app is locked, so this is waiting. Nothing has moved and nothing will until you unlock and
> decide.

and replaces the actions with **No** and **Unlock**. There is no Yes, because a Yes it could not act on
would be a click that did nothing. No goes through the same `decide` path with `api.refuse`. Unlock
sets `showing = null`, hides the overlay and calls `window.PhosphorLock.focus()`
(`ui/screens/decision.js:248-255`). The overlay comes back on its own: `render()` runs on the next
state frame, and by then the request is `pending` rather than `pending_unlock`.

`PhosphorLock.focus()` (`ui/screens/lock.js:260-264`) puts the cursor in the lock screen's existing
password field rather than drawing a second password box.

### `showCard`

`PhosphorDecision.showCard(build)` (`:398-400`) hands the same slot to an arbitrary builder
`build(host, close)`. Used by `ui/screens/moneyin.js:124` to show recovery words or private keys. A
pending ask still outranks it: `render()` puts the decision back the moment it closes.

---

## 7. Lock, first run, migration, money in

### The screen hosts

Two fixed hosts in the document, both `hidden` (`ui/index.html:70-71`):

```html
<div class="screen" id="screen-lock" hidden></div>
<div class="screen" id="screen-firstrun" hidden></div>
```

They sit **outside** `#page`. `document.body[data-locked="true"]` is what the stylesheet keys the
dimming off, set by `ui/screens/lock.js:39` and `ui/screens/firstrun.js:31`, cleared at
`ui/screens/lock.js:28` and `ui/screens/firstrun.js:47`.

Reads continue behind the lock in the dimmed shell, so the person still sees their balance while the
app is shut. Nothing is refused while locked: a write the assistant asks for is authored, checked and
queued (`ui/screens/lock.js:3-5`). Neither screen mounts a pattern field of its own: the window has
exactly one, it is already behind everything, and a second would paint an opaque ground over the dimmed
shell (`ui/screens/lock.js:45-49`, `ui/screens/firstrun.js:34-35`).

### The lock state machine

`ui/screens/lock.js:24-43`, driven by `store.select('lock', render)`:

| `lock.state` | Action |
|---|---|
| `unlocked` | Hide `#screen-lock`, clear `data-locked`, reset `mode` |
| `no_wallet` | Hide `#screen-lock`, call `PhosphorFirstRun.open()` |
| `needs_migration` | Set `data-locked`, show, `buildMigrate()` |
| `locked` | Set `data-locked`, show, `buildLock()` |

`mode` guards against rebuilding the same screen on every frame (`ui/screens/lock.js:37`).

### Unlock, in order

`buildLock` (`ui/screens/lock.js:57-130`) builds a real `<form>`, not a loose input: that is what lets
a password manager offer to fill and to save, and it gives Enter-to-submit without a key handler
(`ui/screens/lock.js:62-63`). The input is `type="password" name="password"
autocomplete="current-password"`. It is focused on build (`:129`).

On submit (`:97-128`):

1. Return early when the password is empty or a request is already in flight (`:99`). The disabled
   button covers the click; `inFlight` covers Enter, which submits the form without going near the
   button (`:88-94`).
2. `setPending(unlock, true, 'Unlocking')`.
3. `POST /api/unlock`.
4. `{ ok: false }`: write `reason(code, retryInSec)` into the error line, clear the field, refocus. The
   field is cleared on a refusal and kept on a success, because a wrong password is retyped and a right
   one is finished with (`:107-108`).
5. `{ ok: true }`: clear the field, `PhosphorShell.refresh({})`.
6. A throw: `net.readable(err)`.

`reason` (`ui/screens/lock.js:135-146`):

| `code` | Sentence |
|---|---|
| `wrong_password` | That password is wrong. |
| `locked_out` | `Too many tries. Wait <n> second(s) and try again.`, or `Wait a moment` without a `retryInSec` |
| `no_wallet` | There is no wallet on this computer yet. |
| `damaged` | The key file on this computer cannot be read. Your recovery words will bring the wallet back. |
| anything else | That did not work. |

### Migration, in order

`buildMigrate` (`ui/screens/lock.js:156-228`): title `Your keys are not encrypted`, two
`new-password` fields, a live strength line fed by `PhosphorFirstRun.strengthWords`
(`ui/screens/lock.js:195-197`), an error line, and an `Encrypt now` submit.

Client validation before any call (`:201-208`): at least eight characters, and the two must match.
Then `setPending(go, true, 'Encrypting your keys')` and `POST /api/wallet/migrate`.

On success, `buildMigrateDone(answer)` (`:230-256`) replaces the card with `Your keys are encrypted`,
a count of destroyed copies from `answer.destroyed`, the honest caveat that a Mac may keep an automatic
snapshot the app cannot reach, and a `Continue` that calls `PhosphorShell.refresh({})`.

### First run: ten screens

`ui/screens/firstrun.js:13-16` names them in order:

```
what, choose, password, words, prove, addresses, money, connect, threshold, done
```

`draft` (`:21`) holds `{ path: 'create'|'import', password, mnemonic, threshold: 100, addresses }`.
`close()` wipes `mnemonic` and `password` first (`:43-44`).

| # | Screen | What it does | API |
|---|---|---|---|
| 1 | `what` | Title `Phosphor`, one sentence, `Get started` | none |
| 2 | `choose` | Two `.choice` buttons writing `draft.path` | none |
| 3 | `password` | Two `new-password` fields, live strength line. Validates 8+ characters and a match. On the `import` path it jumps straight to step 6 (`:155`) | `POST /api/wallet/create` on the `create` path (`:158`) |
| 4 | `words` | The twelve words in an `<ol class="words">`, Copy, Print (`window.print()`), and a checkbox that enables Continue (`:214-215`) | none |
| 5 | `prove` | Types back words 3, 7 and 11 (`picks = [2,6,10]`, `:224`). Wrong twice sends the person back to step 4 rather than locking them out (`:249-253`) | none |
| 5' | `import` | Reached instead of `prove` when `draft.path === 'import'` (`:220`). Twelve space-separated words | `POST /api/wallet/import` (`:273`) |
| 6 | `addresses` | Delegates the whole body to `PhosphorMoneyIn.render` (`:292`) | `GET /api/receive` via MoneyIn |
| 7 | `money` | Reads `PhosphorState.get().wallet.totalUsd`. With zero it shows a spinner and `Watching for a deposit`. Offers `Do this later` (`:315-317`) | none |
| 8 | `connect` | `Start it` for the built-in agent, and a read-only input holding the connection line with Copy. Offers `Do this later` | `POST /api/driver {action:'connection'}` (`:353`) and `{action:'start'}` (`:374`) |
| 9 | `threshold` | A numeric input plus $25/$100/$500 chips, writing `draft.threshold`. Parsed with `parseInt`, falling back to 100 (`:412-413`) | none |
| 10 | `done` | `Open Phosphor`: `close()` then `PhosphorShell.setView('basic', { fromClick: true })` (`:422-425`) | none |

`close()` (`:42-49`) hides the host, clears `data-locked` and calls `PhosphorShell.refresh({})`.

**`draft.threshold` is never sent anywhere.** Step 9 writes it into the local draft and step 10 discards
it with the rest of `draft`. Nothing posts a policy change.

`walletProblem` (`:430-435`) maps `wrong_password`, `exists` and `no_wallet` to sentences.

`strengthWords` (`:458-471`) is a sentence, not a bar: a bar tells a person a colour, a sentence tells
them what to do about it. It is exported so `ui/screens/lock.js:196` can share it.

`field(label, autocomplete)` (`:440-449`) always makes a `type="password"` input, and names it `word`
rather than `password` when the autocomplete hint is `off`, so the three word-verification inputs are
not offered to a password manager.

### Money in

`ui/screens/moneyin.js:31-70`. Three skeleton bars while `load()` resolves, then either an empty state
(`No addresses yet`) or:

1. A lead line: `Send money to the address on the chain you are sending from. If you are not sure, use
   the first one.`
2. One `.receive-card` per chain (`:181-219`): the name, the full address in a `p.addr`, a
   `Copy address` button that flips to `Copied` for 1600 ms, `chain.warning` when present, and a QR
   canvas.
3. A warn banner: `Money sent to the wrong chain is gone. This is not something anyone can undo.`
4. The keys block (`:74-93`): `Show my recovery words` and `Save an encrypted backup`.

The QR (`:227-265`) uses `window.qrcode` from `ui/vendor/qrcode.js` (loaded at `ui/index.html:75`) at
error-correction level `M`, and removes the canvas entirely when the library or the text is missing.
It draws **dark modules on a light quiet zone**, which is the way round the QR standard specifies: an
inverted code reads fine on a modern phone and is rejected by plenty of older scanners, and the thing
on the other side of this code is an address money is sent to (`:221-226`). Quiet zone four modules,
scale `max(2, floor(132 / total))`, device pixel ratio capped at 2.

`load()` caches for the life of the page and dedups in-flight calls (`:14-29`); a failure resolves to
`null` rather than throwing.

The keys live on this surface because this is the wallet surface: the addresses money arrives at, and
the words that are the only way back to them. Both are behind the password, every time, with no session
that remembers you just typed it (`:64-67, 95-97`).

### What the shell does with `data-view` and the hidden screens

`setView` (`ui/screens/shell.js:118-153`) writes four things:

1. `data-active="true"` on `#view-<name>` and removes it from the other two (`:124-127`).
2. `aria-selected` on each `[data-tab]` (`:128-131`).
3. `data-view=<name>` on `document.body` (`:132`).
4. Hides `#chip-feed` unless the view is `trade`, and hides `#btn-freeze` when the view **is** `basic`,
   because Basic carries that button at the foot of its own column with the sentence that says what it
   does, and a second copy in the top bar is the same action twice on one screen (`:133-137`).

The two hidden screens are not views. They are siblings of `#page` that the lock and first-run modules
unhide on top of it. `setView` never touches them.

---

## 8. The shell

### View switching

Three views, fixed (`ui/screens/shell.js:17`): `basic`, `pro`, `trade`. A name not in that list is
ignored (`:120`).

**The server owns which view is on screen**, because the assistant can move it with `switch` and a
chart tool called while pro is up moves it to trade. The window follows rather than arguing
(`ui/app.js:23-28`).

`?view=` pins the window and the server's value is ignored. It exists so a screenshot run lands on the
same screen every time; without the pin the state frame arrives a moment later and moves it
(`ui/screens/shell.js:44-57`). `isPinned()` (`:59-61`) is what `ui/app.js:27` consults.

`setView(name, options)` options:

- `silent: true` suppresses the crossfade (used for the initial call, `:40`).
- `fromClick: true` marks a person-initiated switch.

The crossfade sets `refs.views.dataset.swapping = 'true'` for 220 ms, and only when the view actually
changed, the call was not silent, it came from a click, and reduced motion is off
(`:141-144`). Nothing animates on a keyboard-initiated action, and a swap the server asked for is not
something the person triggered either.

On any real change the shell dispatches `phosphor:view` with `{ detail: { view: name } }`
(`:151`). Canvases mounted in a hidden view have no size to fit to, so every local field and the chart
re-measure once their view is on screen; without this an agent panel built in the background paints
into a 1×1 canvas forever (`:146-150`).

Listeners: `ui/screens/shell.js:76` (the pattern field's debounced refit) and
`ui/screens/trade.js:37-41` (chart boot plus a trade refresh, `trade` only).

### The tabs

`ui/index.html:32-36`, a `nav.tabs[role=tablist]` holding three `button.tab[role=tab][data-tab=...]`
with labels `Basic`, `Pro`, `Trade`. Wired at `ui/screens/shell.js:110-116` to
`setView(dataset.tab, { fromClick: true })`. The three view sections carry `role="tabpanel"`
(`ui/index.html:59-61`).

### Status chips

**Lock chip** (`ui/index.html:39-42`, rendered at `ui/screens/shell.js:248-259`). Text goes in
`[data-role="lock-text"]`; `data-tone="warn"` is set whenever the state is not `unlocked`.

| Condition | Word |
|---|---|
| `state === 'locked'` | Locked |
| `state === 'no_wallet'` | No wallet |
| `state === 'needs_migration'` | Keys not encrypted |
| `idleLocksInSec > 0` | `Locks in <n> min`, `n = max(1, round(sec / 60))` |
| otherwise | Unlocked |

There is no ticking countdown in the window. The number moves only when a new `/api/state` lands.

**Feed chip** (`ui/index.html:43-46`). Hidden unless the view is `trade`
(`ui/screens/shell.js:133`). Text in `[data-role="feed-text"]` is `Live` or `Offline`, and
`data-tone` is `up` or `warn`, driven purely by the SSE connection state
(`ui/screens/shell.js:167-171`).

**Agent chip**: `refs.agentChip = document.getElementById('chip-agent')` at
`ui/screens/shell.js:29`, but no element with that id exists in `ui/index.html`. The reference is
always null and nothing reads it.

**The offline bar** (`ui/index.html:53-56`, `<div class="offline-bar" id="offline-bar" role="status"
hidden>`). Shown when the connection is `offline`, `reconnecting` or `stale`
(`ui/screens/shell.js:163-165`). Text into `[data-role="offline-text"]`
(`ui/screens/shell.js:219-226`):

- `reconnecting`: `Reconnecting to the app.`
- otherwise: `The app stopped answering. What you see here is the last thing it said.`
- plus ` It last reported: <lastError>` when the health poll returned one.

The poll runs **only while the stream is down**: a window with a live stream is already being told
everything, and a poll beside it would be a second, slower answer to a question already settled
(`ui/screens/shell.js:185-192`). Ten seconds is slow enough to be free and fast enough that a person
who restarts the backend sees the banner clear before they reach for the reload. What it buys is the
difference between "the app is not answering" and "the app is answering and something in it is broken",
which is `lastError`.

### `setPending(button, pending, label)`

`ui/screens/shell.js:310-332`. Every wait in the window goes through it. When pending it:

1. Freezes the button's width with an inline `min-width` from its current bounding box.
2. Appends (once) a `span.btn-pending` holding `span.spinner` and `span.btn-pending-label`.
3. Writes the label, defaulting to `Working`.
4. Sets `data-pending="true"`, `aria-busy="true"` and **`button.disabled = true`**.

Releasing removes all four.

`disabled` is the half that was missing, and it mattered most on Unlock: that request does not answer
until every proposal queued behind the lock has been sent, which is a rail apiece and can be a minute,
so the window looked frozen and the natural thing to do was press again. The dataset flag and
`aria-busy` said "working" to a screen reader and to the stylesheet and to nothing else
(`ui/screens/shell.js:301-309`).

Callers pass these verbs: `Approving`, `Refusing` (`ui/screens/decision.js:274-275`), `Freezing`,
`Unfreezing` (`ui/screens/shell.js:292`, `ui/screens/basic.js:135`), `Unlocking`
(`ui/screens/lock.js:102`), `Encrypting your keys` (`ui/screens/lock.js:210`), `Starting`
(`ui/screens/agent.js:250`, `ui/screens/firstrun.js:373`), `Stopping` (`ui/screens/agent.js:262`),
`Bringing it back` (`ui/screens/basic.js:293`, `ui/screens/pro.js:262`), `Checking`
(`ui/screens/receipt.js:78`), `Making your wallet` (`ui/screens/firstrun.js:157`),
`Bringing your wallet in` (`ui/screens/firstrun.js:272`).

### `updateField`

`ui/screens/shell.js:89-106`. Exactly one thing decides the pattern field's intensity, and it reads the
whole window rather than any one panel. Order matters: a locked wallet outranks a pending ask, which
outranks a working agent.

| State | Condition |
|---|---|
| `locked` | `lock.state` is `locked`, `no_wallet` or `needs_migration` |
| `waiting` | at least one proposal with `status === 'pending'` |
| `working` | `PhosphorAgent.isWorking()` |
| `idle` | otherwise |

It short-circuits when the state has not changed (`:103`). Called from `renderStatus`
(`:268`), from `PhosphorDecision.open`/`close` (`ui/screens/decision.js:169, 178`) and from
`PhosphorAgent.setPhase` (`ui/screens/agent.js:292`).

### The freeze button

`ui/index.html:47-49`, `<button class="btn btn-danger" id="btn-freeze">` holding a
`span.btn-label`. Rendered at `ui/screens/shell.js:261-266`: the label is
`Everything is frozen` or `Freeze everything`, and `data-frozen="true"` is set when
`state.policy.killSwitch` is true.

Clicking (`ui/screens/shell.js:271-289`): freezing asks for confirmation first, unfreezing does not.
The confirm body is:

> This cancels every working order and disarms every rule. It does not close a position: nothing in
> this app can do that.

Then `POST /api/kill`, then `PhosphorShell.refresh({})`, with a `down` toast on failure.

Basic carries its own copy at the foot of its column (`ui/screens/basic.js:96-101`) with a slightly
different confirm body (`Nothing gets sold and nothing gets closed.`, `:130`) and a sub-line
(`This cancels every working order and disarms every rule. It does not sell anything.`, `:100`). The
top-bar button is hidden while Basic is up (`ui/screens/shell.js:137`).

### `PhosphorToast` and the rest of `feedback.js`

`ui/screens/feedback.js` assigns three globals (`:215-217`).

`PhosphorToast.show(message, tone, ms)` (`:25-37`): appends a `div.toast` into a lazily created
`div.toasts[role=status][aria-live=polite]` on `document.body`. `tone` becomes `data-tone`. The life is
`ms`, else 7000 for `tone === 'down'`, else 4200. On expiry it sets `data-leaving="true"` and removes
the node 240 ms later.

`PhosphorConfirm.ask({ title, body, confirm, tone })` (`:89-107`): a real `<dialog>` opened with
`showModal()`, so escape and the focus trap are the browser's. It replaced `window.confirm()` on the
flatten, close and disarm paths: an OS modal inside a Tauri window, unstyleable, blocking the render
thread while the person decides about money (`:1-6`). Resolves `true` or `false`; a backdrop click, a
`cancel` event and the Cancel button all resolve `false` (`:69-78`). **Focus lands on Cancel, not on
the destructive answer**, so a return press carried over from whatever the person was doing does not
freeze the app (`:102-105`). `tone === 'down'` makes the confirm button `btn btn-danger`.

`PhosphorPassword.ask({ title, body, confirm, extra })` (`:192-213`) plus
`PhosphorPassword.extraValue()`. A `<form>` inside a `<dialog>`, resolving with the typed password or
with an empty string when the person backs out, so a caller cannot mistake a cancel for a blank
password (`:111-114`). The optional `extra` adds a labelled text input whose value is read back through
`extraValue()` (`:168, 217`).

---

## 9. Theme

`ui/theme.js:73-142` exports one function, `PhosphorTheme.apply(theme)`.

Input is the `theme` slice of `/api/state`: five hex colours,
`Record<'accent'|'background'|'up'|'down'|'agent', string>` (`src/view/theme.ts:31-35`). The five slots
are the `set_theme` MCP contract and have not moved (`ui/theme.js:6-8`).

Guards, in order:

1. A non-object returns immediately (`:74`).
2. The five values are joined into a key and compared against the last applied set; an identical theme
   is a no-op (`:75-76`).
3. Each value goes through `rgb()` (`:37-47`), which accepts `#rgb` or `#rrggbb`, case-insensitive,
   and returns `null` for anything else. A colour is the one agent-supplied string that reaches a
   stylesheet, so it is checked on both sides.
4. If `accent` or `background` failed to parse, the whole call returns and the page is left alone
   rather than painted half a theme (`:83`).

### Which CSS variables `set_theme` can move

Written onto `document.documentElement.style` (`ui/theme.js:86-115`):

| Variable | Derived from |
|---|---|
| `--bg-0` | `background` |
| `--bg-1` | `background` mixed 3.5% toward `lift` |
| `--bg-2` | `background` mixed 7% toward `lift` |
| `--line` | `background` mixed 11% toward `lift` |
| `--line-strong` | `background` mixed 17% toward `lift` |
| `--ink` | `accent` |
| `--on-ink` | `background` when `luminance(accent) > 0.55`, else `#FFFFFF` |
| `--ink-wash` | `accent` at alpha 0.08 |
| `--ink-edge` | `accent` at alpha 0.16 |
| `--up` | `up`, only when it parsed |
| `--up-wash` | `up` at alpha 0.14 |
| `--down` | `down`, only when it parsed |
| `--down-wash` | `down` at alpha 0.14 |
| `--agent` | `agent`, only when it parsed |
| `--agent-wash` | `agent` at alpha 0.13 |
| `--agent-edge` | `agent` at alpha 0.28 |

`lift` is `[0,0,0]` when the ground's luminance exceeds 0.5, else `[255,255,255]`
(`ui/theme.js:87`). The two raised surfaces are mixed from the ground toward the accent's luminance
direction rather than carried as extra slots: a ground the agent lightens has to bring its panels with
it, or a light background would put near-black panels on it and the window would invert
(`ui/theme.js:57-60`). `--on-ink` exists so a white button carries dark text and a dark button carries
light text without a sixth slot to get out of step (`ui/theme.js:96-98`).

### What it will not write

**`--warn` is never written.** It is the colour of waiting for a human: a pending ask, an unconfirmed
send, a delayed feed. The agent has no slot for it and this file has no line for it, so the one colour
that means "a person has to look at this" is the one colour nothing in a session can move
(`ui/theme.js:21-26`). Its default is `#F2B544` (`ui/design/tokens.css:30`). The server's half of the
same rule is that it refuses a background `--warn` would be unreadable on
(`src/view/theme.ts:55-61`).

`--text`, `--text-2` and `--text-3` are also never written. Text is painted from `--text`, which no
slot reaches, so a recolour does not repaint every word in the window (`ui/theme.js:9-13`).

### Canvas handoff

A canvas cannot read a custom property, so the chart and the pattern are told directly, and both calls
are optional and wrapped in try/catch (`ui/theme.js:117-141`):

```js
window.chartTheme({ bg, panel, line, text: '#EDEEF0', accent, up, down });
window.patternTheme();
```

`chartTheme` is `ui/chart/chart.js:118`. `patternTheme` is installed by
`ui/screens/shell.js:68-70` and calls `field.refreshColors()`.

Note `text` is passed as the literal `'#EDEEF0'`, matching the `--text` default at
`ui/design/tokens.css:19`, not read from the token.

### The token file

`ui/design/tokens.css` declares one dark look, painted rather than inherited from the OS
(`color-scheme: dark`, `:9`). The five theme slots default to `--ink: #33FF66`, `--bg-0: #09090B`,
`--up: #33FF66`, `--down: #FF5A6E`, `--agent: #B79CFF` (`:26-31`). Phosphor green is the action colour
and the same green that means up: the app is named for one colour on near-black, so the action and the
direction are one decision (`:23-25`). Everything else, type scale, a four-step spacing rhythm, radii,
easing curves, layout widths and one shadow, is at `:42-85`.

---

## 10. Chart and trade overlay

### `ui/chart/chart.js`

Not an IIFE. Every top-level `var` and `function` is a global (`tests/unit/chart-ui.test.ts:18-20`).
Public entry points:

| Global | Line | Purpose |
|---|---|---|
| `chartBoot()` | `2608` | The one initializer. Reads tokens, reads the volume preference, wires the canvas, invalidates, fetches, and starts a 5000 ms floor timer that refetches when the last fetch is over 15000 ms old |
| `chartTheme(theme)` | `118` | Also assigned to `window.chartTheme` at `142`, which is what `ui/theme.js:120` checks |
| `chartInvalidate(scene)` | `657` | Request a repaint; `true` means the scene changed, not just the HUD |
| `chartResize()` | `847` | Re-measures `#chartwrap` and reallocates both backing stores, only when the size actually changed. Returns whether it did. Calls `queueChartPush()` |
| `chartPushed(rev)` | `1993` | The `chart` SSE frame. Ignores anything at or below `CHART_MY_REV`, which is this window's own echo |
| `candleLive(frame)` | `2042` | The `candle` SSE frame |
| `candlesPushed()` | `2117` | The `candles` SSE frame. Skipped mid-drag; floors the refetch rate at 250 ms |
| `applyChart(payload)` | `1822` | Applies a `/api/chart` body |
| `pushChart(extra)` | `1917` | Writes the view home |
| `toggleVolume()` | `631` | Adds or removes the built-in volume pane, persisted in `localStorage` under `phosphor.chart.volume` |

There is **no** `setView`, `setProduct` or `setGranularity` global. All three are the same operation:
`pushChart` sends the whole view object, and the market and timeframe controls in the chart bar write
into `CHART.view` and then push (`ui/chart/chart.js:1921-1930`).

Indicators are added through the same door: `pushChart({ addIndicator: {...} })` and
`pushChart({ removeIndicator: id })` (`ui/chart/chart.js:2334`,
`ui/chart/chart.js:2605` builds the `addIndicator` object from the command line). The one exception is
the volume pane, which is built in this window and the server has never heard of, so removing it goes
through `toggleVolume()` rather than a round trip that would answer "remove what?"
(`ui/chart/chart.js:2331-2333`).

Drawings, levels and marks are **read only** in the window: `applyChart` copies
`payload.levels`, `payload.marks` and `payload.drawings` into `CHART`
(`ui/chart/chart.js:1833-1835`) and the draw routines render them. Nothing in `ui/` creates one.

### Who owns the view

`applyChart` (`ui/chart/chart.js:1843-1868`) resolves the conflict between the hand in the window and
the agent:

- On the **first** load, or when `payload.lastDriver === 'agent'` with no drag and no push pending, the
  server's view is adopted. The agent case animates through `startViewTween`; the first load must not,
  because there is no previous window to travel from.
- Otherwise, if the payload's **identity** differs (product or timeframe) and nothing of ours is on the
  wire, the whole view is adopted anyway. The candles here were read for the server's product, so a
  view still naming another one puts one market's price under another market's name.
- In every other case the hand keeps the view. Adopting the server's view on every refresh looks
  correct and is not: a refresh fired by our own write can land before that write does, and the gesture
  the human just made snaps back.

### DOM the chart expects

All of it is built by `ui/screens/trade.js:67-183`, and every id is looked up with `getElementById`:

| Id | Element | Read at |
|---|---|---|
| `chart` | `<canvas>` | `chart.js:212` |
| `chart-hud` | `<canvas>` | `chart.js:215` |
| `chartwrap` | `<div>`, focusable, `role="img"` with a keyboard-hint `aria-label` | `chart.js:218` |
| `panel-chart` | `<div>`, receives a `--panes` custom property | `chart.js:1889` |
| `product` | `<select class="input chart-select">` | `chart.js:2132` |
| `timeframes` | `<div>` | `chart.js:2146` |
| `chart-cmd` | `<input type="text" placeholder="Indicators">` | `chart.js:2538` |
| `chart-status` | `<span class="chartstatus grow">` | `chart.js:1963, 1993` |
| `chart-feed` | `<span class="feed" data-feed="offline" role="status">` containing `<i>` and `<b>` | `chart.js:1803` |
| `chart-provider` | `<button class="venue">` | `chart.js:2210` |

Two canvases stacked, not a canvas and a div: `chart.js` draws the last price tag, the crosshair and
the legend onto the HUD with its own 2d context (`ui/screens/trade.js:137-138`). All pointer input is
on the HUD (`ui/chart/chart.js:2326, 2362`) with pointer capture, so a drag that outruns the canvas
keeps going. `chartwrap` takes focus for the keyboard (`ui/chart/chart.js:2357`).

Sizing is driven by a `ResizeObserver` plus a `window` `resize` listener
(`ui/chart/chart.js:2549-2556`), so `ui/split.js`'s release-time `resize` event reaches it.

### Boot timing

The engine's boot wires listeners, starts a 5-second watchdog and a one-second bar-close timer. None of
that should run in a window whose owner never opens trade, so `ui/screens/trade.js:60-65` starts it the
first time the view is on screen and never before, guarded by a `charted` flag. If `window.chartBoot`
is not a function it silently does nothing (`ui/screens/trade.js:62`).

### `ui/chart/trade-overlay.js`

Loaded only by the one window that has a trading account behind it
(`ui/chart/trade-overlay.js:3-5`). One entry point, called from
`ui/chart/chart.js:919` through a single guarded line:

```js
if (typeof drawTradeOverlays === 'function') drawTradeOverlays(ctx, L);
```

`drawTradeOverlays(ctx, L)` (`ui/chart/trade-overlay.js:222`) reads exactly one global,
`window.TRADE`, through `tradeData()` (`:44-46`). Absent means a page with no account behind it and
every function no-ops. `ui/screens/trade.js:215` sets it from the `/api/trade` payload **before** the
render that draws on top of it.

It draws only the focused symbol's objects: `data.symbol` must match the chart's product prefix, and
positions and mandates are filtered to that coin (`:226-237`). A BTC liquidation line drawn on an ETH
chart is not a bug the eye catches, it is a bug the eye trusts.

Three layers, gated by `data.overlays` (`:225`):

| Toggle | Draws |
|---|---|
| `liquidation` | A red band beyond `p.liqPx` and a `LIQ <coin>` line at it (`:248-258`) |
| `mandateWall` | An amber band and a dashed `MANDATE STOP-OUT $<maxLossUsd>` line at each armed mandate's `wallPx` (`:262-277`) |
| `position` | A `LONG/SHORT $<notional> @ <leverage>x <pnl>` line at `p.entryPx`, green when winning and red when not (`:279-...`) |

Colours are fixed literals, not tokens (`:36-40`): `#ff3b30` for the venue's wall, `#F2B544` for the
human's, `#33FF66` long, `#FF5A6E` short. The app's law is that red belongs to the safety gate alone,
extended here only this far: red is for the surfaces where something is taken from you. The mandate
wall is bright amber, not red, because it is the boundary that protects, and painting the guard rail
the same colour as the cliff is how a person stops reading either (`:20-25`).

Everything is drawn from price and time, never from a stored pixel, so a pan or a zoom moves these with
the candles (`:27-28`).

### The overlay toggles

`ui/screens/trade.js:19-23` declares three: `position`/Position, `liquidation`/Forced close,
`mandateWall`/Rules. All three default on and are written to `window.TRADE_OVERLAYS`
(`ui/screens/trade.js:121`). The old build shipped seven with six defaulting to on, which made the row
chrome rather than a control (`:119-120`).

Each toggle is a `button.chip[data-overlay=<id>]` carrying `aria-pressed` and
`data-tone="ink"` (`:106-115`). `onToggle` (`:195-203`) flips both, updates
`window.TRADE_OVERLAYS`, and calls `window.chartInvalidate()` when it exists.

### `ui/split.js`

One handle in the whole window (`ui/split.js:65-71`): `trade` / `deck-rail`.

```
axis: 'x', sign: -1, min: 320,
pane: '.trade-rail', host: '.trade-wrap', prop: '--rail',
give: '.trade-main', giveMin: 620
```

Pro is a grid and Basic is a column, so neither needs dragging. 360 is the rail's design width and 320
its floor: a position line (`Forced close at $x, y% away`) stops fitting on one line below that, and a
rail that wraps that line is worse than a rail that stops shrinking. 620 is the chart's floor: narrower
than that it shows fewer bars than the timeframe row offers, so the controls above it start lying about
what is on screen (`ui/split.js:56-64`).

The DOM contract (`ui/screens/trade.js:68-70, 145-149, 151`):

- The deck carries `data-split="trade"`, which is how `splitBoot` finds it and picks its table
  (`ui/split.js:288-292`).
- The handle carries `data-split-handle="deck-rail"`, `role="separator"`,
  `aria-orientation="vertical"` and `tabIndex = 0`.
- `.trade-wrap`, `.trade-main` and `.trade-rail` are the three selectors the table names.

`splitBoot()` (`ui/split.js:287-322`) is called from `ui/screens/trade.js:182` after the deck is in the
document, guarded on the function existing. A handle with no entry in the table stays inert rather than
guessing at a geometry nobody wrote down (`ui/split.js:299-301`).

Behaviour:

- **One property write** is the only way a size reaches the page: `--rail` on `.trade-wrap`, plus a
  `data-sized` attribute the stylesheet keys the fixed flex-basis off, plus `aria-valuenow`
  (`ui/split.js:158-165`).
- **Reset** removes the property rather than restoring a number, because the default lives in the
  stylesheet and this file does not hold a copy of it to drift from (`ui/split.js:167-175`). Triggered
  by Enter, Space, or two pointer presses within 400 ms (`:221-226, 246-259`).
- **Geometry is measured once**, on pointer down, and a move is arithmetic on the numbers taken then.
  `splitBegin` and `splitAt` touch no DOM at all (`ui/split.js:139-156`).
- **Arrow keys** move by 16 px through the same two functions the pointer uses, so a handle where
  dragging right shrinks the pane shrinks it on the right arrow too (`ui/split.js:33, 229-240`).
- **`localStorage`** under `phosphor.split.trade.deck-rail`, with an in-memory mirror so a handle keeps
  working when storage throws, which a locked-down profile does (`ui/split.js:74-120`).
- **A stored size is a preference, not an instruction.** It is clamped against the window as it is now,
  and the clamped result is **not** written back: a laptop opened on a small external screen must not
  overwrite the layout chosen on the big one (`ui/split.js:177-185`).
- `min` wins a contradiction: a window too small for both floors is one where the safety surface keeps
  its height and the other pane overflows into its own scroll (`ui/split.js:122-129`).

Two events (`ui/split.js:190-193`): `phosphor:split` fires once per animation frame while a boundary
moves, and a plain `resize` fires once, on release, for everything that already listens for one.

---

## 11. Test contract

Nine test files read a `ui/` file. All 62 tests pass on this branch as of 2026-09-07. Three more
mention `ui/` in a comment only and assert nothing about it:
`tests/unit/chart.test.ts:321`, `tests/unit/market-push.test.ts:75`,
`tests/unit/view-op.test.ts:234`.

Six of the nine load a real `ui/` file into a `node:vm` context against a stub `window`, which turns
its globals into the test surface. A rewrite that changes a global's **name** breaks those tests even
if the behaviour is identical.

### `tests/unit/agent-panel-ui.test.ts` — `ui/screens/agent.js`

Loads the file into a vm; the surface is `window.PhosphorAgent`. The stub supplies
`PhosphorDom.{on,el,clear}`, `PhosphorNet`, `PhosphorApi.{driverState,connection}`,
`PhosphorEvents.on`, `window.setTimeout`, `document.{createElement,addEventListener}`, `navigator`.

| Must survive | Assertion |
|---|---|
| No markup path. The source must not match `/\.innerHTML\s*=/` or `insertAdjacentHTML\|outerHTML\|document\.write` | `:42-45` |
| The panel builds buttons through the literal pattern `'btn-label', '<Label>'`, and at least one | `:50-52` |
| The **complete** set of button labels is `Start`, `Stop the answer`, `Stop the assistant`, `Copy`, `Send`. Any other label fails | `:51, 53-56` |
| The source must not match `/\bapprove\b|\brefuse\b/i` anywhere | `:57` |
| `PhosphorAgent.toolLabel` is exported | `:61-89` |
| `toolLabel('propose_swap') === 'asking to swap'`; `toolLabel('swap') === 'swapping'` | `:64-65` |
| `toolLabel('propose_intents_withdraw') === 'asking to withdraw'`; `toolLabel('intents_withdraw') === 'withdrawing'` | `:66-67` |
| `toolLabel('propose_mandate') === 'asking to arm a mandate'`; `toolLabel('mandate_arm') === 'arming a mandate'` | `:68-69` |
| `toolLabel('research') === 'reading the news'` | `:74` |
| `toolLabel('mcp__phosphor__wallet') === 'reading your wallet'` (prefix stripped) | `:79` |
| `toolLabel('some_new_tool') === 'some_new_tool'` (unknown id prints itself) | `:80` |
| `toolLabel('constructor')`, `('toString')`, `('hasOwnProperty')` each return their own name, not an `Object.prototype` member | `:87-89` |

Note the button-label assertion depends on the exact source spelling `dom.el('button', ...)` followed by
`dom.el('span', 'btn-label', 'X')`. A rewrite that builds labels any other way makes the test pass
vacuously except for the `labels.length > 0` guard, which would then fail.

### `tests/unit/approvals-diff.test.ts` — `ui/screens/decision.js`

Surface is `window.PhosphorDecision`. Stub: `PhosphorDom.on`, `PhosphorNet`, `PhosphorApi`,
`PhosphorState.{select,get}`, `document.{createElement,getElementById,addEventListener}`.

| Must survive | Assertion |
|---|---|
| `PhosphorDecision.diffOf(before, after)` exists and returns `{ removed, added }` | `:63-67` |
| `PhosphorDecision.refineDiff(diff)` exists | `:69` |
| One destination added to a seven-item allowlist collapses to **one** entry: `kind: 'changed'`, `label: 'Additional allowed destinations'`, `gained: ['hyperliquid-perps']`, `lost: []`, `unchanged: 7` | `:70-75` |
| A removal reports `lost: ['intents.near']`, `gained: []` | `:81-83` |
| A rule with no colon-and-comma list is printed whole as two entries with signs `['-','+']` | `:89-97` |
| A rule added with nothing it replaces is one entry, `kind: 'line'`, `sign: '+'` | `:101-104` |
| Two rules changing at once do not cross-match: each keeps its own label, gains and losses | `:107-124` |
| An unchanged policy yields zero entries | `:127-128` |

The label is derived by splitting on the first colon, so the server-side sentence format
`"<Rule name>: <a, comma, list>."` is load-bearing on both sides.

### `tests/unit/static-routes.test.ts` — `src/http/router.ts` against `ui/`

| Must survive | Assertion |
|---|---|
| Every literal path passed to `serveStatic('<path>')` in the router source must exist under `ui/` | `:19-29` |
| The router must not contain `route === '/trade'` | `:33` |
| `ui/trade.html` must not exist | `:34` |

The first test scans for the literal call shape `serveStatic('/...`. The current router calls
`serveStatic(route, res)` with a variable, so the match list is empty and the test passes vacuously. It
constrains any rewrite that reintroduces a named page.

### `tests/unit/shell-handshake.test.ts` — `ui/index.html` and `src-tauri/src/backend.rs`

| Must survive | Assertion |
|---|---|
| `src-tauri/src/backend.rs` contains the literal `"x-phosphor:"` | `:25-28` |
| That file must not contain `contains("<title>` | `:30-32` |
| `ui/index.html` must **not** contain the string `x-phosphor` | `:36-37` |
| `IDENTITY_VALUE` must match `/^[a-z]+$/` | `:38` |

The marker lives in the response, not in the document. A rewrite of `ui/index.html` is free to change
the `<title>` (`ui/index.html:6`) without breaking the boot.

### `tests/unit/trade-fills-ui.test.ts` — `ui/core/dom.js` and `ui/screens/trade.js`

The only test that renders real UI. It runs both files into a vm over a hand-built DOM, calls
`window.PhosphorTrade.boot()` then `await window.PhosphorTrade.refresh()`, and asserts on the leaf text.

Structural requirements, all load-bearing:

- `document.getElementById('view-trade')` must return the host the screen builds into (`:149`).
- `window.PhosphorTrade` must expose `boot()` and `refresh()`, and `refresh()` must return a promise
  (`:173-174`).
- The stub window supplies only `PhosphorMotion.reduced`, `PhosphorEvents.on`, `PhosphorNet.readable`,
  `PhosphorApi.trade`, `PhosphorShell.{view,setPending}` and `PhosphorAgent.mount`. Reaching for any
  other namespace during boot throws. In particular `window.splitBoot` and `window.chartBoot` are
  absent, so both must stay behind `typeof === 'function'` guards
  (`ui/screens/trade.js:62, 182`).
- `PhosphorApi.trade()` resolves `{ fresh: true, data }`, so the `!result.fresh` short-circuit at
  `ui/screens/trade.js:211` must keep that shape.
- The stand-in DOM implements only `insertBefore`, `removeChild`, `firstChild`, `nextSibling`,
  `parentNode`, `children`, `dataset`, `classList.add/remove`, `setAttribute`/`getAttribute`/
  `hasAttribute`/`removeAttribute`, `getBoundingClientRect`, `querySelector` (always null),
  `addEventListener`, `focus`. The keyed reconciler at `ui/core/dom.js:61-90` uses exactly these.

Text assertions:

| Must survive | Assertion |
|---|---|
| A 0.001 fill at `szDecimals: 5` renders the exact string `Bought BTC 0.001` | `:179-183` |
| A clock matching `/^\d{2}:\d{2}$/` renders beside it (`dom.clock` on `fill.atMs`) | `:187-188` |
| `szDecimals: null` still prints a nonzero size, never `Bought BTC 0` | `:194-198` |
| `szDecimals: 0` still prints `Bought BTC 0.001` rather than rounding a real trade to nothing | `:204-208` |
| A 12500 fill renders `Bought BTC 12,500`, keeping the separator and not growing decimals | `:212-213` |

The payload shape the test feeds is the real one: `fills` entries are
`{ tid, coin, side, px, sizeCoin, notionalUsd, feeUsd, closedPnlUsd, atMs, tSec, liquidation,
mandateId }` and `markets` entries carry `coin` and `szDecimals` (`:113-139`). Reading
`fill.sz`, `fill.size` or `fill.time` is what this test exists to prevent
(`tests/unit/trade-fills-ui.test.ts:1-5`, `ui/screens/trade.js:365-368`).

### `tests/unit/split-ui.test.ts` — `ui/split.js`

The whole sandbox **is** the test surface, so every one of these must stay a bare global with the same
name: `SPLIT_PAGES`, `SPLIT_MEM`, `splitBegin`, `splitAt`, `splitApply`, `splitReset`, `splitRestore`,
`splitClamp`, `splitRead`, `splitWrite`, `splitForget`, `splitKeydown`, `splitWire`.

| Must survive | Assertion |
|---|---|
| `SPLIT_PAGES.trade['deck-rail']` exists with `min: 320` and `giveMin: 620` | `:135-136, 150-151` |
| Every entry in every page table has `min > 0` and `giveMin > 0` | `:141-147` |
| `splitApply` writes `conf.prop` on `h.host.style` as `<n>px` | `:119-122` |
| Growth is bounded by the give's floor: from `{pane:400, give:900}`, `splitAt(h,-60)===460`, `splitAt(h,-5000)===680`, `splitAt(h,5000)===320` | `:162-164` |
| `sign: -1` is honoured on the keyboard too: `splitAt(h,60)===340` | `:174` |
| A stored size survives a reload through `splitRead`, and `splitRestore` applies it and sets `data-sized` to the empty string | `:190-194` |
| `splitReset` removes the property, removes `data-sized`, and deletes the storage key `phosphor.split.trade.deck-rail` | `:197-201` |
| A stored 900 in a window that can only give 680 applies 680 and **leaves 900 in storage** | `:213-218` |
| A storage that throws on every method still lets `splitWrite` then `splitRead` round-trip through memory, and `splitForget` clear it | `:222-229` |
| `''`, `'wide'`, `'0'`, `'-40'`, `'NaN'` all read back as `null` | `:235-238` |
| `splitKeydown` with `ArrowLeft` moves by exactly 16 and writes storage; `Enter` resets and clears it; both dispatch a `phosphor:split` event on `window` | `:251-259` |
| `ArrowRight` narrows a right-hand pane | `:269-270` |
| With no slack (`give` already at `giveMin`), the pane cannot grow but can always shrink to its floor | `:277-280` |
| `splitClamp(20, 320, 40) === 320` and `splitClamp(900, 320, 40) === 320`: `min` wins a contradiction | `:286-287` |
| `splitWire` gives a double `pointerdown` within 400 ms the reset behaviour | `:297-314` |

`splitKeydown` and `splitNotify` construct `CustomEvent` and `Event`, which the test supplies as
sandbox globals (`:248-249`).

### `tests/unit/chart-ui.test.ts` — `ui/chart/chart.js`

Globals the test reaches for: `applyChart`, `CHART`, `CHART_PUSH_WAIT`, `drawLegend`.

| Must survive | Assertion |
|---|---|
| `applyChart(payload)` sets `CHART.view.product` from `payload.view` on the first load | `:87-88` |
| A later payload naming another market, with `lastDriver: 'human'` and nothing in flight, still moves the window onto it | `:92-95` |
| With `CHART_PUSH_WAIT = 1`, a payload that crossed the hand's write does **not** overrule `CHART.view.product` | `:104-108` |
| The legend nonetheless names the market the drawn bars belong to, and the timeframe from the same payload: `drawLegend` prints `['BTC-USD', '5m', ...]` | `:109-111` |
| `panOffset` and a manual `priceScale` survive a payload that does not change identity | `:118-123` |
| `lastDriver: 'agent'` adopts the whole view, `panOffset` included, and the legend follows | `:129-133` |
| `drawLegend(ctx, layout)` takes a layout of `{ decimals, overlays, panes, dropped, axisTop }` and writes through `ctx.fillText` | `:71-81` |

The payload shape the test feeds is `{ rev, lastDriver, view, candles, meta: { source, stale, built },
indicators, levels, marks, products, timeframes }` (`:48-61`).

### `tests/unit/chart-chrome-ui.test.ts` — `ui/chart/chart.js`

Globals: `C_UP`, `C_DOWN`, `CHART_TOKENS`, `RGB_ACCENT`, `CHART_AXIS_W`, `accent`, `danger`,
`lineInk`, `text2`, `chartTheme`, `buildLayout`, `candleLive`, `toggleVolume`, `CHART`, plus
`window.localStorage`.

| Must survive | Assertion |
|---|---|
| `C_UP === '#33FF66'` and `C_DOWN === '#FF5A6E'` | `:86-87` |
| `CHART_TOKENS.line === '#22242A'` and `CHART_TOKENS.text2 === '#9A9EA8'` | `:88-89` |
| `accent(0.5) === 'rgba(91, 141, 239, 0.5)'` | `:91` |
| `danger(1) === 'rgba(255, 90, 110, 1)'`; `lineInk(1) === 'rgba(34, 36, 42, 1)'`; `text2(0.7) === 'rgba(154, 158, 168, 0.7)'` | `:92-94` |
| A global named `green` must **not** exist: a function called `green()` returning blue is a lie | `:95` |
| `chartTheme` with the shipped defaults leaves `C_UP` on its token; a chosen `up` colour wins and sets `RGB_ACCENT` | `:98-113` |
| Volume is a pane by default, labelled exactly `volume`, sitting directly under the price | `:118-131` |
| `buildLayout(w, h, ctx)` returns `{ panes: [{ indicator: { label, id }, height }], priceHeight, dropped, ... }`, and `priceHeight === usable - pane.height` | `:124-131` |
| The volume plot has `style: 'histogram'`, a `values` array of the raw volumes, and a parallel `signs` array of `1`/`-1` per candle direction | `:137-142` |
| `candleLive` moves the histogram in the same frame it moves the price | `:145-158` |
| A human-added volume indicator wins, so the histogram is not drawn twice; `indicator.source === 'human'` | `:161-171` |
| Volume is dropped silently before the price pane stops being readable: `dropped` stays empty | `:174-181` |
| An asked-for pane outranks the default volume pane when space is tight | `:184-195` |
| `toggleVolume()` removes the pane, writes `'0'` to `localStorage['phosphor.chart.volume']`, and a second call brings it back | `:198-207` |
| `CHART_AXIS_W >= 66` | `:212-218` |

`buildLayout` is called with a stand-in context exposing only `font` and
`measureText(text) -> { width }` (`:45`).

### `tests/unit/chart-live-ui.test.ts` — `ui/chart/chart.js`

Globals: `candleLive`, `flushLiveCandle`, `liveBucket`, `shownPrice`, `CHART`, `CHART_DRAG`,
`CHART_LIVE`, `CHART_PRICE_TWEEN`.

| Must survive | Assertion |
|---|---|
| A frame for another product is dropped | `:93-97` |
| A frame from a provider that is not `CHART.meta.source` is dropped | `:100-106` |
| A `baseSec` that does not divide the bucket is dropped rather than straddled | `:109-123` |
| A frame for a bucket older than the newest drawn bar is ignored, and the array does not grow | `:126-133` |
| When `step === frame.baseSec` the bar is replaced outright and no bar is appended | `:138-143` |
| On a coarser timeframe the minute folds in: open from the existing bar, high/low widened, close taken, volume summed | `:146-162` |
| A minute resent contributes only the difference in volume | `:165-184` |
| A frame for the next bucket appends, and the bar that closed keeps its close | `:187-193` |
| A window panned back keeps its `panOffset` relative to the bar being looked at when a bar is appended | `:198-205` |
| A frame arriving while `CHART_DRAG` is set is **held**, not dropped, and `flushLiveCandle()` applies it | `:208-217` |
| Only the newest held frame survives a drag | `:220-228` |
| `shownPrice()` returns a value between the old and new price while the tween runs, and the candle's own close is already the new one | `:234-242` |
| Switching market nulls `CHART_LIVE` and `CHART_PRICE_TWEEN` so no volume memo or ease carries across | `:245-278` |
| `liveBucket(t, 60)` floors to the minute; `liveBucket(t, 604800) % 604800 === 345600 % 604800`, so a week bucket opens on Monday | `:281-285` |

---

## 12. Gaps

### A. The window computes what the server does not send

1. **`ui/screens/decision.js` reads five simulation fields that are not on `SimulationResult`.**
   `sim.feeUsd`, `sim.gasUsd`, `sim.priceImpact` (`:316-318`), `sim.amountOut` (`:201-202`) and
   `sim.destinations` (`:342`). The declared type (`src/types.ts:409-422`) carries only
   `ok`, `summary`, `depositAddresses`, `postComposition`, `policyDiff` and `error`. When these are
   absent, `costLine` prints `No fee was quoted.` and the destinations list falls back to
   `draft.to` and `draft.leg.to`.

2. **The freeze state is derived from `state.policy.killSwitch`** in two places
   (`ui/screens/shell.js:262, 275`, `ui/screens/basic.js` via the same store). `/api/health` also
   carries `killSwitch`, and `basic.warning` carries a sentence about it, but nothing exposes a
   dedicated flag for the button.

3. **Basic filters dust client-side.** A holding worth under $1 is counted rather than listed
   (`ui/screens/basic.js:215-225`). The server sends every holding.

4. **Pro derives the daily-limit meter fill and the reset wording**
   (`ui/screens/pro.js:288-297, 350-357`), and the position's distance-to-liquidation
   (`ui/screens/trade.js:266-268`). `TradePayload.positions[].liqDistancePct` already carries that
   distance (`src/trade/state.ts:97`) and is not read.

5. **`ui/screens/receipts.js:109-115` sums `feesUsd` across the loaded window** to answer "what did
   this cost me". No route returns that total.

6. **The lock countdown is a static number.** `idleLocksInSec` is rendered once per state frame
   (`ui/screens/shell.js:254-256`); nothing ticks it down between frames.

7. **`ui/screens/decision.js:327-329` reads `state.policy.outbound.humanClickAboveUsd`** to build
   the "why you are being asked" sentence when the verdict carries no reason.

### B. Routes the server exposes that the window never calls

| Route | Declared in `ui/core/api.js`? | Called? |
|---|---|---|
| `GET /api/candles` | no | no |
| `GET /api/gas` | no | no |
| `GET /api/log` | no | no |
| `POST /api/mcp` | no | no (the agent's door) |
| `POST /api/trade` | no | no |
| `GET /api/transactions` | yes, `:58-60` | **no** |
| `GET /api/chart` | yes, `:62-64` | **no** (the chart engine fetches it directly) |
| `POST /api/trade/action` | yes, `:70-72` | **no** |
| `POST /api/lock` | yes, `:95-97` | **no** |

`POST /api/driver` actions `open` and `close` (`src/http/mutation.ts:120, 158`) are also unreachable:
nothing in `ui/` opens a second chat or closes one, and the window renders only
`data.chats[0]` (`ui/screens/agent.js:410`). The four-chat capacity has no surface.

`api.revealStart` supports `what: 'keys'` and `showMaterial` can render private keys
(`ui/screens/moneyin.js:143-151`), but the only call site asks for `'mnemonic'`
(`ui/screens/moneyin.js:90`).

### C. SSE frames nothing consumes

`transactions`, `activity` and `log` are broadcast and have no listener in `ui/`
(section 4). `transactions` fires on every store change and every time a gas receipt lands
(`src/http/state.ts:188`), so the Activity panel only refreshes when something else triggers a
`PhosphorReceipts.load()`, which happens on the fold opening (`ui/screens/basic.js:147`) and once at
Pro boot (`ui/screens/pro.js:121`).

### D. Field-name mismatches, live on this branch

These are cases where the window reads a key the payload does not have. Each renders a degraded state
rather than throwing.

1. **`/api/yield/withdraw` is called with no `chain`.** `ui/screens/basic.js:294` and
   `ui/screens/pro.js:263` both call `api.yieldWithdraw({})`. The route requires
   `chain` to be `eth`, `base` or `arb` (`src/http/mutation.ts:220-223`), so the request is refused
   400 and the person sees a toast reading
   `chain must be one of eth, base, arb; got '' Nothing left your wallet.`
   Both `Bring it back` buttons are non-functional.

2. **Pro's Earning panel reads four keys `YieldView` does not have.**
   `ui/screens/pro.js:246-257` reads `y.principalUsd`, `y.earnedUsd`, `y.apy` and `y.auto`.
   `YieldView` (`src/yield/allocator.ts:49-66`) carries `totalPrincipalUsd`, `totalEarnedUsd`,
   `best.apy` and `autoAllocate`. `fact()` skips an empty value (`ui/screens/pro.js:366`), so all
   three figures are dropped and the panel shows only the two buttons, with the auto button always
   reading `Auto-earn is off`.

3. **Basic's Earning panel treats a string as an object.**
   `ui/screens/basic.js:255-257, 281-288` reads `basic.earning.line`, `.summary` and `.madeLine`.
   `BasicView.earning` is `string | null` (`src/types.ts:588`, built at `src/view/basic.ts:750-772`).
   The panel unhides (the string is truthy) and renders an empty paragraph plus the withdraw button.

4. **Pro reads two top-level state keys `buildState` does not emit.**
   `ui/screens/pro.js:155` reads `state.intents.totalUsd` and `:165` reads
   `state.trade.account.equity`. `buildState` (`src/http/state.ts:60-145`) emits neither `intents` nor
   `trade`. Both guarded `if` blocks are dead, so the Money table never gains its
   `Ready to move` or `Trading money` rows.

5. **Trade's Account panel reads three keys under the wrong names.**
   `ui/screens/trade.js:287-305` reads `account.equity`, `account.free` and `account.health`.
   `TradePayload.account` carries `equityUsd`, `freeUsd` and `healthPct`
   (`src/trade/state.ts:193-210`). The `funded` check at `ui/screens/trade.js:287-289` therefore never
   passes, and the panel always shows the empty state
   `No trading money yet / Ask your assistant to fund the trading account, and it will ask you first.`
   even on a funded account.

6. **Trade's Position panel reads four keys under the wrong names.**
   `ui/screens/trade.js:247-270` reads `p.valueUsd`, `p.size`, `p.unrealizedPnl`, `p.liquidationPx`
   and `p.product`. `Position` (`src/trade/state.ts:79-106`) carries `notionalUsd`, `sizeCoin`,
   `unrealisedUsd` and `liqPx`, and has no `product`. `p.coin`, `p.side`, `p.entryPx` and `p.markPx`
   do match. The result is a heading and Entry/Mark, with no value, no size, no profit-or-loss line
   and no forced-close line.

7. **Trade's Rules panel reads three keys under the wrong names.**
   `ui/screens/trade.js:330-340` reads `m.summary`, `m.spentUsd` and `m.budgetUsd`. `MandateRow`
   (`src/trade/state.ts:140-161`) carries `english: string[]`, `used.notionalUsd` and
   `envelope.maxNotionalUsd`. Each rule renders as its bare `m.id` with no budget meter.

8. **The three overlay toggles are wired to a global the overlay does not read.**
   `ui/screens/trade.js:121, 200-201` writes `window.TRADE_OVERLAYS`.
   `ui/chart/trade-overlay.js:225` reads `data.overlays`, which comes from the `/api/trade` payload
   (`src/trade/state.ts:181`). Pressing a toggle changes nothing on the canvas. The server-side write
   that would move `overlays` is `POST /api/trade { overlay }` (`src/http/trade.ts:75`), which the
   window never calls.

Items 5 through 7 are the same class of bug `tests/unit/trade-fills-ui.test.ts` was written for on the
`fills` list. The fills path is correct; the four beside it are not, and no test covers them.

### E. Where the code and the existing spec disagree

Against `docs/superpowers/specs/2026-09-01-phosphor-v1-reliable-boat-design.md` section 4
(`:143-167`):

1. **The window token no longer travels in an environment variable.** The spec says
   `PHOSPHOR_WINDOW_TOKEN`, and that when absent a bare `npm run app` mints one and prints it to
   stderr (`spec:166-167`). The token now arrives on the backend's **stdin**, first line
   (`src/http/auth.ts:64-85`); the variable name survives only so a test can assert it is unset
   (`src/http/auth.ts:34-37`). The stderr-minting half is still true
   (`src/http/auth.ts:125-129`), but a shell-started process now **refuses to boot** rather than
   minting (`src/http/auth.ts:74-79`).

2. **`/api/state`'s `lock` carries a third key.** The spec names
   `{ state, idleLocksInSec }` (`spec:151`); the code also sends `addresses`
   (`src/http/state.ts:75`).

3. **The custody refusal shape gained a field and changed the meaning of `error`.** The spec says
   `{ ok: false, error: 'wrong_password' | 'no_wallet' | 'locked_out' }` (`spec:152`). The code sends
   `{ ok: false, error: <an English sentence>, code: <the machine code>, retryInSec? }`
   (`src/http/wallet.ts:104-115`), and adds a fourth code, `damaged`
   (`src/http/wallet.ts:100`). The change is documented in place: a client switching on `error`
   printed `wrong_password` at a person (`src/http/wallet.ts:88-95`).

4. **Address keys are `evm`, `solana`, `near`, `nearPublicKey`.** The spec writes
   `{ evm, sol, near }` for `/api/wallet/create` and `/api/wallet/import`
   (`spec:154-155`). `StoredAddresses` is at `src/keystore/store.ts:75`.

5. **`/api/wallet/create` returns `mnemonic` as a `string[]` of whatever length the keystore made**,
   not a fixed `string[12]` (`spec:154` vs `src/http/wallet.ts:198`, which splits on spaces).

6. **`/api/wallet/migrate` returns two extra fields**, `addresses` and a `note` about APFS snapshots
   (`spec:156` vs `src/http/wallet.ts:252-259`).

7. **`/api/wallet/export` refuses on a wrong password with a 200 refusal body**, and verifies rather
   than unlocks. The spec says only `{ ok: true }` (`spec:158` vs
   `src/http/wallet.ts:272-285`).

8. **`/api/receive` returns a second key, `state`** (`spec:159` vs
   `src/http/wallet.ts:423`).

9. **`/api/reconcile` returns two extra fields**, `detail` and `id` (`spec:161` vs
   `src/http/mutation.ts:260`).

10. **`/api/health` returns a field the spec does not list**, `auditChain`
    (`spec:150` vs `src/http/health.ts:32, 85`).

11. **The SSE frame list is incomplete in the spec.** It names `candle` and `lock` as the new frames
    (`spec:163`). The live set is ten types: `state`, `lock`, `transactions`, `chart`, `trade`,
    `activity`, `log`, `candles`, `candle`, `driver` (section 4). The spec does not mention that
    `transactions`, `activity` and `log` exist.

12. **The spec's `/api/state` line does not mention `theme` or `view`**, both of which the window
    depends on for its two `store.select` calls in `ui/app.js:19-28`
    (`src/http/state.ts:125, 128`).
