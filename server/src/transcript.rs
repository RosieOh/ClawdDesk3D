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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn newest_values_win_and_synthetic_models_are_skipped() {
        let text = [
            r#"{"type":"assistant","message":{"model":"claude-sonnet-4-5"},"gitBranch":"old","version":"2.0.0"}"#,
            r#"{"type":"user","permissionMode":"plan","gitBranch":"main","version":"2.1.0"}"#,
            r#"{"type":"assistant","message":{"model":"claude-opus-5-5"}}"#,
            r#"{"type":"assistant","message":{"model":"<synthetic>"}}"#,
            r#"not json"#,
        ]
        .join("\n");
        let info = parse_tail(&text);
        assert_eq!(info.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(info.git_branch.as_deref(), Some("main"));
        assert_eq!(info.version.as_deref(), Some("2.1.0"));
        assert_eq!(info.permission_mode.as_deref(), Some("plan"));
    }

    #[test]
    fn empty_or_garbage_gives_nothing() {
        assert!(parse_tail("").is_empty());
        assert!(parse_tail("{}\n[1,2]\n").is_empty());
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("clawddesk-test-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_only_the_tail_and_drops_the_partial_first_line() {
        let dir = temp_dir("tail");
        let path = dir.join("s.jsonl");
        let mut f = File::create(&path).unwrap();
        // An old model far before the tail window, then padding, then the current model.
        writeln!(
            f,
            r#"{{"type":"assistant","message":{{"model":"claude-old"}}}}"#
        )
        .unwrap();
        let pad = format!(r#"{{"type":"user","pad":"{}"}}"#, "x".repeat(1000));
        for _ in 0..(TAIL_BYTES / 1000 + 10) {
            writeln!(f, "{pad}").unwrap();
        }
        writeln!(
            f,
            r#"{{"type":"assistant","message":{{"model":"claude-new"}},"gitBranch":"feat/x"}}"#
        )
        .unwrap();
        drop(f);
        let info = read_tail(&path).unwrap();
        assert_eq!(info.model.as_deref(), Some("claude-new"));
        assert_eq!(info.git_branch.as_deref(), Some("feat/x"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn only_jsonl_files_inside_the_root_are_allowed() {
        let root = temp_dir("root");
        let outside = temp_dir("outside");
        std::fs::create_dir_all(root.join("projects/p")).unwrap();
        let inside = root.join("projects/p/s.jsonl");
        std::fs::write(&inside, "").unwrap();
        std::fs::write(root.join("settings.json"), "{}").unwrap();
        std::fs::write(outside.join("s.jsonl"), "").unwrap();

        assert!(allowed_path(inside.to_str().unwrap(), &root).is_some());
        assert!(
            allowed_path(root.join("settings.json").to_str().unwrap(), &root).is_none(),
            "not .jsonl"
        );
        assert!(
            allowed_path(outside.join("s.jsonl").to_str().unwrap(), &root).is_none(),
            "outside root"
        );
        let sneaky = root
            .join("projects/../../")
            .join(outside.file_name().unwrap())
            .join("s.jsonl");
        assert!(
            allowed_path(sneaky.to_str().unwrap(), &root).is_none(),
            "`..` escape"
        );
        assert!(
            allowed_path(root.join("missing.jsonl").to_str().unwrap(), &root).is_none(),
            "missing file"
        );

        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }
}
