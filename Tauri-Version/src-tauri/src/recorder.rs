//! Recording sessions driven by ffmpeg.
//!
//! Each segment uses two ffmpeg processes:
//! * video: `ddagrab` (Desktop Duplication; frames stay on the GPU) → `scale_d3d11` → NVENC
//!   (AMF / QSV / x264 fallbacks). Stopped cleanly by sending `q` on stdin.
//! * audio: the Rust mixer (audio.rs) pipes raw f32le into stdin; closing it ends the file.
//!
//! Keeping them apart matters: muxing a real-time audio pipe into the capture process makes
//! ffmpeg hold GPU frames while it waits for audio, which starves ddagrab and drops frames.
//! Audio is attached the moment the video process reports its first frame, which keeps the two
//! in sync; they are merged (stream copy) when the recording is saved.
//!
//! Pausing ends the current segment and resuming starts a new one; if ffmpeg dies mid-recording a
//! new segment starts automatically. A JSON sidecar lists the segments so a crash can be
//! recovered on the next start.

use crate::audio::{self, AudioConfig, AudioHandle, RATE};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Encoder {
    Nvenc,
    Amf,
    Qsv,
    X264,
}

impl Encoder {
    pub fn label(self) -> &'static str {
        match self {
            Encoder::Nvenc => "NVIDIA NVENC",
            Encoder::Amf => "AMD AMF",
            Encoder::Qsv => "Intel Quick Sync",
            Encoder::X264 => "x264 (CPU)",
        }
    }
}

fn ffmpeg_cmd(ffmpeg: &Path) -> Command {
    let mut c = Command::new(ffmpeg);
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

/// Picks the first hardware H.264 encoder that actually works on this PC.
pub fn detect_encoder(ffmpeg: &Path) -> Encoder {
    for (enc, name) in [(Encoder::Nvenc, "h264_nvenc"), (Encoder::Amf, "h264_amf"), (Encoder::Qsv, "h264_qsv")] {
        let ok = ffmpeg_cmd(ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=black:s=320x240:r=30",
                   "-frames:v", "3", "-c:v", name, "-f", "null", "-"])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if ok {
            return enc;
        }
    }
    Encoder::X264
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Video,
    Audio,
}

pub struct VideoOptions {
    pub output_idx: u32,
    pub src_size: (u32, u32),
    pub target_height: Option<u32>,
    pub fps: u32,
    pub quality: String,
    pub encoder: Encoder,
}

pub struct RecordOptions {
    pub kind: Kind,
    pub out_dir: PathBuf,
    pub video: Option<VideoOptions>,
    pub audio: AudioConfig,
    pub audio_format: String,
    pub keep_raw: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SegmentFiles {
    pub video: Option<String>,
    pub audio: String,
    /// Seconds of audio recorded before the first video frame; trimmed when merging.
    #[serde(default)]
    pub audio_trim: f64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub base: String,
    pub kind: Kind,
    pub final_ext: String,
    pub out_dir: PathBuf,
    pub segments: Vec<SegmentFiles>,
    pub keep_raw: bool,
}

struct Proc {
    child: Child,
    stdin: Option<ChildStdin>,
    err_tail: Arc<Mutex<String>>,
    sync: Option<SyncProbe>,
}

/// What's needed to line the audio up with the video of one segment.
struct SyncProbe {
    audio_started: Instant,
    out_us: Arc<AtomicI64>, // latest encoded video time from ffmpeg's progress output
    reader: Option<std::thread::JoinHandle<()>>,
    frame_time: f64,
}

impl Proc {
    fn spawn(mut cmd: Command, keep_stdin: bool) -> Result<Proc, String> {
        let mut child = cmd
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Kunne ikke starte ffmpeg: {e}"))?;
        let err_tail = Arc::new(Mutex::new(String::new()));
        if let Some(stderr) = child.stderr.take() {
            let tail = err_tail.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    let mut t = tail.lock().unwrap();
                    t.push_str(&line);
                    t.push('\n');
                    let len = t.len();
                    if len > 3000 {
                        t.drain(..len - 3000);
                    }
                }
            });
        }
        let stdin = if keep_stdin { child.stdin.take() } else { None };
        Ok(Proc { child, stdin, err_tail, sync: None })
    }

    fn exited(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(Some(_)))
    }

    fn last_error(&self) -> String {
        self.err_tail.lock().unwrap().trim().lines().last().unwrap_or("ukjent feil").to_string()
    }

    fn wait_or_kill(&mut self, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(30)),
                _ => {
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    return;
                }
            }
        }
    }
}

