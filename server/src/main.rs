//! ClawdDesk 3D — Claude Code hook bridge.
//! Receives Claude Code hook POSTs and broadcasts normalized session state over WebSocket.

mod core;

use std::{
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
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

use crate::core::{
    Meta, ROUTE_EVENTS, Session, SessionStore, is_allowed_origin, parse_origin_list,
};

const SWEEP_INTERVAL: Duration = Duration::from_secs(15);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
/// Hook payloads (e.g. PostToolUse with a large tool_response) can be big; anything larger is ignored, still with 200.
const BODY_LIMIT: usize = 10 * 1024 * 1024;

#[derive(Clone)]
struct AppState {
    store: Arc<Mutex<SessionStore>>,
    tx: broadcast::Sender<String>,
    extra_origins: Arc<Vec<String>>,
    host: Arc<str>,
    port: u16,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn snapshot(reason: &str, sessions: Vec<Session>) -> String {
    json!({ "type": "snapshot", "reason": reason, "serverTime": now_ms(), "sessions": sessions })
        .to_string()
}

impl AppState {
    fn snapshot(&self, reason: &str) -> String {
        snapshot(reason, self.store.lock().unwrap().list())
    }

    fn broadcast(&self, reason: &str) {
        // Err only means nobody is connected.
        let _ = self.tx.send(self.snapshot(reason));
    }

    fn origin_ok(&self, origin: Option<&str>) -> bool {
        is_allowed_origin(origin, &self.extra_origins)
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
    let bytes = match to_bytes(body, BODY_LIMIT).await {
        Ok(b) => b,
        Err(err) => {
            eprintln!("[http] bad request ignored: {err}");
            return StatusCode::OK;
        }
    };
    let payload: Value = if bytes.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice(&bytes) {
            Ok(v @ Value::Object(_)) => v,
            Ok(_) => json!({}),
            Err(err) => {
                eprintln!("[http] bad request ignored: {err}");
                return StatusCode::OK;
            }
        }
    };

    let Some(event) = payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or(default_event)
    else {
        return StatusCode::OK;
    };
    let meta = Meta {
        entrypoint: header(headers, "x-claude-entrypoint").map(String::from),
        session_id: header(headers, "x-session-id").map(String::from),
    };

    let updated = {
        let mut store = app.store.lock().unwrap();
        let lookup = payload
            .get("session_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .or(meta.session_id.as_deref())
            .unwrap_or("default");
        let prev = store.get(lookup).map(|s| s.state.as_str());
        store
            .apply(event, &payload, &meta, now_ms())
            .map(|s| (prev, s))
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
    }
    StatusCode::OK
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
                Some(Ok(_)) => {}
            },
            _ = heartbeat.tick() => {
                if !alive { break; } // missed a pong for a whole interval: drop the dead peer
                alive = false;
                if sink.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
            }
        }
    }
}

// ---------------------------------------------------------------- main

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
    // Open WebSockets would keep graceful shutdown waiting; don't let them.
    tokio::spawn(async {
        tokio::time::sleep(Duration::from_millis(500)).await;
        std::process::exit(0);
    });
}

#[tokio::main]
async fn main() {
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    let port: u16 = env("CLAWDDESK_PORT")
        .or_else(|| env("PORT"))
        .and_then(|p| p.parse().ok())
        .unwrap_or(3001);
    let host = env("CLAWDDESK_HOST").unwrap_or_else(|| "127.0.0.1".into()); // loopback only
    let extra_origins = Arc::new(parse_origin_list(
        env("CLAWDDESK_ALLOWED_ORIGINS").as_deref(),
    ));

    let (tx, _) = broadcast::channel(64);
    let app = AppState {
        store: Arc::new(Mutex::new(SessionStore::new())),
        tx,
        extra_origins: extra_origins.clone(),
        host: host.clone().into(),
        port,
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
        .route("/hook/{route}", post(hook_route))
        .layer(cors)
        .layer(middleware::from_fn_with_state(app.clone(), origin_guard)) // outermost: runs first
        .with_state(app.clone());

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
            eprintln!(
                "\n  ✖ {addr} is already in use by another process.\n    \
                 Free it, or run with CLAWDDESK_PORT=<port> and point your hook URLs + VITE_BRIDGE_URL at it.\n"
            );
            std::process::exit(1);
        }
        Err(err) => {
            eprintln!("\n  ✖ cannot listen on {addr}: {err}\n");
            std::process::exit(1);
        }
    };
    println!("\n  🦀 ClawdDesk bridge  http://{addr}   ws://{addr}\n");

    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");
}
