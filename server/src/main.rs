//! ClawdDesk 3D bridge binary: reads CLAWDDESK_* settings and runs the bridge until Ctrl+C / SIGTERM.

use std::time::Duration;

use clawddesk_bridge::{Options, ServeError, serve};

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
    // Open WebSockets would keep graceful shutdown waiting; don't let them.
    tokio::spawn(async {
        tokio::time::sleep(Duration::from_millis(500)).await;
        std::process::exit(0);
    });
}

#[tokio::main]
async fn main() {
    match serve(Options::from_env(), shutdown_signal()).await {
        Ok(()) => {}
        Err(ServeError::AddrInUse(addr)) => {
            eprintln!(
                "\n  ✖ {addr} is already in use by another process.\n    \
                 Free it, or run with CLAWDDESK_PORT=<port> and point your hook URLs + VITE_BRIDGE_URL at it.\n"
            );
            std::process::exit(1);
        }
        Err(err) => {
            eprintln!("\n  ✖ cannot run the bridge: {err}\n");
            std::process::exit(1);
        }
    }
}
