#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod displays;
mod recorder;
mod settings;

use audio::{AudioConfig, AudioHandle};
use recorder::{Encoder, Kind, RecordOptions, Session, VideoOptions};
use serde::Serialize;
use serde_json::Value;
use settings::{Settings, Store};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;

const OVERLAY_WIDTH: f64 = 440.0;

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    Idle,
    Starting,
    Recording,
    Paused,
    Stopping,
}

struct AppState {
    store: Mutex<Store>,
    ffmpeg: PathBuf,
    encoder: Mutex<Option<Encoder>>,
    phase: Mutex<Phase>,
    session: Mutex<Option<Session>>,
    preview: Mutex<Option<AudioHandle>>,
    overlay_visible: AtomicBool,
    hotkeys_suspended: AtomicBool,
    hotkey_actions: Mutex<HashMap<u32, &'static str>>,
    startup_warnings: Mutex<Vec<String>>,
    quitting: AtomicBool,
    indicator_hide_at: Mutex<Option<Instant>>,
}

impl AppState {
    fn settings(&self) -> Settings {
        self.store.lock().unwrap().settings.clone()
    }
    fn phase(&self) -> Phase {
        *self.phase.lock().unwrap()
    }
    fn set_phase(&self, p: Phase) {
        *self.phase.lock().unwrap() = p;
    }
    fn encoder(&self) -> Encoder {
        let mut g = self.encoder.lock().unwrap();
        *g.get_or_insert_with(|| recorder::detect_encoder(&self.ffmpeg))
    }
}

fn st(app: &AppHandle) -> tauri::State<'_, AppState> {
    app.state::<AppState>()
}

// ---------------------------------------------------------------- UI events

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Toast {
    msg: String,
    kind: &'static str,
    file: Option<String>,
}

fn toast(app: &AppHandle, kind: &'static str, msg: impl Into<String>) {
    let _ = app.emit("toast", Toast { msg: msg.into(), kind, file: None });
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecState {
    state: Phase,
    elapsed_ms: u64,
    bytes: u64,
    file: Option<String>,
    markers: u32,
}

fn rec_state(app: &AppHandle) -> RecState {
    let s = st(app);
    let phase = s.phase();
    let sess = s.session.lock().unwrap();
    match sess.as_ref() {
        Some(x) => RecState {
            state: phase,
            elapsed_ms: x.elapsed().as_millis() as u64,
            bytes: x.bytes(),
            file: Some(format!("{}.{}", x.meta.base, x.meta.final_ext)),
            markers: x.markers,
        },
        None => RecState { state: phase, elapsed_ms: 0, bytes: 0, file: None, markers: 0 },
    }
}

fn emit_state(app: &AppHandle) {
    let state = rec_state(app);
    update_tray(app, &state);
    let _ = app.emit("rec:state", state);
}

// ---------------------------------------------------------------- windows

fn overlay(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("overlay")
}

fn show_overlay(app: &AppHandle) {
    let Some(w) = overlay(app) else { return };
    if let Ok(cursor) = app.cursor_position() {
        if let Ok(Some(m)) = app.monitor_from_point(cursor.x, cursor.y) {
            let size = w.outer_size().map(|s| s.width as i32).unwrap_or(OVERLAY_WIDTH as i32);
            let x = m.position().x + (m.size().width as i32 - size) / 2;
            let y = m.position().y + (40.0 * m.scale_factor()) as i32;
            let _ = w.set_position(PhysicalPosition::new(x, y));
        }
    }
    let _ = w.show();
    let _ = w.set_focus();
    st(app).overlay_visible.store(true, Ordering::Relaxed);
    let _ = app.emit("overlay:visibility", true);
    start_preview(app);
}

fn hide_overlay(app: &AppHandle) {
    if let Some(w) = overlay(app) {
        let _ = w.hide();
    }
    st(app).overlay_visible.store(false, Ordering::Relaxed);
    let _ = app.emit("overlay:visibility", false);
    stop_preview(app);
}

fn toggle_overlay(app: &AppHandle) {
    let visible = overlay(app).and_then(|w| w.is_visible().ok()).unwrap_or(false);
    if visible { hide_overlay(app) } else { show_overlay(app) }
}

/// Shows the REC indicator without taking focus away from the game.
fn show_no_activate(w: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::*;
    let Ok(h) = w.hwnd() else { return };
    let hwnd = HWND(h.0 as _);
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | (WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0) as isize);
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
}

