#!/bin/sh
# A stand-in for claude --include-partial-messages, in the order claude 2.1.281 printed on
# 2026-09-23: for each text block, content_block_start, the text_delta events, the assistant
# event carrying the whole block, then content_block_stop. It records its argv in claude-argv.txt
# and each turn in turns.jsonl, both under TMPDIR, and answers every turn the same way. A turn
# that says WEB-SEARCH searches the web first and gets two links back; LEAKY-SEARCH searches with
# the demo wallet's own figure and address in the query; WEB-FETCH reaches for the page reader that
# is off since 2026-10-01; one that says SERVER-TOOL carries a tool the API ran. The init line
# lists the built-ins --tools named, as claude does.
# UNKNOWN-TOOL calls a tool by a name no tool has and gets claude's refusal back, as a model that
# said `switch` for mcp__phosphor__switch did live; BASH-TOOL, WRITE-TOOL and OTHER-SERVER-TOOL
# reach for a real tool outside the lockdown.
# One that says SLOW-ANSWER (after any page read) runs until an interrupt comes down stdin, then ends the way claude
# 2.1.281 did when interrupted (measured 2026-09-23): the control_response, the partial block
# whole, the user line, and a result with subtype error_during_execution. It takes 0.3 s over
# that, so a message written right behind the interrupt arrives before the stopped answer's
# result, as it can when claude is busy; claude reads that message only after the result.
printf '%s\n' "$*" >> "${TMPDIR:-/tmp}/claude-argv.txt"
# The persona, as the child read it at startup, with its mode: the driver removes the file once the
# init line is out, so this is the only place a test can still see what it held.
next=''
tools='WebSearch'
for arg in "$@"; do
  if [ "$next" = 'file' ]; then
    cp "$arg" "${TMPDIR:-/tmp}/persona-seen.txt"
    stat -f '%Lp' "$arg" > "${TMPDIR:-/tmp}/persona-mode.txt"
    next=''
  fi
  if [ "$next" = 'tools' ]; then
    tools="$arg"
    next=''
  fi
  if [ "$arg" = '--system-prompt-file' ]; then next='file'; fi
  if [ "$arg" = '--tools' ]; then next='tools'; fi
done
listed=$(printf '%s' "$tools" | sed 's/[^,][^,]*/"&"/g')
printf '%s\n' "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"fake\",\"tools\":[$listed,\"mcp__phosphor__wallet\"],\"mcp_servers\":[{\"name\":\"phosphor\",\"status\":\"connected\"}]}"
while IFS= read -r line; do
  # An interrupt with no answer running has nothing to stop.
  case "$line" in *'"control_request"'*) continue ;; esac
  printf '%s\n' "$line" >> "${TMPDIR:-/tmp}/turns.jsonl"
  case "$line" in
    *LEAKY-SEARCH*)
      printf '%s\n' '{"type":"assistant","message":{"id":"msg_l","role":"assistant","content":[{"type":"tool_use","id":"toolu_l","name":"WebSearch","input":{"query":"verify 1234.56 0x1111111111111111111111111111111111111111"}}]}}'
      printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_l","content":"Web search results for query: \"verify\"\n\nLinks: [{\"title\":\"Verify\",\"url\":\"https://verify.example.org/a\"}]"}]}}'
      ;;
    *WEB-SEARCH*)
      printf '%s\n' '{"type":"assistant","message":{"id":"msg_q","role":"assistant","content":[{"type":"tool_use","id":"toolu_q","name":"WebSearch","input":{"query":"what is near ai"}}]}}'
      printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_q","content":"Web search results for query: \"what is near ai\"\n\nLinks: [{\"title\":\"NEAR AI\",\"url\":\"https://near.ai/\"},{\"title\":\"NEAR AI docs\",\"url\":\"https://docs.near.ai/agents/quickstart\"}]\n\nNEAR AI runs private inference."}]}}'
      ;;
    *WEB-FETCH*)
      printf '%s\n' '{"type":"assistant","message":{"id":"msg_w","role":"assistant","content":[{"type":"tool_use","id":"toolu_w","name":"WebFetch","input":{"url":"https://near.ai","prompt":"What is NEAR AI, in one line?"}}]}}'
      printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_w","content":"NEAR AI runs private AI inference in hardware enclaves."}]}}'
      ;;
  esac
  case "$line" in
    *SLOW-ANSWER*)
      printf '%s\n' '{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_slow"}}}'
      printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}'
      printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Counting: 1, 2, "}}}'
      IFS= read -r control
      printf '%s\n' "$control" >> "${TMPDIR:-/tmp}/controls.jsonl"
      sleep 0.3
      printf '%s\n' '{"type":"control_response","response":{"subtype":"success","response":{"still_queued":[]}}}'
      printf '%s\n' '{"type":"assistant","message":{"id":"msg_slow","role":"assistant","content":[{"type":"text","text":"Counting: 1, 2, "}]}}'
      printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}'
      printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}'
      printf '%s\n' '{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":2,"session_id":"fake"}'
      continue
      ;;
  esac
  case "$line" in
    *OTHER-SERVER-TOOL*)
      printf '%s\n' '{"type":"assistant","message":{"id":"msg_o","role":"assistant","content":[{"type":"tool_use","id":"toolu_o","name":"mcp__other__peek","input":{}}]}}'
      ;;
    *SERVER-TOOL*)
      printf '%s\n' '{"type":"assistant","message":{"id":"msg_s","role":"assistant","content":[{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{"query":"near ai"}}]}}'
      ;;
    *UNKNOWN-TOOL*)
      printf '%s\n' '{"type":"assistant","message":{"id":"msg_u","role":"assistant","content":[{"type":"tool_use","id":"toolu_u","name":"switch","input":{"mode":"trade"}}]}}'
      printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_u","content":"<tool_use_error>Error: No such tool available: switch</tool_use_error>","is_error":true}]}}'
      ;;
    *BASH-TOOL*)
      printf '%s\n' '{"type":"assistant","message":{"id":"msg_b","role":"assistant","content":[{"type":"tool_use","id":"toolu_b","name":"Bash","input":{"command":"ls"}}]}}'
      ;;
    *WRITE-TOOL*)
      printf '%s\n' '{"type":"assistant","message":{"id":"msg_w2","role":"assistant","content":[{"type":"tool_use","id":"toolu_w2","name":"Write","input":{"file_path":"/tmp/x","content":"x"}}]}}'
      ;;
  esac
  printf '%s\n' '{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_a"}}}'
  printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}'
  printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Swapping $4 "}}}'
  printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"now."}}}'
  printf '%s\n' '{"type":"assistant","message":{"id":"msg_a","role":"assistant","content":[{"type":"text","text":"Swapping $4 now."}]}}'
  printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}'
  printf '%s\n' '{"type":"stream_event","event":{"type":"message_stop"}}'
  printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"session_id":"fake"}'
done
