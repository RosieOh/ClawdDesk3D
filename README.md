# ClawdDesk 3D

A live 3D desk diorama that reacts to what Claude Code (CLI and VS Code) is doing, driven by Claude Code hooks.

```
Claude Code ──hooks (HTTP POST)──▶ server :3001 ──WebSocket──▶ client :5173 (R3F scene + HUD)
```

| State | Trigger | Visual |
|---|---|---|
| `OFFLINE` | `SessionEnd` / no sessions | slate light, core docked, rings folded flat |
| `IDLE` | `SessionStart`, `Stop`, `Notification` | amber glow, breathing float, visor pulse |
| `GENERATING` | `UserPromptSubmit`, `PostToolUse` | counter-spinning gyroscope, bloom, token fountain, keyboard clacking |
| `TOOL_RUNNING` | `PreToolUse` | cyan (emerald for Edit/Write) laser scanning the code cube, rack LEDs, tool badge |

## Run

```bash
npm install        # once — installs server + client (npm workspaces)
npm run dev        # starts bridge (:3001) and client (:5173) together
```

Open http://localhost:5173. With no bridge it runs in **SIMULATOR MODE**; the dock (keys `1`–`6`, `0` clears satellites, `M` toggles sound) works either way.

Smoke-test the bridge without Claude: `npm run test:hooks`.

## Wire up Claude Code

Merge the `hooks` block from [`hooks/claude-settings.hooks.json`](hooks/claude-settings.hooks.json) into `~/.claude/settings.json` (keep any hooks you already have). New sessions pick it up; it applies to both the CLI and the VS Code extension.

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "timeout": 5,
      "command": "curl -s -m 2 -X POST -H 'Content-Type: application/json' -H \"X-Claude-Entrypoint: $CLAUDE_CODE_ENTRYPOINT\" --data-binary @- http://127.0.0.1:3001/hook/session-start >/dev/null 2>&1 || true" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:3001/hook/generating", "timeout": 3, "headers": { "X-Claude-Entrypoint": "$CLAUDE_CODE_ENTRYPOINT" }, "allowedEnvVars": ["CLAUDE_CODE_ENTRYPOINT"] }] }],
    "PreToolUse":  [{ "matcher": "*", "hooks": [{ "type": "http", "url": "http://127.0.0.1:3001/hook/tool-use",  "timeout": 3, "headers": { "X-Claude-Entrypoint": "$CLAUDE_CODE_ENTRYPOINT" }, "allowedEnvVars": ["CLAUDE_CODE_ENTRYPOINT"] }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "http", "url": "http://127.0.0.1:3001/hook/tool-done", "timeout": 3, "headers": { "X-Claude-Entrypoint": "$CLAUDE_CODE_ENTRYPOINT" }, "allowedEnvVars": ["CLAUDE_CODE_ENTRYPOINT"] }] }],
    "Stop":         [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:3001/hook/idle",    "timeout": 3, "headers": { "X-Claude-Entrypoint": "$CLAUDE_CODE_ENTRYPOINT" }, "allowedEnvVars": ["CLAUDE_CODE_ENTRYPOINT"] }] }],
    "Notification": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:3001/hook/idle",    "timeout": 3, "headers": { "X-Claude-Entrypoint": "$CLAUDE_CODE_ENTRYPOINT" }, "allowedEnvVars": ["CLAUDE_CODE_ENTRYPOINT"] }] }],
    "SessionEnd":   [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:3001/hook/offline", "timeout": 3, "headers": { "X-Claude-Entrypoint": "$CLAUDE_CODE_ENTRYPOINT" }, "allowedEnvVars": ["CLAUDE_CODE_ENTRYPOINT"] }] }]
  }
}
```

Notes:
- **SessionStart uses a `command` hook** (curl) because Claude Code doesn't accept `http` hooks on `SessionStart`. Its output goes to `/dev/null` so nothing is injected into Claude's context.
- **`PostToolUse` → `/hook/tool-done`** is an addition: without it the desk would stay in `TOOL_RUNNING` until the turn ends.
- The `X-Claude-Entrypoint` header lets the HUD tell VS Code sessions from CLI ones.
- If the bridge is down, hooks fail fast as non-blocking errors; Claude Code carries on normally. The bridge answers every hook with an empty `200` before processing.

## Bridge API

`POST /hook/{session-start|generating|tool-use|tool-done|idle|offline}` · `POST /hook` (dispatches on `hook_event_name`) · `GET /state` · WebSocket on the same port sends `{type:"snapshot", reason, sessions[]}`.

Sessions are keyed by `session_id`; the project name is the `cwd` basename. Sessions expire after 10 minutes of silence, and ended sessions disappear after 1 minute.

## Ports

The bridge binds to `127.0.0.1` only. If 3001 is taken (e.g. by VS Code Live Preview), it exits with a clear message. To move it:

```bash
CLAWDDESK_PORT=3101 VITE_BRIDGE_URL=ws://127.0.0.1:3101 npm run dev
```

…and change `3001` → `3101` in your hook URLs. Vite automatically moves to the next free port if 5173 is taken.

## Layout

```
server/index.js          Express + ws bridge
client/src/store.ts      Zustand: sessions, derived view, sim override, combo/focus stats
client/src/bridge.ts     WebSocket client with backoff reconnect
client/src/audio.ts      Web Audio clicks + generating hum
client/src/scene/        R3F scene — all procedural geometry (no .glb assets)
client/src/hud/Hud.tsx   Glass HUD + play dock
hooks/                   settings.json snippet
scripts/test-hooks.sh    fake session lifecycle
```

The 3D text uses troika's default font, which is fetched from a CDN on first load, and the HUD fonts come from Google Fonts. Everything else runs offline.