#[derive(Clone, Serialize)]
struct IndicatorData {
    state: &'static str,
    text: String,
    flash: bool,
}

fn position_indicator(app: &AppHandle, w: &WebviewWindow) {
    let s = st(app).settings();
    let Some(d) = displays::resolve(s.display_id.as_deref()) else { return };
    let (dx, dy, dw, dh) = d.rect;
    let size = w.outer_size().unwrap_or(tauri::PhysicalSize::new(190, 44));
    let m = 14;
    let x = if s.indicator_corner.ends_with("left") { dx + m } else { dx + dw - size.width as i32 - m };
    let y = if s.indicator_corner.starts_with("top") { dy + m } else { dy + dh - size.height as i32 - m };
    let _ = w.set_position(PhysicalPosition::new(x, y));
}

fn set_indicator(app: &AppHandle, data: Option<IndicatorData>, auto_hide: Option<Duration>) {
    let Some(w) = app.get_webview_window("indicator") else { return };
    *st(app).indicator_hide_at.lock().unwrap() = auto_hide.map(|d| Instant::now() + d);
    match data {
        Some(d) if st(app).settings().show_indicator => {
            let _ = w.emit("indicator:update", d);
            if !w.is_visible().unwrap_or(false) {
                position_indicator(app, &w);
                show_no_activate(&w);
            }
        }
        _ => {
            let _ = w.hide();
        }
    }
}

// ---------------------------------------------------------------- tray

fn tray_icon(state: Phase) -> Image<'static> {
    let bytes: &'static [u8] = match state {
        Phase::Recording => include_bytes!("../icons/tray-recording@2x.png"),
        Phase::Paused => include_bytes!("../icons/tray-paused@2x.png"),
        _ => include_bytes!("../icons/tray-idle@2x.png"),
    };
    Image::from_bytes(bytes).expect("tray icon")
}

fn update_tray(app: &AppHandle, s: &RecState) {
    let Some(tray) = app.tray_by_id("main") else { return };
    let _ = tray.set_icon(Some(tray_icon(s.state)));
    let label = match s.state {
        Phase::Recording => format!("Tar opp {}", recorder::fmt_time(Duration::from_millis(s.elapsed_ms))),
        Phase::Paused => format!("Pauset {}", recorder::fmt_time(Duration::from_millis(s.elapsed_ms))),
        Phase::Stopping => "Lagrer…".into(),
        _ => "Inaktiv".into(),
    };
    let _ = tray.set_tooltip(Some(format!("Intervjueren — {label}")));
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(app, &[
        &MenuItem::with_id(app, "toggle", "Vis / skjul overlegg", true, None::<&str>)?,
        &MenuItem::with_id(app, "record", "Start / stopp opptak", true, None::<&str>)?,
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "folder", "Åpne opptaksmappe", true, None::<&str>)?,
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "quit", "Avslutt", true, None::<&str>)?,
    ])?;
    TrayIconBuilder::with_id("main")
        .icon(tray_icon(Phase::Idle))
        .tooltip("Intervjueren — Inaktiv")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "toggle" => toggle_overlay(app),
            "record" => toggle_record(app),
            "folder" => open_output_dir(app),
            "quit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                toggle_overlay(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

// ---------------------------------------------------------------- hotkeys

/// Converts Electron-style accelerators ("Control+Alt+num5") into global-hotkey syntax.
fn normalize_accel(acc: &str) -> String {
    acc.split('+')
        .map(|t| match t {
            "Control" | "CommandOrControl" | "CmdOrCtrl" => "Control".to_string(),
            "Return" => "Enter".to_string(),
            "Plus" => "Equal".to_string(),
            t if t.len() > 3 && t.starts_with("num") => format!("Numpad{}", &t[3..]),
            t => t.to_string(),
        })
        .collect::<Vec<_>>()
        .join("+")
}

fn register_hotkeys(app: &AppHandle) -> Vec<String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let state = st(app);
    let mut actions = state.hotkey_actions.lock().unwrap();
    actions.clear();
    if state.hotkeys_suspended.load(Ordering::Relaxed) {
        return vec![];
    }
    let hk = state.settings().hotkeys;
    let mut failed = vec![];
    for (name, acc) in [("toggleOverlay", hk.toggle_overlay), ("toggleRecord", hk.toggle_record), ("pause", hk.pause), ("marker", hk.marker)] {
        if acc.is_empty() {
            continue;
        }
        match normalize_accel(&acc).parse::<Shortcut>() {
            Ok(sc) if gs.register(sc).is_ok() => {
                actions.insert(sc.id(), name);
            }
            _ => failed.push(name.to_string()),
        }
    }
    failed
}

