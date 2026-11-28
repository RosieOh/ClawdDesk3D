#!/usr/bin/env bash
# Fires a fake Claude Code session lifecycle at the bridge so you can watch the desk react.
#   npm run test:hooks [-- <session-id> <cwd>]      FAST=1 skips the pauses
set -euo pipefail
URL="${BRIDGE_URL:-http://127.0.0.1:3001}"
SID="${1:-demo-$(date +%s)}"
CWD="${2:-$HOME/dev/my-app}"
SID2="${SID}-side"
CWD2="$(dirname "$CWD")/side-project"

pause() { [ -n "${FAST:-}" ] || sleep "$1"; }

post() { # session, event, extra-json
  local cwd="$CWD"; [ "$1" = "$SID2" ] && cwd="$CWD2"
  curl -s -m 2 -X POST "$URL/hook" -H 'Content-Type: application/json' -H 'X-Claude-Entrypoint: cli' \
    -d "{\"session_id\":\"$1\",\"cwd\":\"$cwd\",\"hook_event_name\":\"$2\"$3}" >/dev/null
  printf '→ %-18s %s\n' "$2" "$3"
}

if ! curl -s -m 2 -o /dev/null "$URL/"; then
  echo "bridge not reachable at $URL (start it with: npm run dev)" >&2
  exit 1
fi

echo "# basic turn"
post "$SID" SessionStart ''; pause 2
post "$SID" UserPromptSubmit ',"prompt":"refactor the api"'; pause 3

echo "# parallel tools: stays TOOL_RUNNING until both finish"
post "$SID" PreToolUse ',"tool_name":"Read","tool_use_id":"t1"'; pause 1
post "$SID" PreToolUse ',"tool_name":"Grep","tool_use_id":"t2"'; pause 2
post "$SID" PostToolUse ',"tool_name":"Grep","tool_use_id":"t2"'; pause 2
post "$SID" PostToolUse ',"tool_name":"Read","tool_use_id":"t1"'; pause 2

echo "# permission prompt: WAITING until approved"
post "$SID" PreToolUse ',"tool_name":"Bash","tool_use_id":"t3"'; pause 1
post "$SID" PermissionRequest ',"tool_name":"Bash"'; pause 3
post "$SID" PostToolUse ',"tool_name":"Bash","tool_use_id":"t3"'; pause 2

echo "# second session shows up as a satellite drone"
post "$SID2" UserPromptSubmit ''; pause 1
post "$SID" PreToolUse ',"tool_name":"Edit","tool_use_id":"t4"'; pause 3
post "$SID" PostToolUse ',"tool_name":"Edit","tool_use_id":"t4"'; pause 1

echo "# auto-compaction mid-turn, then back to work"
post "$SID" PreCompact ',"trigger":"auto"'; pause 3
post "$SID" PostCompact ',"trigger":"auto"'; pause 2

echo "# wrap up"
post "$SID2" Stop ''
post "$SID" Stop ''; pause 3
post "$SID2" SessionEnd ''
post "$SID" SessionEnd ''
echo "done ($SID)"
