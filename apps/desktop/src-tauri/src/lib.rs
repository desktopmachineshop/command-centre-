//! Command Centre desktop shell: shows the server's PWA in a window, runs the
//! worker daemon (`cc-worker`, a Node single-executable sidecar) while the app
//! is open, and lives in the tray.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Desktop settings. They live in the worker's own config file, so the worker
/// and the app share the server URL, token and node name.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    server_url: String,
    #[serde(default)]
    token: String,
    #[serde(default)]
    node_name: String,
    #[serde(default = "enabled_by_default")]
    worker_enabled: bool,
    #[serde(default)]
    launch_at_login: bool,
}

fn enabled_by_default() -> bool {
    true
}

impl Settings {
    fn worker_ready(&self) -> bool {
        self.worker_enabled && !self.server_url.is_empty() && !self.token.is_empty()
    }
}

struct Worker {
    child: Option<CommandChild>,
    /// Bumped on every start/stop, so an old child's exit doesn't touch a newer one.
    generation: u64,
}

struct AppState {
    worker: Mutex<Worker>,
    status_item: MenuItem<Wry>,
    worker_item: CheckMenuItem<Wry>,
}

/// `%APPDATA%\CommandCentre\worker.json`, the worker's default config path.
fn config_path(app: &AppHandle) -> PathBuf {
    let base = app.path().config_dir().unwrap_or_else(|_| PathBuf::from("."));
    base.join("CommandCentre").join("worker.json")
}

fn read_config(app: &AppHandle) -> Map<String, Value> {
    std::fs::read_to_string(config_path(app))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn load_settings(app: &AppHandle) -> Settings {
    serde_json::from_value(Value::Object(read_config(app))).unwrap_or(Settings {
        server_url: String::new(),
        token: String::new(),
        node_name: String::new(),
        worker_enabled: true,
        launch_at_login: false,
    })
}

/// Merges the settings into the config file, keeping keys the worker owns (node id etc.).
fn store_settings(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let mut config = read_config(app);
    if let Value::Object(fields) = serde_json::to_value(settings).map_err(|e| e.to_string())? {
        for (key, value) in fields {
            if value.as_str() == Some("") {
                config.remove(&key); // empty node name: the worker uses the hostname
            } else {
                config.insert(key, value);
            }
        }
    }
    let path = config_path(app);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&Value::Object(config)).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

fn set_status(app: &AppHandle, text: &str) {
    let state = app.state::<AppState>();
    let _ = state.status_item.set_text(format!("Worker: {text}"));
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(format!("Command Centre - worker {text}")));
    }
}

/// Turns a `CC_STATUS {...}` line from the worker into short tray text.
fn describe_status(json: &str) -> Option<String> {
    let status: Value = serde_json::from_str(json).ok()?;
    let state = status["state"].as_str()?;
    let job = &status["job"];
    Some(match (state, job.is_object()) {
        ("connected", true) => format!(
            "busy: {} {:.0}%",
            job["kind"].as_str().unwrap_or("job"),
            job["progress"].as_f64().unwrap_or(0.0) * 100.0
        ),
        ("connected", false) => "online, idle".into(),
        ("connecting", _) => "connecting...".into(),
        ("disconnected", _) => format!("offline ({}), retrying", status["error"].as_str().unwrap_or("no connection")),
        (other, _) => other.into(),
    })
}

fn start_worker(app: &AppHandle) {
    let settings = load_settings(app);
    let state = app.state::<AppState>();
    let mut worker = state.worker.lock().unwrap();
    if worker.child.is_some() {
        return;
    }
    if !settings.worker_ready() {
        drop(worker);
        set_status(app, if settings.worker_enabled { "needs settings" } else { "off" });
        return;
    }

    let config = config_path(app).to_string_lossy().into_owned();
    let spawned = app
        .shell()
        .sidecar("cc-worker")
        .map(|cmd| cmd.args(["--config", config.as_str(), "--status-json"]))
        .and_then(|cmd| cmd.spawn());
    let (mut rx, child) = match spawned {
        Ok(pair) => pair,
        Err(err) => {
            drop(worker);
            set_status(app, &format!("failed to start ({err})"));
            return;
        }
    };
    worker.generation += 1;
    worker.child = Some(child);
    let generation = worker.generation;
    drop(worker);
    set_status(app, "starting...");

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line = String::from_utf8_lossy(&line);
                    match line.trim().strip_prefix("CC_STATUS ").and_then(describe_status) {
                        Some(text) => set_status(&app, &text),
                        None => println!("{}", line.trim_end()),
                    }
                }
                CommandEvent::Stderr(line) => eprintln!("{}", String::from_utf8_lossy(&line).trim_end()),
                CommandEvent::Terminated(payload) => {
                    let state = app.state::<AppState>();
                    let mut worker = state.worker.lock().unwrap();
                    if worker.generation != generation {
                        return; // stopped on purpose, or already replaced
                    }
                    worker.child = None;
                    drop(worker);
                    set_status(&app, &format!("exited (code {:?}), restarting in 10s", payload.code));
                    restart_later(app.clone(), generation);
                    return;
                }
                _ => {}
            }
        }
    });
}

