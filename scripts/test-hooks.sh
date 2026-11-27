#!/usr/bin/env bash
# Fires a fake Claude Code session lifecycle at the bridge so you can watch the desk react.
set -euo pipefail
URL="${BRIDGE_URL:-http://127.0.0.1:3001}"
SID="${1:-demo-$(date +%s)}"
CWD="${2:-$HOME/dev/my-app}"

post() { # path, extra-json
  curl -s -m 2 -X POST "$URL/hook/$1" -H 'Content-Type: application/json' -H 'X-Claude-Entrypoint: cli' \
    -d "{\"session_id\":\"$SID\",\"cwd\":\"$CWD\"$2}" >/dev/null
  echo "→ $1 $2"
}

post session-start ',"hook_event_name":"SessionStart"'; sleep 2
post generating    ',"hook_event_name":"UserPromptSubmit","prompt":"refactor the api"'; sleep 3
post tool-use      ',"hook_event_name":"PreToolUse","tool_name":"Read"'; sleep 2
post tool-done     ',"hook_event_name":"PostToolUse","tool_name":"Read"'; sleep 2
post tool-use      ',"hook_event_name":"PreToolUse","tool_name":"Edit"'; sleep 3
post tool-done     ',"hook_event_name":"PostToolUse","tool_name":"Edit"'; sleep 1
post tool-use      ',"hook_event_name":"PreToolUse","tool_name":"Bash"'; sleep 3
post tool-done     ',"hook_event_name":"PostToolUse","tool_name":"Bash"'; sleep 2
post idle          ',"hook_event_name":"Stop"'; sleep 3
post offline       ',"hook_event_name":"SessionEnd"'
echo "done ($SID)"
