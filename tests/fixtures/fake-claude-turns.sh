#!/bin/sh
# A stand-in for the claude binary that announces a clean init event and then records the turns it
# is given, one JSON line per turn, in turns.jsonl under TMPDIR. TMPDIR rather than a variable of
# its own, because the driver hands its child an allowlisted environment (INHERITED_ENV in
# src/driver.ts) and TMPDIR is on it; the test points TMPDIR at a directory of its own.
#
# It exists so tests/unit/driver-prompt.test.ts can see what actually goes down the child's stdin
# without needing Claude Code installed and without paying for a model turn. The init event is
# clean on purpose: an empty tool list and a connected phosphor server, so assertSurface and
# assertMemory both pass and the driver reaches its ready state.
printf '%s\n' '{"type":"system","subtype":"init","session_id":"fake","tools":[],"mcp_servers":[{"name":"phosphor","status":"connected"}]}'
turns="${TMPDIR:-/tmp}/turns.jsonl"
: > "$turns"
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$turns"
done