struct Segment {
    video: Option<Proc>,
    audio: Proc,
}

struct VideoPlan {
    filter: String,
    codec_args: Vec<String>,
    encoder: Encoder,
    size: (u32, u32),
    bitrate: u64,
    fps: u32,
}

pub struct Session {
    pub meta: Meta,
    raw_dir: PathBuf,
    meta_path: PathBuf,
    video: Option<VideoPlan>,
    segment: Option<Segment>,
    pub audio: AudioHandle,
    accumulated: Duration,
    active_since: Option<Instant>,
    pub markers: u32,
    pub restarts: u32,
}

fn stamp() -> String {
    chrono::Local::now().format("%Y-%m-%d_%H-%M-%S").to_string()
}

pub fn fmt_time(d: Duration) -> String {
    let s = d.as_secs();
    format!("{:02}:{:02}:{:02}", s / 3600, (s / 60) % 60, s % 60)
}

fn unique_base(out_dir: &Path, base: &str, ext: &str) -> String {
    let mut name = base.to_string();
    let mut i = 2;
    while out_dir.join(format!("{name}.{ext}")).exists() {
        name = format!("{base}_{i}");
        i += 1;
    }
    name
}

fn plan_video(v: &VideoOptions) -> VideoPlan {
    let (sw, sh) = v.src_size;
    let (w, h) = match v.target_height {
        Some(t) if t < sh => ((((sw as f64 * t as f64 / sh as f64) / 2.0).round() as u32) * 2, t),
        _ => (sw, sh),
    };
    let bpp = match v.quality.as_str() { "low" => 0.05, "high" => 0.13, _ => 0.08 };
    let bitrate = ((w as f64 * h as f64 * v.fps as f64 * bpp) as u64).clamp(1_500_000, 40_000_000);
    let grab = format!("ddagrab=output_idx={}:framerate={}:draw_mouse=0", v.output_idx, v.fps);
    let (b, max, buf, g) = (bitrate.to_string(), (bitrate * 3 / 2).to_string(), (bitrate * 2).to_string(), (v.fps * 2).to_string());
    let s = |x: &str| x.to_string();
    let (filter, codec_args) = match v.encoder {
        // Whole pipeline on the GPU: capture, scale/convert, encode.
        Encoder::Nvenc => (
            format!("{grab},scale_d3d11=width={w}:height={h}:format=nv12"),
            vec![s("-c:v"), s("h264_nvenc"), s("-preset"), s("p4"), s("-rc"), s("vbr"), s("-b:v"), b, s("-maxrate"), max, s("-bufsize"), buf, s("-g"), g,
                 s("-delay"), s("0"), s("-threads"), s("1")],
        ),
        Encoder::Amf => (
            format!("{grab},hwdownload,format=bgra,scale={w}:{h},format=nv12"),
            vec![s("-c:v"), s("h264_amf"), s("-quality"), s("speed"), s("-rc"), s("vbr_peak"), s("-b:v"), b, s("-maxrate"), max, s("-g"), g],
        ),
        Encoder::Qsv => (
            format!("{grab},hwdownload,format=bgra,scale={w}:{h},format=nv12"),
            vec![s("-c:v"), s("h264_qsv"), s("-preset"), s("veryfast"), s("-b:v"), b, s("-maxrate"), max, s("-g"), g],
        ),
        Encoder::X264 => (
            format!("{grab},hwdownload,format=bgra,scale={w}:{h},format=yuv420p"),
            vec![s("-c:v"), s("libx264"), s("-preset"), s("veryfast"), s("-b:v"), b, s("-maxrate"), max, s("-bufsize"), buf, s("-g"), g],
        ),
    };
    VideoPlan { filter, codec_args, encoder: v.encoder, size: (w, h), bitrate, fps: v.fps }
}

