# Phosphor as an installed desktop app

Date: 2026-08-19
Status: built and verified 2026-08-19

## Goal

Phosphor installs like any other Mac app. You drag `Phosphor.app` to `/Applications`,
double-click it, and the control window opens. No terminal, no `npm run app`, no Node
on the machine.

The reference is WARDEN: a Tauri 2 bundle, `targets: "app"`, unsigned, dragged into
place by hand.

## What must not change

The security model. `src/server.ts` refuses any request whose `Host` header is not
`127.0.0.1` or `localhost`, and it monkey-patches `http.Server.listen` so a bare port
can never bind to every interface. Those two guards, plus the session token, are what
stop a webpage from reaching the approval surface. The whole build is arranged around
leaving them untouched.

The approval click also stays where it is: a human click in the app window, on a
surface no agent can reach.

## Architecture

A Tauri 2 shell that owns the window and the process, and the existing Node app,
unchanged, running underneath as a sidecar.

```
Phosphor.app
  Contents/
    MacOS/
      phosphor-desktop          Rust launcher (Tauri)
      node                      Node 24 runtime, 115MB, bundled as an externalBin
    Resources/
      phosphor/                 the payload, this directory is the old repo root
        src/  ui/  data/  skills/  node_modules/  config.json
```

On launch the Rust side:

1. Checks whether something already answers on the configured port. If it is Phosphor,
   it shows the window and spawns nothing. If it is not Phosphor, it stops with a
   readable error instead of racing for the port.
2. Spawns `Resources/node Resources/phosphor/src/main.ts` with the environment below.
3. Polls the port until the server answers, then opens the window at
   `http://127.0.0.1:<port>`.
4. Kills the child on quit, including on force-quit of the window.

### Why the window loads a loopback URL, not bundled files

Serving `ui/` from `tauri://localhost` would make every API call cross-origin and
force a rewrite of the CSRF and DNS-rebind defenses. Loading `http://127.0.0.1:4177`
leaves the origin model exactly as reviewed.

It also buys a second property: the window is a plain remote page with no Tauri IPC
bridge. A page that somehow got compromised has no route into Rust at all. Anything
the app needs from the native side is a menu item, not an IPC call.

### Why Node ships whole, not bundled or compiled

The `listen` patch in `src/server.ts` depends on Node's own `http.Server` internals,
and it is load-bearing for the "loopback only" guarantee. Bun's `node:http` is a
reimplementation, so `bun build --compile` would put a security guard on top of
different internals. A bundler is also unnecessary: Node 24 runs the TypeScript
directly, which is how `npm run app` already works, so shipping `src/` verbatim means
the installed app runs byte-identical code to the reviewed tree.

Cost: about 200MB installed. Accepted.

## Paths after install

The payload directory is named `phosphor`, not `app`. That is deliberate. `root`
resolves to `Contents/Resources/phosphor`, so:

- `data/`, `skills/`, `ui/`, `src/`, `config.json` resolve with no code change.
- `defaultKeysPath` derives its slug from `path.basename(root)`, which stays
  `phosphor`. The installed app therefore reads the same
  `~/.phosphor/phosphor/keys.json` the repo checkout uses today. No migration, no
  second key, no surprise.

Writable state moves out of the read-only bundle:

| What | Where |
|---|---|
| `state/` (policy, audit log, store, caches) | `~/Library/Application Support/com.karimbabasf.phosphor/state` |
| `config.local.json` | `~/Library/Application Support/com.karimbabasf.phosphor/` |
| keys | `~/.phosphor/phosphor/keys.json`, unchanged |

`PHOSPHOR_DATA_DIR` already exists and already accepts an absolute path, so the state
directory needs no code change. `config.local.json` does: `loadConfig` reads it from
the same directory as `config.json`, which is now read-only.

### The one code change

`loadConfig` gains `PHOSPHOR_CONFIG_DIR`. When set, `config.local.json` is read from
there instead of from the payload directory. `config.json` stays where it is, since
it is the committed template and never written. Unset, every path behaves exactly as
it does today, so the repo workflow and the 1003 tests are unaffected.

## Connecting an agent

`src/mcp.ts` is launched by the agent, not by the app, so it needs a stable absolute
path that survives installation:

```
/Applications/Phosphor.app/Contents/MacOS/node
/Applications/Phosphor.app/Contents/Resources/phosphor/src/mcp.ts
```

The app carries a native menu item, Phosphor > Copy MCP config, that puts the full
`claude mcp add-json` line on the clipboard with the real installed paths filled in.
Native menu rather than a button in the page, because the page has no IPC bridge and
should not get one.

`resolvePort` in `src/mcp.ts` reads `config.json` next to itself, which still works:
the port lives in the committed template. A port changed in the installed
`config.local.json` would not reach the MCP proxy, so the copied command sets
`PHOSPHOR_PORT` explicitly.

## Dev workflow

Unchanged. `npm run app` from the repo still works, still writes to `state/`, still
reads `config.local.json` from the repo root. The bundle is additive: a build script
plus `src-tauri/`, and one env-var branch in `config.ts`.

## Phases

1. `PHOSPHOR_CONFIG_DIR` in `config.ts`, with tests.
2. Payload build script: prune `node_modules` to runtime files, stage
   `Contents/Resources/phosphor`, copy the Node binary.
3. Tauri shell: port probe, sidecar spawn, readiness poll, window, teardown.
4. Copy-MCP-config menu item.
5. Build, install, launch, verify the real app end to end.

## What the build corrected

Three things the design got wrong, kept here because each one is silent.

**The crate cannot be called `phosphor`.** Tauri stages resource directories next to the
compiled binary, so a resource mapped to `phosphor` and a binary named `phosphor` claim
the same path. The build dies on `failed to remove file target/release/phosphor`, which
does not sound like a naming collision. The binary is `phosphor-desktop`; the payload
directory keeps the name it needs for the key path.

**Pruning `node_modules` by directory name breaks viem.** An early prune dropped
directories called `test/`, `tests/` and `docs/`. viem ships its test-client actions in
`_esm/actions/test/`, so `npm ci` succeeded, the bundle looked right, and the app died on
first boot with `ERR_MODULE_NOT_FOUND`. The prune list is now extensions only: sourcemaps
and `.d.ts` declarations, which Node cannot load by definition. `scripts/bundle-payload.ts`
now boots the staged tree on the bundled runtime and requires a served page before the
build is allowed to finish, so this class of failure cannot reach a bundle again.

**The identifier could not end in `.app`.** `com.phosphor.app` collides with the bundle
extension and Tauri warns about it. It is `com.karimbabasf.phosphor`, which is also what
names the Application Support directory.

## Verified

Both launch paths were exercised against the installed bundle on 2026-08-19:

- Cold start on a free port spawns the bundled Node, serves the UI, and the WebKit process
  holds live connections to it. Quitting kills the backend and releases the port.
- Starting while a repo instance is already on the port spawns nothing, opens a window onto
  the running instance, and quitting leaves that instance alive.
- State landed in Application Support. The repo's own `state/` was untouched.
- Phosphor > Copy MCP Config produced the `claude mcp add-json` line with
  `/Applications/Phosphor.app` paths and the right port.

## Out of scope

Signing and notarization. The bundle is unsigned like WARDEN, so first launch needs a
right-click Open. Revisit if it ever ships to somebody else.
