//! ClawdDesk 3D — Claude Code hook bridge.
//! Receives Claude Code hook POSTs and broadcasts normalized session state over WebSocket.

pub mod approvals;
pub mod commands;
pub mod core;
pub mod project;
pub mod transcript;
pub mod voicelab;

use std::{
    future::Future,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{
        Path, Request, State,
        ws::{Message, WebSocket, WebSocketUpgrade, rejection::WebSocketUpgradeRejection},
    },
    http::{HeaderMap, HeaderValue, Method, StatusCode, header::ORIGIN},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::{net::TcpListener, sync::broadcast};
use tower_http::cors::{AllowHeaders, AllowOrigin, CorsLayer};

use crate::approvals::{Approvals, Behavior, Pending, decision_output, summarize};
use crate::commands::{Commands, Status as CommandStatus};
use crate::core::{
    Meta, ROUTE_EVENTS, Session, SessionStore, is_allowed_origin, parse_origin_list,
};
use crate::transcript::{TranscriptInfo, allowed_path, config_root, read_tail, usage_totals};
use crate::voicelab::LabInfo;

const SWEEP_INTERVAL: Duration = Duration::from_secs(15);
const VOICE_LAB_INTERVAL: Duration = Duration::from_secs(10);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
/// Hook payloads (e.g. PostToolUse with a large tool_response) can be big; anything larger is ignored, still with 200.
const BODY_LIMIT: usize = 10 * 1024 * 1024;
/// Events after which the transcript may say something new (model switch, branch change, new turn).
/// A session's first event always reads it too.
const TRANSCRIPT_EVENTS: [&str; 6] = [
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
    "StopFailure",
    "PostCompact",
    "Notification",
];

/// How long a permission request waits for the desk before Claude Code shows its own prompt.
const DEFAULT_APPROVAL_TIMEOUT: Duration = Duration::from_secs(30);
/// Tools whose approval needs the user's own input (answers, a plan review): never answered from the desk.
const INTERACTIVE_TOOLS: [&str; 2] = ["AskUserQuestion", "ExitPlanMode"];

#[derive(Clone)]
struct AppState {
    approvals: Arc<Mutex<Approvals>>,
    approval_timeout: Duration,
    /// connected desks that are on screen and accept approvals (see `client_loop` presence messages)
    approvers: Arc<AtomicUsize>,
    /// the menu bar app takes approvals until this moment (renewed by its heartbeat, see `app_presence`)
    app_approver_until: Arc<Mutex<Option<Instant>>>,
    /// the local voice lab, while it answers /health
    voice_lab: Arc<Mutex<Option<LabInfo>>>,
    /// tasks sent to Claude from the desk (spoken commands)
    commands: Arc<Mutex<Commands>>,
    /// are you at the desk? (camera presence from the menu bar app; None = unknown / not watching)
    user: Arc<Mutex<Option<UserPresence>>>,
    /// cwd → repository name (None: not in a repository), so the filesystem is walked once per folder
    repo_names: Arc<Mutex<std::collections::HashMap<String, Option<String>>>>,
    store: Arc<Mutex<SessionStore>>,
    tx: broadcast::Sender<String>,
    extra_origins: Arc<Vec<String>>,
    host: Arc<str>,
    port: u16,
    /// Claude config dir; transcripts are only read from inside it.
    transcript_root: Option<Arc<PathBuf>>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UserPresence {
    present: bool,
    /// when it last changed (ms)
    since: u64,
    #[serde(skip)]
    updated: Instant,
}

/// Presence is forgotten if the app stops reporting it (quit, camera off without telling us).
const USER_PRESENCE_TTL: Duration = Duration::from_secs(60);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn snapshot(
    reason: &str,
    sessions: Vec<Session>,
    approvals: Vec<Pending>,
    voice_lab: Option<LabInfo>,
    commands: Vec<commands::Command>,
    user: Option<UserPresence>,
) -> String {
    json!({
        "type": "snapshot",
        "reason": reason,
        "serverTime": now_ms(),
        "sessions": sessions,
        "approvals": approvals,
        "voiceLab": voice_lab,
        "commands": commands,
        "user": user,
    })
    .to_string()
}

impl AppState {
    fn snapshot(&self, reason: &str) -> String {
        let sessions = self.store.lock().unwrap().list();
        let approvals = self.approvals.lock().unwrap().list();
        let voice_lab = self.voice_lab.lock().unwrap().clone();
        let commands = self.commands.lock().unwrap().list();
        snapshot(
            reason,
            sessions,
            approvals,
            voice_lab,
            commands,
            self.user_presence(),
        )
    }

    fn broadcast(&self, reason: &str) {
        // Err only means nobody is connected.
        let _ = self.tx.send(self.snapshot(reason));
    }

    fn origin_ok(&self, origin: Option<&str>) -> bool {
        is_allowed_origin(origin, &self.extra_origins)
    }

    fn user_presence(&self) -> Option<UserPresence> {
        self.user
            .lock()
            .unwrap()
            .clone()
            .filter(|u| u.updated.elapsed() < USER_PRESENCE_TTL)
    }

    /// Someone can answer a permission request right now: a visible desk or the menu bar app —
    /// and, when the camera says you've stepped away, nobody.
    fn has_approver(&self) -> bool {
        if self.user_presence().is_some_and(|u| !u.present) {
            return false;
        }
        self.approvers.load(Ordering::SeqCst) > 0
            || self
                .app_approver_until
                .lock()
                .unwrap()
                .is_some_and(|until| until > Instant::now())
    }
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

// ---------------------------------------------------------------- HTTP

/// Reject foreign browser origins *before* anything is parsed or processed.
/// Hooks and curl send no Origin header, so they always pass.
async fn origin_guard(State(app): State<AppState>, req: Request, next: Next) -> Response {
    let origin = header(req.headers(), ORIGIN.as_str());
    if app.origin_ok(origin) {
        return next.run(req).await;
    }
    eprintln!(
        "[http] blocked origin {} {} {}",
        origin.unwrap_or(""),
        req.method(),
        req.uri().path()
    );
    StatusCode::FORBIDDEN.into_response()
}

/// Always answers an empty 200 (= "success, no decision") so Claude Code is never blocked by the visualizer,
/// even for oversized or malformed bodies. The payload's hook_event_name wins over the route,
/// so e.g. a Notification posted to /hook/idle is handled correctly.
async fn handle_hook(
    app: &AppState,
    default_event: Option<&str>,
    headers: &HeaderMap,
    body: Body,
) -> StatusCode {
    if let Some(payload) = read_payload(body).await {
        apply_hook(app, default_event, headers, &payload).await;
    }
    StatusCode::OK
}

/// The hook's JSON object; None (logged) for oversized or malformed bodies. Non-objects count as `{}`.
async fn read_payload(body: Body) -> Option<Value> {
    let bytes = match to_bytes(body, BODY_LIMIT).await {
        Ok(b) => b,
        Err(err) => {
            eprintln!("[http] bad request ignored: {err}");
            return None;
        }
    };
    if bytes.is_empty() {
        return Some(json!({}));
    }
    match serde_json::from_slice(&bytes) {
        Ok(v @ Value::Object(_)) => Some(v),
        Ok(_) => Some(json!({})),
        Err(err) => {
            eprintln!("[http] bad request ignored: {err}");
            None
        }
    }
}

/// Apply one hook event to the session store, log it and broadcast. Returns the updated session.
async fn apply_hook(
    app: &AppState,
    default_event: Option<&str>,
    headers: &HeaderMap,
    payload: &Value,
) -> Option<Session> {
    let event = payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or(default_event)?;
    let meta = Meta {
        entrypoint: header(headers, "x-claude-entrypoint").map(String::from),
        session_id: header(headers, "x-session-id").map(String::from),
    };

    let lookup = payload
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or(meta.session_id.as_deref())
        .unwrap_or("default")
        .to_string();
    let known = app.store.lock().unwrap().get(&lookup).is_some();
    let info = if TRANSCRIPT_EVENTS.contains(&event) || !known {
        read_transcript(app, payload).await
    } else {
        None
    };

    let updated = {
        let mut store = app.store.lock().unwrap();
        let prev = store.get(&lookup).map(|s| s.state.as_str());
        store.apply(event, payload, &meta, now_ms()).map(|s| {
            let merged = info.is_some_and(|info| store.merge_transcript(&s.id, info));
            let s = if merged {
                store.get(&s.id).cloned().unwrap_or(s)
            } else {
                s
            };
            (prev, s)
        })
    };

    // Name the session by its repository, and refresh token totals at turn boundaries.
    let updated = match updated {
        Some((prev, s)) => {
            let repo = repo_name_cached(app, &s.cwd);
            let usage = if USAGE_EVENTS.contains(&event) || prev.is_none() {
                read_usage(app, payload).await
            } else {
                None
            };
            let mut store = app.store.lock().unwrap();
            if let Some(name) = repo {
                store.set_project(&s.id, &name);
            }
            if let Some(u) = usage {
                store.set_usage(&s.id, u);
            }
            let s = store.get(&s.id).cloned().unwrap_or(s);
            Some((prev, s))
        }
        None => None,
    };

    if let Some((prev, s)) = updated {
        let tool_tag = match &s.tool {
            Some(t) if s.running > 1 => format!(" ({t} +{})", s.running - 1),
            Some(t) => format!(" ({t})"),
            None => String::new(),
        };
        let short_id: String = s.id.chars().take(8).collect();
        println!(
            "[hook] {event:<18} {:<20} {} -> {}{tool_tag}  [{}] {short_id}",
            s.project,
            prev.unwrap_or("NEW"),
            s.state.as_str(),
            s.source,
        );
        app.broadcast("hook");
        return Some(s);
    }
    None
}

// ---------------------------------------------------------------- approvals

/// PermissionRequest: hold the hook call while a desk is connected and answer with its decision.
/// No desk, an interactive tool, or no answer in time → an empty 200, and Claude Code asks as usual.
async fn permission_hook(State(app): State<AppState>, headers: HeaderMap, body: Body) -> Response {
    let no_decision = || StatusCode::OK.into_response();
    let Some(payload) = read_payload(body).await else {
        return no_decision();
    };
    let Some(session) = apply_hook(&app, Some("PermissionRequest"), &headers, &payload).await
    else {
        return no_decision();
    };
    let tool = payload
        .get("tool_name")
        .and_then(Value::as_str)
        .unwrap_or("Tool")
        .to_string();
    // Only hold the prompt when someone can actually answer: a desk that is visible right now.
    if !app.has_approver() || INTERACTIVE_TOOLS.contains(&tool.as_str()) {
        return no_decision();
    }

    let input = payload.get("tool_input").cloned().unwrap_or(Value::Null);
    let now = now_ms();
    let (id, rx) = {
        let mut approvals = app.approvals.lock().unwrap();
        let id = approvals.new_id();
        let pending = Pending {
            id: id.clone(),
            session_id: session.id.clone(),
            project: session.project.clone(),
            tool: tool.clone(),
            summary: summarize(&tool, &input),
            created_at: now,
            expires_at: now + app.approval_timeout.as_millis() as u64,
        };
        (id, approvals.add(pending))
    };
    println!("[approval] {id} {} wants {tool}", session.project);
    app.broadcast("approval");

    let outcome = tokio::time::timeout(app.approval_timeout, rx).await;
    let behavior = match outcome {
        Ok(Ok(b)) => b,
        _ => {
            app.approvals.lock().unwrap().expire(&id);
            println!("[approval] {id} no answer, back to Claude Code's prompt");
            app.broadcast("approval");
            return no_decision();
        }
    };
    let allowed = behavior == Behavior::Allow;
    println!(
        "[approval] {id} {}",
        if allowed { "approved" } else { "denied" }
    );
    app.store
        .lock()
        .unwrap()
        .resolve_waiting(&session.id, allowed, now_ms());
    app.broadcast("approval");
    (
        [("content-type", "application/json")],
        decision_output(behavior, allowed.then_some(input)),
    )
        .into_response()
}

#[derive(serde::Deserialize)]
struct DecideBody {
    behavior: String,
}

/// The desk's Approve / Deny. Only pages that send an allowed Origin may answer (a bare request can't).
async fn decide(
    State(app): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<DecideBody>,
) -> Response {
    let origin = header(&headers, ORIGIN.as_str());
    if origin.is_none() && header(&headers, "x-clawddesk-app").is_none() {
        return (StatusCode::FORBIDDEN, "answer from the desk").into_response();
    }
    let Some(behavior) = Behavior::parse(&body.behavior) else {
        return (StatusCode::BAD_REQUEST, "behavior must be allow or deny").into_response();
    };
    match app.approvals.lock().unwrap().decide(&id, behavior) {
        Some(_) => Json(json!({ "ok": true })).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            "no such request (answered or expired)",
        )
            .into_response(),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandBody {
    text: String,
    /// run in this session's project folder
    session_id: String,
}

/// A task for Claude from the desk (a spoken command): `claude -p` in the session's folder.
/// Like approvals, only the desk page or the menu bar app may send one.
async fn command(
    State(app): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CommandBody>,
) -> Response {
    if header(&headers, ORIGIN.as_str()).is_none() && header(&headers, "x-clawddesk-app").is_none()
    {
        return (StatusCode::FORBIDDEN, "send commands from the desk").into_response();
    }
    let prompt = body.text.trim().to_string();
    if prompt.is_empty() || prompt.chars().count() > commands::MAX_PROMPT {
        return (StatusCode::BAD_REQUEST, "text must be 1-2000 characters").into_response();
    }
    let Some(session) = app.store.lock().unwrap().get(&body.session_id).cloned() else {
        return (StatusCode::NOT_FOUND, "no such session").into_response();
    };
    if session.cwd.is_empty() || !std::path::Path::new(&session.cwd).is_dir() {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            "that session has no project folder",
        )
            .into_response();
    }
    let Some(claude) = commands::find_claude() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "claude CLI not found (set CLAWDDESK_CLAUDE)",
        )
            .into_response();
    };
    let cmd = {
        let mut cmds = app.commands.lock().unwrap();
        if cmds.running() >= commands::MAX_RUNNING {
            return (StatusCode::TOO_MANY_REQUESTS, "already running two tasks").into_response();
        }
        cmds.start(
            prompt.clone(),
            session.project.clone(),
            session.cwd.clone(),
            now_ms(),
        )
    };
    println!("[command] {} in {}: {prompt}", cmd.id, session.project);
    app.broadcast("command");

    let id = cmd.id.clone();
    let worker = app.clone();
    tokio::spawn(async move {
        let outcome = commands::run_claude(&claude, &prompt, &session.cwd).await;
        let (status, text) = match outcome {
            Ok(text) => (CommandStatus::Done, text),
            Err(err) => (CommandStatus::Failed, err),
        };
        println!("[command] {id} {status:?}");
        worker
            .commands
            .lock()
            .unwrap()
            .finish(&id, status, text, now_ms());
        worker.broadcast("command");
    });
    (StatusCode::ACCEPTED, Json(cmd)).into_response()
}

#[derive(serde::Deserialize)]
struct UserPresenceBody {
    present: Option<bool>,
}

/// The menu bar app reports whether you're at the desk (camera presence), or `null` when it stops watching.
async fn user_presence(
    State(app): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<UserPresenceBody>,
) -> StatusCode {
    if header(&headers, "x-clawddesk-app").is_none() {
        return StatusCode::FORBIDDEN;
    }
    let changed = {
        let mut user = app.user.lock().unwrap();
        let before = user.as_ref().map(|u| u.present);
        *user = body.present.map(|present| UserPresence {
            present,
            since: match user.as_ref() {
                Some(u) if u.present == present => u.since,
                _ => now_ms(),
            },
            updated: Instant::now(),
        });
        before != body.present
    };
    if changed {
        println!(
            "[presence] {}",
            match body.present {
                Some(true) => "at the desk",
                Some(false) => "away",
                None => "unknown",
            }
        );
        app.broadcast("presence");
    }
    StatusCode::NO_CONTENT
}

#[derive(serde::Deserialize)]
struct AppPresence {
    approvals: bool,
}

/// How long one menu bar heartbeat keeps it counted as an approver.
const APP_PRESENCE_TTL: Duration = Duration::from_secs(15);

/// The menu bar app says whether it takes approvals (heartbeat every few seconds while it does).
async fn app_presence(
    State(app): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AppPresence>,
) -> StatusCode {
    if header(&headers, "x-clawddesk-app").is_none() {
        return StatusCode::FORBIDDEN;
    }
    *app.app_approver_until.lock().unwrap() =
        body.approvals.then(|| Instant::now() + APP_PRESENCE_TTL);
    StatusCode::NO_CONTENT
}

/// Events after which the token totals are worth re-counting (a turn or the session ended).
const USAGE_EVENTS: [&str; 4] = ["Stop", "StopFailure", "SessionEnd", "PostCompact"];

fn repo_name_cached(app: &AppState, cwd: &str) -> Option<String> {
    if cwd.is_empty() {
        return None;
    }
    let mut cache = app.repo_names.lock().unwrap();
    cache
        .entry(cwd.to_string())
        .or_insert_with(|| project::repo_name(cwd))
        .clone()
}

/// Token totals over the whole transcript (blocking file I/O off the async runtime).
async fn read_usage(app: &AppState, payload: &Value) -> Option<core::Usage> {
    let root = app.transcript_root.clone()?;
    let raw = payload.get("transcript_path")?.as_str()?.to_string();
    tokio::task::spawn_blocking(move || {
        let path = allowed_path(&raw, &root)?;
        usage_totals(&path).ok()
    })
    .await
    .ok()
    .flatten()
}

/// Session details from the transcript the hook points at (blocking file I/O off the async runtime).
async fn read_transcript(app: &AppState, payload: &Value) -> Option<TranscriptInfo> {
    let root = app.transcript_root.clone()?;
    let raw = payload.get("transcript_path")?.as_str()?.to_string();
    tokio::task::spawn_blocking(move || {
        let path = allowed_path(&raw, &root)?;
        read_tail(&path).ok().filter(|i| !i.is_empty())
    })
    .await
    .ok()
    .flatten()
}

async fn hook_route(
    State(app): State<AppState>,
    Path(route): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> StatusCode {
    match ROUTE_EVENTS.iter().find(|(r, _)| *r == route) {
        Some((_, event)) => handle_hook(&app, Some(event), &headers, body).await,
        None => StatusCode::NOT_FOUND,
    }
}

/// Generic endpoint: dispatch on hook_event_name only.
async fn hook_generic(State(app): State<AppState>, headers: HeaderMap, body: Body) -> StatusCode {
    handle_hook(&app, None, &headers, body).await
}

async fn get_state(State(app): State<AppState>) -> impl IntoResponse {
    ([("content-type", "application/json")], app.snapshot("poll"))
}

/// `GET /` is both the info endpoint and the WebSocket endpoint (the client connects to ws://host:port).
async fn root(
    State(app): State<AppState>,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    match ws {
        Ok(ws) => ws.on_upgrade(move |socket| client_loop(app, socket)),
        Err(_) => {
            let sessions = app.store.lock().unwrap().len();
            Json(json!({
                "name": "clawddesk-bridge",
                "ok": true,
                "sessions": sessions,
                "ws": format!("ws://{}:{}", app.host, app.port),
            }))
            .into_response()
        }
    }
}

// ---------------------------------------------------------------- WebSocket

async fn client_loop(app: AppState, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let mut rx = app.tx.subscribe();
    if sink
        .send(Message::Text(app.snapshot("hello").into()))
        .await
        .is_err()
    {
        return;
    }

    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat.tick().await; // first tick fires immediately
    let mut alive = true;
    // This desk takes approvals while it says so ({"type":"presence","approvals":true}, sent when visible).
    let mut approver = false;
    let set_approver = |on: bool, current: &mut bool| {
        if on != *current {
            if on {
                app.approvers.fetch_add(1, Ordering::SeqCst);
            } else {
                app.approvers.fetch_sub(1, Ordering::SeqCst);
            }
            *current = on;
        }
    };

    loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                Ok(data) => {
                    if sink.send(Message::Text(data.into())).await.is_err() { break; }
                }
                // Fell behind: the next snapshot is a full state anyway, so just catch up.
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    if sink.send(Message::Text(app.snapshot("hook").into())).await.is_err() { break; }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            incoming = stream.next() => match incoming {
                Some(Ok(Message::Pong(_))) => alive = true,
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(Message::Text(text))) => {
                    if let Ok(v) = serde_json::from_str::<Value>(&text)
                        && v.get("type").and_then(Value::as_str) == Some("presence")
                    {
                        let on = v.get("approvals").and_then(Value::as_bool).unwrap_or(false);
                        set_approver(on, &mut approver);
                    }
                }
                Some(Ok(_)) => {}
            },
            _ = heartbeat.tick() => {
                if !alive { break; } // missed a pong for a whole interval: drop the dead peer
                alive = false;
                if sink.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
            }
        }
    }
    set_approver(false, &mut approver);
}