fn on_hotkey(app: &AppHandle, shortcut: &Shortcut) {
    let action = st(app).hotkey_actions.lock().unwrap().get(&shortcut.id()).copied();
    match action {
        Some("toggleOverlay") => toggle_overlay(app),
        Some("toggleRecord") => toggle_record(app),
        Some("pause") => {
            let app = app.clone();
            std::thread::spawn(move || {
                if let Err(e) = toggle_pause_impl(&app) { toast(&app, "error", e) }
            });
        }
        Some("marker") => marker_impl(app),
        _ => {}
    }
}

// ---------------------------------------------------------------- audio preview (level meters while idle)

fn start_preview(app: &AppHandle) {
    let state = st(app);
    if state.phase() != Phase::Idle || !state.overlay_visible.load(Ordering::Relaxed) || state.preview.lock().unwrap().is_some() {
        return;
    }
    let s = state.settings();
    if !s.capture_mic && !s.capture_system_audio {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let handle = audio::start(audio_config(&s));
        let state = st(&app);
        let mut preview = state.preview.lock().unwrap();
        if preview.is_none() && state.phase() == Phase::Idle && state.overlay_visible.load(Ordering::Relaxed) {
            *preview = Some(handle);
        }
    });
}

fn stop_preview(app: &AppHandle) {
    let handle = st(app).preview.lock().unwrap().take();
    drop(handle); // joins the audio thread outside the lock
}

fn restart_preview(app: &AppHandle) {
    stop_preview(app);
    start_preview(app);
}

fn audio_config(s: &Settings) -> AudioConfig {
    AudioConfig {
        mic: s.capture_mic.then(|| s.mic_device_id.clone()),
        loopback: s.capture_system_audio,
        noise_suppression: s.noise_suppression,
        mic_gain: s.mic_volume,
        sys_gain: s.system_volume,
    }
}

// ---------------------------------------------------------------- recording

fn record_options(state: &AppState, s: &Settings) -> Result<RecordOptions, String> {
    let kind = if s.mode == "audio" { Kind::Audio } else { Kind::Video };
    let video = if kind == Kind::Video {
        let d = displays::resolve(s.display_id.as_deref()).ok_or("Fant ingen skjerm å ta opp.")?;
        Some(VideoOptions {
            output_idx: d.display_id.parse().unwrap_or(0),
            src_size: (d.rect.2 as u32, d.rect.3 as u32),
            target_height: s.resolution.parse().ok(),
            fps: s.fps.clamp(10, 60),
            quality: s.quality.clone(),
            encoder: state.encoder(),
        })
    } else {
        None
    };
    Ok(RecordOptions {
        kind,
        out_dir: PathBuf::from(&s.output_dir),
        video,
        audio: audio_config(s),
        audio_format: s.audio_format.clone(),
        keep_raw: s.keep_raw,
    })
}

fn start_recording_impl(app: &AppHandle) -> Result<(), String> {
    let state = st(app);
    {
        let mut phase = state.phase.lock().unwrap();
        if *phase != Phase::Idle {
            return Ok(());
        }
        *phase = Phase::Starting;
    }
    emit_state(app);
    stop_preview(app);
    let s = state.settings();
    let result = record_options(&state, &s).and_then(|opts| Session::start(&state.ffmpeg, opts));
    match result {
        Ok((session, warnings)) => {
            let info = session.video_info();
            *state.session.lock().unwrap() = Some(session);
            state.set_phase(Phase::Recording);
            emit_state(app);
            for w in warnings {
                toast(app, "warn", w);
            }
            if let Some((enc, (w, h), bitrate)) = info {
                toast(app, "info", format!("Tar opp {w}×{h} · {:.1} Mbps · {}", bitrate as f64 / 1e6, enc.label()).replace('.', ","));
            }
            Ok(())
        }
        Err(e) => {
            state.set_phase(Phase::Idle);
            emit_state(app);
            start_preview(app);
            Err(e)
        }
    }
}

