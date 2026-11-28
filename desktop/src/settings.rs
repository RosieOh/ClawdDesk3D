//! App preferences, stored as JSON in the app's config directory.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Settings {
    /// hold permission prompts so they can be answered from the menu bar (off: only a visible desk holds them)
    #[serde(default)]
    pub menubar_approvals: bool,
    /// watch the camera (Apple Vision, on device) to know whether you're at the desk
    #[serde(default)]
    pub camera_presence: bool,
}

fn path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("settings.json"))
}

impl Settings {
    pub fn load(app: &AppHandle) -> Self {
        path(app)
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, app: &AppHandle) {
        let Some(p) = path(app) else { return };
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(p, json);
        }
    }
}
