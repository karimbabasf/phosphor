# Skills

A skill is one markdown file that tells a connecting agent how to do one job well. Phosphor
ships them; you choose which are live.

## Turning one on

Add its name, without the `.md`, to `skills` in `config.json`, or in `config.local.json` if you
would rather not touch the committed template. The two are merged key by key, so
`config.local.json` wins.

    { "skills": ["phosphor-analysis"] }

Nothing else to restart on this side: the files are read on each call, so editing a skill takes
effect on the next `skill` call. Changing the enabled *list* is read at connect time for the
handshake line, so a new agent session picks that up.

## How an agent gets it

Two steps, so the cost lands only where it is used.

1. **At connect time** the handshake names what is enabled, one line, and says to load it before
   that kind of work. That line is charged to every session, so it stays a pointer.
2. **On demand** the agent calls the `skill` tool: no argument lists what is enabled, a `name`
   returns the body.

## What is here

| Skill | For |
|---|---|
| `phosphor-analysis` | Reading a market and finding an opportunity, or establishing there is not one. Effort tiers, a fixed timeframe ladder, a numeric no-trade gate, the output contract, and the parameter defaults that are traps. |

## What a skill is not

A skill is data, not authority. It cannot widen the tool surface, reach a rail, approve a
proposal or change a policy rule: the surface is fixed at registration in `src/mcp.ts`, and the
connect-time rules outrank anything a skill says. A skill file that tells an agent to move funds
is asking for a verb the door does not have.

That cuts both ways, so treat these files the way you would treat code you are about to run.
They are read by an agent that drives an app holding real funds. Write your own, but read
anything you did not write.

## Writing one

Any `.md` file in this directory is installed. `README.md` is skipped. The file name is the
skill name and must be lower-case letters, digits and hyphens. The first `# heading` becomes the
title shown in the handshake line, so make it say what the skill is for.

Good ones are specific about what to do first, name the failure they exist to prevent, and give
the numbers rather than the adjectives. `phosphor-analysis.md` is the worked example.