fn stop_recording_impl(app: &AppHandle) -> Result<(), String> {
    let state = st(app);
    {
        let mut phase = state.phase.lock().unwrap();
        if !matches!(*phase, Phase::Recording | Phase::Paused) {
            return Ok(());
        }
        *phase = Phase::Stopping;
    }
    emit_state(app);
    set_indicator(app, Some(IndicatorData { state: "saving", text: "Lagrer…".into(), flash: false }), None);
    let session = state.session.lock().unwrap().take();
    let Some(session) = session else {
        state.set_phase(Phase::Idle);
        return Ok(());
    };
    let (meta, duration) = session.stop();
    let result = recorder::finalize(&state.ffmpeg, &meta, duration, |pct| {
        let _ = app.emit("convert:progress", pct);
    });
    state.set_phase(Phase::Idle);
    emit_state(app);
    match &result {
        Ok(file) => {
            set_indicator(app, Some(IndicatorData { state: "saved", text: "Lagret ✓".into(), flash: false }), Some(Duration::from_millis(2500)));
            let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let _ = app.emit("toast", Toast { msg: format!("Lagret {name} — klikk for å vise"), kind: "ok", file: Some(file.to_string_lossy().into_owned()) });
        }
        Err(e) => {
            set_indicator(app, Some(IndicatorData { state: "error", text: "Lagring feilet".into(), flash: false }), Some(Duration::from_secs(6)));
            toast(app, "error", format!("Lagring feilet: {e}\nRådelene ligger i {}", meta.out_dir.join(".raw").display()));
        }
    }
    let _ = app.emit("recent:changed", ());
    if state.quitting.load(Ordering::Relaxed) {
        app.exit(0);
    }
    start_preview(app);
    Ok(())
}

fn toggle_record(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let r = match st(&app).phase() {
            Phase::Idle => start_recording_impl(&app),
            Phase::Recording | Phase::Paused => stop_recording_impl(&app),
            _ => Ok(()),
        };
        if let Err(e) = r {
            toast(&app, "error", e);
        }
    });
}

fn toggle_pause_impl(app: &AppHandle) -> Result<(), String> {
    let state = st(app);
    let phase = state.phase();
    let mut guard = state.session.lock().unwrap();
    let Some(sess) = guard.as_mut() else { return Ok(()) };
    match phase {
        Phase::Recording => {
            sess.pause();
            state.set_phase(Phase::Paused);
        }
        Phase::Paused => {
            sess.resume(&state.ffmpeg)?;
            state.set_phase(Phase::Recording);
        }
        _ => return Ok(()),
    }
    drop(guard);
    emit_state(app);
    tick(app);
    Ok(())
}

fn marker_impl(app: &AppHandle) {
    let state = st(app);
    let r = state.session.lock().unwrap().as_mut().map(|s| s.add_marker());
    if let Some((n, at)) = r {
        let t = recorder::fmt_time(at);
        toast(app, "info", format!("Markør {n} ved {t}"));
        let phase = if state.phase() == Phase::Paused { "paused" } else { "recording" };
        set_indicator(app, Some(IndicatorData { state: phase, text: format!("Markør {n} ved {t}"), flash: true }), None);
        emit_state(app);
    }
}

/// Twice a second while recording: keep the timer, tray and indicator fresh, and heal ffmpeg.
fn tick(app: &AppHandle) {
    let state = st(app);
    let phase = state.phase();
    if matches!(phase, Phase::Recording | Phase::Paused) {
        let msg = if phase == Phase::Recording {
            state.session.lock().unwrap().as_mut().and_then(|s| s.check_health(&state.ffmpeg))
        } else {
            None
        };
        if let Some(m) = msg {
            let paused = state.session.lock().unwrap().as_ref().is_some_and(|s| s.is_paused());
            if paused {
                state.set_phase(Phase::Paused);
            }
            toast(app, if paused { "error" } else { "warn" }, m);
        }
        let rs = rec_state(app);
        let label = if rs.state == Phase::Paused { "PAUSE" } else { "REC" };
        let text = format!("{label} {}", recorder::fmt_time(Duration::from_millis(rs.elapsed_ms)));
        set_indicator(app, Some(IndicatorData { state: if rs.state == Phase::Paused { "paused" } else { "recording" }, text, flash: false }), None);
        update_tray(app, &rs);
        let _ = app.emit("rec:state", rs);
    } else {
        let hide_at = *state.indicator_hide_at.lock().unwrap();
        if hide_at.is_some_and(|t| Instant::now() >= t) {
            set_indicator(app, None, None);
        }
    }
}