// ---------------------------------------------------------------- public API

/// Bridge settings. `Options::from_env()` reads the CLAWDDESK_* variables.
#[derive(Debug, Clone)]
pub struct Options {
    pub host: String,
    pub port: u16,
    /// exact origins allowed besides loopback pages (e.g. `tauri://localhost` for the desktop app)
    pub extra_origins: Vec<String>,
    pub approval_timeout: Duration,
    pub voice_lab_url: String,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".into(), // loopback only
            port: 3001,
            extra_origins: Vec::new(),
            approval_timeout: DEFAULT_APPROVAL_TIMEOUT,
            voice_lab_url: voicelab::DEFAULT_URL.into(),
        }
    }
}

impl Options {
    pub fn from_env() -> Self {
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let d = Self::default();
        Self {
            host: env("CLAWDDESK_HOST").unwrap_or(d.host),
            port: env("CLAWDDESK_PORT")
                .or_else(|| env("PORT"))
                .and_then(|p| p.parse().ok())
                .unwrap_or(d.port),
            extra_origins: parse_origin_list(env("CLAWDDESK_ALLOWED_ORIGINS").as_deref()),
            approval_timeout: env("CLAWDDESK_APPROVAL_TIMEOUT")
                .and_then(|s| s.parse::<u64>().ok())
                .map(Duration::from_secs)
                .unwrap_or(d.approval_timeout),
            voice_lab_url: env("CLAWDDESK_VOICE_LAB").unwrap_or(d.voice_lab_url),
        }
    }
}