impl Session {
    pub fn start(ffmpeg: &Path, opts: RecordOptions) -> Result<(Session, Vec<String>), String> {
        let raw_dir = opts.out_dir.join(".raw");
        fs::create_dir_all(&raw_dir).map_err(|e| format!("Kan ikke opprette lagringsmappen: {e}"))?;
        let final_ext = if opts.kind == Kind::Video { "mp4".to_string() } else { opts.audio_format.clone() };
        let prefix = if opts.kind == Kind::Video { "Intervju" } else { "Intervju-lyd" };
        let base = unique_base(&opts.out_dir, &format!("{prefix}_{}", stamp()), &final_ext);

        let audio = audio::start(opts.audio);
        let mut warnings = audio.warnings.clone();
        if opts.kind == Kind::Audio && !audio.mic_ok && !audio.sys_ok {
            return Err("Kun lyd krever at mikrofon og/eller systemlyd er slått på og fungerer (Innstillinger → Lyd).".into());
        }
        if opts.kind == Kind::Video && !audio.mic_ok && !audio.sys_ok {
            warnings.push("Tar opp video UTEN lyd — ingen lydkilde er aktiv.".into());
        }

        let meta = Meta { base: base.clone(), kind: opts.kind, final_ext, out_dir: opts.out_dir.clone(), segments: vec![], keep_raw: opts.keep_raw };
        let meta_path = raw_dir.join(format!("{base}.json"));
        let mut session = Session {
            meta,
            raw_dir,
            meta_path,
            video: opts.video.as_ref().map(plan_video),
            segment: None,
            audio,
            accumulated: Duration::ZERO,
            active_since: None,
            markers: 0,
            restarts: 0,
        };
        session.spawn_segment(ffmpeg)?;
        Ok((session, warnings))
    }

    pub fn video_info(&self) -> Option<(Encoder, (u32, u32), u64)> {
        self.video.as_ref().map(|v| (v.encoder, v.size, v.bitrate))
    }

    fn write_meta(&self) {
        if let Ok(json) = serde_json::to_string_pretty(&self.meta) {
            let _ = fs::write(&self.meta_path, json);
        }
    }

