//! Spoken (or typed) tasks for Claude: run `claude -p` in a session's project folder and report back.
//!
//! The run is a normal headless Claude Code session: its hooks reach the bridge like any other, so it
//! shows up on the desk, and tools that need permission go through the desk's Approve / Deny.

use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use serde::Serialize;
use serde_json::Value;
use tokio::process::Command as Process;

/// Keep this many finished commands in the snapshot.
const KEEP: usize = 6;
pub const MAX_RUNNING: usize = 2;
pub const TIMEOUT: Duration = Duration::from_secs(15 * 60);
pub const MAX_PROMPT: usize = 2_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    pub id: String,
    pub prompt: String,
    pub project: String,
    pub cwd: String,
    pub status: Status,
    /// Claude's final answer (done) or what went wrong (failed)
    pub result: Option<String>,
    pub started_at: u64,
    pub finished_at: Option<u64>,
}

#[derive(Default)]
pub struct Commands {
    list: VecDeque<Command>,
    seq: u64,
}

impl Commands {
    pub fn running(&self) -> usize {
        self.list
            .iter()
            .filter(|c| c.status == Status::Running)
            .count()
    }

    pub fn start(&mut self, prompt: String, project: String, cwd: String, now: u64) -> Command {
        self.seq += 1;
        let c = Command {
            id: format!("cmd-{}", self.seq),
            prompt,
            project,
            cwd,
            status: Status::Running,
            result: None,
            started_at: now,
            finished_at: None,
        };
        self.list.push_front(c.clone());
        // Forget old finished ones; running commands always stay.
        while self.list.len() > KEEP {
            match self.list.iter().rposition(|c| c.status != Status::Running) {
                Some(i) => {
                    self.list.remove(i);
                }
                None => break,
            }
        }
        c
    }

    pub fn finish(&mut self, id: &str, status: Status, result: String, now: u64) {
        if let Some(c) = self.list.iter_mut().find(|c| c.id == id) {
            c.status = status;
            c.result = Some(result);
            c.finished_at = Some(now);
        }
    }

    pub fn list(&self) -> Vec<Command> {
        self.list.iter().cloned().collect()
    }
}

/// Where the `claude` CLI is. Apps started from Finder get a minimal PATH, so also look in the usual places.
pub fn find_claude() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("CLAWDDESK_CLAUDE")
        .map(PathBuf::from)
        .filter(|p| p.is_file())
    {
        return Some(p);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut candidates: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| {
            std::env::split_paths(&p)
                .map(|d| d.join("claude"))
                .collect()
        })
        .unwrap_or_default();
    if let Some(h) = &home {
        candidates.push(h.join(".local/bin/claude"));
        candidates.push(h.join(".claude/local/claude"));
        candidates.push(h.join(".npm-global/bin/claude"));
    }
    candidates.push("/opt/homebrew/bin/claude".into());
    candidates.push("/usr/local/bin/claude".into());
    candidates.into_iter().find(|p| p.is_file())
}

/// The final text of a `claude -p --output-format json` run, or why it failed.
pub fn parse_output(stdout: &str, stderr: &str, success: bool) -> Result<String, String> {
    let last_json = stdout
        .lines()
        .rev()
        .find_map(|l| serde_json::from_str::<Value>(l.trim()).ok());
    if let Some(v) = last_json {
        let text = v
            .get("result")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let is_error = v.get("is_error").and_then(Value::as_bool).unwrap_or(false)
            || v.get("subtype")
                .and_then(Value::as_str)
                .is_some_and(|s| s != "success");
        return if is_error {
            Err(if text.is_empty() {
                "Claude stopped with an error.".into()
            } else {
                text
            })
        } else {
            Ok(text)
        };
    }
    let err = stderr.trim();
    if !success || stdout.trim().is_empty() {
        Err(if err.is_empty() {
            "Claude exited without an answer.".into()
        } else {
            last_line(err)
        })
    } else {
        Ok(stdout.trim().to_string())
    }
}

fn last_line(s: &str) -> String {
    s.lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or(s)
        .trim()
        .chars()
        .take(300)
        .collect()
}

/// Run one headless Claude Code turn in `cwd`.
pub async fn run_claude(claude: &Path, prompt: &str, cwd: &str) -> Result<String, String> {
    let child = Process::new(claude)
        .arg("-p")
        .arg(prompt)
        .args(["--output-format", "json"])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("could not start claude: {e}"))?;
    match tokio::time::timeout(TIMEOUT, child.wait_with_output()).await {
        Err(_) => Err(format!(
            "timed out after {} minutes",
            TIMEOUT.as_secs() / 60
        )),
        Ok(Err(e)) => Err(format!("claude failed: {e}")),
        Ok(Ok(out)) => parse_output(
            &String::from_utf8_lossy(&out.stdout),
            &String::from_utf8_lossy(&out.stderr),
            out.status.success(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_recent_finished_and_all_running() {
        let mut c = Commands::default();
        let first = c.start("a".into(), "p".into(), "/p".into(), 1);
        for i in 0..8 {
            let x = c.start(format!("x{i}"), "p".into(), "/p".into(), 2);
            c.finish(&x.id, Status::Done, "ok".into(), 3);
        }
        let list = c.list();
        assert_eq!(list.len(), KEEP);
        assert!(
            list.iter().any(|x| x.id == first.id),
            "running command is never dropped"
        );
        assert_eq!(c.running(), 1);
        c.finish(&first.id, Status::Failed, "boom".into(), 4);
        assert_eq!(c.running(), 0);
    }

    #[test]
    fn parses_claude_json_output() {
        let ok = r#"{"type":"result","subtype":"success","is_error":false,"result":"All 12 tests pass.","session_id":"x"}"#;
        assert_eq!(parse_output(ok, "", true), Ok("All 12 tests pass.".into()));
        let err = r#"{"type":"result","subtype":"error_max_turns","is_error":true,"result":""}"#;
        assert!(parse_output(err, "", false).is_err());
        assert_eq!(
            parse_output("", "Error: not logged in\n", false),
            Err("Error: not logged in".into())
        );
        assert_eq!(
            parse_output("plain text answer", "", true),
            Ok("plain text answer".into())
        );
    }
}
