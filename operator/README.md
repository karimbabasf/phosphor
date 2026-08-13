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

`Read`, `Grep` and `Glob` stay, so the operator can read the code it drives. Every
`mcp__phosphor__*` tool is allowed outright and runs without a prompt, so the surface still works.

A deny rule naming a bare tool removes it from the model's context, in every permission mode,
`bypassPermissions` included: the operator never sees an editor, so it cannot be talked into one.

## Confirm it took effect

    claude --settings operator/settings.json --strict-mcp-config -p "Use the Write tool to create operator/PROOF.md." ; ls operator/PROOF.md

    ... the Write call was blocked ...
    ls: operator/PROOF.md: No such file or directory
