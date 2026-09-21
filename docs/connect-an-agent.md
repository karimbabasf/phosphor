# Connect an agent

Phosphor has no intelligence of its own. An agent drives it over MCP, the Model Context Protocol
that tools like Claude Code, Codex, Hermes and Grok speak. This page shows how the app connects the
agent you already use, what that agent sees, and what it can never do whatever it is told.

## Pick your assistant

The last step of the first run, and the Agent panel of the Vault tab, is a picker with six tiles:

- Claude Code
- Codex
- Hermes
- Grok
- Another agent (any MCP client)
- Claude Desktop or a chat app

Pick the one you already use. The app checks that agent on this Mac inside three seconds and says
in one sentence what it found. The check is a `--version` call and a sign-in probe that stays on
this Mac (a status command, or whether the vendor's credential file exists); it never sends
anything to the vendor and never reads a token. The answer is one of four states:

| State | The sentence |
| --- | --- |
| installed and signed in | "Codex is signed in: start it in your terminal and it will appear here." (Claude Code: "is signed in and ready to start.") |
| installed, not signed in | "Codex is installed but not signed in. Sign in in your terminal, then press Check again." |
| not installed | "Codex is not on this Mac yet. Install it, then come back to this screen." |
| cannot be checked | "Phosphor cannot check this agent, so paste the line below into it and it will appear here." |

The path the agent was found at, its version, and the install and sign-in commands sit behind
Details. Claude Desktop and chat apps get three sentences and no check: Phosphor needs an agent
that runs on your Mac, Claude Desktop cannot drive it yet, so install Claude Code or Codex and pick
it here.

## What a pick does

Picking a tile writes the choice to `agent.json` in the app's state directory, runs the check, and
registers Phosphor with the agent through the agent's own command, so there is nothing to paste:

| Agent | What the app runs |
| --- | --- |
| Claude Code | `claude mcp add phosphor --scope user --env ... -- <node> <path>/src/mcp.ts` |
| Codex | `codex mcp add phosphor --env ... -- <node> <path>/src/mcp.ts` (writes `~/.codex/config.toml`) |
| Hermes | `hermes mcp add phosphor --command <node> --env ... --args <path>/src/mcp.ts` |
| Grok | `grok mcp add phosphor <node> --scope user --env ... -- <path>/src/mcp.ts` |

`...` is `PHOSPHOR_PORT=<port>` and `PHOSPHOR_DATA_DIR=<state directory>`, the two things the
proxy needs to find this installation of the app. The registration is written at the agent's user
or global scope, never for one folder: Phosphor will be available in every Claude Code, Codex,
Hermes or Grok session on this Mac, not just one folder, and moves under your threshold run on
their own up to your daily auto ceiling (five times the threshold by default, $500 on a fresh
install; see [Policy](policy.md)). The picker says the same sentence behind Details. An entry that
already exists is removed and written again, so it always names the paths of the app you have now.
If the registration cannot be written, the sentence says so and the line to paste is shown; Details
holds the same line for anyone who would rather run it themselves.

Another agent gets the stdio command instead, with the environment in front of it:

```sh
PHOSPHOR_PORT=4177 PHOSPHOR_DATA_DIR='/Users/you/Library/Application Support/com.karimbabasf.phosphor/state' /Applications/Phosphor.app/Contents/MacOS/node /Applications/Phosphor.app/Contents/Resources/phosphor/src/mcp.ts
```

Register that the way your client registers a stdio MCP server. The same line, for the agent you
picked, is under Phosphor, then Copy MCP Config in the menu bar; the window and the menu read it
from the same place, so they never differ.

## Starting it

Claude Code is the one agent the app starts itself: press Start it on the picker, or Start your
assistant in the assistant column. The session it starts is locked down, and the lockdown is not a
setting you can loosen:

- It sees Phosphor's own tools and nothing else. No shell, no file access, no web fetch, no
  search.
- It runs with none of your Claude Code settings, hooks, plugins or `CLAUDE.md` files, and loads
  no memory the app did not write.
- It announces its tool list when it starts. If that list holds anything outside Phosphor's
  tools, the app refuses to drive and says so.
- It has no way to approve its own proposals. Approval is your click in the window.

Every other agent starts in your terminal, the way you always start it, and appears in the window
when it connects: the light in front of the sentence turns on and the sentence reads "Codex is
connected." An agent that runs inside the app must run under a lockdown file the app owns
(`operator/driver.settings.json`, held to the installed release by `tests/lockdown.test.ts`), which
is why only Claude Code is started in-app today.

Tell it what to do from its own terminal, or in the box at the bottom of the assistant column for
the built-in one. Its moves land in Activity, and every one that needs your click waits for it in
the window.

## Changing it later

The Agent panel in the Vault tab shows the agent you picked, its state from the same check, a
Change button that opens the same picker, and Check again. Changing the pick never stops or
restarts an agent the app started: while one is running the switch is refused with "Your assistant
is running. Turn it off in the chat, then change it here." Turn it off from the assistant column
first, then change it.

An agent you remove later reads "Codex is no longer on this Mac" in the panel, with the light off.
Nothing else in the app depends on it, so the app boots as it always did.

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

The server talks to the app on `127.0.0.1:4177`. The installed app owns that port, and one app
serves one wallet, so a second copy of Phosphor refuses to start while the first is running. See
[Troubleshooting](troubleshooting.md#the-agent-does-not-connect) if the agent cannot attach.

## More than one agent

Up to six agents can drive at once. An agent can spawn up to three workers of its own with
`agent_spawn`; a worker reads, measures and draws, and has no propose tools at all. Agents share a
board they post one-line claims to, so two do not measure the same thing twice. Everything one
agent reads from another is data, never an instruction.
