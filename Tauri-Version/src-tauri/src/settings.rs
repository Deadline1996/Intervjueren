use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Hotkeys {
    pub toggle_overlay: String,
    pub toggle_record: String,
    pub pause: String,
    pub marker: String,
}

impl Default for Hotkeys {
    fn default() -> Self {
        Self {
            toggle_overlay: "Alt+O".into(),
            toggle_record: "Alt+R".into(),
            pause: "Alt+P".into(),
            marker: "Alt+M".into(),
        }
    }
}

/// Same JSON shape as the Electron version, so its settings.json can be reused as-is.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub output_dir: String,
    pub mode: String,               // "video" | "audio"
    pub display_id: Option<String>, // DXGI output index; None = primary
    pub resolution: String,         // "native" | "1440" | "1080" | "720"
    pub fps: u32,
    pub quality: String, // "low" | "medium" | "high"
    pub capture_system_audio: bool,
    pub capture_mic: bool,
    pub mic_device_id: String, // device name or "default"
    pub mic_volume: f32,
    pub system_volume: f32,
    pub noise_suppression: bool,
    pub audio_format: String, // "mp3" | "m4a" | "wav"
    pub keep_raw: bool,
    pub show_indicator: bool,
    pub indicator_corner: String,
    pub hotkeys: Hotkeys,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            output_dir: String::new(),
            mode: "video".into(),
            display_id: None,
            resolution: "1080".into(),
            fps: 30,
            quality: "medium".into(),
            capture_system_audio: true,
            capture_mic: true,
            mic_device_id: "default".into(),
            mic_volume: 1.0,
            system_volume: 1.0,
            noise_suppression: true,
            audio_format: "mp3".into(),
            keep_raw: false,
            show_indicator: true,
            indicator_corner: "top-right".into(),
            hotkeys: Hotkeys::default(),
        }
    }
}

pub struct Store {
    path: PathBuf,
    pub settings: Settings,
}

impl Store {
    /// Loads settings, falling back to the Electron builds' files the first time.
    pub fn load(config_dir: &Path, appdata: &Path, videos: &Path) -> Self {
        let path = config_dir.join("settings.json");
        let candidates = [
            path.clone(),
            appdata.join("Intervjueren").join("settings.json"),
            appdata.join("FiveM Recorder").join("settings.json"),
        ];
        let mut settings = candidates
            .iter()
            .find_map(|p| fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
            .unwrap_or_default();
        if settings.output_dir.is_empty() {
            settings.output_dir = videos.join("FiveM-intervjuer").to_string_lossy().into_owned();
        }
        // Electron stored display ids that mean nothing to DXGI; ignore anything non-numeric.
        if settings.display_id.as_deref().is_some_and(|d| d.parse::<u32>().is_err()) {
            settings.display_id = None;
        }
        let store = Self { path, settings };
        store.save();
        store
    }

    pub fn save(&self) {
        if let Some(dir) = self.path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(&self.settings) {
            let _ = fs::write(&self.path, json);
        }
    }

    /// Shallow-merges a JSON patch from the UI (hotkeys merge one level deeper).
    pub fn patch(&mut self, patch: Value) -> Result<(), String> {
        let mut current = serde_json::to_value(&self.settings).map_err(|e| e.to_string())?;
        if let (Value::Object(cur), Value::Object(p)) = (&mut current, patch) {
            for (k, v) in p {
                match (cur.get_mut(&k), v) {
                    (Some(Value::Object(dst)), Value::Object(src)) => dst.extend(src),
                    (_, v) => {
                        cur.insert(k, v);
                    }
                }
            }
        }
        self.settings = serde_json::from_value(current).map_err(|e| e.to_string())?;
        self.save();
        Ok(())
    }
}
