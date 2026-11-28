//! Session details that hooks don't carry (model, git branch, Claude Code version), read from the tail of the
//! session transcript. Only `.jsonl` files under the Claude config directory are ever opened.

use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

use serde_json::Value;

/// How much of the transcript end to scan; the latest assistant turn is almost always within this.
const TAIL_BYTES: u64 = 64 * 1024;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TranscriptInfo {
    pub model: Option<String>,
    pub git_branch: Option<String>,
    pub version: Option<String>,
    pub permission_mode: Option<String>,
}

impl TranscriptInfo {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// Claude Code's config directory: `$CLAUDE_CONFIG_DIR`, else `~/.claude`.
pub fn config_root() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|home| PathBuf::from(home).join(".claude"))
}

/// The transcript path a hook reported, if it is a `.jsonl` file inside `root` (after resolving symlinks / `..`).
pub fn allowed_path(raw: &str, root: &Path) -> Option<PathBuf> {
    let path = Path::new(raw);
    if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return None;
    }
    let real = path.canonicalize().ok()?;
    let root = root.canonicalize().ok()?;
    real.starts_with(&root).then_some(real)
}

/// Read the last `TAIL_BYTES` of the file and extract what it says about the session.
pub fn read_tail(path: &Path) -> std::io::Result<TranscriptInfo> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut buf)?;
    let text = String::from_utf8_lossy(&buf);
    // When starting mid-file the first line is partial; skip it.
    let text = if start > 0 {
        text.split_once('\n').map_or("", |(_, rest)| rest)
    } else {
        &text
    };
    Ok(parse_tail(text))
}

/// Newest value wins for every field. `<synthetic>` placeholder models are ignored.
pub fn parse_tail(text: &str) -> TranscriptInfo {
    let mut info = TranscriptInfo::default();
    for line in text.lines().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let str_of = |key: &str| {
            v.get(key)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(String::from)
        };
        if info.model.is_none() && v.get("type").and_then(Value::as_str) == Some("assistant") {
            info.model = v
                .pointer("/message/model")
                .and_then(Value::as_str)
                .filter(|m| !m.is_empty() && !m.starts_with('<'))
                .map(String::from);
        }
        if info.git_branch.is_none() {
            info.git_branch = str_of("gitBranch");
        }
        if info.version.is_none() {
            info.version = str_of("version");
        }
        if info.permission_mode.is_none() {
            info.permission_mode = str_of("permissionMode");
        }
        if info.model.is_some()
            && info.git_branch.is_some()
            && info.version.is_some()
            && info.permission_mode.is_some()
        {
            break;
        }
    }
    info
}
