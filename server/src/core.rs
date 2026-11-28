//! Pure session state machine + origin policy (no I/O, unit-tested).

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;

/// Drop sessions after 10 min of silence.
pub const STALE_MS: u64 = 10 * 60 * 1000;
/// Keep ended sessions visible for 1 min.
pub const OFFLINE_LINGER_MS: u64 = 60 * 1000;

/// Default event for each legacy route, used when the payload has no `hook_event_name`.
pub const ROUTE_EVENTS: [(&str, &str); 6] = [
    ("session-start", "SessionStart"),
    ("generating", "UserPromptSubmit"),
    ("tool-use", "PreToolUse"),
    ("tool-done", "PostToolUse"),
    ("idle", "Stop"),
    ("offline", "SessionEnd"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AgentState {
    Offline,
    Idle,
    Waiting,
    Generating,
    ToolRunning,
}

impl AgentState {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentState::Offline => "OFFLINE",
            AgentState::Idle => "IDLE",
            AgentState::Waiting => "WAITING",
            AgentState::Generating => "GENERATING",
            AgentState::ToolRunning => "TOOL_RUNNING",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Event {
    SessionStart,
    UserPromptSubmit,
    PreToolUse,
    PostToolUse,
    Notification,
    Stop,
    SubagentStop,
    PreCompact,
    SessionEnd,
}

impl Event {
    fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "SessionStart" => Event::SessionStart,
            "UserPromptSubmit" => Event::UserPromptSubmit,
            "PreToolUse" => Event::PreToolUse,
            "PostToolUse" | "PostToolUseFailure" => Event::PostToolUse,
            "Notification" => Event::Notification,
            "Stop" | "StopFailure" => Event::Stop,
            "SubagentStop" => Event::SubagentStop,
            "PreCompact" => Event::PreCompact,
            "SessionEnd" => Event::SessionEnd,
            _ => return None,
        })
    }
}

/// Wire format sent to the client (camelCase, same as the former Node bridge).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub cwd: String,
    pub project: String,
    /// 'vscode' | 'cli' | other entrypoint | 'unknown'
    pub source: String,
    pub state: AgentState,
    /// most recently started tool still running (TOOL_RUNNING only)
    pub tool: Option<String>,
    /// number of tools currently in flight
    pub running: usize,
    pub last_tool: Option<String>,
    pub last_event: String,
    pub prompts: u32,
    pub started_at: u64,
    pub last_seen: u64,
}

