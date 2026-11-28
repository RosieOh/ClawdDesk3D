//! Minimal blocking HTTP/1.0 client for the local bridge (loopback only; no TLS, no redirects).

use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    time::Duration,
};

const TIMEOUT: Duration = Duration::from_millis(800);

fn request(port: u16, raw: &str) -> std::io::Result<String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, TIMEOUT)?;
    stream.set_read_timeout(Some(TIMEOUT * 3))?;
    stream.set_write_timeout(Some(TIMEOUT))?;
    stream.write_all(raw.as_bytes())?;
    let mut buf = String::new();
    stream.take(4 * 1024 * 1024).read_to_string(&mut buf)?;
    let (head, body) = buf.split_once("\r\n\r\n").unwrap_or((&buf, ""));
    let status = head.split_whitespace().nth(1).unwrap_or("");
    if !status.starts_with('2') {
        return Err(std::io::Error::other(format!("HTTP {status}")));
    }
    Ok(body.to_string())
}

pub fn get(port: u16, path: &str) -> std::io::Result<String> {
    request(
        port,
        &format!("GET {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"),
    )
}

/// POST JSON as the menu bar app (the bridge only takes approvals / presence from the desk or the app).
pub fn post_json(port: u16, path: &str, body: &str) -> std::io::Result<String> {
    request(
        port,
        &format!(
            "POST {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\n\
             X-ClawdDesk-App: 1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ),
    )
}
