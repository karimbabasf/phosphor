#!/bin/sh
# A stand-in for the claude binary that plays one turn with one tool call, in the exact shape
# Claude Code's stream-json output carries it: the tool_use block names the tool and carries an
# id, and the tool_result block that answers it carries only `tool_use_id`, never a name.
#
# It exists so tests/unit/driver-tool-data.test.ts can drive the real parser in src/driver.ts
# over a real child process. The result's content is the one text block the MCP proxy wraps a
# JSON answer in (src/mcp-content.ts), so the test sees what the window will see.
printf '%s\n' '{"type":"system","subtype":"init","session_id":"fake","tools":[],"mcp_servers":[{"name":"phosphor","status":"connected"}]}'
printf '%s\n' '{"type":"assistant","message":{"id":"msg_01","type":"message","role":"assistant","model":"fake","content":[{"type":"tool_use","id":"toolu_01AbC","name":"mcp__phosphor__wallet","input":{}}],"stop_reason":"tool_use"},"parent_tool_use_id":null,"session_id":"fake"}'
printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01AbC","type":"tool_result","content":[{"type":"text","text":"{\"mode\":\"demo\",\"totalUsd\":12.5,\"holdings\":[{\"chain\":\"base\",\"symbol\":\"USDC\",\"amount\":12.5,\"usd\":12.5,\"native\":false}],\"screen\":{\"view\":\"basic\"}}"}]}]},"parent_tool_use_id":null,"session_id":"fake"}'
printf '%s\n' '{"type":"assistant","message":{"id":"msg_02","type":"message","role":"assistant","model":"fake","content":[{"type":"tool_use","id":"toolu_02XyZ","name":"mcp__phosphor__policy_show","input":{}}],"stop_reason":"tool_use"},"parent_tool_use_id":null,"session_id":"fake"}'
printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_02XyZ","type":"tool_result","content":"{\"version\":1,\"sentences\":[\"Never more than $50 in one move.\"]}"}]},"parent_tool_use_id":null,"session_id":"fake"}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":2,"session_id":"fake"}'
# Held open so the test reads the whole turn before the child leaves on its own.
sleep 30
