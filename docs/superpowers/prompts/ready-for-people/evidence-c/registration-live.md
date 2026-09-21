# Live registration from the running demo backend on 4203 (vendor homes isolated: CLAUDE_CONFIG_DIR, CODEX_HOME, GROK_HOME, HERMES_HOME under the session scratchpad), 2026-09-20

POST /api/driver {action: agent-pick} per agent, the answer, and what the vendor wrote:

- codex: 119 ms, state=installed_not_logged_in, registered=true. ~CODEX_HOME/config.toml:
```
[mcp_servers.phosphor]
command = "node"
args = ["/Users/karimbaba/Developer/Apps/phosphor-rfp-c-agent/src/mcp.ts"]

[mcp_servers.phosphor.env]
PHOSPHOR_DATA_DIR = "/private/tmp/claude-501/-Users-karimbaba/c49886b8-5402-456e-8f99-4860322f1b81/scratchpad/rfp-c/data"
```
- grok: 182 ms, registered=true. ~GROK_HOME/config.toml:
```
[mcp_servers.phosphor]
command = "node"
args = ["/Users/karimbaba/Developer/Apps/phosphor-rfp-c-agent/src/mcp.ts"]
enabled = true

[mcp_servers.phosphor.env]
```
- claude: 750 ms, registered=true. ~CLAUDE_CONFIG_DIR/.claude.json mcpServers:
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
- hermes: 3340 ms (its add connects to the proxy and reads 46 tools first), registered=true, twice (idempotent). ~HERMES_HOME/config.yaml:
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

```

Backend log lines:
```
phosphor app_start: the human picked Claude Code as the agent (was none)
phosphor app_start: claude registration written: Added stdio MCP server phosphor with command: node /Users/karimbaba/Developer...
phosphor app_start: the human picked Codex as the agent (was claude)
phosphor app_start: codex registration written: Added global MCP server 'phosphor'.
phosphor app_start: the human picked Hermes as the agent (was codex)
phosphor app_start: the human picked Grok as the agent (was hermes)
phosphor app_start: grok registration written: Added stdio MCP server 'phosphor' with command: node /Users/karimbaba/Develop...
phosphor app_start: hermes registration written: Connecting to 'phosphor'...
phosphor app_start: the human picked Another agent as the agent (was grok)
phosphor app_start: the human picked Claude Desktop or a chat app as the agent (was mcp)
phosphor app_start: the human picked Grok as the agent (was desktop)
phosphor app_start: grok registration written: Added stdio MCP server 'phosphor' with command: node /Users/karimbaba/Develop...
```