fn open_output_dir(app: &AppHandle) {
    let dir = st(app).settings().output_dir;
    let _ = std::fs::create_dir_all(&dir);
    let _ = app.opener().open_path(dir, None::<&str>);
}

fn request_quit(app: &AppHandle) {
    let state = st(app);
    state.quitting.store(true, Ordering::Relaxed);
    if matches!(state.phase(), Phase::Recording | Phase::Paused) {
        let app = app.clone();
        std::thread::spawn(move || {
            let _ = stop_recording_impl(&app);
        });
    } else if state.phase() != Phase::Stopping {
        app.exit(0);
    }
}

// ---------------------------------------------------------------- commands

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsResult {
    settings: Settings,
    failed_hotkeys: Vec<String>,
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    st(&app).settings()
}

#[tauri::command]
fn set_settings(app: AppHandle, patch: Value) -> Result<SettingsResult, String> {
    let state = st(&app);
    let before = state.settings();
    state.store.lock().unwrap().patch(patch)?;
    let after = state.settings();
    let mut failed_hotkeys = vec![];
    if serde_json::to_value(&before.hotkeys).ok() != serde_json::to_value(&after.hotkeys).ok() {
        failed_hotkeys = register_hotkeys(&app);
    }
    // Live volume changes apply to whatever audio is running.
    for h in [state.session.lock().unwrap().as_ref().map(|s| &s.audio)].into_iter().flatten() {
        h.mic_gain.set(after.mic_volume);
        h.sys_gain.set(after.system_volume);
    }
    if let Some(h) = state.preview.lock().unwrap().as_ref() {
        h.mic_gain.set(after.mic_volume);
        h.sys_gain.set(after.system_volume);
    }
    let audio_changed = before.capture_mic != after.capture_mic
        || before.capture_system_audio != after.capture_system_audio
        || before.mic_device_id != after.mic_device_id
        || before.noise_suppression != after.noise_suppression;
    if audio_changed {
        let app = app.clone();
        std::thread::spawn(move || restart_preview(&app));
    }
    if before.indicator_corner != after.indicator_corner || before.display_id != after.display_id {
        if let Some(w) = app.get_webview_window("indicator") {
            position_indicator(&app, &w);
        }
    }
    if !after.show_indicator {
        set_indicator(&app, None, None);
    }
    Ok(SettingsResult { settings: after, failed_hotkeys })
}

#[tauri::command]
fn suspend_hotkeys(app: AppHandle, suspend: bool) -> Vec<String> {
    st(&app).hotkeys_suspended.store(suspend, Ordering::Relaxed);
    register_hotkeys(&app)
}

#[tauri::command]
fn take_startup_warnings(app: AppHandle) -> Vec<String> {
    std::mem::take(&mut *st(&app).startup_warnings.lock().unwrap())
}

#[tauri::command]
fn list_displays() -> Vec<displays::Display> {
    displays::list()
}

#[derive(Serialize)]
struct Mic {
    id: String,
    name: String,
}

#[tauri::command]
async fn list_mics() -> Vec<Mic> {
    tauri::async_runtime::spawn_blocking(|| audio::list_inputs().into_iter().map(|n| Mic { id: n.clone(), name: n }).collect())
        .await
        .unwrap_or_default()
}

#[tauri::command]
fn get_state(app: AppHandle) -> RecState {
    rec_state(&app)
}

