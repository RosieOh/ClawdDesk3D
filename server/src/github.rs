//! Proactive GitHub alerts and briefing data, through the user's own `gh` CLI (nothing else is needed).
//!
//! Every few minutes the bridge looks at the repositories of the sessions it knows: failing CI on your open
//! pull requests, and reviews requested from you anywhere. The first look is a baseline; afterwards only
//! things that newly appear become alerts (spoken by the desk, notified by the menu bar app).

use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use serde::Serialize;
use serde_json::Value;
use tokio::process::Command;

pub const DEFAULT_INTERVAL: Duration = Duration::from_secs(5 * 60);
const GH_TIMEOUT: Duration = Duration::from_secs(20);
const KEEP_ALERTS: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    CiFailed,
    ReviewRequested,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    /// stable identity: a new commit on a failing PR is a new finding
    #[serde(skip)]
    pub key: String,
    pub kind: Kind,
    pub repo: String,
    pub number: u64,
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    pub id: String,
    #[serde(flatten)]
    pub finding: Finding,
    pub at: u64,
}

/// What the morning briefing reads.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub repos: Vec<String>,
    pub open_prs: usize,
    pub ci_failing: Vec<Finding>,
    pub review_requested: Vec<Finding>,
    pub checked_at: u64,
}

#[derive(Default)]
pub struct GitHub {
    seen: HashSet<String>,
    baseline_done: bool,
    alerts: VecDeque<Alert>,
    seq: u64,
    pub overview: Option<Overview>,
    /// cwd → owner/name (None: not a GitHub repository)
    repo_of: HashMap<String, Option<String>>,
}

impl GitHub {
    pub fn cached_repo(&self, cwd: &str) -> Option<Option<String>> {
        self.repo_of.get(cwd).cloned()
    }

    pub fn remember_repo(&mut self, cwd: &str, repo: Option<String>) {
        self.repo_of.insert(cwd.to_string(), repo);
    }

    /// Record one poll. Returns the alerts that are new (none on the very first poll: that's the baseline).
    pub fn record(&mut self, overview: Overview, now: u64) -> Vec<Alert> {
        let findings: Vec<Finding> = overview
            .ci_failing
            .iter()
            .chain(&overview.review_requested)
            .cloned()
            .collect();
        let mut fresh = Vec::new();
        for f in findings {
            if self.seen.insert(f.key.clone()) && self.baseline_done {
                self.seq += 1;
                let alert = Alert {
                    id: format!("al-{}", self.seq),
                    finding: f,
                    at: now,
                };
                self.alerts.push_front(alert.clone());
                fresh.push(alert);
            }
        }
        self.alerts.truncate(KEEP_ALERTS);
        self.baseline_done = true;
        self.overview = Some(overview);
        fresh
    }

    pub fn alerts(&self) -> Vec<Alert> {
        self.alerts.iter().cloned().collect()
    }
}

// ---------------------------------------------------------------- gh

pub fn find_gh() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).map(|d| d.join("gh")).collect())
        .unwrap_or_default();
    candidates.push("/opt/homebrew/bin/gh".into());
    candidates.push("/usr/local/bin/gh".into());
    candidates.into_iter().find(|p| p.is_file())
}

async fn gh_json(gh: &Path, args: &[&str], cwd: Option<&str>) -> Option<Value> {
    let mut cmd = Command::new(gh);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let out = tokio::time::timeout(GH_TIMEOUT, cmd.output())
        .await
        .ok()?
        .ok()?;
    if !out.status.success() {
        return None;
    }
    serde_json::from_slice(&out.stdout).ok()
}

/// `owner/name` of the GitHub repository checked out in `cwd`.
pub async fn repo_for(gh: &Path, cwd: &str) -> Option<String> {
    let v = gh_json(gh, &["repo", "view", "--json", "nameWithOwner"], Some(cwd)).await?;
    v.get("nameWithOwner")
        .and_then(Value::as_str)
        .map(String::from)
}

