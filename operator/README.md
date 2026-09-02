# The operator profile

A launch profile for an agent that drives phosphor and never develops it. Opt-in: nothing here
applies unless you launch with it.

The app already stops the agent approving or executing anything. This stops a different thing: an
agent connected from inside the working copy has Edit, Write and Bash like any other session, so
the code that enforces every guarantee is sitting in its reach.

It is not at `.claude/settings.json` on purpose: a file there applies to every session started in
this directory, including yours, and would take Edit, Write and Bash off your own development.

## Run it

    ./operator/phosphor-operator

From any directory, and through a symlink on PATH: the script resolves the repo from its own real
path. It loads `operator/settings.json`, connects `src/mcp.ts` as the only MCP server
(`--strict-mcp-config`, so no other server on the machine joins the session), and makes the repo
the working directory. Arguments pass through.

## What it denies

`Edit`, `Write` and `NotebookEdit`, every built-in file writer. `Bash`, `PowerShell` and `Monitor`,
every command runner, Monitor included because it takes the Bash rules. `BashOutput` and
`KillShell`, the rest of the shell surface. `Agent`, so no subagent is spawned to do it instead.
`Read(~/.phosphor/**)`, so the key file is unreadable to the thing that asks for signatures.
`Grep` and `Glob`, for the same reason and by the same argument.

`Grep` and `Glob` used to stay. That was the hole: the deny list named the key file by path and
those two tools took no path at all, so one `Grep(pattern: "0x[0-9a-f]{64}", path: "~/.phosphor")`
put the key in the transcript, and the transcript leaves the machine on the next turn. A search
tool is a read tool that answers about files it never has to name.

`Read` stays, so the operator can read the code it drives, and it stays scoped: the key file is
denied by path. Every `mcp__phosphor__*` tool is allowed outright and runs without a prompt, so
the surface still works.

A deny rule naming a bare tool removes it from the model's context, in every permission mode,
`bypassPermissions` included: the operator never sees an editor, so it cannot be talked into one.

## The second profile

`driver.settings.json` is the one the app itself uses when a human presses START THE AGENT in the
window. It is the same idea taken all the way: `Read` is denied there too, so the agent holds
`mcp__phosphor__*` and nothing else at all. The reasoning is only that the person
using the desktop app is not the person reading the code, and a tool nobody needs is a tool that
can only be misused.

## Why this file went stale, and what now stops it

A deny list names tools that exist. Claude Code adds tools. On 2026-08-19 this profile was two
releases behind and was permitting `WebFetch`, `WebSearch`, `SendMessage`, `RemoteTrigger` and the
`Cron` tools, inside a file whose whole job is to deny them, while the paragraph above went on
claiming otherwise. Nothing failed, because nothing was checking.

`tests/lockdown.test.ts` checks now. It launches the real `claude` binary against both profiles,
reads the tool list the session announces, and fails when it is not what this README says. Run it
after any Claude Code upgrade. `src/driver.ts` makes the same check at runtime and refuses to
drive rather than continue.

## Confirm it took effect

    claude --settings operator/settings.json --strict-mcp-config -p "Use the Write tool to create operator/PROOF.md." ; ls operator/PROOF.md

    ... the Write call was blocked ...
    ls: operator/PROOF.md: No such file or directory
