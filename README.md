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

## Menu bar app (macOS)

`ClawdDesk.app` runs the whole thing as a menu bar app: the bridge (or the one already running, e.g. `npm run dev`), the desk in a window, and a status dot in the menu bar.

```bash
npm run app:install     # build ClawdDesk.app and copy it to ~/Applications (opens it)
```

- **Menu bar dot**: amber idle, orange generating, cyan running a tool, pink when something needs you; a number next to it counts waiting permission requests. Its menu lists the sessions (project, state, model) and pending requests with **Approve / Deny**.
- **Open the desk** with ⌥⌘J from anywhere, from the menu, or by launching ClawdDesk again (Spotlight). Closing the window just hides it; the app stays in the menu bar (no Dock icon).
- **Notifications** while the desk is hidden: a permission request waiting, a task that took 30 s or more finished, or a turn that stopped with an error.
- **Answer Permissions from the Menu Bar** (menu toggle, off by default): also hold permission requests while the desk is hidden, so they can be answered from the menu or after a notification. Off, only a visible desk holds them.
- **Launch at Login** (menu toggle): starts in the menu bar only, with the bridge always on.
- The app accepts the desk from its own webview origin (`tauri://localhost`); voice, captions and clap detection work in its window as in the browser.

Built with Tauri 2 (no Xcode needed, just the Command Line Tools). The bundle is ad-hoc signed for this Mac.

### Camera presence

Turn on **Camera Presence** in the menu bar app and it watches whether you're at the desk, using Apple's Vision face detector on this Mac (one frame a second, nothing stored or sent; the camera light is on only while this is on). After 20 s without a face you count as away:

- the desk stops holding permission requests (nobody is there to answer), and notifications go out even with the desk window open;
- spoken announcements are kept instead of spoken; when you come back JARVIS says "Welcome back, sir. While you were away: …" with what happened.

The detector is a small Swift helper bundled inside the app (`clawddesk-presence`, built by `desktop/build.rs`); macOS asks once for camera access for ClawdDesk.

## Alerts, briefing and room lights

**GitHub alerts.** Every 5 minutes (`CLAWDDESK_GITHUB_INTERVAL`, seconds; `0` turns it off) the bridge asks your own `gh` CLI about the repositories of the sessions it knows: failing CI on your open pull requests, and reviews requested from you anywhere. The first look is a baseline; afterwards anything new is spoken ("Sir, CI failed on pull request ClawdDesk3D #12: …") and notified by the menu bar app. A new commit that fails again counts as new. Nothing leaves your Mac except `gh`'s own calls to GitHub.