async fn blocking(app: AppHandle, f: fn(&AppHandle) -> Result<(), String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || f(&app)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn start_recording(app: AppHandle) -> Result<(), String> {
    blocking(app, start_recording_impl).await
}

#[tauri::command]
async fn stop_recording(app: AppHandle) -> Result<(), String> {
    blocking(app, stop_recording_impl).await
}

#[tauri::command]
async fn toggle_pause(app: AppHandle) -> Result<(), String> {
    blocking(app, toggle_pause_impl).await
}

#[tauri::command]
fn add_marker(app: AppHandle) {
    marker_impl(&app);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Recovered {
    name: String,
    ok: bool,
    file: Option<String>,
    error: Option<String>,
}

#[tauri::command]
async fn run_recovery(app: AppHandle) -> Vec<Recovered> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = st(&app);
        let dir = PathBuf::from(state.settings().output_dir);
        let skip = state.session.lock().unwrap().as_ref().map(|s| s.meta.base.clone());
        recorder::recover(&state.ffmpeg, &dir, skip.as_deref())
            .into_iter()
            .map(|(name, r)| match r {
                Ok(f) => Recovered { name, ok: true, file: Some(f.to_string_lossy().into_owned()), error: None },
                Err(e) => Recovered { name, ok: false, file: None, error: Some(e) },
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    let mut dialog = app.dialog().file().set_title("Velg hvor opptak skal lagres").set_directory(st(&app).settings().output_dir);
    if let Some(w) = overlay(&app) {
        dialog = dialog.set_parent(&w);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder()).await.ok().flatten()?;
    picked.into_path().ok().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_folder(app: AppHandle) {
    open_output_dir(&app);
}

#[tauri::command]
fn show_file(app: AppHandle, path: String) {
    let _ = app.opener().reveal_item_in_dir(path);
}

#[tauri::command]
fn open_file(app: AppHandle, path: String) {
    let _ = app.opener().open_path(path, None::<&str>);
}

#[derive(Serialize)]
struct RecentFile {
    name: String,
    path: String,
    size: u64,
}

#[tauri::command]
fn list_recent(app: AppHandle) -> Vec<RecentFile> {
    let dir = PathBuf::from(st(&app).settings().output_dir);
    let Ok(entries) = std::fs::read_dir(&dir) else { return vec![] };
    let mut files: Vec<(std::time::SystemTime, RecentFile)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let ext = Path::new(&name).extension()?.to_str()?.to_ascii_lowercase();
            if !["mp4", "mp3", "m4a", "wav"].contains(&ext.as_str()) {
                return None;
            }
            let md = e.metadata().ok()?;
            Some((md.modified().ok()?, RecentFile { name, path: e.path().to_string_lossy().into_owned(), size: md.len() }))
        })
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.into_iter().take(6).map(|(_, f)| f).collect()
}

#[tauri::command]
fn hide_overlay_cmd(app: AppHandle) {
    hide_overlay(&app);
}

#[tauri::command]
fn resize_overlay(app: AppHandle, height: f64) {
    let Some(w) = overlay(&app) else { return };
    let max = w.current_monitor().ok().flatten().map(|m| m.size().height as f64 / m.scale_factor() - 60.0).unwrap_or(1000.0);
    let _ = w.set_size(LogicalSize::new(OVERLAY_WIDTH, height.ceil().clamp(120.0, max)));
}

// ---------------------------------------------------------------- startup

fn find_ffmpeg(app: &AppHandle) -> PathBuf {
    let mut candidates = vec![];
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("ffmpeg.exe"));
        candidates.push(dir.join("resources").join("ffmpeg.exe"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("ffmpeg.exe"));
        }
    }
    candidates.into_iter().find(|p| p.exists()).unwrap_or_else(|| PathBuf::from("ffmpeg.exe"))
}

fn build_windows(app: &AppHandle) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("index.html".into()))
        .title("Intervjueren")
        .inner_size(OVERLAY_WIDTH, 640.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .content_protected(true) // keep the overlay out of the recording
        .visible(false)
        .build()?
        .on_window_event({
            let app = app.clone();
            move |e| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                    api.prevent_close();
                    hide_overlay(&app);
                }
            }
        });

    let indicator = WebviewWindowBuilder::new(app, "indicator", WebviewUrl::App("indicator.html".into()))
        .title("Intervjueren REC")
        .inner_size(190.0, 44.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .content_protected(true)
        .visible(false)
        .build()?;
    let _ = indicator.set_ignore_cursor_events(true);
    Ok(())
}

fn spawn_background_loops(app: &AppHandle) {
    let a = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        tick(&a);
    });
    // Level meters, only while the overlay is visible.
    let a = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(50));
        let state = st(&a);
        if !state.overlay_visible.load(Ordering::Relaxed) {
            continue;
        }
        let peaks = {
            let sess = state.session.lock().unwrap();
            let prev = state.preview.lock().unwrap();
            sess.as_ref().map(|s| &s.audio).or(prev.as_ref()).map(|h| (h.mic_peak.take(), h.sys_peak.take()))
        };
        let (mic, sys) = peaks.unwrap_or((0.0, 0.0));
        let _ = a.emit("meters", (audio::meter(mic), audio::meter(sys)));
    });
}

