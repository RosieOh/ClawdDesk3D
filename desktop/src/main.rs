//! ClawdDesk menu bar app.
//!
//! - runs the bridge in-process (or uses one that is already running, e.g. `npm run dev`)
//! - menu bar icon coloured by what Claude Code is doing, with sessions and Approve / Deny in its menu
//! - macOS notifications when a permission is waiting or a long task finishes while the desk is hidden
//! - the 3D desk in a window, toggled with ⌥⌘J; no Dock icon; optional launch at login

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod http;
mod icon;
mod model;
mod settings;

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use clawddesk_bridge::{Options, ServeError};
use tauri::{
    AppHandle, Manager, RunEvent, WindowEvent,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{TrayIcon, TrayIconBuilder},
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

use crate::model::{Snapshot, View};
use crate::settings::Settings;

const PORT: u16 = 3001;
const POLL: Duration = Duration::from_secs(1);
const PRESENCE_EVERY: Duration = Duration::from_secs(5);
/// Only tasks at least this long are worth a notification.
const LONG_TASK: Duration = Duration::from_secs(30);
const TRAY_ID: &str = "clawddesk";
const DESK: &str = "desk";
/// Passed by the login item: start in the menu bar without opening the desk.
const HIDDEN_ARG: &str = "--hidden";

fn main() {
    let shortcut = Shortcut::new(Some(Modifiers::ALT | Modifiers::SUPER), Code::KeyJ);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_desk(app)
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![HIDDEN_ARG]),
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, sc, event| {
                    if *sc == shortcut && event.state() == ShortcutState::Pressed {
                        toggle_desk(app);
                    }
                })
                .build(),
        )
        .on_window_event(|window, event| {
            // Closing the desk only hides it; the app lives in the menu bar.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            start_bridge();

            let settings = Arc::new(Mutex::new(Settings::load(app.handle())));
            let tray = TrayIconBuilder::with_id(TRAY_ID)
                .icon(icon::status_dot(None))
                .icon_as_template(false)
                .tooltip("ClawdDesk")
                .show_menu_on_left_click(true)
                .on_menu_event({
                    let settings = settings.clone();
                    move |app, event| on_menu(app, event.id().as_ref(), &settings)
                })
                .build(app)?;
            refresh_menu(
                app.handle(),
                &tray,
                &View::default(),
                &settings.lock().unwrap(),
            );

            if let Err(err) = app.global_shortcut().register(shortcut) {
                eprintln!("[desktop] could not register ⌥⌘J: {err}");
            }

            let handle = app.handle().clone();
            thread::spawn(move || watch(handle, settings));

            // Opened by hand (Finder, Spotlight, `open`): show the desk. At login: stay in the menu bar.
            if !std::env::args().any(|a| a == HIDDEN_ARG) {
                show_desk(app.handle());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building ClawdDesk")
        .run(|app, event| {
            // Launching it again while it runs (Finder, Spotlight) brings the desk up.
            if let RunEvent::Reopen { .. } = event {
                show_desk(app);
            }
        });
}

/// Run the bridge inside the app unless another one already owns the port.
fn start_bridge() {
    tauri::async_runtime::spawn(async {
        let opts = Options {
            port: PORT,
            ..Options::from_env()
        };
        match clawddesk_bridge::serve(opts, std::future::pending()).await {
            Ok(()) => {}
            Err(ServeError::AddrInUse(addr)) => {
                println!("[desktop] using the bridge already running on {addr}")
            }
            Err(err) => eprintln!("[desktop] bridge failed: {err}"),
        }
    });
}

// ---------------------------------------------------------------- desk window

fn show_desk(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(DESK) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn toggle_desk(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(DESK) {
        let front = w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false);
        if front {
            let _ = w.hide();
        } else {
            show_desk(app);
        }
    }
}

fn desk_visible(app: &AppHandle) -> bool {
    app.get_webview_window(DESK)
        .is_some_and(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
}

// ---------------------------------------------------------------- menu

fn on_menu(app: &AppHandle, id: &str, settings: &Arc<Mutex<Settings>>) {
    match id {
        "open" => show_desk(app),
        "quit" => {
            // Stop offering menu bar approvals right away so no prompt waits for a closed app.
            let _ = http::post_json(PORT, "/presence/app", r#"{"approvals":false}"#);
            app.exit(0);
        }
        "login" => {
            let auto = app.autolaunch();
            let on = auto.is_enabled().unwrap_or(false);
            let _ = if on { auto.disable() } else { auto.enable() };
        }
        "menubar-approvals" => {
            let mut s = settings.lock().unwrap();
            s.menubar_approvals = !s.menubar_approvals;
            s.save(app);
            let body = format!(r#"{{"approvals":{}}}"#, s.menubar_approvals);
            let _ = http::post_json(PORT, "/presence/app", &body);
        }
        other => {
            if let Some((verb, approval)) = other.split_once(':') {
                let behavior = match verb {
                    "approve" => "allow",
                    "deny" => "deny",
                    _ => return,
                };
                let body = format!(r#"{{"behavior":"{behavior}"}}"#);
                let path = format!("/approvals/{approval}");
                if let Err(err) = http::post_json(PORT, &path, &body) {
                    eprintln!("[desktop] answering {approval} failed: {err}");
                }
            }
        }
    }
}

fn refresh_menu(app: &AppHandle, tray: &TrayIcon, view: &View, settings: &Settings) {
    let build = || -> tauri::Result<Menu<tauri::Wry>> {
        let menu = Menu::new(app)?;
        let header = if !view.reachable {
            "ClawdDesk — bridge not running".to_string()
        } else {
            match view.sessions.len() {
                0 => "ClawdDesk — no sessions".to_string(),
                1 => "ClawdDesk — 1 session".to_string(),
                n => format!("ClawdDesk — {n} sessions"),
            }
        };
        menu.append(&MenuItem::with_id(
            app,
            "header",
            header,
            false,
            None::<&str>,
        )?)?;
        for line in view.session_lines().into_iter().take(8) {
            menu.append(&MenuItem::new(app, line, false, None::<&str>)?)?;
        }
        if !view.approvals.is_empty() {
            menu.append(&PredefinedMenuItem::separator(app)?)?;
            for a in &view.approvals {
                let approve = MenuItem::with_id(
                    app,
                    format!("approve:{}", a.id),
                    "Approve",
                    true,
                    None::<&str>,
                )?;
                let deny =
                    MenuItem::with_id(app, format!("deny:{}", a.id), "Deny", true, None::<&str>)?;
                let title = format!("⚠︎ {} — {}", a.project, a.label());
                menu.append(&Submenu::with_items(app, title, true, &[&approve, &deny])?)?;
            }
        }
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        menu.append(&MenuItem::with_id(
            app,
            "open",
            "Open Desk",
            true,
            Some("Alt+Cmd+J"),
        )?)?;
        menu.append(&CheckMenuItem::with_id(
            app,
            "menubar-approvals",
            "Answer Permissions from the Menu Bar",
            true,
            settings.menubar_approvals,
            None::<&str>,
        )?)?;
        let login = app.autolaunch().is_enabled().unwrap_or(false);
        menu.append(&CheckMenuItem::with_id(
            app,
            "login",
            "Launch at Login",
            true,
            login,
            None::<&str>,
        )?)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        menu.append(&MenuItem::with_id(
            app,
            "quit",
            "Quit ClawdDesk",
            true,
            Some("Cmd+Q"),
        )?)?;
        Ok(menu)
    };
    match build() {
        Ok(menu) => {
            let _ = tray.set_menu(Some(menu));
        }
        Err(err) => eprintln!("[desktop] menu: {err}"),
    }
}

// ---------------------------------------------------------------- watcher

/// Poll the bridge, keep the tray in sync, send notifications, renew the menu bar approver heartbeat.
fn watch(app: AppHandle, settings: Arc<Mutex<Settings>>) {
    let mut last_signature = String::new();
    let mut seen_approvals: HashSet<String> = HashSet::new();
    let mut turns: HashMap<String, Instant> = HashMap::new();
    let mut last_presence: Option<Instant> = None;
    let mut first = true;

    loop {
        let snapshot = http::get(PORT, "/state")
            .ok()
            .and_then(|body| Snapshot::parse(&body));
        let view = View::from(snapshot.as_ref());
        let (menubar_approvals, signature) = {
            let s = settings.lock().unwrap();
            let login = app.autolaunch().is_enabled().unwrap_or(false);
            (
                s.menubar_approvals,
                format!("{}|{}|{login}", view.signature(), s.menubar_approvals),
            )
        };

        if let Some(tray) = app.tray_by_id(TRAY_ID)
            && signature != last_signature
        {
            let _ = tray.set_icon(Some(icon::status_dot(view.color())));
            let _ = tray.set_title(view.badge());
            let _ = tray.set_tooltip(Some(view.tooltip()));
            refresh_menu(&app, &tray, &view, &settings.lock().unwrap());
            last_signature = signature;
        }

        // Notifications only when the desk isn't on screen (it speaks and shows cards itself).
        let quiet = desk_visible(&app);
        for a in &view.approvals {
            if seen_approvals.insert(a.id.clone()) && !first && !quiet {
                notify(
                    &app,
                    &format!("{} needs your approval", a.project),
                    &format!(
                        "{}\nApprove or deny from the ClawdDesk menu bar.",
                        a.label()
                    ),
                );
            }
        }
        seen_approvals.retain(|id| view.approvals.iter().any(|a| &a.id == id));

        for s in &view.sessions {
            let working = matches!(s.state.as_str(), "GENERATING" | "TOOL_RUNNING" | "WAITING");
            if working {
                turns.entry(s.id.clone()).or_insert_with(Instant::now);
            } else if let Some(started) = turns.remove(&s.id) {
                let took = started.elapsed();
                if s.state == "IDLE" && !quiet && !first {
                    if s.last_event == "StopFailure" {
                        notify(
                            &app,
                            &format!("{} stopped with an error", s.project),
                            "Open the desk for details.",
                        );
                    } else if took >= LONG_TASK {
                        let mins = (took.as_secs() + 30) / 60;
                        let body = if mins >= 1 {
                            format!("Took {mins} min.")
                        } else {
                            format!("Took {} s.", took.as_secs())
                        };
                        notify(&app, &format!("{} — task complete", s.project), &body);
                    }
                }
            }
        }
        turns.retain(|id, _| view.sessions.iter().any(|s| &s.id == id));

        if menubar_approvals
            && view.reachable
            && last_presence.is_none_or(|t| t.elapsed() >= PRESENCE_EVERY)
        {
            let _ = http::post_json(PORT, "/presence/app", r#"{"approvals":true}"#);
            last_presence = Some(Instant::now());
        } else if !menubar_approvals {
            last_presence = None;
        }

        first = false;
        thread::sleep(POLL);
    }
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    if let Err(err) = app.notification().builder().title(title).body(body).show() {
        eprintln!("[desktop] notification: {err}");
    }
}
