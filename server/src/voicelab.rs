//! Watches for the optional local voice lab (voice-lab/server.py) so pages learn about it from the
//! snapshot instead of probing it themselves (a refused connection is logged in every browser console).

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

pub const DEFAULT_URL: &str = "http://127.0.0.1:3003";
const PROBE_TIMEOUT: Duration = Duration::from_millis(800);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LabInfo {
    /// cloned voice name; None when the lab runs without a reference recording (transcription only)
    pub voice: Option<String>,
    /// the voice model is loaded
    pub ready: bool,
    /// can speak (has a reference recording)
    pub tts: bool,
    /// can transcribe spoken commands
    pub stt: bool,
}

/// `host:port` of a plain `http://` URL on this machine; anything else is not probed.
pub fn authority(url: &str) -> Option<String> {
    let rest = url.strip_prefix("http://")?;
    let auth = rest.split('/').next()?.to_string();
    let host = auth.rsplit_once(':').map_or(auth.as_str(), |(h, _)| h);
    matches!(host, "127.0.0.1" | "localhost" | "[::1]").then_some(auth)
}

/// Parse the `/health` response body: `{"ok": true, "voice": "...", "ready": bool}`.
pub fn parse_health(raw: &str) -> Option<LabInfo> {
    let (head, body) = raw.split_once("\r\n\r\n")?;
    if !head.starts_with("HTTP/1.") || !head.split_whitespace().nth(1).is_some_and(|c| c == "200") {
        return None;
    }
    let v: Value = serde_json::from_str(body.trim()).ok()?;
    if v.get("ok").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let voice = v.get("voice").and_then(Value::as_str).map(String::from);
    Some(LabInfo {
        tts: v
            .get("tts")
            .and_then(Value::as_bool)
            .unwrap_or(voice.is_some()),
        stt: v.get("stt").and_then(Value::as_bool).unwrap_or(false),
        ready: v.get("ready").and_then(Value::as_bool).unwrap_or(false),
        voice,
    })
}

/// One `GET /health` over a raw HTTP/1.0 connection (no HTTP client dependency needed for this).
pub async fn probe(url: &str) -> Option<LabInfo> {
    let auth = authority(url)?;
    let fut = async {
        let mut stream = TcpStream::connect(&auth).await.ok()?;
        let req = format!("GET /health HTTP/1.0\r\nHost: {auth}\r\nConnection: close\r\n\r\n");
        stream.write_all(req.as_bytes()).await.ok()?;
        let mut buf = Vec::with_capacity(512);
        stream.take(16 * 1024).read_to_end(&mut buf).await.ok()?;
        parse_health(&String::from_utf8_lossy(&buf))
    };
    tokio::time::timeout(PROBE_TIMEOUT, fut)
        .await
        .ok()
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_local_http_urls_are_probed() {
        assert_eq!(
            authority("http://127.0.0.1:3003").as_deref(),
            Some("127.0.0.1:3003")
        );
        assert_eq!(
            authority("http://localhost:3003/").as_deref(),
            Some("localhost:3003")
        );
        assert!(authority("https://127.0.0.1:3003").is_none());
        assert!(authority("http://example.com:3003").is_none());
    }

    #[test]
    fn health_responses() {
        let ok = "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\": true, \"voice\": \"my-voice\", \"ready\": true}";
        assert_eq!(
            parse_health(ok),
            Some(LabInfo {
                voice: Some("my-voice".into()),
                ready: true,
                tts: true,
                stt: false,
            })
        );
        let stt_only = "HTTP/1.0 200 OK\r\n\r\n{\"ok\": true, \"voice\": null, \"ready\": false, \"tts\": false, \"stt\": true}";
        let info = parse_health(stt_only).unwrap();
        assert_eq!((info.voice, info.tts, info.stt), (None, false, true));
        assert!(parse_health("HTTP/1.0 503 Service Unavailable\r\n\r\n{\"ok\": true}").is_none());
        assert!(parse_health("HTTP/1.0 200 OK\r\n\r\n{\"ok\": false}").is_none());
        assert!(parse_health("garbage").is_none());
    }

    #[tokio::test]
    async fn probing_a_closed_port_is_none() {
        assert!(probe("http://127.0.0.1:9").await.is_none());
    }
}