**Daily briefing.** The first time the desk wakes up each day (voice turned on, or back at the desk with camera presence), JARVIS greets you by the time of day and sums up: sessions online, your open PRs, failing CI and waiting reviews. Ask for it any time: "briefing", "what's new?", "브리핑". (Calendar is not included: there's no calendar access.)

**Philips Hue.** `npm run hue:pair` finds your bridge (Philips' discovery service, or `-- --ip <address>`), asks you to press its link button and writes `~/.config/clawddesk/hue.json` (mode 600). Restart the bridge and the room follows the desk: warm white with no sessions, amber idle, orange generating, cyan running a tool, pink with one breathing pulse when a permission waits. Pick a room with `-- --group <id>` (the pairing lists them); lights are never switched off, and the bridge sends at most one group command a second over the Hue local API.

## Approve from the desk

When Claude Code asks for permission (a `PermissionRequest`), the desk shows a card with the project, the tool and what it wants to do (the command, file or URL), a countdown and **Approve / Deny**. The answer goes straight back to Claude Code, which then runs the tool or carries on without it.

- The bridge only holds the request while a desk is **visible on screen**; with no desk, or the tab hidden or minimized, Claude Code shows its normal prompt immediately.
- If nobody answers within 30 s (`CLAWDDESK_APPROVAL_TIMEOUT`, seconds), the normal prompt appears.
- Approve passes the original input back unchanged, so your deny/ask permission rules still apply. Tools that need your own input (`AskUserQuestion`, `ExitPlanMode`) are never answered from the desk.
- Answers are only accepted from the desk page (an allowed `Origin`), never from other websites; there is no keyboard shortcut, so nothing gets approved by accident.

This uses the `PermissionRequest` **http** hook (`/hook/permission`); run `npm run hooks:install` again after updating.

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

### Your own voice (voice lab)

The voice lab also transcribes spoken commands (below). The desk can speak with a voice cloned from **your own recording**: F5-TTS running locally on Apple Silicon (MLX), zero-shot from a ~10 s reference clip, no training run. Use your own voice or that of someone who agreed to it; don't clone people who haven't.

```bash
npm run voice:setup     # once: Python 3.12 env in voice-lab/.venv (~2-3 GB incl. the model on first start)
npm run voice:record    # read one sentence; saves voice-lab/my-voice/reference.wav + reference.txt
npm run voice:serve     # http://127.0.0.1:3003, keep it running next to npm run dev
```

The bridge notices the lab within ~10 s and tells the page (the voice button turns into **MY VOICE**) and uses it for English lines; Korean keeps the system voice (the model speaks English and Chinese). A short line takes ~1.5-3 s to generate the first time on an M-series Mac, then comes from the cache in `voice-lab/cache/`. `--steps` / `--method` trade quality for speed (default: euler, 16 steps). The server answers only loopback pages and runs everything on one worker thread. `voice-lab/my-voice/`, `voice-lab/cache/` and `voice-lab/.venv/` are gitignored. Model weights are CC-BY-NC: fine for personal use, not for commercial use.

Priority when speaking: a voice-pack clip for that moment → your cloned voice (English) → the browser's voice.

## Voice commands

With the voice lab running (`npm run voice:serve`; a reference recording is optional, transcription works without one), press **Space** or **🎙 TALK** and speak; a double clap while JARVIS is awake does the same ("Yes, sir?"). Recording stops by itself after a short pause, is transcribed on this Mac by Whisper (`whisper-large-v3-turbo` via MLX, Korean and English, under a second for a sentence) and then:

| You say | JARVIS |
|---|---|
| "status", "how's it going?", "상태 알려줘" | reads the session status |
| "be quiet", "조용히 해줘" | turns the voice off |
| "never mind", "취소" | drops it |
| anything else, e.g. "Jarvis, run the tests and tell me what fails" | runs it as a task for Claude in the **project of the session shown on the desk** |

A task runs as `claude -p "<what you said>"` in that session's folder, started by the bridge. It is a normal headless Claude Code session: it appears on the desk, and tools that need permission come to the desk's Approve / Deny (with no approver, Claude Code denies them, as headless runs always do). When it finishes, JARVIS reads the start of Claude's answer and the caption shows more. At most two tasks run at once; each is stopped after 15 minutes. Only the desk page or the menu bar app can start tasks.

## Double clap

Press **C** (or **👏**) to let the page listen to the microphone. Then a **double clap**:

- while the voice is off: wakes JARVIS (voice on, "At your service, sir.")
- while it is on: "Yes, sir?" and it listens for a command (see above); without the voice lab, a status report instead ("Sir, 3 sessions are online. web-app is waiting for your approval. api is working.")

Detection runs in an AudioWorklet (so it also works with the tab in the background) on the raw signal: a clap is a sharp peak well above the room's noise floor that dies away within ~80 ms; two of them 150-700 ms apart make a double clap, so talking, music or a single knock don't trigger it. Audio never leaves the browser and nothing is recorded. The setting is remembered; the browser asks for microphone access once.

## Which session is on the desk

The HUD shows the Claude Code session the desk is following: short session id (click to copy the full id, e.g. for `claude --resume`), entrypoint (CLI / VS Code), model, permission mode, git branch, how it began (new / resumed / cleared) and the Claude Code version. The model, branch and version come from the last 64 kB of the session transcript (only `.jsonl` files under `~/.claude` or `$CLAUDE_CONFIG_DIR` are read); the rest comes from the hook payloads.

With several sessions open, the stats panel lists them all. The desk follows the most recently active one; click a session to pin it, click again (or **unpin**) to go back to following. A pin is released when its session ends and disappears.


The session panel also shows **token totals** for the session (↑ fresh input incl. cache writes, ↓ output, cache reads), summed from the transcript at each turn's end (no cost estimate: prices change and differ per plan). While a tool runs, its **command, file or URL** is shown under the tool chip and below the hologram badge, with anything that looks like a secret masked (`TOKEN=••••`, `Bearer ••••`, `sk-…`, `ghp_…`). Running **subagents** orbit the core as small sparks. Sessions are named after their **git repository**, so working in `repo/client` still shows `repo`.
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
| `PermissionRequest` | http, matcher `*`, timeout 45 s | `/hook/permission` (answers with the desk's decision) |
| `Elicitation`, `ElicitationResult` | command (curl), matcher `*` | `/hook` |
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
voice-lab/               local voice cloning server (F5-TTS / MLX) + reference recorder
desktop/                 menu bar app (Tauri 2): bridge, desk window, tray, notifications, ⌥⌘J
client/src/voice/        announcer, speech engines (browser, voice pack, voice lab), captions
client/src/sensors/      double-clap detector (AudioWorklet + pure detector)
.github/workflows/ci.yml CI: rustfmt, clippy, cargo test, client typecheck/tests/build
```

Fonts (Inter, JetBrains Mono) are bundled from `@fontsource`, so the app runs fully offline. One exception: if a project name contains characters outside Latin (e.g. Korean), troika fetches a fallback font for those glyphs from its CDN.
