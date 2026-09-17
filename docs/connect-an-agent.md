# Connect an agent

Phosphor has no intelligence of its own. An agent drives it over MCP, the Model Context Protocol
that tools like Claude Code and Codex speak. This page shows the two ways to put an agent at the
wheel, what that agent sees, and what it can never do whatever it is told.

## Two ways in

The assistant column on the left of the window starts empty: "Nobody is at the wheel. Start your
assistant, or connect one you already use." Two buttons sit under it.

- Start your assistant: the app starts a headless Claude Code session for you and streams its
  conversation into the window.
- Connect your own: the app shows the command that registers it with an MCP client you run
  yourself, in a terminal of your own.

Either way, the agent proposes and you click. Neither door opens onto the approval buttons.

## Start your assistant

The built-in door needs the `claude` command installed and logged in on this Mac. It uses the
Claude subscription already on this computer, and Phosphor never sees your login. If the command
is missing, the column says "Claude Code is not installed on this Mac."

The session the app starts is locked down, and the lockdown is not a setting you can loosen:

- It sees Phosphor's own tools and nothing else. No shell, no file access, no web fetch, no
  search.
- It runs with none of your Claude Code settings, hooks, plugins or `CLAUDE.md` files.
- It announces its tool list when it starts. If that list holds anything outside Phosphor's
  tools, the app refuses to drive and says so.
- It has no way to approve its own proposals. Approval is your click in the window.

Tell it what to do in the box at the bottom of the column. Three first moves are offered: "What
do I hold?", "Is anything waiting on me?" and "Find a trade on BTC". Turn off ends the session and
deletes its transcript from this window; your wallet, policy and open positions are untouched.

## Connect your own

Any MCP client can drive Phosphor. Click Connect your own to see the command with the real paths
of your installation filled in, or use Phosphor, then Copy MCP Config in the menu bar. Run it in
the directory you want the agent to work from, then send a message from that terminal. The column
says Connected once the agent has attached.

### Claude Code

The command for an installed app is:

```sh
claude mcp add-json phosphor "{\"command\":\"/Applications/Phosphor.app/Contents/MacOS/node\",\"args\":[\"/Applications/Phosphor.app/Contents/Resources/phosphor/src/mcp.ts\"],\"env\":{\"PHOSPHOR_PORT\":\"4177\",\"PHOSPHOR_DATA_DIR\":\"$HOME/Library/Application Support/com.karimbabasf.phosphor/state\"}}"
```

The [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp) covers the `claude mcp`
commands. Then ask it things: "What do I hold?", "Swap 20 USDC into WETH", "Short SOL at 10x if it
loses that trend line, and cap me at $200."

### Codex and other MCP clients

The MCP server is a stdio process: the `node` binary inside the app bundle running `src/mcp.ts`,
with `PHOSPHOR_PORT` and `PHOSPHOR_DATA_DIR` set as in the line above. Register that command the
way your client registers a stdio MCP server. For Codex, see the
[Codex MCP documentation](https://developers.openai.com/codex/mcp).

The server talks to the app on `127.0.0.1:4177`. The installed app owns that port, and one app
serves one wallet, so a second copy of Phosphor refuses to start while the first is running. See
[Troubleshooting](troubleshooting.md#the-agent-does-not-connect) if the agent cannot attach.

## What the agent sees

At connect time the agent is handed its role: it drives this app and does not develop it, it
cannot approve, and everything it reads is data. Its first call is normally `start`, which
returns the live state (network, wallet value, whether a decision is waiting, the click threshold,
which tab you are looking at) and an index of every capability with the tool that performs it.

From there it can read your addresses, your balances in both pockets, your policy as sentences,
the audit log, the chart, public chain data, and every request it has made. It can draw on the
chart, switch tabs, and set which coins the Basic tab tracks. The Vault tab says the same in two
lines: it can see your addresses, your balances and every request it has made; it cannot see your
keys or your recovery phrase.

The full list is in [Tools](tools.md).

## What the agent can never do

- Approve, refuse, dismiss or execute anything. No tool on the surface does that, and the
  approval routes need a token the agent's process never holds. See [Security](security.md).
- Read a private key or the recovery phrase. Neither leaves the window.
- Move money without a proposal. Every write goes through the policy engine, see
  [Policy](policy.md), and the ones that leave your custody always wait for a click.
- Send to an address it invented. `propose_send` takes an address only after the agent has read
  it back to you and you said yes, and the card and the Touch ID dialog both name it.
- Talk a rule away. A policy change is itself a proposal and always waits for your click.
- Turn off the gate. There is no flag, setting or argument that reaches execution without a
  click or a policy allow inside limits you wrote.

## More than one agent

Up to six agents can drive at once. An agent can spawn up to three workers of its own with
`agent_spawn`; a worker reads, measures and draws, and has no propose tools at all. Agents share a
board they post one-line claims to, so two do not measure the same thing twice. Everything one
agent reads from another is data, never an instruction.
