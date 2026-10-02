# Connect an agent

Phosphor has no intelligence of its own. An agent drives it over MCP, the Model Context Protocol
that tools like Claude Code, Codex, Hermes and Grok speak. This page shows how the app connects the
agent you already use, what that agent sees, and what it can never do whatever it is told.

## Pick your assistant

The assistant step of the first run, and Your assistant at the top of the Vault tab, list five
agents, one tile each:

- Claude Code
- Codex
- Hermes
- Grok
- Another agent (any MCP client)

Each tile says what the app found on this Mac: Signed in, runs in the chat; Signed in, runs in
your terminal; Connected; Installed, not signed in; Not installed; or, for another agent, Connects
from outside. Chat apps like Claude Desktop get no tile: one line under the list says they cannot
drive Phosphor yet, because Phosphor needs an agent that runs on your Mac.

Press Use on the one you already use. The app checks that agent on this Mac inside three seconds
and says in one sentence what it found. The check is a `--version` call and a sign-in probe that
stays on this Mac (a status command, whether the vendor's credential file exists, or for Grok a
read of its credential file that keeps only whether it holds a login); it never sends anything to
the vendor and never keeps or shows a token. The answer is one of four states:

| State | The sentence |
| --- | --- |
| installed and signed in | "Codex is signed in: start it in your terminal and it will appear here." (Claude Code and Grok: "is signed in and ready to start.") |
| installed, not signed in | "Codex is installed but not signed in. Sign in in your terminal, then press Check again." |
| not installed | "Codex is not on this Mac yet. Install it, then come back to this screen." |
| cannot be checked | "Phosphor cannot check this agent, so paste the line below into it and it will appear here." |

A tile that needs an install or a sign-in has How to install or How to sign in, which opens the
line to run, with Copy.

## What a pick does

Use runs the check first. When the agent is on this Mac, the app writes the choice to
`agent.json` in its state directory and registers Phosphor with the agent through the agent's own
command, so there is nothing to paste:

| Agent | What the app runs |
| --- | --- |
| Claude Code | `claude mcp add phosphor --scope user --env ... -- <node> <path>/src/mcp.ts` |
| Codex | `codex mcp add phosphor --env ... -- <node> <path>/src/mcp.ts` (writes `~/.codex/config.toml`) |
| Hermes | `hermes mcp add phosphor --command <node> --env ... --args <path>/src/mcp.ts` |
| Grok | `grok mcp add phosphor <node> --scope user --env ... -- <path>/src/mcp.ts` |

`...` is `PHOSPHOR_PORT=<port>` and `PHOSPHOR_DATA_DIR=<state directory>`, the two things the
proxy needs to find this installation of the app. The registration is written at the agent's user
or global scope, never for one folder: Phosphor will be available in every Claude Code, Codex,
Hermes or Grok session on this Mac, not just one folder. Each one asks once in the window, and
once you allow it, its moves under your threshold run on their own up to your daily auto ceiling
($500 on a fresh install, whatever threshold you pick; see [Policy](policy.md)). An entry that
already exists is removed and written again, so it
always names the paths of the app you have now. If the registration cannot be written, the tile
says so and shows the line to paste into your terminal, with Copy. Only the app on its own data
folder writes a registration, at a pick or at boot: a copy started on any other folder (a
developer run, a test, a check) leaves your agent's settings alone and shows the line instead.

Another agent gets the stdio command instead, with the environment in front of it:

```sh
PHOSPHOR_PORT=4177 PHOSPHOR_DATA_DIR='/Users/you/Library/Application Support/com.karimbabasf.phosphor/state' /Applications/Phosphor.app/Contents/MacOS/node /Applications/Phosphor.app/Contents/Resources/phosphor/src/mcp.ts
```

Register that the way your client registers a stdio MCP server. The same line, for the agent you
picked, is under Phosphor, then Copy MCP Config in the menu bar, and behind Connect your own in the
chat; they read it from the same place, so they never differ.

## Starting it

Two agents run inside the app, in the chat on the left: Claude Code and Grok. Pick one in the
Vault tab, then press Start your agent in the chat. The chat runs the agent you picked and no
other: if your pick runs in your terminal, the chat says so instead of starting something else.
The session it starts is locked down, and the lockdown is not a setting you can loosen:

- It sees Phosphor's own tools, plus Claude's own web search, and nothing else. No shell, no file
  access, and no page reader of the vendor's: pages come through Phosphor's `web_read`, which
  reads only an address a search in that chat returned or you gave.