#[derive(Debug)]
pub enum ServeError {
    /// the port is taken (typically another bridge is already running)
    AddrInUse(String),
    Io(String, std::io::Error),
}

impl std::fmt::Display for ServeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServeError::AddrInUse(addr) => write!(f, "{addr} is already in use"),
            ServeError::Io(addr, err) => write!(f, "{addr}: {err}"),
        }
    }
}

impl std::error::Error for ServeError {}

/// Run the bridge until `shutdown` resolves.
pub async fn serve(
    opts: Options,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> Result<(), ServeError> {
    let Options {
        host,
        port,
        extra_origins,
        approval_timeout,
        voice_lab_url,
    } = opts;
    let extra_origins = Arc::new(extra_origins);

    let (tx, _) = broadcast::channel(64);
    let app = AppState {
        store: Arc::new(Mutex::new(SessionStore::new())),
        tx,
        extra_origins: extra_origins.clone(),
        host: host.clone().into(),
        port,
        transcript_root: config_root().map(Arc::new),
        approvals: Arc::new(Mutex::new(Approvals::default())),
        approvers: Arc::new(AtomicUsize::new(0)),
        voice_lab: Arc::new(Mutex::new(None)),
        commands: Arc::new(Mutex::new(Commands::default())),
        user: Arc::new(Mutex::new(None)),
        repo_names: Arc::new(Mutex::new(std::collections::HashMap::new())),
        app_approver_until: Arc::new(Mutex::new(None)),
        approval_timeout,
    };

    let cors_origins = extra_origins.clone();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(move |origin: &HeaderValue, _| {
            is_allowed_origin(origin.to_str().ok(), &cors_origins)
        }))
        .allow_methods([Method::GET, Method::HEAD, Method::POST])
        .allow_headers(AllowHeaders::mirror_request());

    let router = Router::new()
        .route("/", get(root))
        .route("/state", get(get_state))
        .route("/hook", post(hook_generic))
        .route("/hook/permission", post(permission_hook))
        .route("/approvals/{id}", post(decide))
        .route("/presence/app", post(app_presence))
        .route("/command", post(command))
        .route("/presence/user", post(user_presence))
        .route("/hook/{route}", post(hook_route))
        .layer(cors)
        .layer(middleware::from_fn_with_state(app.clone(), origin_guard)) // outermost: runs first
        .with_state(app.clone());

    // Voice lab watcher: tell pages when the local cloned-voice server comes and goes.
    {
        let app = app.clone();
        let url = voice_lab_url;
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(VOICE_LAB_INTERVAL);
            loop {
                tick.tick().await;
                let found = voicelab::probe(&url).await;
                let changed = {
                    let mut current = app.voice_lab.lock().unwrap();
                    let changed = *current != found;
                    *current = found.clone();
                    changed
                };
                if changed {
                    match &found {
                        Some(lab) => println!(
                            "[voice lab] voice: {} ({}), transcription: {}",
                            lab.voice.as_deref().unwrap_or("off"),
                            if lab.ready { "ready" } else { "loading" },
                            if lab.stt { "on" } else { "off" }
                        ),
                        None => println!("[voice lab] gone"),
                    }
                    app.broadcast("voicelab");
                }
            }
        });
    }

    // Sweeper: drop stale / long-ended sessions.
    {
        let app = app.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(SWEEP_INTERVAL);
            loop {
                tick.tick().await;
                let removed = app.store.lock().unwrap().sweep(now_ms());
                for s in &removed {
                    let short_id: String = s.id.chars().take(8).collect();
                    println!("[sweep] expired {} {short_id}", s.project);
                }
                if !removed.is_empty() {
                    app.broadcast("sweep");
                }
            }
        });
    }

    let addr = format!("{host}:{port}");
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
            return Err(ServeError::AddrInUse(addr));
        }
        Err(err) => return Err(ServeError::Io(addr, err)),
    };
    println!("\n  🦀 ClawdDesk bridge  http://{addr}   ws://{addr}\n");

    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown)
        .await
        .map_err(|err| ServeError::Io(addr, err))
}
