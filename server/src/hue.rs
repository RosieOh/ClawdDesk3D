//! Philips Hue: the room follows the desk. Generating glows orange, tools cyan, a waiting permission
//! pulses pink, and with no sessions the lights go back to a warm white (never off).
//!
//! Config (written by `npm run hue:pair`): `$CLAWDDESK_HUE_CONFIG` or `~/.config/clawddesk/hue.json`
//!   {"bridge": "192.168.0.10", "username": "…", "group": "0", "brightness": 200}
//! Uses the bridge's local HTTP API (v1) on the LAN; at most one group update per second.

use std::{path::PathBuf, time::Duration};

use serde::Deserialize;
use serde_json::json;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::watch,
};

/// Hue bridges handle about one group command per second.
const MIN_GAP: Duration = Duration::from_millis(1000);

#[derive(Debug, Clone, Deserialize)]
pub struct HueConfig {
    pub bridge: String,
    pub username: String,
    #[serde(default = "default_group")]
    pub group: String,
    #[serde(default = "default_brightness")]
    pub brightness: u8,
}

fn default_group() -> String {
    "0".into() // all lights
}
fn default_brightness() -> u8 {
    200
}

/// The look the room should have.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mood {
    /// no sessions: warm white
    Rest,
    Idle,
    Generating,
    Tool,
    /// a permission waits for you
    Attention,
}

impl Mood {
    pub fn from_state(state: &str, waiting: bool) -> Self {
        if waiting {
            return Mood::Attention;
        }
        match state {
            "GENERATING" => Mood::Generating,
            "TOOL_RUNNING" => Mood::Tool,
            "IDLE" => Mood::Idle,
            "WAITING" => Mood::Attention,
            _ => Mood::Rest,
        }
    }
}

pub fn config_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("CLAWDDESK_HUE_CONFIG").filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(p));
    }
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config/clawddesk/hue.json"))
}

pub fn load_config() -> Option<HueConfig> {
    let text = std::fs::read_to_string(config_path()?).ok()?;
    serde_json::from_str(&text).ok()
}

/// sRGB → CIE 1931 xy (Philips' recommended conversion, wide gamut).
pub fn rgb_to_xy(rgb: [u8; 3]) -> [f64; 2] {
    let lin = |c: u8| {
        let c = c as f64 / 255.0;
        if c > 0.04045 {
            ((c + 0.055) / 1.055).powf(2.4)
        } else {
            c / 12.92
        }
    };
    let (r, g, b) = (lin(rgb[0]), lin(rgb[1]), lin(rgb[2]));
    let x = r * 0.664_511 + g * 0.154_324 + b * 0.162_028;
    let y = r * 0.283_881 + g * 0.668_433 + b * 0.047_685;
    let z = r * 0.000_088 + g * 0.072_310 + b * 0.986_039;
    let sum = x + y + z;
    if sum <= 0.0 {
        return [0.3227, 0.329]; // white point
    }
    let round = |v: f64| (v * 10_000.0).round() / 10_000.0;
    [round(x / sum), round(y / sum)]
}

/// The group action body for a mood.
pub fn action(mood: Mood, brightness: u8) -> serde_json::Value {
    let color = |rgb: [u8; 3], bri: u8| json!({ "on": true, "xy": rgb_to_xy(rgb), "bri": bri, "transitiontime": 4 });
    match mood {
        Mood::Rest => json!({ "on": true, "ct": 366, "bri": brightness, "transitiontime": 10 }),
        Mood::Idle => color([255, 154, 77], brightness.saturating_sub(40)),
        Mood::Generating => color([255, 140, 50], brightness),
        Mood::Tool => color([54, 215, 255], brightness),
        // one breathe cycle to catch the eye, then stays pink
        Mood::Attention => {
            let mut v = color([255, 60, 130], brightness);
            v["alert"] = json!("select");
            v
        }
    }
}

/// `PUT http://<bridge>/api/<user>/groups/<group>/action` over a raw HTTP/1.0 connection.
pub async fn put_action(cfg: &HueConfig, body: &serde_json::Value) -> std::io::Result<String> {
    let host = if cfg.bridge.contains(':') {
        cfg.bridge.clone()
    } else {
        format!("{}:80", cfg.bridge)
    };
    let path = format!("/api/{}/groups/{}/action", cfg.username, cfg.group);
    let body = body.to_string();
    let req = format!(
        "PUT {path} HTTP/1.0\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let fut = async {
        let mut stream = TcpStream::connect(&host).await?;
        stream.write_all(req.as_bytes()).await?;
        let mut buf = Vec::new();
        stream.take(64 * 1024).read_to_end(&mut buf).await?;
        Ok::<_, std::io::Error>(String::from_utf8_lossy(&buf).into_owned())
    };
    tokio::time::timeout(Duration::from_secs(3), fut)
        .await
        .map_err(|_| std::io::Error::other("hue bridge timed out"))?
}

/// Apply mood changes to the lights, at most once a second (the latest mood wins).
pub async fn run(cfg: HueConfig, mut moods: watch::Receiver<Mood>) {
    let mut applied: Option<Mood> = None;
    loop {
        let mood = *moods.borrow_and_update();
        if applied != Some(mood) {
            match put_action(&cfg, &action(mood, cfg.brightness)).await {
                Ok(resp) if resp.contains("\"error\"") => eprintln!(
                    "[hue] bridge refused: {}",
                    resp.lines().last().unwrap_or("")
                ),
                Ok(_) => applied = Some(mood),
                Err(err) => eprintln!("[hue] {err}"),
            }
            tokio::time::sleep(MIN_GAP).await;
            continue;
        }
        if moods.changed().await.is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn colours_convert_to_xy() {
        let [x, y] = rgb_to_xy([255, 0, 0]);
        assert!(
            (x - 0.7006).abs() < 0.01 && (y - 0.2993).abs() < 0.01,
            "red ≈ (0.70, 0.30): {x} {y}"
        );
        assert_eq!(rgb_to_xy([0, 0, 0]), [0.3227, 0.329]);
    }

    #[test]
    fn moods() {
        assert_eq!(Mood::from_state("GENERATING", false), Mood::Generating);
        assert_eq!(Mood::from_state("IDLE", true), Mood::Attention);
        assert_eq!(Mood::from_state("OFFLINE", false), Mood::Rest);
        assert_eq!(action(Mood::Attention, 200)["alert"], "select");
        assert_eq!(action(Mood::Rest, 150)["ct"], 366);
        assert_eq!(
            action(Mood::Rest, 150)["on"],
            true,
            "never turns the lights off"
        );
    }

    #[tokio::test]
    async fn sends_group_actions_to_the_bridge() {
        // A stand-in Hue bridge that records the request it gets.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = sock.read(&mut buf).await.unwrap();
            sock.write_all(b"HTTP/1.0 200 OK\r\n\r\n[{\"success\":{}}]")
                .await
                .unwrap();
            String::from_utf8_lossy(&buf[..n]).into_owned()
        });
        let cfg = HueConfig {
            bridge: addr.to_string(),
            username: "user123".into(),
            group: "2".into(),
            brightness: 180,
        };
        let resp = put_action(&cfg, &action(Mood::Tool, 180)).await.unwrap();
        assert!(resp.contains("success"));
        let req = server.await.unwrap();
        assert!(req.starts_with("PUT /api/user123/groups/2/action HTTP/1.0"));
        assert!(req.contains("\"xy\":[") && req.contains("\"bri\":180"));
    }
}
