//! intervjueren-engine: the recording backend that the Electron app drives.
//!
//! Protocol: one JSON object per line.
//!   stdin  → {"id": 1, "cmd": "start", ...}
//!   stdout ← {"id": 1, "ok": true, "data": ...} | {"id": 1, "ok": false, "error": "..."}
//!   stdout ← {"event": "state" | "meters" | "progress" | "toast", ...}
//!
//! Commands: info, listDisplays, listMics, preview, gains, meters, start, pause, resume,
//! marker, stop, recover. When stdin closes (Electron quit or crashed) a running recording is
//! stopped and saved before the engine exits.
//!
//! Usage: intervjueren-engine.exe --ffmpeg <path-to-ffmpeg.exe>

#![windows_subsystem = "windows"]

mod audio;
mod displays;
mod recorder;

use audio::{AudioConfig, AudioHandle};
use recorder::{Encoder, Kind, RecordOptions, Session, VideoOptions};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AudioOpts {
    mic: Option<String>,
    loopback: bool,
    noise_suppression: bool,
    mic_gain: f32,
    sys_gain: f32,
}

impl From<AudioOpts> for AudioConfig {
    fn from(a: AudioOpts) -> Self {
        AudioConfig { mic: a.mic, loopback: a.loopback, noise_suppression: a.noise_suppression, mic_gain: a.mic_gain, sys_gain: a.sys_gain }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartOpts {
    kind: String,
    out_dir: PathBuf,
    display_id: Option<String>,
    resolution: String,
    fps: u32,
    quality: String,
    audio: AudioOpts,
    audio_format: String,
    keep_raw: bool,
    /// "auto" (default) or an encoder id: nvenc / amf / qsv / x264.
    #[serde(default)]
    encoder: Option<String>,
}

struct Engine {
    ffmpeg: PathBuf,
    encoders: Mutex<Option<Vec<(Encoder, bool)>>>,
    phase: Mutex<&'static str>,
    session: Mutex<Option<Session>>,
    preview: Mutex<Option<AudioHandle>>,
    meters_on: AtomicBool,
    out: Mutex<std::io::Stdout>,
}

impl Engine {
    fn emit(&self, v: Value) {
        let mut out = self.out.lock().unwrap();
        let _ = writeln!(out, "{v}");
        let _ = out.flush();
    }

    fn encoders(&self) -> Vec<(Encoder, bool)> {
        self.encoders.lock().unwrap().get_or_insert_with(|| recorder::detect_encoders(&self.ffmpeg)).clone()
    }

    fn auto_encoder(&self) -> Encoder {
        recorder::best_encoder(&self.encoders())
    }

    fn phase(&self) -> &'static str {
        *self.phase.lock().unwrap()
    }

    fn set_phase(&self, p: &'static str) {
        *self.phase.lock().unwrap() = p;
        self.emit_state();
    }

    fn emit_state(&self) {
        let phase = self.phase();
        let sess = self.session.lock().unwrap();
        let v = match sess.as_ref() {
            Some(s) => json!({
                "event": "state", "state": phase, "elapsedMs": s.elapsed().as_millis() as u64, "bytes": s.bytes(),
                "file": format!("{}.{}", s.meta.base, s.meta.final_ext), "markers": s.markers,
            }),
            None => json!({ "event": "state", "state": phase, "elapsedMs": 0, "bytes": 0, "file": null, "markers": 0 }),
        };
        drop(sess);
        self.emit(v);
    }

    fn start(&self, args: Value) -> Result<Value, String> {
        if self.phase() != "idle" {
            return Err("Et opptak pågår allerede.".into());
        }
        let o: StartOpts = serde_json::from_value(args).map_err(|e| e.to_string())?;
        self.set_phase("starting");
        drop(self.preview.lock().unwrap().take());
        let kind = if o.kind == "audio" { Kind::Audio } else { Kind::Video };
        let display = if kind == Kind::Video {
            match displays::resolve(o.display_id.as_deref()) {
                Some(d) => Some(d),
                None => {
                    self.set_phase("idle");
                    return Err("Fant ingen skjerm å ta opp.".into());
                }
            }
        } else {
            None
        };
        let opts_for = |encoder: Encoder| RecordOptions {
            kind,
            out_dir: o.out_dir.clone(),
            video: display.as_ref().map(|d| VideoOptions {
                output_idx: d.display_id.parse().unwrap_or(0),
                src_size: (d.rect.2 as u32, d.rect.3 as u32),
                target_height: o.resolution.parse().ok(),
                fps: o.fps.clamp(10, 60),
                quality: o.quality.clone(),
                encoder,
            }),
            audio: o.audio.clone().into(),
            audio_format: o.audio_format.clone(),
            keep_raw: o.keep_raw,
        };

        // A manually chosen encoder that fails (missing driver, settings copied from another PC)
        // falls back to the automatic choice instead of failing the recording.
        let auto = if kind == Kind::Video { self.auto_encoder() } else { Encoder::X264 };
        let chosen = o.encoder.as_deref().and_then(Encoder::from_id).unwrap_or(auto);
        let mut result = Session::start(&self.ffmpeg, opts_for(chosen));
        if let (Err(_), true) = (&result, kind == Kind::Video && chosen != auto) {
            let note = format!("Videokoderen {} virker ikke på denne PC-en — bruker {} i stedet.", chosen.label(), auto.label());
            result = Session::start(&self.ffmpeg, opts_for(auto)).map(|(s, mut w)| {
                w.insert(0, note);
                (s, w)
            });
        }
        match result {
            Ok((session, warnings)) => {
                let info = session.video_info().map(|(enc, (w, h), b)| json!({ "encoder": enc.label(), "width": w, "height": h, "bitrate": b }));
                let file = format!("{}.{}", session.meta.base, session.meta.final_ext);
                *self.session.lock().unwrap() = Some(session);
                self.set_phase("recording");
                Ok(json!({ "file": file, "video": info, "warnings": warnings }))
            }
            Err(e) => {
                self.set_phase("idle");
                Err(e)
            }
        }
    }

    fn pause_resume(&self, pause: bool) -> Result<Value, String> {
        let phase = self.phase();
        {
            let mut guard = self.session.lock().unwrap();
            let Some(s) = guard.as_mut() else { return Ok(Value::Null) };
            match (pause, phase) {
                (true, "recording") => s.pause(),
                (false, "paused") => s.resume(&self.ffmpeg)?,
                _ => return Ok(Value::Null),
            }
        }
        self.set_phase(if pause { "paused" } else { "recording" });
        Ok(Value::Null)
    }

    fn marker(&self) -> Result<Value, String> {
        let r = self.session.lock().unwrap().as_mut().map(|s| s.add_marker());
        self.emit_state();
        Ok(match r {
            Some((n, at)) => json!({ "count": n, "elapsedMs": at.as_millis() as u64, "time": recorder::fmt_time(at) }),
            None => Value::Null,
        })
    }

    fn stop(&self) -> Result<Value, String> {
        if !matches!(self.phase(), "recording" | "paused") {
            return Ok(Value::Null);
        }
        self.set_phase("stopping");
        let Some(session) = self.session.lock().unwrap().take() else {
            self.set_phase("idle");
            return Ok(Value::Null);
        };
        let (meta, duration) = session.stop();
        let r = recorder::finalize(&self.ffmpeg, &meta, duration, |pct| self.emit(json!({ "event": "progress", "pct": pct })));
        self.set_phase("idle");
        match r {
            Ok(file) => Ok(json!({ "file": file })),
            Err(e) => Err(format!("{e}\nRådelene ligger i {}", meta.out_dir.join(".raw").display())),
        }
    }

    fn handle(&self, cmd: &str, args: Value) -> Result<Value, String> {
        match cmd {
            "info" => Ok(json!({ "encoder": self.auto_encoder().label() })),
            "encoders" => {
                let list = self.encoders();
                let best = recorder::best_encoder(&list);
                let items: Vec<Value> = list
                    .iter()
                    .map(|(e, ok)| json!({ "id": e.id(), "label": e.label(), "available": ok }))
                    .collect();
                Ok(json!({ "auto": best.id(), "autoLabel": best.label(), "encoders": items }))
            }
            "listDisplays" => Ok(json!(displays::list())),
            "listMics" => Ok(json!(audio::list_inputs())),
            "preview" => {
                // Level meters while idle. null/absent audio config = stop.
                let cfg = serde_json::from_value::<AudioOpts>(args["audio"].clone()).ok();
                drop(self.preview.lock().unwrap().take());
                if let (Some(cfg), "idle") = (cfg, self.phase()) {
                    let handle = audio::start(cfg.into());
                    *self.preview.lock().unwrap() = Some(handle);
                }
                Ok(Value::Null)
            }
            "gains" => {
                let (mic, sys) = (args["mic"].as_f64().unwrap_or(1.0) as f32, args["sys"].as_f64().unwrap_or(1.0) as f32);
                if let Some(s) = self.session.lock().unwrap().as_ref() {
                    s.audio.mic_gain.set(mic);
                    s.audio.sys_gain.set(sys);
                }
                if let Some(p) = self.preview.lock().unwrap().as_ref() {
                    p.mic_gain.set(mic);
                    p.sys_gain.set(sys);
                }
                Ok(Value::Null)
            }
            "meters" => {
                self.meters_on.store(args["on"].as_bool().unwrap_or(false), Ordering::Relaxed);
                Ok(Value::Null)
            }
            "start" => self.start(args),
            "pause" => self.pause_resume(true),
            "resume" => self.pause_resume(false),
            "marker" => self.marker(),
            "stop" => self.stop(),
            "state" => {
                self.emit_state();
                Ok(Value::Null)
            }
            "recover" => {
                let dir = PathBuf::from(args["outDir"].as_str().unwrap_or_default());
                let skip = self.session.lock().unwrap().as_ref().map(|s| s.meta.base.clone());
                let results: Vec<Value> = recorder::recover(&self.ffmpeg, &dir, skip.as_deref())
                    .into_iter()
                    .map(|(name, r)| match r {
                        Ok(f) => json!({ "name": name, "ok": true, "file": f }),
                        Err(e) => json!({ "name": name, "ok": false, "error": e }),
                    })
                    .collect();
                Ok(json!(results))
            }
            other => Err(format!("ukjent kommando: {other}")),
        }
    }
}

fn spawn_loops(engine: &Arc<Engine>) {
    // Status twice a second while recording, and self-healing if ffmpeg dies.
    let e = engine.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let phase = e.phase();
        if !matches!(phase, "recording" | "paused") {
            continue;
        }
        if phase == "recording" {
            let msg = e.session.lock().unwrap().as_mut().and_then(|s| s.check_health(&e.ffmpeg));
            if let Some(msg) = msg {
                let paused = e.session.lock().unwrap().as_ref().is_some_and(|s| s.is_paused());
                e.emit(json!({ "event": "toast", "kind": if paused { "error" } else { "warn" }, "msg": msg }));
                if paused {
                    e.set_phase("paused");
                }
            }
        }
        e.emit_state();
    });
    // Level meters, only while the overlay asks for them.
    let e = engine.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(50));
        if !e.meters_on.load(Ordering::Relaxed) {
            continue;
        }
        let peaks = {
            let sess = e.session.lock().unwrap();
            let prev = e.preview.lock().unwrap();
            sess.as_ref().map(|s| &s.audio).or(prev.as_ref()).map(|h| (h.mic_peak.take(), h.sys_peak.take()))
        };
        let (mic, sys) = peaks.unwrap_or((0.0, 0.0));
        e.emit(json!({ "event": "meters", "mic": audio::meter(mic), "sys": audio::meter(sys) }));
    });
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let ffmpeg = args
        .iter()
        .position(|a| a == "--ffmpeg")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("ffmpeg.exe"));

    let engine = Arc::new(Engine {
        ffmpeg,
        encoders: Mutex::new(None),
        phase: Mutex::new("idle"),
        session: Mutex::new(None),
        preview: Mutex::new(None),
        meters_on: AtomicBool::new(false),
        out: Mutex::new(std::io::stdout()),
    });
    spawn_loops(&engine);
    engine.emit(json!({ "event": "ready" }));

    let stdin = std::io::stdin();
    for line in stdin.lock().lines().map_while(Result::ok) {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let id = msg["id"].clone();
        let cmd = msg["cmd"].as_str().unwrap_or_default().to_string();
        let reply = match engine.handle(&cmd, msg) {
            Ok(data) => json!({ "id": id, "ok": true, "data": data }),
            Err(error) => json!({ "id": id, "ok": false, "error": error }),
        };
        engine.emit(reply);
    }

    // Electron went away: never lose a recording because of it.
    let _ = engine.stop();
}
