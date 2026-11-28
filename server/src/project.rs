//! Name a session by its repository: a session whose cwd is `repo/client` still belongs to `repo`.

use std::path::Path;

/// The name of the git repository containing `cwd` (the folder holding `.git`), if any.
pub fn repo_name(cwd: &str) -> Option<String> {
    let mut dir = Path::new(cwd);
    for _ in 0..32 {
        if dir.join(".git").exists() {
            return dir.file_name().map(|n| n.to_string_lossy().into_owned());
        }
        dir = dir.parent()?;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_enclosing_repository() {
        let root = std::env::temp_dir().join(format!("clawddesk-repo-{}", std::process::id()));
        let sub = root.join("myrepo/client/src");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::create_dir_all(root.join("myrepo/.git")).unwrap();
        assert_eq!(repo_name(sub.to_str().unwrap()).as_deref(), Some("myrepo"));
        assert_eq!(
            repo_name(root.join("myrepo").to_str().unwrap()).as_deref(),
            Some("myrepo")
        );
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(repo_name("/definitely/not/a/repo/here"), None);
    }
}
