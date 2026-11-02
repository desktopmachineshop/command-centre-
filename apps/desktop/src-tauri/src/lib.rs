//! Command Centre desktop shell: shows the server's PWA in a window, runs the
//! worker daemon (`cc-worker`, a Node single-executable sidecar) while the app
//! is open, and lives in the tray.
//!
//! Linking: the app has no shared token to type in. It asks the server for a link
//! code, opens the server's app at `#/devices?link=<code>` where Dave signs in and
//! presses "Link this computer", and polls until the server hands it this
//! computer's own worker token (see apps/server/src/desktop.ts).

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// The server this build was made for (the Desktop workflow sets it), so a fresh
/// install needs no typing: it goes straight to signing in.
const DEFAULT_SERVER_URL: Option<&str> = option_env!("CC_DEFAULT_SERVER_URL");

/// Desktop settings. They live in the worker's own config file, so the worker
/// and the app share the server URL, token and node name.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    server_url: String,
    /// This computer's worker token, from linking. Never shown or typed.
    #[serde(default)]
    token: String,
    #[serde(default)]
    device_id: String,
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
    /// Bumped by every new link attempt, so an older one stops polling.
    link_generation: AtomicU64,
    /// The code of the link waiting for approval, shown on the settings page.
    link_code: Mutex<Option<String>>,
}

/// What the settings page edits. The token is never sent to or from it.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct SettingsForm {
    server_url: String,
    #[serde(default)]
    node_name: String,
    worker_enabled: bool,
    launch_at_login: bool,
}

/// What the settings page shows.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct SettingsView {
    server_url: String,
    node_name: String,
    worker_enabled: bool,
    launch_at_login: bool,
    linked: bool,
    link_code: Option<String>,
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
    let mut settings = serde_json::from_value(Value::Object(read_config(app))).unwrap_or(Settings {
        server_url: String::new(),
        token: String::new(),
        device_id: String::new(),
        node_name: String::new(),
        worker_enabled: true,
        launch_at_login: false,
    });
    if settings.server_url.is_empty() {
        settings.server_url = DEFAULT_SERVER_URL.unwrap_or_default().trim_end_matches('/').to_string();
    }
    settings
}

/// `https://host` for a usable server URL (http only for a local server).
fn server_base(server_url: &str) -> Option<String> {
    let url = Url::parse(server_url).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    Some(url.as_str().trim_end_matches('/').to_string())
}