/// Restarts a crashed worker after a pause, unless it was stopped or restarted meanwhile.
fn restart_later(app: AppHandle, generation: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(10));
        let current = app.state::<AppState>().worker.lock().unwrap().generation;
        if current == generation && app.state::<AppState>().worker_item.is_checked().unwrap_or(false) {
            start_worker(&app);
        }
    });
}

fn stop_worker(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut worker = state.worker.lock().unwrap();
    worker.generation += 1;
    if let Some(child) = worker.child.take() {
        let _ = child.kill();
    }
}

fn restart_worker(app: &AppHandle) {
    stop_worker(app);
    start_worker(app);
    if !load_settings(app).worker_enabled {
        set_status(app, "off");
    }
}

/// Shows the main window, creating it if needed: the server's UI when one is
/// configured, otherwise the bundled settings page.
fn show_main(app: &AppHandle, visible: bool) {
    if let Some(window) = app.get_webview_window("main") {
        if visible {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        return;
    }
    let url = Url::parse(&load_settings(app).server_url)
        .ok()
        .filter(|u| u.scheme() == "http" || u.scheme() == "https")
        .map(WebviewUrl::External)
        .unwrap_or_else(|| WebviewUrl::App("index.html".into()));
    let built = WebviewWindowBuilder::new(app, "main", url)
        .title("Command Centre")
        .inner_size(1280.0, 860.0)
        .visible(visible)
        .build();
    if let Ok(window) = built {
        // Closing the window keeps the app (and the worker) running in the tray.
        let handle = window.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = handle.hide();
            }
        });
    }
}

fn show_settings(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html".into()))
        .title("Command Centre settings")
        .inner_size(520.0, 640.0)
        .resizable(false)
        .build();
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    load_settings(&app)
}

/// Saves settings, applies launch-at-login, restarts the worker and points the main window at the server.
#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let url = Url::parse(&settings.server_url).map_err(|e| format!("Server URL: {e}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Server URL must start with https:// (or http:// for a local server)".into());
    }
    store_settings(&app, &settings)?;

    let autostart = app.autolaunch();
    let result = if settings.launch_at_login { autostart.enable() } else { autostart.disable() };
    result.map_err(|e| format!("Launch at login: {e}"))?;

    let _ = app.state::<AppState>().worker_item.set_checked(settings.worker_enabled);
    restart_worker(&app);

    match app.get_webview_window("main") {
        Some(main) => {
            let _ = main.navigate(url);
            let _ = main.show();
        }
        None => show_main(&app, true),
    }
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.close();
    }
    Ok(())
}

pub fn run() {
    let app = tauri::Builder::default()
        // Must come first: a second launch just focuses the running app.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app, true)))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .invoke_handler(tauri::generate_handler![get_settings, save_settings])
        .setup(|app| {
            let handle = app.handle();
            let settings = load_settings(handle);

            let status_item = MenuItem::with_id(app, "status", "Worker: starting...", false, None::<&str>)?;
            let open_item = MenuItem::with_id(app, "open", "Open Command Centre", true, None::<&str>)?;
            let worker_item = CheckMenuItem::with_id(app, "worker", "Worker on", true, settings.worker_enabled, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "settings", "Settings...", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&status_item, &separator, &open_item, &worker_item, &settings_item, &quit_item])?;

            app.manage(AppState { worker: Mutex::new(Worker { child: None, generation: 0 }), status_item, worker_item });

            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("Command Centre")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app, true),
                    "settings" => show_settings(app),
                    "worker" => {
                        let mut settings = load_settings(app);
                        settings.worker_enabled = app.state::<AppState>().worker_item.is_checked().unwrap_or(true);
                        if let Err(err) = store_settings(app, &settings) {
                            eprintln!("saving settings: {err}");
                        }
                        restart_worker(app);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle(), true);
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // Started by launch-at-login: stay in the tray until opened.
            let minimized = std::env::args().any(|a| a == "--minimized");
            show_main(handle, !minimized);
            start_worker(handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Command Centre app");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            stop_worker(app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::describe_status;

    #[test]
    fn describes_worker_status() {
        assert_eq!(describe_status(r#"{"state":"connected","job":null}"#).unwrap(), "online, idle");
        assert_eq!(
            describe_status(r#"{"state":"connected","job":{"id":"j","kind":"ffmpeg.run","progress":0.42}}"#).unwrap(),
            "busy: ffmpeg.run 42%"
        );
        assert_eq!(
            describe_status(r#"{"state":"disconnected","job":null,"error":"code 1006"}"#).unwrap(),
            "offline (code 1006), retrying"
        );
        assert!(describe_status("not json").is_none());
    }
}
