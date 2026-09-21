# Live registration from the running demo backend on 4203, 2026-09-20 (re-captured on 1f2f29a plus the review fixes)

Vendor homes isolated and EMPTY before the run: CLAUDE_CONFIG_DIR, CODEX_HOME, GROK_HOME, HERMES_HOME under the session scratchpad, so the login probes read signed out and every file below was written by the vendor's own `mcp add` when the app picked it. POST /api/driver {action: agent-pick} per agent, twice for hermes to show the second write is idempotent.

- pick claude: HTTP 200, 2323 ms, state=installed_not_logged_in, registered=true, registrationFailed=false
- pick codex: HTTP 200, 153 ms, state=installed_not_logged_in, registered=true, registrationFailed=false
- pick grok: HTTP 200, 175 ms, state=installed_not_logged_in, registered=true, registrationFailed=false
- pick hermes: HTTP 200, 3650 ms, state=installed_not_logged_in, registered=true, registrationFailed=false
- pick hermes: HTTP 200, 3847 ms, state=installed_not_logged_in, registered=true, registrationFailed=false

## claude: claude/.claude.json (whole file, or the part the app wrote)
```
{
  "phosphor": {
    "type": "stdio",
    "command": "node",
    "args": [
      "/Users/karimbaba/Developer/Apps/phosphor-rfp-c-agent/src/mcp.ts"
    ],
    "env": {
      "PHOSPHOR_PORT": "4203",
      "PHOSPHOR_DATA_DIR": "/private/tmp/claude-501/-Users-karimbaba/c49886b8-5402-456e-8f99-4860322f1b81/scratchpad/rfp-c/data"
    }
  }
}
```

## codex: codex/config.toml (whole file, or the part the app wrote)
```
[mcp_servers.phosphor]
command = "node"
args = ["/Users/karimbaba/Developer/Apps/phosphor-rfp-c-agent/src/mcp.ts"]

[mcp_servers.phosphor.env]
PHOSPHOR_DATA_DIR = "/private/tmp/claude-501/-Users-karimbaba/c49886b8-5402-456e-8f99-4860322f1b81/scratchpad/rfp-c/data"
PHOSPHOR_PORT = "4203"
```

## grok: grok/config.toml (whole file, or the part the app wrote)
```
[mcp_servers.phosphor]
command = "node"
args = ["/Users/karimbaba/Developer/Apps/phosphor-rfp-c-agent/src/mcp.ts"]
enabled = true

[mcp_servers.phosphor.env]
PHOSPHOR_PORT = "4203"
PHOSPHOR_DATA_DIR = "/private/tmp/claude-501/-Users-karimbaba/c49886b8-5402-456e-8f99-4860322f1b81/scratchpad/rfp-c/data"
```

## hermes: hermes/config.yaml (whole file, or the part the app wrote)
```
_config_version: 45
mcp_servers:
  phosphor:
    command: node
    args:
      - /Users/karimbaba/Developer/Apps/phosphor-rfp-c-agent/src/mcp.ts
    env:
      PHOSPHOR_PORT: '4203'
      PHOSPHOR_DATA_DIR: /private/tmp/claude-501/-Users-karimbaba/c49886b8-5402-456e-8f99-4860322f1b81/scratchpad/rfp-c/data
    enabled: true

# ── Security ──────────────────────────────────────────────────────────
(the rest of the file is Hermes's own commented defaults)
```

## Backend log lines
```
phosphor app_start: the human picked Claude Code as the agent (was none)
phosphor app_start: claude registration written: Added stdio MCP server phosphor with command: node /Users/karimbaba/Developer...
phosphor app_start: the human picked Codex as the agent (was claude)
phosphor app_start: codex registration written: Added global MCP server 'phosphor'.
phosphor app_start: the human picked Grok as the agent (was codex)
phosphor app_start: grok registration written: Added stdio MCP server 'phosphor' with command: node /Users/karimbaba/Develop...
phosphor app_start: the human picked Hermes as the agent (was grok)
phosphor app_start: hermes registration written: Connecting to 'phosphor'...
phosphor app_start: the human picked Hermes as the agent (was hermes)
phosphor app_start: hermes registration written: Connecting to 'phosphor'...
```
