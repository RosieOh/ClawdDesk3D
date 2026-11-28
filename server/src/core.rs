//! Pure session state machine + origin policy (no I/O, unit-tested).

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;

use crate::transcript::TranscriptInfo;

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
    /// Claude is blocked on the human: a permission dialog or an MCP elicitation form.
    Attention,
    /// The elicitation form was answered.
    Resume,
    Stop,
    /// Subagent start/stop: the parent's Task tool is still in flight, so only a keep-alive.
    Heartbeat,
    PreCompact,
    PostCompact,
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
            "PermissionRequest" | "Elicitation" => Event::Attention,
            "ElicitationResult" => Event::Resume,
            "Stop" | "StopFailure" => Event::Stop,
            "SubagentStart" | "SubagentStop" => Event::Heartbeat,
            "PreCompact" => Event::PreCompact,
            "PostCompact" => Event::PostCompact,
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
    /// model id, e.g. `claude-opus-5-5` (payload `model`, else the transcript's latest assistant turn)
    pub model: Option<String>,
    /// `default` | `plan` | `acceptEdits` | `auto` | `bypassPermissions` | …
    pub permission_mode: Option<String>,
    pub git_branch: Option<String>,
    /// Claude Code version
    pub claude_version: Option<String>,
    /// how the session began: `startup` | `resume` | `clear` (compaction restarts don't overwrite it)
    pub start_source: Option<String>,
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

impl Compaction {
    fn from_trigger(payload: &Value) -> Self {
        if field(payload, "trigger").as_deref() == Some("manual") {
            Compaction::Manual
        } else {
            Compaction::Auto
        }
    }
}

