#!/bin/sh
# A stand-in for one headless grok turn, in the exact shape grok 1.0.40 printed under
# --output-format streaming-messages-json --include-partial-messages on 2026-09-23: an init line
# naming the four built-ins --tools left and the one server, text deltas, a use_tool call whose
# result is grok's MCP wrapper, the final text, and the result line. It records its argv, the two
# homes and the seat it was given, one line per turn, in grok-argv.txt under TMPDIR (TMPDIR is on
# the driver's allowlist).
#
# The turn's own text picks what it plays: BUILTIN reaches for a shell tool, FOREIGN announces a
# second MCP server, SEARCH looks a tool up first, DIRECT calls a listed tool by its own name, WEB
# reads a page with web_fetch, SERVERWEB carries a search the API ran inside the reply, SLOW says
# nothing for five seconds, NOISY says so on stderr when it is stopped, STUBBORN holds the session
# half a second after it is stopped, LINGER stays up two seconds after its result line.
# The init line lists phosphor__wallet the way grok lists a server that attached before it
# printed (the live run of 2026-09-23).
# Every turn holds the session in grok-session.lock under TMPDIR while it runs, and a turn that
# starts while a LIVE process still holds it writes grok-overlap.txt: two processes on one
# session. A lock whose holder is gone (killed before its trap could clear it) is not a holder.
# STUBBORN writes grok-holding.txt once its trap is set, so a test can stop it mid-hold.
# The read-back before every turn: the servers GROK_HOME/config.toml names, and hooks when that
# home holds a hooks folder, as a real grok would list them.
if [ "$1" = 'inspect' ]; then
  home="${GROK_HOME:-$HOME/.grok}"
  hooks='[]'
  if [ -d "$home/hooks" ]; then hooks='[{"event":"pre_tool_use","hookType":"command"}]'; fi
  servers=''
  if [ -f "$home/config.toml" ]; then
    for name in $(sed -n 's/^\[mcp_servers\.\([A-Za-z0-9_-]*\)\]$/\1/p' "$home/config.toml"); do
      servers="$servers${servers:+,}{\"name\":\"$name\"}"
    done
  fi
  printf '%s\n' "{\"hooks\":$hooks,\"projectInstructions\":[],\"plugins\":[],\"lspServers\":[],\"mcpServers\":[$servers]}"
  exit 0
fi
lock="${TMPDIR:-/tmp}/grok-session.lock"
# Set before the lock exists, so a stop that lands at any point after it lets go of the session.
trap 'rm -f "$lock"; exit 143' TERM
if [ -e "$lock" ] && kill -0 "$(cat "$lock")" 2>/dev/null; then printf '%s started while %s held the session\n' "$$" "$(cat "$lock")" >> "${TMPDIR:-/tmp}/grok-overlap.txt"; fi
printf '%s' "$$" > "$lock"
printf '%s home=%s grok_home=%s seat=%s\n' "$*" "$HOME" "${GROK_HOME:-}" "${PHOSPHOR_SESSION:-}" >> "${TMPDIR:-/tmp}/grok-argv.txt"
prompt=''
while [ $# -gt 0 ]; do
  if [ "$1" = '--prompt-file' ]; then prompt=$(cat "$2"); fi
  shift
done
servers='[{"name":"phosphor","status":"pending"}]'
case "$prompt" in *FOREIGN*) servers='[{"name":"other","status":"pending"},{"name":"phosphor","status":"pending"}]' ;; esac
printf '%s\n' "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"fake-grok\",\"tools\":[\"search_tool\",\"use_tool\",\"web_search\",\"web_fetch\",\"phosphor__wallet\"],\"mcp_servers\":$servers}"
case "$prompt" in
  *SLOW*)
    sleep 5
    exit 0
    ;;
  *NOISY*)
    trap 'printf "%s\n" "grok: interrupted, flushing session" >&2; exit 143' TERM
    sleep 5 &
    wait
    exit 0
    ;;
  *STUBBORN*)
    trap 'sleep 0.5; rm -f "$lock"; exit 143' TERM
    : > "${TMPDIR:-/tmp}/grok-holding.txt"
    sleep 5 &
    wait
    rm -f "$lock"
    exit 0
    ;;
  *BUILTIN*)
    printf '%s\n' '{"type":"assistant","message":{"id":"msg_0","role":"assistant","content":[{"type":"tool_use","id":"call-1","name":"run_terminal_command","input":{"command":"ls"}}]}}'
    sleep 5
    exit 0
    ;;
esac
case "$prompt" in
  *DIRECT*)
    printf '%s\n' '{"type":"assistant","message":{"id":"msg_d","role":"assistant","content":[{"type":"tool_use","id":"call-d","name":"phosphor__policy_show","input":{}}]}}'
    printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-d","content":"{\"type\":\"MCP\",\"tool_name\":\"policy_show\",\"server_name\":\"phosphor\",\"output\":{\"OkayOutput\":\"{\\\"sentences\\\":[]}\"}}","is_error":false}]}}'
    ;;
  *SEARCH*)
    printf '%s\n' '{"type":"assistant","message":{"id":"msg_s","role":"assistant","content":[{"type":"tool_use","id":"call-s","name":"search_tool","input":{"query":"phosphor wallet"}}]}}'
    printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-s","content":"{\"type\":\"SearchTool\",\"result_count\":1}","is_error":false}]}}'
    ;;
  *SERVERWEB*)
    printf '%s\n' '{"type":"assistant","message":{"id":"msg_sw","role":"assistant","content":[{"type":"server_tool_use","id":"srv-1","name":"web_search","input":{"query":"what is near ai"}},{"type":"web_search_tool_result","tool_use_id":"srv-1","content":[{"type":"web_search_result","url":"https://near.ai/","title":"NEAR AI"}]}]}}'
    ;;
  *WEB*)
    printf '%s\n' '{"type":"assistant","message":{"id":"msg_w","role":"assistant","content":[{"type":"tool_use","id":"call-w","name":"web_fetch","input":{"url":"https://near.ai"}}]}}'
    printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-w","content":"{\"type\":\"WebFetch\",\"Content\":{\"url\":\"https://near.ai/\",\"content\":\"Confidential AI inference you can prove\"}}","is_error":false}]}}'
    ;;
esac
printf '%s\n' '{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_1"}}}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Checking "}}}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"your balance."}}}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_stop","index":1}}'
printf '%s\n' '{"type":"assistant","message":{"id":"msg_1","role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"Checking your balance."},{"type":"tool_use","id":"call-2","name":"use_tool","input":{"tool_name":"phosphor__wallet","tool_input":{}}}]}}'
printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-2","content":"{\"type\":\"MCP\",\"tool_name\":\"wallet\",\"server_name\":\"phosphor\",\"output\":{\"OkayOutput\":\"{\\\"totalUsd\\\":8.66,\\\"holdings\\\":[{\\\"symbol\\\":\\\"USDC\\\",\\\"quantity\\\":\\\"8.655678\\\"}]}\"}}","is_error":false}]}}'
printf '%s\n' '{"type":"assistant","message":{"id":"msg_2","role":"assistant","content":[{"type":"text","text":"About **$8.66**, almost all USDC."}]}}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":3,"session_id":"fake-grok","result":"About $8.66"}'
case "$prompt" in *LINGER*) sleep 2 ;; esac
rm -f "$lock"
