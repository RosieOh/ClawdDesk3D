//! Permission requests waiting for an answer from the desk (or the menu bar app).
//!
//! The PermissionRequest hook call is held open while a desk is connected; whoever answers first
//! (Approve / Deny) resolves it, and after a timeout the bridge answers "no decision" so Claude Code
//! shows its normal permission prompt instead.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::oneshot;

/// Longest preview of the tool input shown on the desk.
const SUMMARY_MAX: usize = 240;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Behavior {
    Allow,
    Deny,
}

impl Behavior {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "allow" => Some(Behavior::Allow),
            "deny" => Some(Behavior::Deny),
            _ => None,
        }
    }
}

/// What the desk shows for a waiting request.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub id: String,
    pub session_id: String,
    pub project: String,
    pub tool: String,
    /// short, human-readable preview of what the tool wants to do (command, file, URL…)
    pub summary: String,
    pub created_at: u64,
    pub expires_at: u64,
}

#[derive(Default)]
pub struct Approvals {
    waiting: HashMap<String, (Pending, oneshot::Sender<Behavior>)>,
    seq: u64,
}

impl Approvals {
    pub fn new_id(&mut self) -> String {
        self.seq += 1;
        format!("ap-{}", self.seq)
    }

    pub fn add(&mut self, p: Pending) -> oneshot::Receiver<Behavior> {
        let (tx, rx) = oneshot::channel();
        self.waiting.insert(p.id.clone(), (p, tx));
        rx
    }

    /// Answer a request. Returns the request if it was still waiting.
    pub fn decide(&mut self, id: &str, behavior: Behavior) -> Option<Pending> {
        let (p, tx) = self.waiting.remove(id)?;
        // The hook call may have just timed out; then nobody is listening, which is fine.
        let _ = tx.send(behavior);
        Some(p)
    }

    /// Drop a request without an answer (timed out).
    pub fn expire(&mut self, id: &str) -> Option<Pending> {
        self.waiting.remove(id).map(|(p, _)| p)
    }

    pub fn list(&self) -> Vec<Pending> {
        let mut out: Vec<Pending> = self.waiting.values().map(|(p, _)| p.clone()).collect();
        out.sort_by_key(|p| p.created_at);
        out
    }
}

fn truncate(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max.saturating_sub(1)).collect();
    format!("{cut}…")
}

/// Hide things that look like secrets in text shown on screen (tokens, passwords, API keys).
pub fn mask_secrets(text: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut after_bearer = false;
    for w in text.split(' ') {
        let masked = if after_bearer {
            "••••".to_string()
        } else if let Some((k, _)) = w
            .split_once('=')
            .filter(|(k, v)| !v.is_empty() && is_secret_name(k))
        {
            format!("{k}=••••")
        } else if looks_like_key(w) {
            "••••".to_string()
        } else {
            w.to_string()
        };
        after_bearer = w.eq_ignore_ascii_case("bearer");
        out.push(masked);
    }
    out.join(" ")
}

fn is_secret_name(name: &str) -> bool {
    let n = name.trim_start_matches('-').to_ascii_lowercase();
    [
        "token",
        "secret",
        "password",
        "passwd",
        "pwd",
        "api_key",
        "apikey",
        "api-key",
        "access_key",
        "private_key",
        "auth",
    ]
    .iter()
    .any(|s| n.ends_with(s))
}

/// Long opaque credentials: `sk-…`, `ghp_…`, `xox?-…`, AWS access keys.
fn looks_like_key(w: &str) -> bool {
    let w = w.trim_matches(|c: char| c == '"' || c == '\'' || c == ',');
    let prefixed = [
        "sk-",
        "sk_",
        "ghp_",
        "gho_",
        "ghs_",
        "github_pat_",
        "xoxb-",
        "xoxp-",
        "AKIA",
        "AIza",
    ]
    .iter()
    .any(|p| w.starts_with(p));
    prefixed && w.len() >= 20
}

/// One line describing what the tool is about to do, from its `tool_input`.
pub fn summarize(tool: &str, input: &Value) -> String {
    let s = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("");
    let text = match tool {
        "Bash" => s("command").to_string(),
        "Edit" | "MultiEdit" | "Write" | "Read" | "NotebookEdit" => {
            let path = if s("file_path").is_empty() {
                s("notebook_path")
            } else {
                s("file_path")
            };
            path.to_string()
        }
        "WebFetch" => s("url").to_string(),
        "WebSearch" => s("query").to_string(),
        "Glob" | "Grep" => s("pattern").to_string(),
        "Task" | "Agent" => s("description").to_string(),
        _ => String::new(),
    };
    if !text.is_empty() {
        return truncate(&mask_secrets(&text.replace('\n', " ⏎ ")), SUMMARY_MAX);
    }
    match input {
        Value::Null => String::new(),
        Value::Object(o) if o.is_empty() => String::new(),
        other => truncate(&other.to_string(), SUMMARY_MAX),
    }
}