/// After an auto-compaction mid-turn Claude keeps working; after `/compact` it waits for a prompt.
fn after_compaction(trigger: Compaction) -> AgentState {
    match trigger {
        Compaction::Auto => AgentState::Generating,
        Compaction::Manual => AgentState::Idle,
    }
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

/// `model` as a plain id string, or an object with `id` / `display_name`.
fn model_of(p: &Value) -> Option<String> {
    match p.get("model")? {
        Value::String(m) if !m.is_empty() => Some(m.clone()),
        Value::Object(o) => ["id", "display_name"]
            .iter()
            .find_map(|k| o.get(*k).and_then(Value::as_str).filter(|v| !v.is_empty()))
            .map(String::from),
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

    /// Fill in details read from the session transcript. Hook payload values (model, permission mode) are newer,
    /// so the transcript only fills the gaps for those; branch and version always come from it.
    /// Returns whether anything changed.
    pub fn merge_transcript(&mut self, id: &str, info: TranscriptInfo) -> bool {
        let Some(e) = self.entries.get_mut(id) else {
            return false;
        };
        let s = &mut e.session;
        let before = (
            s.model.clone(),
            s.permission_mode.clone(),
            s.git_branch.clone(),
            s.claude_version.clone(),
        );
        if info.model.is_some() {
            s.model = info.model;
        }
        if s.permission_mode.is_none() {
            s.permission_mode = info.permission_mode;
        }
        if info.git_branch.is_some() {
            s.git_branch = info.git_branch;
        }
        if info.version.is_some() {
            s.claude_version = info.version;
        }
        before
            != (
                s.model.clone(),
                s.permission_mode.clone(),
                s.git_branch.clone(),
                s.claude_version.clone(),
            )
    }

    /// Apply one hook event at time `now` (ms). Returns the updated session, or `None` if ignored.
    pub fn apply(
        &mut self,
        event_name: &str,
        payload: &Value,
        meta: &Meta,
        now: u64,
    ) -> Option<Session> {
        let event = Event::parse(event_name)?;
        let cwd = field(payload, "cwd");
        let raw_id = field(payload, "session_id")
            .or_else(|| meta.session_id.clone().filter(|s| !s.is_empty()));
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
                model: None,
                permission_mode: None,
                git_branch: None,
                claude_version: None,
                start_source: None,
            },
            tools: Vec::new(),
            compacting: None,
        });
        let Entry {
            session: s,
            tools,
            compacting,
        } = entry;
        let prev = s.state;

        if let Some(cwd) = cwd {
            s.project = project_from_cwd(&cwd);
            s.cwd = cwd;
        }
        let src = normalize_source(
            meta.entrypoint
                .as_deref()
                .filter(|e| !e.is_empty())
                .or(payload.get("entrypoint").and_then(Value::as_str)),
        );
        if src != "unknown" {
            s.source = src;
        }
        s.last_seen = now;
        s.last_event = event_name.to_string();
        if let Some(model) = model_of(payload) {
            s.model = Some(model);
        }
        if let Some(mode) = field(payload, "permission_mode") {
            s.permission_mode = Some(mode);
        }
        if event == Event::SessionStart {
            match field(payload, "source") {
                Some(src) if src != "compact" => s.start_source = Some(src),
                _ => {}
            }
        }

        match event {
            Event::SessionStart => {
                tools.clear();
                if field(payload, "source").as_deref() == Some("compact") {
                    // The restart after a compaction. If PostCompact already settled the state, keep it.
                    if let Some(trigger) = compacting.take() {
                        s.state = after_compaction(trigger);
                    }
                } else {
                    *compacting = None;
                    s.state = AgentState::Idle;
                }
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
                let by_id = field(payload, "tool_use_id")
                    .and_then(|id| tools.iter().position(|(k, _)| *k == id));
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
                *compacting = Some(Compaction::from_trigger(payload));
                tools.clear();
                s.state = AgentState::ToolRunning;
                s.tool = Some("Compact".into());
                s.running = 0;
                return Some(s.clone());
            }
            Event::Attention => s.state = AgentState::Waiting,
            Event::Resume => {
                if prev == AgentState::Waiting {
                    s.state = AgentState::Generating;
                }
            }
            Event::PostCompact => {
                let trigger = compacting
                    .take()
                    .unwrap_or_else(|| Compaction::from_trigger(payload));
                tools.clear();
                s.state = after_compaction(trigger);
            }
            // The parent's Task tool is still in flight; its PostToolUse settles the state.
            Event::Heartbeat => {}
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
                age > STALE_MS
                    || (e.session.state == AgentState::Offline && age > OFFLINE_LINGER_MS)
            })
            .map(|(id, _)| id.clone())
            .collect();
        expired
            .into_iter()
            .filter_map(|id| self.entries.remove(&id))
            .map(|e| e.session)
            .collect()
    }

    /// Sessions, most recently active first.
    pub fn list(&self) -> Vec<Session> {
        let mut out: Vec<Session> = self.entries.values().map(|e| e.session.clone()).collect();
        out.sort_by(|a, b| b.last_seen.cmp(&a.last_seen).then_with(|| a.id.cmp(&b.id)));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SID: &str = "sess-1";

    struct Harness {
        store: SessionStore,
        t: u64,
    }

    impl Harness {
        fn new() -> Self {
            Self {
                store: SessionStore::new(),
                t: 1_000,
            }
        }
        fn fire_meta(&mut self, event: &str, extra: Value, meta: Meta) -> Session {
            let mut p = json!({ "session_id": SID, "cwd": "/Users/me/dev/my-app", "hook_event_name": event });
            if let (Value::Object(base), Value::Object(more)) = (&mut p, extra) {
                base.extend(more);
            }
            self.store
                .apply(event, &p, &meta, self.t)
                .expect("event should apply")
        }
        fn fire(&mut self, event: &str, extra: Value) -> Session {
            self.fire_meta(event, extra, Meta::default())
        }
    }

    use AgentState::*;

    #[test]
    fn basic_lifecycle() {
        let mut h = Harness::new();
        assert_eq!(h.fire("SessionStart", json!({})).state, Idle);
        let s = h.fire("UserPromptSubmit", json!({}));
        assert_eq!(s.state, Generating);
        assert_eq!(s.prompts, 1);
        assert_eq!(s.project, "my-app");
        assert_eq!(
            h.fire(
                "PreToolUse",
                json!({ "tool_name": "Read", "tool_use_id": "a" })
            )
            .state,
            ToolRunning
        );
        assert_eq!(
            h.fire(
                "PostToolUse",
                json!({ "tool_name": "Read", "tool_use_id": "a" })
            )
            .state,
            Generating
        );
        assert_eq!(h.fire("Stop", json!({})).state, Idle);
        assert_eq!(h.fire("SessionEnd", json!({})).state, Offline);
    }

    #[test]
    fn parallel_tools_stay_running_until_the_last_one_finishes() {
        let mut h = Harness::new();
        h.fire("UserPromptSubmit", json!({}));
        h.fire(
            "PreToolUse",
            json!({ "tool_name": "Read", "tool_use_id": "a" }),
        );
        let s = h.fire(
            "PreToolUse",
            json!({ "tool_name": "Grep", "tool_use_id": "b" }),
        );
        assert_eq!(s.running, 2);
        assert_eq!(s.tool.as_deref(), Some("Grep"));

        let s = h.fire(
            "PostToolUse",
            json!({ "tool_name": "Grep", "tool_use_id": "b" }),
        );
        assert_eq!(s.state, ToolRunning);
        assert_eq!(s.tool.as_deref(), Some("Read"));
        assert_eq!(s.running, 1);

        let s = h.fire(
            "PostToolUseFailure",
            json!({ "tool_name": "Read", "tool_use_id": "a" }),
        );
        assert_eq!(s.state, Generating);
        assert_eq!(s.tool, None);
        assert_eq!(s.running, 0);
    }

    #[test]
    fn tool_events_without_id_match_by_name() {
        let mut h = Harness::new();
        h.fire("PreToolUse", json!({ "tool_name": "Bash" }));
        h.fire("PreToolUse", json!({ "tool_name": "Read" }));
        let s = h.fire("PostToolUse", json!({ "tool_name": "Bash" }));
        assert_eq!(s.state, ToolRunning);
        assert_eq!(s.tool.as_deref(), Some("Read"));
    }

    #[test]
    fn pre_tool_use_without_prompt_still_shows_tool() {
        let mut h = Harness::new();
        h.fire("SessionStart", json!({}));
        let s = h.fire(
            "PreToolUse",
            json!({ "tool_name": "mcp__github__create_issue", "tool_use_id": "x" }),
        );
        assert_eq!(s.state, ToolRunning);
        assert_eq!(s.tool.as_deref(), Some("create_issue"));
    }

    #[test]
    fn stop_clears_dangling_tools() {
        // e.g. a denied permission never gets PostToolUse
        let mut h = Harness::new();
        h.fire(
            "PreToolUse",
            json!({ "tool_name": "Bash", "tool_use_id": "a" }),
        );
        h.fire("Stop", json!({}));
        assert_eq!(h.fire("UserPromptSubmit", json!({})).state, Generating);
    }

    #[test]
    fn permission_notification_waits_and_approval_resumes() {
        let mut h = Harness::new();
        h.fire("UserPromptSubmit", json!({}));
        h.fire(
            "PreToolUse",
            json!({ "tool_name": "Bash", "tool_use_id": "a" }),
        );
        let s = h.fire(
            "Notification",
            json!({ "notification_type": "permission_prompt", "message": "Claude needs your permission to use Bash" }),
        );
        assert_eq!(s.state, Waiting);
        assert_eq!(s.tool, None);
        assert_eq!(
            h.fire(
                "PostToolUse",
                json!({ "tool_name": "Bash", "tool_use_id": "a" })
            )
            .state,
            Generating
        );
    }

    #[test]
    fn idle_notification_does_not_interrupt_a_turn() {
        let mut h = Harness::new();
        h.fire("UserPromptSubmit", json!({}));
        assert_eq!(
            h.fire(
                "Notification",
                json!({ "notification_type": "idle_prompt" })
            )
            .state,
            Generating
        );
        h.fire("Stop", json!({}));
        assert_eq!(
            h.fire(
                "Notification",
                json!({ "notification_type": "idle_prompt" })
            )
            .state,
            Idle
        );
    }

    #[test]
    fn compaction_auto_resumes_manual_idles() {
        let mut h = Harness::new();
        h.fire("UserPromptSubmit", json!({}));
        let s = h.fire("PreCompact", json!({ "trigger": "auto" }));
        assert_eq!(s.state, ToolRunning);
        assert_eq!(s.tool.as_deref(), Some("Compact"));
        assert_eq!(
            h.fire("SessionStart", json!({ "source": "compact" })).state,
            Generating
        );

        h.fire("Stop", json!({}));
        h.fire("PreCompact", json!({ "trigger": "manual" }));
        assert_eq!(
            h.fire("SessionStart", json!({ "source": "compact" })).state,
            Idle
        );
    }

    #[test]
    fn permission_request_waits_immediately() {
        let mut h = Harness::new();
        h.fire("UserPromptSubmit", json!({}));
        h.fire(
            "PreToolUse",
            json!({ "tool_name": "Bash", "tool_use_id": "a" }),
        );
        let s = h.fire("PermissionRequest", json!({ "tool_name": "Bash" }));
        assert_eq!(s.state, Waiting);
        assert_eq!(s.running, 1);
        assert_eq!(
            h.fire(
                "PostToolUse",
                json!({ "tool_name": "Bash", "tool_use_id": "a" })
            )
            .state,
            Generating
        );
    }

    #[test]
    fn elicitation_round_trip() {
        let mut h = Harness::new();
        h.fire("UserPromptSubmit", json!({}));
        h.fire(
            "PreToolUse",
            json!({ "tool_name": "mcp__jira__create", "tool_use_id": "m" }),
        );
        assert_eq!(h.fire("Elicitation", json!({})).state, Waiting);
        let s = h.fire("ElicitationResult", json!({}));
        assert_eq!(
            s.state, ToolRunning,
            "the MCP tool that asked is still running"
        );
        assert_eq!(s.tool.as_deref(), Some("create"));
        // A stray result outside WAITING changes nothing.
        h.fire("Stop", json!({}));
        assert_eq!(h.fire("ElicitationResult", json!({})).state, Idle);
    }

    #[test]
    fn post_compact_settles_before_the_compact_restart() {
        let mut h = Harness::new();
        h.fire("UserPromptSubmit", json!({}));
        h.fire("PreCompact", json!({ "trigger": "auto" }));
        assert_eq!(
            h.fire("PostCompact", json!({ "trigger": "auto" })).state,
            Generating
        );
        assert_eq!(
            h.fire("SessionStart", json!({ "source": "compact" })).state,
            Generating,
            "restart keeps the settled state"
        );

        h.fire("Stop", json!({}));
        h.fire("PreCompact", json!({ "trigger": "manual" }));
        assert_eq!(
            h.fire("PostCompact", json!({})).state,
            Idle,
            "pending trigger wins over a missing payload field"
        );
        assert_eq!(
            h.fire("SessionStart", json!({ "source": "compact" })).state,
            Idle
        );
    }

    #[test]
    fn subagent_start_is_only_a_heartbeat() {
        let mut h = Harness::new();
        h.fire(
            "PreToolUse",
            json!({ "tool_name": "Task", "tool_use_id": "t" }),
        );
        let s = h.fire("SubagentStart", json!({}));
        assert_eq!(s.state, ToolRunning);
        assert_eq!(s.tool.as_deref(), Some("Task"));
    }

    #[test]
    fn subagent_stop_is_only_a_heartbeat() {
        let mut h = Harness::new();
        h.fire(
            "PreToolUse",
            json!({ "tool_name": "Task", "tool_use_id": "t" }),
        );
        h.t += 5_000;
        let s = h.fire("SubagentStop", json!({}));
        assert_eq!(s.state, ToolRunning);
        assert_eq!(s.tool.as_deref(), Some("Task"));
        assert_eq!(s.last_seen, 6_000);
    }

    #[test]
    fn entrypoint_header_normalizes_source() {
        let mut h = Harness::new();
        let meta = |e: &str| Meta {
            entrypoint: Some(e.into()),
            session_id: None,
        };
        assert_eq!(
            h.fire_meta("SessionStart", json!({}), meta("claude-vscode"))
                .source,
            "vscode"
        );
        assert_eq!(h.fire_meta("Stop", json!({}), meta("cli")).source, "cli");
        assert_eq!(
            h.fire("Stop", json!({})).source,
            "cli",
            "missing header keeps the last known source"
        );
    }

    #[test]
    fn unknown_events_and_unattributable_payloads_are_ignored() {
        let mut store = SessionStore::new();
        let m = Meta::default();
        assert!(
            store
                .apply("Bogus", &json!({ "session_id": SID, "cwd": "/x" }), &m, 0)
                .is_none()
        );
        assert!(
            store
                .apply("Stop", &json!({ "hook_event_name": "Stop" }), &m, 0)
                .is_none()
        );
        assert_eq!(store.len(), 0);
    }

    #[test]
    fn sweep_expires_stale_and_ended_sessions() {
        let mut h = Harness::new();
        h.fire("SessionStart", json!({}));
        h.store.apply(
            "SessionEnd",
            &json!({ "session_id": "other", "cwd": "/x" }),
            &Meta::default(),
            h.t,
        );
        h.t += OFFLINE_LINGER_MS + 1;
        let ids: Vec<String> = h.store.sweep(h.t).into_iter().map(|s| s.id).collect();
        assert_eq!(ids, ["other"]);
        h.t += STALE_MS;
        let ids: Vec<String> = h.store.sweep(h.t).into_iter().map(|s| s.id).collect();
        assert_eq!(ids, [SID]);
        assert_eq!(h.store.len(), 0);
    }

    #[test]
    fn allowed_origins() {
        let none: [String; 0] = [];
        assert!(
            is_allowed_origin(None, &none),
            "hooks / curl send no Origin"
        );
        assert!(is_allowed_origin(Some("http://localhost:5173"), &none));
        assert!(is_allowed_origin(Some("http://127.0.0.1:4173"), &none));
        assert!(is_allowed_origin(Some("http://[::1]:5173"), &none));
        assert!(!is_allowed_origin(Some("https://evil.example"), &none));
        assert!(!is_allowed_origin(
            Some("http://localhost.evil.example"),
            &none
        ));
        assert!(!is_allowed_origin(Some("null"), &none));
        assert!(!is_allowed_origin(Some("file://"), &none));
        assert!(is_allowed_origin(
            Some("https://desk.example"),
            &["https://desk.example".to_string()]
        ));
    }

    #[test]
    fn helpers() {
        assert_eq!(project_from_cwd("C:\\code\\proj\\"), "proj");
        assert_eq!(project_from_cwd(""), "unknown");
        assert_eq!(short_tool_name(None), "Tool");
        assert!(is_attention_notification(
            &json!({ "message": "Claude needs your permission to use Bash" })
        ));
        assert!(!is_attention_notification(
            &json!({ "message": "Claude is waiting for your input" })
        ));
        assert_eq!(parse_origin_list(Some(" a, ,b ")), ["a", "b"]);
    }
}
