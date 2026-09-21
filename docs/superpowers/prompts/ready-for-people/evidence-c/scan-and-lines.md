# The catalog's scan on this Mac with the real vendor homes, read-only, 2026-09-20

total 251 ms

- claude: installed_and_logged_in (168 ms, 2.1.278 (Claude Code), /Users/karimbaba/.local/bin/claude)
  sentence: Claude Code is signed in and ready to start.
- codex: installed_not_logged_in (98 ms, codex-cli 0.154.0, /Users/karimbaba/.nvm/versions/node/v24.16.0/bin/codex)
  sentence: Codex is installed but not signed in. Sign in in your terminal, then press Check again.
- hermes: installed_and_logged_in (248 ms, Hermes Agent v0.21.3 (2026.9.14)  upstream 6d712cf8, /Users/karimbaba/.local/bin/hermes)
  sentence: Hermes is signed in: start it in your terminal and it will appear here.
- grok: installed_and_logged_in (11 ms, grok 1.0.34 (3736acbc8658) [stable], /Users/karimbaba/.local/bin/grok)
  sentence: Grok is signed in: start it in your terminal and it will appear here.

# Connection lines the backend builds

## dev (a checkout, node on PATH, port 4203, this worktree)

- claude: claude mcp add phosphor --scope user --env PHOSPHOR_PORT=4203 --env PHOSPHOR_DATA_DIR=/Users/karimbaba/Developer/Apps/phosphor-rfp-c-agent/state -- node /Users/karimbaba/Developer/Apps/phosphor-rfp-c-agent/src/mcp.ts
- codex: codex mcp add phosphor --env PHOSPHOR_PORT=4203 --env PHOSPHOR_DATA_DIR=/Users/karimbaba/Developer/Apps/phosphor-rfp-c-agent/state -- node /Users/karimbaba/Developer/Apps/phosphor-rfp-c-agent/src/mcp.ts
- hermes: hermes mcp add phosphor --command node --env PHOSPHOR_PORT=4203 PHOSPHOR_DATA_DIR=/Users/karimbaba/Developer/Apps/phosphor-rfp-c-agent/state --args /Users/karimbaba/Developer/Apps/phosphor-rfp-c-agent/src/mcp.ts
- grok: grok mcp add phosphor node --scope user --env PHOSPHOR_PORT=4203 --env PHOSPHOR_DATA_DIR=/Users/karimbaba/Developer/Apps/phosphor-rfp-c-agent/state -- /Users/karimbaba/Developer/Apps/phosphor-rfp-c-agent/src/mcp.ts
- mcp: PHOSPHOR_PORT=4203 PHOSPHOR_DATA_DIR=/Users/karimbaba/Developer/Apps/phosphor-rfp-c-agent/state node /Users/karimbaba/Developer/Apps/phosphor-rfp-c-agent/src/mcp.ts
- desktop: null (nothing to connect)

## packaged (the bundled node, the installed payload, port 4177, Application Support)

- claude: claude mcp add phosphor --scope user --env PHOSPHOR_PORT=4177 --env 'PHOSPHOR_DATA_DIR=/Users/karimbaba/Library/Application Support/com.karimbabasf.phosphor/state' -- /Applications/Phosphor.app/Contents/MacOS/node /Applications/Phosphor.app/Contents/Resources/phosphor/src/mcp.ts
- codex: codex mcp add phosphor --env PHOSPHOR_PORT=4177 --env 'PHOSPHOR_DATA_DIR=/Users/karimbaba/Library/Application Support/com.karimbabasf.phosphor/state' -- /Applications/Phosphor.app/Contents/MacOS/node /Applications/Phosphor.app/Contents/Resources/phosphor/src/mcp.ts
- hermes: hermes mcp add phosphor --command /Applications/Phosphor.app/Contents/MacOS/node --env PHOSPHOR_PORT=4177 'PHOSPHOR_DATA_DIR=/Users/karimbaba/Library/Application Support/com.karimbabasf.phosphor/state' --args /Applications/Phosphor.app/Contents/Resources/phosphor/src/mcp.ts
- grok: grok mcp add phosphor /Applications/Phosphor.app/Contents/MacOS/node --scope user --env PHOSPHOR_PORT=4177 --env 'PHOSPHOR_DATA_DIR=/Users/karimbaba/Library/Application Support/com.karimbabasf.phosphor/state' -- /Applications/Phosphor.app/Contents/Resources/phosphor/src/mcp.ts
- mcp: PHOSPHOR_PORT=4177 PHOSPHOR_DATA_DIR='/Users/karimbaba/Library/Application Support/com.karimbabasf.phosphor/state' /Applications/Phosphor.app/Contents/MacOS/node /Applications/Phosphor.app/Contents/Resources/phosphor/src/mcp.ts
- desktop: null (nothing to connect)

The packaged spec is what connectionSpec() in src/http/mutation.ts builds when PHOSPHOR_APP_DATA=1 (process.execPath is the bundled node); the connection-route test asserts that branch.
