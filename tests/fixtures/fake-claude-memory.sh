#!/bin/sh
# A stand-in for the claude binary that announces one init event and then waits.
#
# It exists so tests/unit/driver-memory.test.ts can drive the real parser in src/driver.ts over a
# real child process without needing Claude Code installed and without paying for a model turn.
# The init event says the child loaded auto-memory, which is the thing the driver has to refuse.
printf '%s\n' '{"type":"system","subtype":"init","session_id":"fake","tools":[],"mcp_servers":[{"name":"phosphor","status":"connected"}],"memory_paths":{"auto":"/Users/someone/.claude/projects/-repo/memory/"}}'
# Held open so the refusal is what ends the session rather than the child exiting on its own.
sleep 30