/// `Intervjueren.exe --selftest <dir>`: records a short video and audio clip headlessly and
/// prints the results. Handy for checking the capture chain without touching the screen.
fn selftest(app: AppHandle, dir: PathBuf, video_secs: u64) {
    std::thread::spawn(move || {
        let state = st(&app);
        let mut out = String::new();
        let started = Instant::now();
        let enc = state.encoder();
        out += &format!("ffmpeg: {}\nencoder: {} ({} ms)\n", state.ffmpeg.display(), enc.label(), started.elapsed().as_millis());
        for d in displays::list() {
            out += &format!("display {}: {}\n", d.display_id, d.name);
        }
        out += &format!("mics: {:?}\n", audio::list_inputs());
        let mut s = state.settings();
        s.output_dir = dir.to_string_lossy().into_owned();
        for (mode, secs) in [("video", video_secs), ("audio", 4)] {
            s.mode = mode.into();
            let res = record_options(&state, &s).and_then(|o| Session::start(&state.ffmpeg, o));
            match res {
                Ok((mut sess, warnings)) => {
                    out += &format!("{mode}: started, warnings={warnings:?} mic_ok={} sys_ok={}\n", sess.audio.mic_ok, sess.audio.sys_ok);
                    std::thread::sleep(Duration::from_secs(secs / 2));
                    sess.add_marker();
                    if mode == "video" {
                        sess.pause();
                        std::thread::sleep(Duration::from_millis(500));
                        let _ = sess.resume(&state.ffmpeg);
                    }
                    std::thread::sleep(Duration::from_secs(secs / 2));
                    let (meta, d) = sess.stop();
                    let r = recorder::finalize(&state.ffmpeg, &meta, d, |_| {});
                    out += &format!("{mode}: segments={} elapsed={:?} -> {:?}\n", meta.segments.len(), d, r);
                }
                Err(e) => out += &format!("{mode}: FAILED {e}\n"),
            }
        }
        let _ = std::fs::write(dir.join("selftest.txt"), &out);
        app.exit(0);
    });
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let selftest_dir = args.iter().position(|a| a == "--selftest").map(|i| PathBuf::from(args.get(i + 1).cloned().unwrap_or_else(|| ".".into())));
    let start_hidden = args.iter().any(|a| a == "--hidden");
    let selftest_secs = args.iter().position(|a| a == "--selftest").and_then(|i| args.get(i + 2)).and_then(|s| s.parse().ok()).unwrap_or(6);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_overlay(app)))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        on_hotkey(app, shortcut);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_settings, set_settings, suspend_hotkeys, take_startup_warnings, list_displays, list_mics,
            get_state, start_recording, stop_recording, toggle_pause, add_marker, run_recovery,
            pick_folder, open_folder, show_file, open_file, list_recent, hide_overlay_cmd, resize_overlay
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let paths = app.path();
            let store = Store::load(
                &paths.app_config_dir()?,
                &paths.data_dir()?,
                &paths.video_dir().unwrap_or_else(|_| PathBuf::from(".")),
            );
            app.manage(AppState {
                store: Mutex::new(store),
                ffmpeg: find_ffmpeg(&handle),
                encoder: Mutex::new(None),
                phase: Mutex::new(Phase::Idle),
                session: Mutex::new(None),
                preview: Mutex::new(None),
                overlay_visible: AtomicBool::new(false),
                hotkeys_suspended: AtomicBool::new(false),
                hotkey_actions: Mutex::new(HashMap::new()),
                startup_warnings: Mutex::new(vec![]),
                quitting: AtomicBool::new(false),
                indicator_hide_at: Mutex::new(None),
            });

            if let Some(dir) = selftest_dir.clone() {
                let _ = std::fs::create_dir_all(&dir);
                selftest(handle, dir, selftest_secs);
                return Ok(());
            }

            build_windows(&handle)?;
            create_tray(&handle)?;
            let failed = register_hotkeys(&handle);
            if !failed.is_empty() {
                *st(&handle).startup_warnings.lock().unwrap() = failed;
            }
            // Probe the GPU encoder in the background so the first recording starts instantly.
            let h = handle.clone();
            std::thread::spawn(move || {
                st(&h).encoder();
            });
            spawn_background_loops(&handle);
            if !start_hidden {
                show_overlay(&handle);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build app")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                // Closing windows must not quit the tray app; only an explicit exit does.
                if code.is_none() && !st(app).quitting.load(Ordering::Relaxed) {
                    api.prevent_exit();
                }
            }
        });
}