/// The PermissionRequest hook output for a decision made on the desk. An allow passes the original input
/// back unchanged as `updatedInput` (Claude Code re-checks it against deny/ask rules).
pub fn decision_output(behavior: Behavior, input: Option<Value>) -> String {
    let decision = match behavior {
        Behavior::Allow => match input {
            Some(input) if !input.is_null() => {
                json!({ "behavior": "allow", "updatedInput": input })
            }
            _ => json!({ "behavior": "allow" }),
        },
        Behavior::Deny => json!({ "behavior": "deny", "message": "Denied from ClawdDesk." }),
    };
    json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision } })
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(id: &str, at: u64) -> Pending {
        Pending {
            id: id.into(),
            session_id: "s".into(),
            project: "p".into(),
            tool: "Bash".into(),
            summary: "ls".into(),
            created_at: at,
            expires_at: at + 30_000,
        }
    }

    #[test]
    fn decide_resolves_the_waiting_hook_once() {
        let mut a = Approvals::default();
        let mut rx = a.add(pending("ap-1", 1));
        assert_eq!(a.list().len(), 1);
        assert!(a.decide("ap-1", Behavior::Allow).is_some());
        assert_eq!(rx.try_recv().unwrap(), Behavior::Allow);
        assert!(
            a.decide("ap-1", Behavior::Deny).is_none(),
            "already answered"
        );
        assert!(a.list().is_empty());
    }

    #[test]
    fn expire_drops_without_an_answer_and_lists_in_order() {
        let mut a = Approvals::default();
        let mut rx = a.add(pending("b", 2));
        let _keep = a.add(pending("a", 1));
        assert_eq!(
            a.list().iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert!(a.expire("b").is_some());
        assert!(rx.try_recv().is_err());
        assert!(a.decide("b", Behavior::Allow).is_none());
    }

    #[test]
    fn summaries_show_what_the_tool_will_do() {
        assert_eq!(
            summarize("Bash", &json!({ "command": "rm -rf build\nls" })),
            "rm -rf build ⏎ ls"
        );
        assert_eq!(
            summarize(
                "Edit",
                &json!({ "file_path": "/a/b.ts", "old_string": "x" })
            ),
            "/a/b.ts"
        );
        assert_eq!(
            summarize("WebFetch", &json!({ "url": "https://x.dev" })),
            "https://x.dev"
        );
        assert_eq!(summarize("mcp__x__y", &json!({ "q": 1 })), r#"{"q":1}"#);
        assert_eq!(summarize("Bash", &json!({})), "");
        let long = summarize("Bash", &json!({ "command": "x".repeat(500) }));
        assert_eq!(long.chars().count(), SUMMARY_MAX);
        assert!(long.ends_with('…'));
    }

    #[test]
    fn secrets_are_masked() {
        assert_eq!(
            mask_secrets("curl -H Authorization: Bearer abc123 https://x"),
            "curl -H Authorization: Bearer •••• https://x"
        );
        assert_eq!(
            mask_secrets("export API_KEY=hunter2 && run"),
            "export API_KEY=•••• && run"
        );
        assert_eq!(
            mask_secrets("mysql --password=s3cret"),
            "mysql --password=••••"
        );
        assert_eq!(
            mask_secrets("echo sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX"),
            "echo ••••"
        );
        assert_eq!(
            mask_secrets("npm test -- --watch=false"),
            "npm test -- --watch=false"
        );
        assert_eq!(
            summarize(
                "Bash",
                &json!({ "command": "GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxx gh pr list" })
            ),
            "GITHUB_TOKEN=•••• gh pr list"
        );
    }

    #[test]
    fn output_matches_the_hook_schema() {
        let input = json!({ "command": "npm test" });
        let v: Value =
            serde_json::from_str(&decision_output(Behavior::Allow, Some(input.clone()))).unwrap();
        assert_eq!(
            v["hookSpecificOutput"]["hookEventName"],
            "PermissionRequest"
        );
        assert_eq!(v["hookSpecificOutput"]["decision"]["behavior"], "allow");
        assert_eq!(v["hookSpecificOutput"]["decision"]["updatedInput"], input);
        let v: Value = serde_json::from_str(&decision_output(Behavior::Allow, None)).unwrap();
        assert!(
            v["hookSpecificOutput"]["decision"]
                .get("updatedInput")
                .is_none()
        );
        let v: Value = serde_json::from_str(&decision_output(Behavior::Deny, None)).unwrap();
        assert_eq!(v["hookSpecificOutput"]["decision"]["behavior"], "deny");
        assert!(v["hookSpecificOutput"]["decision"]["message"].is_string());
    }
}
