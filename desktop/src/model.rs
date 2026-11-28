//! What the tray shows, derived from the bridge's `/state` snapshot.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub project: String,
    pub state: String,
    pub tool: Option<String>,
    pub model: Option<String>,
    #[serde(default)]
    pub last_event: String,
    #[serde(default)]
    pub last_seen: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Approval {
    pub id: String,
    pub project: String,
    pub tool: String,
    #[serde(default)]
    pub summary: String,
}

impl Approval {
    /// "Bash: npm test" (summary shortened for a menu line)
    pub fn label(&self) -> String {
        let summary: String = self.summary.chars().take(48).collect();
        let more = if self.summary.chars().count() > 48 {
            "…"
        } else {
            ""
        };
        if summary.is_empty() {
            self.tool.clone()
        } else {
            format!("{}: {summary}{more}", self.tool)
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Alert {
    pub id: String,
    pub kind: String,
    pub repo: String,
    pub number: u64,
    #[serde(default)]
    pub title: String,
}

impl Alert {
    /// Notification title and body.
    pub fn notification(&self) -> (String, String) {
        let repo = self.repo.rsplit('/').next().unwrap_or(&self.repo);
        let head = if self.kind == "ci_failed" {
            "CI failed"
        } else {
            "Review requested"
        };
        (
            format!("{head}: {repo} #{}", self.number),
            self.title.clone(),
        )
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Snapshot {
    pub sessions: Vec<Session>,
    #[serde(default)]
    pub approvals: Vec<Approval>,
    #[serde(default)]
    pub alerts: Vec<Alert>,
}

impl Snapshot {
    pub fn parse(body: &str) -> Option<Self> {
        serde_json::from_str(body).ok()
    }
}

#[derive(Debug, Clone, Default)]
pub struct View {
    pub reachable: bool,
    /// most recent first, ended sessions dropped
    pub sessions: Vec<Session>,
    pub approvals: Vec<Approval>,
    pub alerts: Vec<Alert>,
}

impl From<Option<&Snapshot>> for View {
    fn from(s: Option<&Snapshot>) -> Self {
        let Some(s) = s else { return View::default() };
        let mut sessions: Vec<Session> = s
            .sessions
            .iter()
            .filter(|x| x.state != "OFFLINE")
            .cloned()
            .collect();
        sessions.sort_by_key(|s| std::cmp::Reverse(s.last_seen));
        View {
            reachable: true,
            sessions,
            approvals: s.approvals.clone(),
            alerts: s.alerts.clone(),
        }
    }
}

/// `claude-opus-5-5` → `Opus 5.5` (same idea as the desk's formatter, kept small)
pub fn pretty_model(id: &str) -> String {
    let parts: Vec<&str> = id.trim_start_matches("claude-").split('-').collect();
    let Some(i) = parts
        .iter()
        .position(|p| ["opus", "sonnet", "haiku", "fable"].contains(p))
    else {
        return id.to_string();
    };
    let mut name = parts[i].to_string();
    name[..1].make_ascii_uppercase();
    let version: Vec<&str> = parts
        .iter()
        .filter(|p| p.len() <= 2 && p.chars().all(|c| c.is_ascii_digit()))
        .copied()
        .collect();
    if version.is_empty() {
        name
    } else {
        format!("{name} {}", version.join("."))
    }
}

fn state_label(s: &Session) -> String {
    match s.state.as_str() {
        "GENERATING" => "generating".into(),
        "TOOL_RUNNING" => format!("running {}", s.tool.as_deref().unwrap_or("a tool")),
        "WAITING" => "needs you".into(),
        "IDLE" => "idle".into(),
        other => other.to_lowercase(),
    }
}

impl View {
    /// Colour of the menu bar dot: a waiting permission wins, then the most recently active session.
    pub fn color(&self) -> Option<[u8; 3]> {
        if !self.reachable {
            return None;
        }
        if !self.approvals.is_empty() || self.sessions.iter().any(|s| s.state == "WAITING") {
            return Some([255, 93, 143]);
        }
        Some(match self.sessions.first().map(|s| s.state.as_str()) {
            Some("GENERATING") => [255, 179, 92],
            Some("TOOL_RUNNING") => [54, 215, 255],
            Some("IDLE") => [255, 154, 77],
            _ => [125, 143, 168],
        })
    }

    /// Number next to the icon: pending approvals.
    pub fn badge(&self) -> Option<String> {
        (!self.approvals.is_empty()).then(|| self.approvals.len().to_string())
    }

    pub fn tooltip(&self) -> String {
        match self.sessions.first() {
            Some(s) if self.reachable => format!("ClawdDesk — {}: {}", s.project, state_label(s)),
            _ if self.reachable => "ClawdDesk — no sessions".into(),
            _ => "ClawdDesk — bridge not running".into(),
        }
    }

    pub fn session_lines(&self) -> Vec<String> {
        self.sessions
            .iter()
            .map(|s| {
                let model = s
                    .model
                    .as_deref()
                    .map(pretty_model)
                    .map(|m| format!(" · {m}"))
                    .unwrap_or_default();
                format!("●  {} — {}{model}", s.project, state_label(s))
            })
            .collect()
    }

    /// Changes whenever anything the tray shows changes.
    pub fn signature(&self) -> String {
        let s: Vec<String> = self
            .sessions
            .iter()
            .map(|s| format!("{}:{}:{:?}:{:?}", s.id, s.state, s.tool, s.model))
            .collect();
        let a: Vec<&str> = self.approvals.iter().map(|a| a.id.as_str()).collect();
        format!("{}|{}|{}", self.reachable, s.join(","), a.join(","))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(json: &str) -> View {
        View::from(Snapshot::parse(json).as_ref())
    }

    #[test]
    fn colours_and_badge() {
        assert_eq!(View::default().color(), None, "bridge unreachable");
        let v = snap(
            r#"{"sessions":[{"id":"a","project":"p","state":"GENERATING","lastSeen":2},{"id":"b","project":"q","state":"IDLE","lastSeen":1}]}"#,
        );
        assert_eq!(v.color(), Some([255, 179, 92]));
        assert_eq!(v.badge(), None);
        let v = snap(
            r#"{"sessions":[{"id":"a","project":"p","state":"IDLE"}],"approvals":[{"id":"ap-1","project":"p","tool":"Bash","summary":"npm test"}]}"#,
        );
        assert_eq!(v.color(), Some([255, 93, 143]));
        assert_eq!(v.badge().as_deref(), Some("1"));
        assert_eq!(v.approvals[0].label(), "Bash: npm test");
    }

    #[test]
    fn lines_skip_ended_sessions_and_sort_by_recency() {
        let v = snap(
            r#"{"sessions":[{"id":"a","project":"old","state":"OFFLINE","lastSeen":9},{"id":"b","project":"api","state":"TOOL_RUNNING","tool":"Bash","model":"claude-opus-5-5","lastSeen":5},{"id":"c","project":"web","state":"WAITING","lastSeen":7}]}"#,
        );
        assert_eq!(
            v.session_lines(),
            ["●  web — needs you", "●  api — running Bash · Opus 5.5"]
        );
        assert_eq!(v.tooltip(), "ClawdDesk — web: needs you");
    }

    #[test]
    fn model_names() {
        assert_eq!(pretty_model("claude-opus-5-5"), "Opus 5.5");
        assert_eq!(pretty_model("claude-sonnet-4-5-20250929"), "Sonnet 4.5");
        assert_eq!(pretty_model("gpt-x"), "gpt-x");
    }
}