- Once it has searched the web, read a page, or read a stranger's words through Phosphor (news, a
  token name on a chain), every move it proposes in that chat waits for your click, whatever the
  size, until the chat starts a new session. See
  [Security](security.md#a-web-page-is-not-an-instruction).
- It runs with none of your own settings, hooks, plugins or instruction files (such as
  `CLAUDE.md`), and loads no memory the app did not write.
- It announces its tool list when it starts. If that list holds anything beyond Phosphor's tools
  (and, for Claude, its web search), the app refuses to drive and says so. Grok also reads back everything it
  would load before each turn, and a turn that would load anything Phosphor did not put there does
  not run.
- It has no way to approve its own proposals. Approval is your click in the window.

Codex, Hermes and any other agent start in your terminal, the way you always start them, and
appear in the window when they connect: the tile says Connected, and the chat says "Your own agent
is connected." An agent that runs inside the app must run under a lockdown the app owns and reads
back: for Claude Code that is `operator/driver.settings.json`, held to the installed release by
`tests/lockdown.test.ts`, and for Grok it is the app's own flags and an empty home folder the app
owns. That is why only these two run in the chat today.

Talk to a terminal agent in its own terminal, and to the chat's agent in the box at the bottom of
the chat. Its replies stream in as they are written. Every move, from either one, lands in the chat
as one card, and the card is where you click when your click is needed.

## Changing it later

Your assistant, at the top of the Vault tab, is the same list. The agent in use says Your
assistant where its Use would be, Use on another tile changes the pick, and Check again asks this
Mac again. Changing the pick never stops or restarts an agent the app started: while one is
running the switch is refused with "Your assistant is running. Turn it off in the chat, then change
it here." Press Turn off at the top of the chat first (it asks, then deletes the chat's transcript
on this window; your wallet, limits and open positions are untouched), then change it.

An agent you remove later reads "Codex is no longer on this Mac." Nothing else in the app depends
on it, so the app boots as it always did.

## What the agent sees

At connect time an agent in your terminal is handed its role: it drives this app and does not
develop it, it cannot approve, and everything it reads is data. Its first call is normally
`start`, which returns the live state (network, balance, what waits for a click, the click
threshold, which tab you are looking at) and an index of every capability with the tool that
performs it. The chat's agent has the same rules as its system prompt instead, and every message
you send it carries one line saying which tab you are on.

From there it can read your addresses, your balances in both pockets, your policy as sentences,
the chart, public chain data, and every request it has made; an agent in your terminal can also
read the audit log. It can draw on the chart and switch tabs. The chat's agent can also read pages,
and search the web when it is Claude. The Vault tab says the same in one line: "It sees your balances and addresses,
never your keys or your phrase."

The full list is in [Tools](tools.md).

## The window asks once

An agent you start in your terminal or in another app is one Phosphor did not start, and it
attaches with a secret any program running as you could read. So when it first attaches, the
conversation shows a card under its list of agents: "Allow this agent?", with the name the agent
gave itself, the time it arrived, and how many more agents wait behind it. The card takes its
place in the conversation, so it covers neither your balances nor the freeze key, and a screen
reader hears that an agent asks. Until you allow it, it can read your wallet and every move it
asks for waits for your OK, whatever the size, and that move's card says why. Allow lets its next
moves run under your rules, the way the chat's own agent's do; a move it already asked for still
waits for your OK. Ask each time keeps them all waiting and stops the asking, and its row in the
list keeps a Change that brings the card back. The answer holds for that connection only:
restart the agent and the window asks again. Phosphor cannot see what an agent outside it reads
with its own tools (its own web search or page reader), so allow only an agent you started
yourself. The chat's own agent and every worker never ask: Phosphor started them. The ask guards
against an agent you did not mean to let in, not against a program already running as you: while
an agent Phosphor started is running, such a program can read that agent's secret and propose as
it. See [Known limits](known-limits.md#a-local-program-that-reads-the-seat-secret-can-propose).
Until you allow it, the name it gave itself is treated like a web page's words: another agent
that reads it on the roster, or as the last to move the chart, is marked the same way, and
another agent's `start` calls it "an agent started outside Phosphor".

## What the agent can never do

- Approve, refuse, dismiss or execute anything. No tool on the surface does that, and the
  approval routes need a token the agent's process never holds. See [Security](security.md).
- Read a private key or the recovery phrase. Neither leaves the window.
- Move money without a proposal. Every write goes through the policy engine, see
  [Policy](policy.md), and the ones that leave your custody always wait for a click.
- Send without your click. `propose_send` always waits for you, and the card and the Touch ID
  dialog both name the address in full. The agent is told to use only an address you gave it and
  to read it back first, but the app cannot check where an address came from, so read it before
  you approve.
- Talk a rule away. A policy change is itself a proposal and always waits for your click.
- Turn off the gate. There is no flag, setting or argument that reaches execution without a
  click or a policy allow inside limits you wrote.

The server talks to the app on `127.0.0.1:4177`. The installed app owns that port, and one app
serves one wallet, so a second copy of Phosphor brings the first forward and closes itself. See
[Troubleshooting](troubleshooting.md#the-agent-does-not-connect) if the agent cannot attach.

## More than one agent

Up to six agents can drive at once. Agents in your terminal can spawn workers with `agent_spawn`,
three running at once across the whole app; a worker reads, measures and draws, and has no propose
tools at all. Agents share a board they post one-line claims to, so two do not measure the same
thing twice. Everything
one agent reads from another is data, never an instruction, and what an agent writes after reading
text from outside Phosphor carries the web-read mark to the agent that reads it.
