# ClawdDesk 3D

A live 3D desk diorama that reacts to what Claude Code (CLI and VS Code) is doing, driven by Claude Code hooks.

```
Claude Code ──hooks (HTTP POST)──▶ server :3001 ──WebSocket──▶ client :5173 (R3F scene + HUD)
```

| State | Trigger | Visual |
|---|---|---|
| `OFFLINE` | `SessionEnd` / no sessions | slate light, core docked, rings folded flat |
| `IDLE` | `SessionStart`, `Stop`, idle `Notification` | amber glow, breathing float, visor pulse |
| `WAITING` | permission / input `Notification` | rose glow, blinking visor, HUD shows **NEEDS YOU** |
| `GENERATING` | `UserPromptSubmit`, `PostToolUse(Failure)` (last tool done), auto-compaction finished | counter-spinning gyroscope, bloom, token fountain, keyboard clacking |
| `TOOL_RUNNING` | `PreToolUse` (stays until *every* parallel tool is done), `PreCompact` | cyan (emerald for Edit/Write) laser scanning the code cube, rack LEDs, tool badge (`Bash +1` when several run) |

## Run

```bash
npm install        # once — installs server + client (npm workspaces)
npm run dev        # starts bridge (:3001) and client (:5173) together
```

Open http://localhost:5173. With no bridge it runs in **SIMULATOR MODE**; the dock (keys `1`–`7`, `0` clears satellites, `M` toggles sound) works either way.

Smoke-test the bridge without Claude: `npm run test:hooks`. Unit tests (bridge state machine + origin policy) and the client typecheck: `npm test`.

## Wire up Claude Code

Merge the `hooks` block from [`hooks/claude-settings.hooks.json`](hooks/claude-settings.hooks.json) into `~/.claude/settings.json` (keep any hooks you already have). New sessions pick it up; it applies to both the CLI and the VS Code extension.

It registers these events:

| Event | Hook type | Route |
|---|---|---|
| `SessionStart` | command (curl) | `/hook/session-start` |
| `UserPromptSubmit` | http | `/hook/generating` |
| `PreToolUse` | http, matcher `*` | `/hook/tool-use` |
| `PostToolUse`, `PostToolUseFailure` | http, matcher `*` | `/hook/tool-done` |
| `Notification`, `Stop` | http | `/hook/idle` |
| `SubagentStop`, `PreCompact` | command (curl) | `/hook` |
| `SessionEnd` | http | `/hook/offline` |

Notes:
- **SessionStart uses a `command` hook** (curl) because Claude Code doesn't accept `http` hooks on `SessionStart`. Its output goes to `/dev/null` so nothing is injected into Claude's context.
- The payload's `hook_event_name` always wins over the route, so e.g. a `Notification` posted to `/hook/idle` becomes `WAITING` when it's a permission prompt.
- **Parallel tools** are tracked by `tool_use_id`; the desk leaves `TOOL_RUNNING` only when the last one reports `PostToolUse`/`PostToolUseFailure`. `Stop` clears anything left dangling (e.g. a denied permission).
- **`PreCompact`** shows a `Compact` tool; the `SessionStart` (source `compact`) that follows returns to `GENERATING` for auto-compaction and `IDLE` for `/compact`. `SubagentStop` is only a keep-alive.
- The `X-Claude-Entrypoint` header lets the HUD tell VS Code sessions from CLI ones.
- If the bridge is down, hooks fail fast as non-blocking errors; Claude Code carries on normally. The bridge answers every hook with an empty `200` before processing.

## Bridge API

`POST /hook/{session-start|generating|tool-use|tool-done|idle|offline}` · `POST /hook` (dispatches on `hook_event_name`) · `GET /state` · WebSocket on the same port sends `{type:"snapshot", reason, sessions[]}`.

Sessions are keyed by `session_id`; the project name is the `cwd` basename. Sessions expire after 10 minutes of silence, and ended sessions disappear after 1 minute.

## Security

The bridge binds to loopback **and** only accepts browser requests and WebSocket connections whose `Origin` is a loopback page (`http(s)://localhost|127.0.0.1|[::1]` on any port). Requests without an `Origin` (Claude Code hooks, curl) are allowed. This stops arbitrary websites you visit from reading your session paths over the WebSocket or faking hook events. To serve the client from somewhere else, list it explicitly:

```bash
CLAWDDESK_ALLOWED_ORIGINS=https://desk.example,http://192.168.0.10:5173 npm run dev
```

## Ports

The bridge binds to `127.0.0.1` only. If 3001 is taken (e.g. by VS Code Live Preview), it exits with a clear message. To move it:

```bash
CLAWDDESK_PORT=3101 VITE_BRIDGE_URL=ws://127.0.0.1:3101 npm run dev
```

…and change `3001` → `3101` in your hook URLs. Vite automatically moves to the next free port if 5173 is taken.

## Layout

```
server/index.js          Express + ws bridge (HTTP, WebSocket, origin guard)
server/core.js           pure session state machine + origin policy
server/core.test.js      node:test unit tests
client/src/store.ts      Zustand: sessions, derived view, sim override, combo/focus stats
client/src/bridge.ts     WebSocket client with backoff reconnect
client/src/audio.ts      Web Audio clicks + generating hum
client/src/scene/        R3F scene — all procedural geometry (no .glb assets)
client/src/scene/fonts.ts local .woff files for 3D text
client/src/hud/Hud.tsx   Glass HUD + play dock
hooks/                   settings.json snippet
scripts/test-hooks.sh    fake session lifecycle
```

Fonts (Inter, JetBrains Mono) are bundled from `@fontsource`, so the app runs fully offline. One exception: if a project name contains characters outside Latin (e.g. Korean), troika fetches a fallback font for those glyphs from its CDN.
