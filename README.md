# ClawdDesk 3D

A live 3D desk diorama that reacts to what Claude Code (CLI and VS Code) is doing, driven by Claude Code hooks.

```
Claude Code ──hooks (HTTP POST)──▶ bridge :3001 (Rust, axum) ──WebSocket──▶ client :5173 (R3F scene + HUD)
```

| State | Trigger | Visual |
|---|---|---|
| `OFFLINE` | `SessionEnd` / no sessions | slate light, core docked, rings folded flat |
| `IDLE` | `SessionStart`, `Stop`, idle `Notification` | amber glow, breathing float, visor pulse |
| `WAITING` | `PermissionRequest`, `Elicitation`, permission `Notification` | rose glow, blinking visor, HUD shows **NEEDS YOU** |
| `GENERATING` | `UserPromptSubmit`, `PostToolUse(Failure)` (last tool done), `ElicitationResult`, `PostCompact` after auto-compaction | counter-spinning gyroscope, bloom, token fountain, keyboard clacking |
| `TOOL_RUNNING` | `PreToolUse` (stays until *every* parallel tool is done), `PreCompact` | cyan (emerald for Edit/Write) laser scanning the code cube, rack LEDs, tool badge (`Bash +1` when several run) |

## JARVIS voice

Press **V** (or the **VOICE** button) and the desk talks, in English with a calm British butler voice by default (**EN/KO** switches to Korean):

| When | Says |
|---|---|
| a turn that took 15 s or more finishes | "Task complete, sir. It took 3 minutes." |
| Claude asks for permission / input | "Sir, I need your authorization to run Bash." |
| a turn stops with an error (`StopFailure`) | "I'm afraid the task has stopped with an error, sir." |
| a new session comes online | "web-app is online, sir." |
| a session ends | "web-app has gone offline, sir." |

With several sessions open, the project is named ("Sir, web-app requires your authorization…"). Every line also appears as a subtitle above the dock, voice on or off, and the core glows in time with the words while it speaks. Quick replies stay silent; dock buttons announce immediately, so the simulator can demo it.

It uses the browser's built-in speech (Web Speech API), so nothing to install. Voice preference: Jamie, then Daniel (British English), downloadable **Premium / Enhanced** versions first when present: on macOS add them under System Settings › Accessibility › Spoken Content › System voice › Manage Voices. Browsers only allow speech after a click or key press, so after a reload the first interaction re-enables it. Voice on/off and language are remembered per browser.

### Voice packs (your own recordings)

Recorded clips can replace the synthesized voice for each kind of announcement. Put a pack in `voicepack/` at the repo root (or point `CLAWDDESK_VOICEPACK` at a folder); the dev and preview servers serve it at `/voicepack/`, it is never bundled, and **`voicepack/` and `assets/` are gitignored**: only use recordings you have the right to use, and keep them out of the repository.

`voicepack/voicepack.json` (see [`voicepack.example.json`](voicepack.example.json)):

```json
{
  "name": "My pack",
  "volume": 0.9,
  "clips": {
    "greeting": ["clips/hello.wav"],
    "done": ["clips/done-1.wav", "clips/done-2.wav"],
    "permission": ["clips/need-approval.wav"],
    "failed": ["clips/error.wav"],
    "started": ["clips/online.wav"],
    "ended": ["clips/offline.wav"]
  }
}
```

Paths are relative to the pack folder (a symlink inside it to wherever the files live works). Several clips per kind are picked at random without repeating the last one; a kind with no clips falls back to the synthesized voice; the caption always shows the full sentence. WAV, MP3, OGG, M4A/AAC, FLAC and WebM are accepted (not WMA). When a pack is installed, the voice button shows its name; the core glows with the clip's loudness.

## Which session is on the desk

The HUD shows the Claude Code session the desk is following: short session id (click to copy the full id, e.g. for `claude --resume`), entrypoint (CLI / VS Code), model, permission mode, git branch, how it began (new / resumed / cleared) and the Claude Code version. The model, branch and version come from the last 64 kB of the session transcript (only `.jsonl` files under `~/.claude` or `$CLAUDE_CONFIG_DIR` are read); the rest comes from the hook payloads.

With several sessions open, the stats panel lists them all. The desk follows the most recently active one; click a session to pin it, click again (or **unpin**) to go back to following. A pin is released when its session ends and disappears.

## Run