/// Failed check conclusions on a PR's head commit.
pub fn ci_failed(pr: &Value) -> bool {
    pr.get("statusCheckRollup")
        .and_then(Value::as_array)
        .is_some_and(|checks| {
            checks.iter().any(|c| {
                let concl = c
                    .get("conclusion")
                    .or_else(|| c.get("state"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                matches!(
                    concl,
                    "FAILURE" | "ERROR" | "TIMED_OUT" | "STARTUP_FAILURE" | "ACTION_REQUIRED"
                )
            })
        })
}

/// Your open PRs in `repo`: how many, and which have failing CI.
pub fn parse_prs(repo: &str, prs: &Value) -> (usize, Vec<Finding>) {
    let list = prs.as_array().cloned().unwrap_or_default();
    let failing = list
        .iter()
        .filter(|pr| ci_failed(pr))
        .map(|pr| {
            let number = pr.get("number").and_then(Value::as_u64).unwrap_or(0);
            let sha = pr.get("headRefOid").and_then(Value::as_str).unwrap_or("");
            Finding {
                key: format!("ci:{repo}#{number}@{sha}"),
                kind: Kind::CiFailed,
                repo: repo.to_string(),
                number,
                title: pr
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                url: pr
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            }
        })
        .collect();
    (list.len(), failing)
}

pub fn parse_reviews(found: &Value) -> Vec<Finding> {
    found
        .as_array()
        .map(|a| {
            a.iter()
                .map(|pr| {
                    let repo = pr
                        .pointer("/repository/nameWithOwner")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let number = pr.get("number").and_then(Value::as_u64).unwrap_or(0);
                    Finding {
                        key: format!("review:{repo}#{number}"),
                        kind: Kind::ReviewRequested,
                        repo,
                        number,
                        title: pr
                            .get("title")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        url: pr
                            .get("url")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

/// One look at GitHub for these repositories.
pub async fn poll(gh: &Path, repos: &[String], now: u64) -> Overview {
    let mut overview = Overview {
        repos: repos.to_vec(),
        checked_at: now,
        ..Default::default()
    };
    for repo in repos {
        let args = [
            "pr",
            "list",
            "-R",
            repo,
            "--author",
            "@me",
            "--state",
            "open",
            "--json",
            "number,title,url,headRefOid,statusCheckRollup",
        ];
        if let Some(prs) = gh_json(gh, &args, None).await {
            let (open, failing) = parse_prs(repo, &prs);
            overview.open_prs += open;
            overview.ci_failing.extend(failing);
        }
    }
    let args = [
        "search",
        "prs",
        "--review-requested=@me",
        "--state=open",
        "--json",
        "number,title,url,repository",
    ];
    if let Some(found) = gh_json(gh, &args, None).await {
        overview.review_requested = parse_reviews(&found);
    }
    overview
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn prs() -> Value {
        json!([
            { "number": 12, "title": "Voice", "url": "u12", "headRefOid": "aaa",
              "statusCheckRollup": [{ "name": "ci", "conclusion": "SUCCESS" }, { "name": "lint", "conclusion": "FAILURE" }] },
            { "number": 13, "title": "Approve", "url": "u13", "headRefOid": "bbb",
              "statusCheckRollup": [{ "name": "ci", "conclusion": "SUCCESS" }, { "context": "x", "state": "PENDING" }] }
        ])
    }

    #[test]
    fn finds_failing_ci_on_open_prs() {
        let (open, failing) = parse_prs("me/repo", &prs());
        assert_eq!(open, 2);
        assert_eq!(failing.len(), 1);
        assert_eq!(
            (failing[0].number, failing[0].key.as_str()),
            (12, "ci:me/repo#12@aaa")
        );
    }

    #[test]
    fn reviews_from_search() {
        let found = json!([{ "number": 7, "title": "Fix", "url": "u7", "repository": { "nameWithOwner": "org/app" } }]);
        let r = parse_reviews(&found);
        assert_eq!(
            (r[0].repo.as_str(), r[0].number, r[0].kind),
            ("org/app", 7, Kind::ReviewRequested)
        );
    }

    #[test]
    fn first_poll_is_a_baseline_then_only_new_things_alert() {
        let mut g = GitHub::default();
        let (_, failing) = parse_prs("me/repo", &prs());
        let ov = |ci: Vec<Finding>, rev: Vec<Finding>| Overview {
            ci_failing: ci,
            review_requested: rev,
            ..Default::default()
        };
        assert!(
            g.record(ov(failing.clone(), vec![]), 1).is_empty(),
            "baseline"
        );
        assert!(
            g.record(ov(failing.clone(), vec![]), 2).is_empty(),
            "still the same failure"
        );
        let review = parse_reviews(
            &json!([{ "number": 7, "title": "Fix", "url": "u", "repository": { "nameWithOwner": "org/app" } }]),
        );
        let fresh = g.record(ov(failing.clone(), review), 3);
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh[0].finding.kind, Kind::ReviewRequested);
        // a new commit that fails again is a new alert
        let mut refailed = failing.clone();
        refailed[0].key = "ci:me/repo#12@ccc".into();
        assert_eq!(g.record(ov(refailed, vec![]), 4).len(), 1);
        assert_eq!(g.alerts().len(), 2);
    }
}