    fn spawn_segment(&mut self, ffmpeg: &Path) -> Result<(), String> {
        let n = self.meta.segments.len() + 1;
        let video_mode = self.video.is_some();
        let audio_name = format!("{}.part{n:03}.{}", self.meta.base, if video_mode { "audio.mka" } else { "mka" });
        let video_name = video_mode.then(|| format!("{}.part{n:03}.video.mkv", self.meta.base));

        // Audio encoder: waits on stdin until the mixer starts feeding it.
        let mut cmd = ffmpeg_cmd(ffmpeg);
        cmd.args(["-hide_banner", "-loglevel", "error", "-nostats", "-y",
                  "-f", "f32le", "-ar", &RATE.to_string(), "-ac", "2", "-i", "pipe:0"]);
        if video_mode { cmd.args(["-c:a", "aac", "-b:a", "192k"]) } else { cmd.args(["-c:a", "flac"]) };
        cmd.args(["-f", "matroska"]).arg(self.raw_dir.join(&audio_name)).stdout(Stdio::null());
        let mut audio_proc = Proc::spawn(cmd, true)?;
        let audio_in = audio_proc.stdin.take().expect("audio stdin");

        self.audio.sink_failed.store(false, Ordering::Relaxed);
        let video_proc = match (&self.video, &video_name) {
            (Some(plan), Some(name)) => {
                let mut cmd = ffmpeg_cmd(ffmpeg);
                cmd.args(["-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-stats_period", "0.05", "-y",
                          "-filter_threads", "1", "-f", "lavfi", "-i", &plan.filter])
                    .args(&plan.codec_args)
                    .args(["-f", "matroska"])
                    .arg(self.raw_dir.join(name))
                    .stdout(Stdio::piped());
                let mut proc = Proc::spawn(cmd, true).inspect_err(|_| {
                    let _ = audio_proc.child.kill();
                })?;
                // Audio starts flowing right away. ddagrab needs a moment before its first frame,
                // so the audio leads slightly; end_segment measures by how much (from the encoded
                // video length) and the merge on save trims exactly that.
                self.audio.sink.lock().unwrap().writer = Some(Box::new(audio_in));
                let audio_started = Instant::now();
                let started = Arc::new(AtomicBool::new(false));
                let out_us = Arc::new(AtomicI64::new(0));
                let stdout = proc.child.stdout.take().expect("progress pipe");
                let (flag, out) = (started.clone(), out_us.clone());
                let reader = std::thread::spawn(move || {
                    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                        if let Some(f) = line.strip_prefix("frame=").and_then(|v| v.trim().parse::<u64>().ok()) {
                            if f > 0 {
                                flag.store(true, Ordering::Relaxed);
                            }
                        } else if let Some(us) = line.strip_prefix("out_time_us=").and_then(|v| v.trim().parse::<i64>().ok()) {
                            out.store(us, Ordering::Relaxed);
                        }
                    }
                });
                // Wait for proof that capture + encoding work before reporting success.
                let deadline = Instant::now() + Duration::from_secs(8);
                while !started.load(Ordering::Relaxed) {
                    if proc.exited() || Instant::now() > deadline {
                        std::thread::sleep(Duration::from_millis(100));
                        let msg = proc.last_error();
                        let _ = proc.child.kill();
                        self.audio.sink.lock().unwrap().writer = None;
                        let _ = audio_proc.child.kill();
                        let _ = fs::remove_file(self.raw_dir.join(name));
                        let _ = fs::remove_file(self.raw_dir.join(&audio_name));
                        return Err(format!("Skjermopptaket startet ikke: {msg}"));
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                self.active_since = Some(audio_started);
                proc.sync = Some(SyncProbe { audio_started, out_us, reader: Some(reader), frame_time: 1.0 / plan.fps as f64 });
                Some(proc)
            }
            _ => {
                self.audio.sink.lock().unwrap().writer = Some(Box::new(audio_in));
                self.active_since = Some(Instant::now());
                None
            }
        };

        self.meta.segments.push(SegmentFiles { video: video_name, audio: audio_name, audio_trim: 0.0 });
        self.write_meta();
        self.segment = Some(Segment { video: video_proc, audio: audio_proc });
        Ok(())
    }

    /// Ends the current segment cleanly: `q` tells the video encoder to finish its file, and
    /// closing the audio pipe does the same for the audio encoder.
    fn end_segment(&mut self) {
        if let Some(since) = self.active_since.take() {
            self.accumulated += since.elapsed();
        }
        let Some(mut seg) = self.segment.take() else { return };
        if let Some(v) = seg.video.as_mut() {
            if let Some(mut stdin) = v.stdin.take() {
                let _ = stdin.write_all(b"q");
            }
        }
        self.audio.sink.lock().unwrap().writer = None;
        let stopped = Instant::now();
        if let Some(v) = seg.video.as_mut() {
            v.wait_or_kill(Duration::from_secs(15));
            if let Some(mut sync) = v.sync.take() {
                if let Some(r) = sync.reader.take() {
                    let _ = r.join(); // ensures the final progress report has been read
                }
                // audio length − video length = how far the audio ran ahead at the start.
                let audio_len = stopped.duration_since(sync.audio_started).as_secs_f64();
                let video_len = sync.out_us.load(Ordering::Relaxed) as f64 / 1e6 + sync.frame_time;
                if let Some(last) = self.meta.segments.last_mut() {
                    last.audio_trim = (audio_len - video_len).clamp(0.0, 3.0);
                }
                self.write_meta();
            }
        }
        seg.audio.wait_or_kill(Duration::from_secs(15));
    }

    pub fn is_paused(&self) -> bool {
        self.segment.is_none()
    }

    pub fn pause(&mut self) {
        if !self.is_paused() {
            self.end_segment();
        }
    }

    pub fn resume(&mut self, ffmpeg: &Path) -> Result<(), String> {
        if self.is_paused() { self.spawn_segment(ffmpeg) } else { Ok(()) }
    }

    pub fn elapsed(&self) -> Duration {
        self.accumulated + self.active_since.map(|s| s.elapsed()).unwrap_or_default()
    }

    pub fn bytes(&self) -> u64 {
        self.meta.segments.iter()
            .flat_map(|s| s.video.iter().chain(std::iter::once(&s.audio)))
            .filter_map(|f| fs::metadata(self.raw_dir.join(f)).ok())
            .map(|m| m.len())
            .sum()
    }

    /// If ffmpeg died mid-recording, keep going in a fresh segment. Returns a message for the UI.
    pub fn check_health(&mut self, ffmpeg: &Path) -> Option<String> {
        let seg = self.segment.as_mut()?;
        let video_died = seg.video.as_mut().is_some_and(|v| v.exited());
        let audio_died = seg.audio.exited() || self.audio.sink_failed.load(Ordering::Relaxed);
        if !video_died && !audio_died {
            return None;
        }
        let reason = if video_died { seg.video.as_ref().unwrap().last_error() } else { seg.audio.last_error() };
        self.end_segment();
        if self.restarts >= 20 {
            return Some(format!("ffmpeg feilet gjentatte ganger ({reason}). Opptaket er satt på pause."));
        }
        self.restarts += 1;
        Some(match self.spawn_segment(ffmpeg) {
            Ok(()) => "Opptaket hikket, men fortsetter i en ny del — ingenting av det som er tatt opp er tapt.".to_string(),
            Err(e) => format!("Opptaket er satt på pause: {e}"),
        })
    }

    pub fn add_marker(&mut self) -> (u32, Duration) {
        self.markers += 1;
        let at = self.elapsed();
        let file = self.meta.out_dir.join(format!("{}.markører.txt", self.meta.base));
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(file) {
            let _ = write!(f, "{}  Markør {}\r\n", fmt_time(at), self.markers);
        }
        (self.markers, at)
    }

    /// Stops capture. The returned job is finalized separately (it can take a few seconds).
    pub fn stop(mut self) -> (Meta, Duration) {
        self.end_segment();
        let d = self.elapsed();
        (self.meta.clone(), d)
    }
}

// ---------------------------------------------------------------- finalizing

fn non_empty(p: &Path) -> bool {
    fs::metadata(p).map(|m| m.len() > 0).unwrap_or(false)
}

fn run_ffmpeg(mut cmd: Command, duration: Duration, progress: &dyn Fn(u8)) -> Result<(), String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Kunne ikke starte ffmpeg: {e}"))?;
    let mut stderr = child.stderr.take().unwrap();
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    let total_us = duration.as_micros().max(1) as f64;
    for line in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
        if let Some(v) = line.strip_prefix("out_time_us=").and_then(|v| v.parse::<f64>().ok()) {
            if !duration.is_zero() {
                progress(((v / total_us) * 100.0).clamp(0.0, 99.0) as u8);
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let err = err_thread.join().unwrap_or_default();
    if status.success() { Ok(()) } else { Err(err.trim().lines().last().unwrap_or("ffmpeg feilet").to_string()) }
}

fn concat_file(list: &Path, files: &[PathBuf]) -> Result<(), String> {
    let mut body = String::new();
    for p in files {
        let path = p.to_string_lossy().replace('\\', "/").replace('\'', r"'\''");
        body.push_str(&format!("file '{path}'\n"));
    }
    fs::write(list, body).map_err(|e| e.to_string())
}

/// Joins the segments into the final file. `progress` receives 0–100.
pub fn finalize(ffmpeg: &Path, meta: &Meta, duration: Duration, progress: impl Fn(u8)) -> Result<PathBuf, String> {
    let raw_dir = meta.out_dir.join(".raw");
    let final_path = meta.out_dir.join(format!("{}.{}", meta.base, meta.final_ext));
    let list = raw_dir.join(format!("{}.concat.txt", meta.base));
    let mut temps: Vec<PathBuf> = vec![];

    let result = (|| {
        let mut parts = vec![];
        for (i, seg) in meta.segments.iter().enumerate() {
            let audio = raw_dir.join(&seg.audio);
            match &seg.video {
                Some(v) => {
                    let video = raw_dir.join(v);
                    if !non_empty(&video) {
                        continue;
                    }
                    if !non_empty(&audio) {
                        parts.push(video);
                        continue;
                    }
                    // Put each segment's audio next to its video (stream copy, fast).
                    let pair = raw_dir.join(format!("{}.part{:03}.av.mkv", meta.base, i + 1));
                    let mut cmd = ffmpeg_cmd(ffmpeg);
                    cmd.args(["-hide_banner", "-loglevel", "error", "-nostats", "-y", "-i"]).arg(&video)
                        .args(["-ss", &format!("{:.3}", seg.audio_trim), "-i"]).arg(&audio)
                        .args(["-map", "0:v", "-map", "1:a", "-c", "copy", "-f", "matroska"]).arg(&pair);
                    run_ffmpeg(cmd, Duration::ZERO, &|_| {})?;
                    temps.push(pair.clone());
                    parts.push(pair);
                }
                None if non_empty(&audio) => parts.push(audio),
                None => {}
            }
        }
        if parts.is_empty() {
            return Err("Ingenting ble tatt opp.".to_string());
        }
        concat_file(&list, &parts)?;
        let mut cmd = ffmpeg_cmd(ffmpeg);
        cmd.args(["-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-y",
                  "-f", "concat", "-safe", "0", "-i"]).arg(&list);
        match (meta.kind, meta.final_ext.as_str()) {
            (Kind::Video, _) => cmd.args(["-c", "copy", "-movflags", "+faststart"]),
            (Kind::Audio, "wav") => cmd.args(["-vn", "-c:a", "pcm_s16le"]),
            (Kind::Audio, "m4a") => cmd.args(["-vn", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]),
            (Kind::Audio, _) => cmd.args(["-vn", "-c:a", "libmp3lame", "-b:a", "192k"]),
        };
        cmd.arg(&final_path);
        run_ffmpeg(cmd, duration, &progress)
    })();

    let _ = fs::remove_file(&list);
    for t in &temps {
        let _ = fs::remove_file(t);
    }
    if let Err(e) = result {
        let _ = fs::remove_file(&final_path);
        return Err(e);
    }
    let _ = fs::remove_file(raw_dir.join(format!("{}.json", meta.base)));
    if !meta.keep_raw {
        for s in &meta.segments {
            for f in s.video.iter().chain(std::iter::once(&s.audio)) {
                let _ = fs::remove_file(raw_dir.join(f));
            }
        }
    }
    Ok(final_path)
}

/// Finalizes recordings left behind by a crash. `skip` is the base name of an active session.
pub fn recover(ffmpeg: &Path, out_dir: &Path, skip: Option<&str>) -> Vec<(String, Result<PathBuf, String>)> {
    let raw_dir = out_dir.join(".raw");
    let Ok(entries) = fs::read_dir(&raw_dir) else { return vec![] };
    let mut results = vec![];
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let Some(mut meta) = fs::read_to_string(&p).ok().and_then(|s| serde_json::from_str::<Meta>(&s).ok()) else {
            continue;
        };
        if Some(meta.base.as_str()) == skip {
            continue;
        }
        let original = meta.base.clone();
        meta.out_dir = out_dir.to_path_buf();
        // Segment file names keep the original base; only the final file gets the new name.
        meta.base = unique_base(out_dir, &format!("{original}_gjenopprettet"), &meta.final_ext);
        let r = finalize(ffmpeg, &meta, Duration::ZERO, |_| {});
        let nothing_left = meta.segments.iter().all(|s| !non_empty(&raw_dir.join(&s.audio)) && s.video.as_ref().is_none_or(|v| !non_empty(&raw_dir.join(v))));
        if r.is_ok() || nothing_left {
            let _ = fs::remove_file(&p);
        }
        results.push((original, r));
    }
    results
}

impl Drop for Session {
    fn drop(&mut self) {
        self.end_segment();
    }
}