Requires Node.js and a Rust toolchain ([rustup](https://rustup.rs)).

```bash
npm install        # once — installs the client
npm run dev        # builds + starts the bridge (:3001, cargo run) and the client (:5173) together
```

The first `npm run dev` compiles the bridge (a few tens of seconds); after that it starts instantly. While it runs, saving a file under `server/` rebuilds and restarts the bridge; if the build fails, the previous bridge keeps running. For an always-on bridge, build it once with `npm run build` and run `server/target/release/clawddesk-bridge` (≈3 MB binary, ≈15 MB RAM).

Open http://localhost:5173. With no bridge it runs in **SIMULATOR MODE**; the dock (keys `1`–`7`, `0` clears satellites, `M` toggles sound) works either way.

Smoke-test the bridge without Claude: `npm run test:hooks` (parallel tools, a permission prompt, a second session, auto-compaction; `FAST=1` skips the pauses).

`npm test` runs everything CI runs: bridge unit tests (`cargo test`), hook installer tests, the client typecheck and the client store tests (vitest).

## Wire up Claude Code

```bash
npm run hooks:install      # add the ClawdDesk hooks to ~/.claude/settings.json
npm run hooks:status       # which events are wired
npm run hooks:uninstall    # remove them again
```

The installer only adds or removes ClawdDesk's own hooks (marked with an `X-ClawdDesk` header or a `# clawddesk` comment); hooks from other tools and every other setting stay exactly as they were. It writes a timestamped backup next to the file first. Options: `--port <n>` for a non-default bridge port, `--settings <path>`, `--dry-run` (pass them after `--`, e.g. `npm run hooks:install -- --port 3101`). New sessions pick the hooks up, in both the CLI and the VS Code extension. The template is [`hooks/claude-settings.hooks.json`](hooks/claude-settings.hooks.json) if you prefer to merge by hand.

It registers these events:

| Event | Hook type | Route |
|---|---|---|
| `SessionStart` | command (curl) | `/hook/session-start` |
| `UserPromptSubmit` | http | `/hook/generating` |
| `PreToolUse` | http, matcher `*` | `/hook/tool-use` |
| `PostToolUse`, `PostToolUseFailure` | http, matcher `*` | `/hook/tool-done` |
| `Notification`, `Stop` | http | `/hook/idle` |
| `PermissionRequest`, `Elicitation`, `ElicitationResult` | command (curl), matcher `*` | `/hook` |
| `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact` | command (curl) | `/hook` |
| `SessionEnd` | http | `/hook/offline` |

Notes:
- **SessionStart uses a `command` hook** (curl) because Claude Code doesn't accept `http` hooks on `SessionStart`. Its output goes to `/dev/null` so nothing is injected into Claude's context.
- The payload's `hook_event_name` always wins over the route, so e.g. a `Notification` posted to `/hook/idle` becomes `WAITING` when it's a permission prompt.
- **Parallel tools** are tracked by `tool_use_id`; the desk leaves `TOOL_RUNNING` only when the last one reports `PostToolUse`/`PostToolUseFailure`. `Stop` clears anything left dangling (e.g. a denied permission).
- **`PermissionRequest` / `Elicitation`** switch to `WAITING` as soon as Claude asks; the permission `Notification` is kept as a fallback. `ElicitationResult` resumes work.
- **`PreCompact`** shows a `Compact` tool; `PostCompact` returns to `GENERATING` for auto-compaction and `IDLE` for `/compact` (the `SessionStart` with source `compact` does the same if `PostCompact` never arrives). `SubagentStart`/`SubagentStop` are only keep-alives.
- The new events use `command` hooks whose output goes to `/dev/null`, so they never return a decision (a `PermissionRequest` hook with no output leaves the normal permission dialog alone).
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
server/src/main.rs       axum bridge: hook routes, WebSocket, origin guard, sweeper
server/src/core.rs       pure session state machine + origin policy (+ unit tests)
client/src/store.ts      Zustand: sessions, derived view, sim override, combo/focus stats (+ store.test.ts)
client/src/bridge.ts     WebSocket client with backoff reconnect
client/src/audio.ts      Web Audio clicks + generating hum
client/src/scene/        R3F scene — all procedural geometry (no .glb assets)
client/src/scene/fonts.ts local .woff files for 3D text
client/src/hud/Hud.tsx   Glass HUD + play dock
hooks/                   settings.json snippet
scripts/hooks.mjs        hook installer / uninstaller (+ hooks.test.mjs)
scripts/dev-bridge.mjs   dev runner: rebuild + restart the bridge on change
scripts/test-hooks.sh    fake session lifecycle
.github/workflows/ci.yml CI: rustfmt, clippy, cargo test, client typecheck/tests/build
```

Fonts (Inter, JetBrains Mono) are bundled from `@fontsource`, so the app runs fully offline. One exception: if a project name contains characters outside Latin (e.g. Korean), troika fetches a fallback font for those glyphs from its CDN.
