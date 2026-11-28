//! Camera presence: runs the Swift helper (Apple Vision face detection) and turns its face counts into
//! "at the desk" / "away", with hysteresis so a glance away or a missed frame doesn't flip it.

use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

/// No face for this long → away.
pub const AWAY_AFTER: Duration = Duration::from_secs(20);

#[derive(Debug, Default)]
pub struct Debouncer {
    present: Option<bool>,
    last_face: Option<Instant>,
}

impl Debouncer {
    /// Feed a face count (or a tick with no new data: `None`). Returns the new state when it changes.
    pub fn feed(&mut self, faces: Option<u32>, now: Instant) -> Option<bool> {
        if faces.is_some_and(|f| f > 0) {
            self.last_face = Some(now);
            if self.present != Some(true) {
                self.present = Some(true);
                return Some(true);
            }
            return None;
        }
        let gone_long = self
            .last_face
            .is_none_or(|t| now.duration_since(t) >= AWAY_AFTER);
        if gone_long && (faces.is_some() || self.last_face.is_some()) && self.present != Some(false)
        {
            self.present = Some(false);
            return Some(false);
        }
        None
    }

    pub fn present(&self) -> Option<bool> {
        self.present
    }
}

/// The helper ships next to the app binary (Contents/MacOS/clawddesk-presence).
pub fn helper_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let p = exe.parent()?.join("clawddesk-presence");
    p.is_file().then_some(p)
}

/// Start the helper; its stdout yields one JSON line per change. Dropping/killing the child stops the camera.
pub fn spawn() -> std::io::Result<(Child, impl Iterator<Item = Option<u32>>)> {
    let path = helper_path()
        .ok_or_else(|| std::io::Error::other("presence helper not found next to the app"))?;
    let mut child = Command::new(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("no stdout"))?;
    let lines = BufReader::new(stdout)
        .lines()
        .map_while(Result::ok)
        .map(|line| {
            let v: serde_json::Value = serde_json::from_str(&line).ok()?;
            if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                eprintln!("[presence] {err}");
                return None;
            }
            v.get("faces").and_then(|f| f.as_u64()).map(|f| f as u32)
        });
    Ok((child, lines))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hysteresis() {
        let t0 = Instant::now();
        let s = |secs: u64| t0 + Duration::from_secs(secs);
        let mut d = Debouncer::default();
        assert_eq!(d.feed(Some(1), s(0)), Some(true));
        assert_eq!(d.feed(Some(0), s(1)), None, "a missed frame isn't leaving");
        assert_eq!(d.feed(None, s(15)), None);
        assert_eq!(d.feed(Some(1), s(16)), None, "still here");
        assert_eq!(d.feed(Some(0), s(17)), None);
        assert_eq!(d.feed(None, s(16 + 20)), Some(false), "20 s without a face");
        assert_eq!(d.feed(None, s(60)), None);
        assert_eq!(d.feed(Some(2), s(61)), Some(true), "back");
    }

    #[test]
    fn nobody_from_the_start() {
        let t0 = Instant::now();
        let mut d = Debouncer::default();
        assert_eq!(d.feed(Some(0), t0), Some(false));
        assert_eq!(d.present(), Some(false));
    }
}