/// This computer's name, for the Devices page.
fn computer_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "Computer".into())
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
        let why = if !settings.worker_enabled {
            "off"
        } else if settings.token.is_empty() {
            "not linked yet"
        } else {
            "needs settings"
        };
        set_status(app, why);
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
                    match line.trim().strip_prefix("CC_STATUS ") {
                        Some(json) if is_unlinked(json) => {
                            // The server no longer knows this token (unlinked on the Devices page).
                            forget_link(&app);
                            return;
                        }
                        Some(json) => match describe_status(json) {
                            Some(text) => set_status(&app, &text),
                            None => println!("{}", line.trim_end()),
                        },
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

/// The worker was refused with "bad token": this computer isn't linked (any more).
fn is_unlinked(json: &str) -> bool {
    serde_json::from_str::<Value>(json)
        .ok()
        .and_then(|s| s["error"].as_str().map(|e| e.contains("bad token")))
        .unwrap_or(false)
}

/// Drops the token the server refused, stops the worker and waits for "Link this computer".
fn forget_link(app: &AppHandle) {
    stop_worker(app);
    let mut settings = load_settings(app);
    settings.token.clear();
    settings.device_id.clear();
    if let Err(err) = store_settings(app, &settings) {
        eprintln!("saving settings: {err}");
    }
    set_status(app, "not linked - choose Link this computer");
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkStart {
    code: String,
    poll_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkPoll {
    status: String,
    #[serde(default)]
    token: String,
    #[serde(default)]
    device_id: String,
}

/// Starts linking this computer: gets a code from the server, opens the approval
/// page in the main window (Dave signs in there if needed) and polls until it's approved.
fn begin_link(app: &AppHandle) {
    let settings = load_settings(app);
    let Some(base) = server_base(&settings.server_url) else {
        show_settings(app);
        return;
    };
    let state = app.state::<AppState>();
    let generation = state.link_generation.fetch_add(1, Ordering::SeqCst) + 1;
    set_status(app, "linking: contacting the server...");
    let app = app.clone();
    std::thread::spawn(move || {
        let name = if settings.node_name.is_empty() { computer_name() } else { settings.node_name.clone() };
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(20)).build();
        let started = agent
            .post(&format!("{base}/api/desktop/link"))
            .send_json(serde_json::json!({ "name": name }))
            .map_err(|e| e.to_string())
            .and_then(|r| r.into_json::<LinkStart>().map_err(|e| e.to_string()));
        let start = match started {
            Ok(start) => start,
            Err(err) => {
                set_status(&app, &format!("can't reach the server to link ({err})"));
                return;
            }
        };
        let current = |app: &AppHandle| app.state::<AppState>().link_generation.load(Ordering::SeqCst) == generation;
        *app.state::<AppState>().link_code.lock().unwrap() = Some(start.code.clone());
        set_status(&app, &format!("waiting for you to approve {} in the window", start.code));
        open_main_at(&app, &format!("{base}/#/devices?link={}", start.code));

        let deadline = Instant::now() + Duration::from_secs(11 * 60);
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_secs(2));
            if !current(&app) {
                return; // a newer link attempt took over
            }
            let polled = agent
                .post(&format!("{base}/api/desktop/link/poll"))
                .send_json(serde_json::json!({ "pollToken": start.poll_token }))
                .map_err(|e| e.to_string())
                .and_then(|r| r.into_json::<LinkPoll>().map_err(|e| e.to_string()));
            match polled {
                Ok(poll) if poll.status == "approved" && !poll.token.is_empty() => {
                    let mut settings = load_settings(&app);
                    settings.token = poll.token;
                    settings.device_id = poll.device_id;
                    if let Err(err) = store_settings(&app, &settings) {
                        set_status(&app, &format!("linked, but saving failed ({err})"));
                        return;
                    }
                    *app.state::<AppState>().link_code.lock().unwrap() = None;
                    restart_worker(&app);
                    if let Some(window) = app.get_webview_window("settings") {
                        let _ = window.close();
                    }
                    return;
                }
                Ok(poll) if poll.status == "expired" => break,
                Ok(_) => {}  // still waiting for approval
                Err(_) => {} // a blip: keep trying until the code expires
            }
        }
        if current(&app) {
            *app.state::<AppState>().link_code.lock().unwrap() = None;
            set_status(&app, "link code expired - choose Link this computer");
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
    let url = server_base(&load_settings(app).server_url)
        .and_then(|base| Url::parse(&base).ok())
        .map(WebviewUrl::External)
        .unwrap_or_else(|| WebviewUrl::App("index.html".into()));
    build_main(app, url, visible);
}

/// Opens the main window at `url` (on the server), creating it if needed.
fn open_main_at(app: &AppHandle, url: &str) {
    let Ok(parsed) = Url::parse(url) else { return };
    match app.get_webview_window("main") {
        Some(window) => {
            let _ = window.navigate(parsed);
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        None => build_main(app, WebviewUrl::External(parsed), true),
    }
}

fn build_main(app: &AppHandle, url: WebviewUrl, visible: bool) {
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
fn get_settings(app: AppHandle) -> SettingsView {
    let settings = load_settings(&app);
    SettingsView {
        server_url: settings.server_url,
        node_name: settings.node_name,
        worker_enabled: settings.worker_enabled,
        launch_at_login: settings.launch_at_login,
        linked: !settings.token.is_empty(),
        link_code: app.state::<AppState>().link_code.lock().unwrap().clone(),
    }
}

/// Saves settings, applies launch-at-login and restarts the worker. A new server
/// (or no link yet) starts linking, which opens the sign-in page in the main window.
#[tauri::command]
fn save_settings(app: AppHandle, settings: SettingsForm) -> Result<(), String> {
    let url = Url::parse(settings.server_url.trim()).map_err(|e| format!("Server URL: {e}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Server URL must start with https:// (or http:// for a local server)".into());
    }
    let base = url.as_str().trim_end_matches('/').to_string();
    let mut stored = load_settings(&app);
    if server_base(&stored.server_url).as_deref() != Some(base.as_str()) {
        // A token only works on the server that issued it.
        stored.token.clear();
        stored.device_id.clear();
    }
    stored.server_url = base.clone();
    stored.node_name = settings.node_name.trim().to_string();
    stored.worker_enabled = settings.worker_enabled;
    stored.launch_at_login = settings.launch_at_login;
    store_settings(&app, &stored)?;

    let autostart = app.autolaunch();
    let result = if settings.launch_at_login { autostart.enable() } else { autostart.disable() };
    result.map_err(|e| format!("Launch at login: {e}"))?;

    let _ = app.state::<AppState>().worker_item.set_checked(settings.worker_enabled);
    if stored.token.is_empty() {
        stop_worker(&app);
        begin_link(&app);
        return Ok(());
    }
    restart_worker(&app);
    open_main_at(&app, &base);
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.close();
    }
    Ok(())
}

/// "Link this computer" on the settings page: links again (e.g. after it was unlinked).
#[tauri::command]
fn link_now(app: AppHandle) {
    begin_link(&app);
}

pub fn run() {
    let app = tauri::Builder::default()
        // Must come first: a second launch just focuses the running app.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app, true)))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .invoke_handler(tauri::generate_handler![get_settings, save_settings, link_now])
        .setup(|app| {
            let handle = app.handle();
            let settings = load_settings(handle);

            let status_item = MenuItem::with_id(app, "status", "Worker: starting...", false, None::<&str>)?;
            let open_item = MenuItem::with_id(app, "open", "Open Command Centre", true, None::<&str>)?;
            let worker_item = CheckMenuItem::with_id(app, "worker", "Worker on", true, settings.worker_enabled, None::<&str>)?;
            let link_item = MenuItem::with_id(app, "link", "Link this computer...", true, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "settings", "Settings...", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&status_item, &separator, &open_item, &worker_item, &link_item, &settings_item, &quit_item])?;

            app.manage(AppState {
                worker: Mutex::new(Worker { child: None, generation: 0 }),
                status_item,
                worker_item,
                link_generation: AtomicU64::new(0),
                link_code: Mutex::new(None),
            });

            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("Command Centre")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app, true),
                    "settings" => show_settings(app),
                    "link" => begin_link(app),
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
            start_worker(handle);
            if server_base(&settings.server_url).is_none() {
                show_settings(handle); // a build without a default server: ask for it
            } else if settings.token.is_empty() {
                begin_link(handle); // first run: sign in and approve this computer
            } else {
                show_main(handle, !minimized);
            }
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
    use super::{describe_status, is_unlinked};

    #[test]
    fn spots_an_unlinked_computer() {
        assert!(is_unlinked(r#"{"state":"disconnected","job":null,"error":"bad token: this computer was unlinked"}"#));
        assert!(is_unlinked(r#"{"state":"disconnected","job":null,"error":"bad token"}"#));
        assert!(!is_unlinked(r#"{"state":"disconnected","job":null,"error":"code 1006"}"#));
        assert!(!is_unlinked("not json"));
    }

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