/// Header-derived info that accompanies a hook payload.
#[derive(Debug, Default, Clone)]
pub struct Meta {
    pub entrypoint: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Compaction {
    Auto,
    Manual,
}

#[derive(Debug)]
struct Entry {
    session: Session,
    /// in-flight tools: (tool_use_id, short name), insertion-ordered
    tools: Vec<(String, String)>,
    compacting: Option<Compaction>,
}

// ---------------------------------------------------------------- helpers

pub fn project_from_cwd(cwd: &str) -> String {
    if cwd.is_empty() {
        return "unknown".into();
    }
    cwd.split(['/', '\\'])
        .rfind(|p| !p.is_empty())
        .unwrap_or(cwd)
        .to_string()
}

pub fn normalize_source(raw: Option<&str>) -> String {
    let v = raw.unwrap_or("").trim().to_lowercase();
    if v.is_empty() {
        return "unknown".into();
    }
    if v.contains("vscode") || v.contains("cursor") || v.contains("windsurf") {
        return "vscode".into();
    }
    if v.contains("jetbrains") {
        return "jetbrains".into();
    }
    v
}

pub fn short_tool_name(name: Option<&str>) -> String {
    match name {
        None | Some("") => "Tool".into(),
        // mcp__server__tool_name -> tool_name
        Some(n) if n.starts_with("mcp__") => match n.rsplit("__").next() {
            Some(last) if !last.is_empty() => last.into(),
            _ => n.into(),
        },
        Some(n) => n.into(),
    }
}

/// String field of a JSON payload; numbers are stringified, empty strings count as missing.
fn field(p: &Value, key: &str) -> Option<String> {
    match p.get(key)? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Notifications that mean "Claude is blocked on the human" rather than "done".
pub fn is_attention_notification(p: &Value) -> bool {
    if let Some(kind) = field(p, "notification_type") {
        // e.g. idle_prompt, auth_success are not attention requests
        return kind == "permission_prompt" || kind == "elicitation_dialog";
    }
    let msg = field(p, "message").unwrap_or_default().to_lowercase();
    msg.contains("permission") || msg.contains("approve") || msg.contains("approval")
}

// ---------------------------------------------------------------- origin policy

const LOOPBACK_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

/// Browser requests carry an Origin; Claude Code hooks and curl don't.
/// Only loopback pages (the dev client, any port) plus explicitly listed origins may talk to the bridge,
/// so an arbitrary website can neither read session paths over WebSocket nor fake hook events.
pub fn is_allowed_origin(origin: Option<&str>, extra: &[String]) -> bool {
    let Some(origin) = origin.filter(|o| !o.is_empty()) else {
        return true;
    };
    if extra.iter().any(|e| e == origin) {
        return true;
    }
    // includes the literal "null" origin
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some_and(|h| LOOPBACK_HOSTS.contains(&h))
}

pub fn parse_origin_list(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

// ---------------------------------------------------------------- state machine

#[derive(Debug, Default)]
pub struct SessionStore {
    entries: HashMap<String, Entry>,
    /// fallback keys for tool events that lack tool_use_id
    seq: u64,
}

impl SessionStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn get(&self, id: &str) -> Option<&Session> {
        self.entries.get(id).map(|e| &e.session)
    }

    /// Apply one hook event at time `now` (ms). Returns the updated session, or `None` if ignored.
    pub fn apply(&mut self, event_name: &str, payload: &Value, meta: &Meta, now: u64) -> Option<Session> {
        let event = Event::parse(event_name)?;
        let cwd = field(payload, "cwd");
        let raw_id = field(payload, "session_id").or_else(|| meta.session_id.clone().filter(|s| !s.is_empty()));
        if raw_id.is_none() && cwd.is_none() {
            return None; // nothing to attribute this to
        }
        let id = raw_id.unwrap_or_else(|| "default".into());

        let entry = self.entries.entry(id.clone()).or_insert_with(|| Entry {
            session: Session {
                id,
                cwd: String::new(),
                project: "unknown".into(),
                source: "unknown".into(),
                state: AgentState::Idle,
                tool: None,
                running: 0,
                last_tool: None,
                last_event: String::new(),
                prompts: 0,
                started_at: now,
                last_seen: now,
            },
            tools: Vec::new(),
            compacting: None,
        });
        let Entry { session: s, tools, compacting } = entry;
        let prev = s.state;

        if let Some(cwd) = cwd {
            s.project = project_from_cwd(&cwd);
            s.cwd = cwd;
        }
        let src = normalize_source(meta.entrypoint.as_deref().filter(|e| !e.is_empty()).or(payload.get("entrypoint").and_then(Value::as_str)));
        if src != "unknown" {
            s.source = src;
        }
        s.last_seen = now;
        s.last_event = event_name.to_string();

        match event {
            Event::SessionStart => {
                tools.clear();
                let trigger = compacting.take();
                // After an auto-compaction mid-turn Claude keeps working; otherwise it waits for a prompt.
                let resumed = field(payload, "source").as_deref() == Some("compact") && trigger == Some(Compaction::Auto);
                s.state = if resumed { AgentState::Generating } else { AgentState::Idle };
            }
            Event::UserPromptSubmit => {
                tools.clear();
                s.prompts += 1;
                s.state = AgentState::Generating;
            }
            Event::PreToolUse => {
                let name = short_tool_name(field(payload, "tool_name").as_deref());
                let key = field(payload, "tool_use_id").unwrap_or_else(|| {
                    self.seq += 1;
                    format!("{name}#{}", self.seq)
                });
                match tools.iter_mut().find(|(k, _)| *k == key) {
                    Some(slot) => slot.1 = name.clone(),
                    None => tools.push((key, name.clone())),
                }
                s.last_tool = Some(name);
                s.state = AgentState::ToolRunning;
            }
            Event::PostToolUse => {
                let by_id = field(payload, "tool_use_id").and_then(|id| tools.iter().position(|(k, _)| *k == id));
                let idx = by_id.or_else(|| {
                    let name = short_tool_name(field(payload, "tool_name").as_deref());
                    tools.iter().position(|(_, v)| *v == name)
                });
                if let Some(i) = idx {
                    tools.remove(i);
                }
                s.state = AgentState::Generating;
            }
            Event::Notification => {
                if is_attention_notification(payload) {
                    s.state = AgentState::Waiting;
                } else if tools.is_empty() && prev != AgentState::Generating {
                    s.state = AgentState::Idle;
                }
            }
            Event::PreCompact => {
                *compacting = Some(if field(payload, "trigger").as_deref() == Some("manual") {
                    Compaction::Manual
                } else {
                    Compaction::Auto
                });
                tools.clear();
                s.state = AgentState::ToolRunning;
                s.tool = Some("Compact".into());
                s.running = 0;
                return Some(s.clone());
            }
            // The parent's Task tool is still in flight; its PostToolUse settles the state. Just a heartbeat.
            Event::SubagentStop => {}
            Event::Stop => {
                tools.clear();
                s.state = AgentState::Idle;
            }
            Event::SessionEnd => {
                tools.clear();
                *compacting = None;
                s.state = AgentState::Offline;
            }
        }

        match s.state {
            AgentState::Waiting => {
                s.running = tools.len();
                s.tool = None;
            }
            AgentState::Idle | AgentState::Offline => {
                s.tool = None;
                s.running = 0;
            }
            _ => {
                s.running = tools.len();
                match tools.last() {
                    Some((_, name)) => {
                        s.state = AgentState::ToolRunning;
                        s.tool = Some(name.clone());
                    }
                    None => s.tool = None,
                }
            }
        }
        Some(s.clone())
    }

    /// Drop stale / long-ended sessions at time `now`. Returns the removed sessions.
    pub fn sweep(&mut self, now: u64) -> Vec<Session> {
        let expired: Vec<String> = self
            .entries
            .iter()
            .filter(|(_, e)| {
                let age = now.saturating_sub(e.session.last_seen);
                age > STALE_MS || (e.session.state == AgentState::Offline && age > OFFLINE_LINGER_MS)
            })
            .map(|(id, _)| id.clone())
            .collect();
        expired.into_iter().filter_map(|id| self.entries.remove(&id)).map(|e| e.session).collect()
    }

    /// Sessions, most recently active first.
    pub fn list(&self) -> Vec<Session> {
        let mut out: Vec<Session> = self.entries.values().map(|e| e.session.clone()).collect();
        out.sort_by(|a, b| b.last_seen.cmp(&a.last_seen).then_with(|| a.id.cmp(&b.id)));
        out
    }
}

