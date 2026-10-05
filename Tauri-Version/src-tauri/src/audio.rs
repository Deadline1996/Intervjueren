//! Audio capture + mixing.
//!
//! Captures the microphone and/or system audio (WASAPI loopback of the default output device),
//! converts both to 48 kHz stereo f32, and mixes them on a wall-clock-paced thread. The mixed
//! stream is written as raw f32le into an optional sink (ffmpeg's stdin while recording).
//!
//! Pacing by wall clock matters: WASAPI loopback delivers *nothing* while no sound is playing,
//! so gaps are filled with silence instead of collapsing the timeline.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use std::collections::VecDeque;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub const RATE: u32 = 48_000;
const MAX_BUFFERED: usize = (RATE as usize / 4) * 2; // 250 ms of stereo samples

/// Where the mix goes (ffmpeg's stdin while a segment is recording).
#[derive(Default)]
pub struct SinkSlot {
    pub writer: Option<Box<dyn Write + Send>>,
}

pub type Sink = Arc<Mutex<SinkSlot>>;

/// Lock-free f32 cell for gains and meter peaks.
#[derive(Default)]
pub struct AtomicF32(AtomicU32);
impl AtomicF32 {
    pub fn new(v: f32) -> Self { Self(AtomicU32::new(v.to_bits())) }
    pub fn get(&self) -> f32 { f32::from_bits(self.0.load(Ordering::Relaxed)) }
    pub fn set(&self, v: f32) { self.0.store(v.to_bits(), Ordering::Relaxed) }
    pub fn take(&self) -> f32 { f32::from_bits(self.0.swap(0, Ordering::Relaxed)) }
    pub fn max(&self, v: f32) {
        let _ = self.0.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |b| {
            (v > f32::from_bits(b)).then(|| v.to_bits())
        });
    }
}

struct Source {
    buf: Mutex<VecDeque<f32>>, // interleaved stereo @ 48 kHz
    gain: Arc<AtomicF32>,
    peak: Arc<AtomicF32>,
}

pub struct AudioConfig {
    pub mic: Option<String>, // device name, or "default"
    pub loopback: bool,
    pub noise_suppression: bool,
    pub mic_gain: f32,
    pub sys_gain: f32,
}

pub struct AudioHandle {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    pub sink: Sink,
    pub sink_failed: Arc<AtomicBool>,
    pub mic_gain: Arc<AtomicF32>,
    pub sys_gain: Arc<AtomicF32>,
    pub mic_peak: Arc<AtomicF32>,
    pub sys_peak: Arc<AtomicF32>,
    pub mic_ok: bool,
    pub sys_ok: bool,
    pub warnings: Vec<String>,
}

impl Drop for AudioHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

pub fn list_inputs() -> Vec<String> {
    cpal::default_host()
        .input_devices()
        .map(|it| it.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default()
}

// ---------------------------------------------------------------- per-source processing

/// Linear resampler for interleaved frames (fine for speech / game audio monitoring).
struct Resampler {
    ratio: f64, // input frames per output frame
    pos: f64,
    prev: Vec<f32>,
    ch: usize,
}

impl Resampler {
    fn new(in_rate: u32, ch: usize) -> Self {
        Self { ratio: in_rate as f64 / RATE as f64, pos: 0.0, prev: vec![0.0; ch], ch }
    }
    fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if (self.ratio - 1.0).abs() < f64::EPSILON {
            out.extend_from_slice(input);
            return;
        }
        let ch = self.ch;
        let frames = input.len() / ch;
        if frames == 0 {
            return;
        }
        let get = |i: usize, c: usize, prev: &[f32]| if i == 0 { prev[c] } else { input[(i - 1) * ch + c] };
        while self.pos < frames as f64 {
            let i = self.pos.floor() as usize;
            let t = (self.pos - i as f64) as f32;
            for c in 0..ch {
                out.push(get(i, c, &self.prev) * (1.0 - t) + get(i + 1, c, &self.prev) * t);
            }
            self.pos += self.ratio;
        }
        self.pos -= frames as f64;
        self.prev.copy_from_slice(&input[(frames - 1) * ch..frames * ch]);
    }
}

/// Converts device-format frames into 48 kHz stereo and pushes them into the source buffer.
struct Pipeline {
    in_ch: usize,
    mono: bool, // mic: downmix to mono, process, then duplicate to stereo
    resampler: Resampler,
    denoise: Option<(Box<nnnoiseless::DenoiseState<'static>>, Vec<f32>)>,
    scratch: Vec<f32>,
    resampled: Vec<f32>,
}

impl Pipeline {
    fn new(in_ch: usize, in_rate: u32, mono: bool, denoise: bool) -> Self {
        let work_ch = if mono { 1 } else { 2 };
        Self {
            in_ch,
            mono,
            resampler: Resampler::new(in_rate, work_ch),
            denoise: (mono && denoise).then(|| (nnnoiseless::DenoiseState::new(), Vec::new())),
            scratch: Vec::new(),
            resampled: Vec::new(),
        }
    }

    fn push(&mut self, data: &[f32], src: &Source) {
        let ch = self.in_ch.max(1);
        self.scratch.clear();
        for frame in data.chunks_exact(ch) {
            if self.mono {
                self.scratch.push(frame.iter().sum::<f32>() / ch as f32);
            } else if ch == 1 {
                self.scratch.extend_from_slice(&[frame[0], frame[0]]);
            } else {
                self.scratch.extend_from_slice(&frame[..2]);
            }
        }
        self.resampled.clear();
        self.resampler.process(&self.scratch, &mut self.resampled);

        let mut buf = src.buf.lock().unwrap();
        if self.mono {
            if let Some((state, pending)) = self.denoise.as_mut() {
                // RNNoise works on 480-sample frames in i16 range.
                pending.extend(self.resampled.iter().map(|s| s * 32767.0));
                let mut out = [0f32; nnnoiseless::DenoiseState::FRAME_SIZE];
                let n = pending.len() / out.len() * out.len();
                for chunk in pending[..n].chunks_exact(out.len()) {
                    state.process_frame(&mut out, chunk);
                    for s in out {
                        let v = s / 32767.0;
                        buf.extend([v, v]);
                    }
                }
                pending.drain(..n);
            } else {
                for &v in &self.resampled {
                    buf.extend([v, v]);
                }
            }
        } else {
            buf.extend(self.resampled.iter().copied());
        }
        // Keep latency bounded if the mixer falls behind or a device clock runs fast.
        let len = buf.len();
        if len > MAX_BUFFERED {
            buf.drain(..len - MAX_BUFFERED);
        }
    }
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    mut pipeline: Pipeline,
    src: Arc<Source>,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let mut conv: Vec<f32> = Vec::new();
    device.build_input_stream(
        config,
        move |data: &[T], _| {
            conv.clear();
            conv.extend(data.iter().map(|&s| s.to_sample::<f32>()));
            pipeline.push(&conv, &src);
        },
        |err| eprintln!("audio stream error: {err}"),
        None,
    )
}

fn open(device: &cpal::Device, loopback: bool, mono: bool, denoise: bool, src: Arc<Source>) -> Result<cpal::Stream, String> {
    let supported = if loopback { device.default_output_config() } else { device.default_input_config() }
        .map_err(|e| e.to_string())?;
    let config: cpal::StreamConfig = supported.config();
    let pipeline = Pipeline::new(config.channels as usize, config.sample_rate.0, mono, denoise);
    let stream = match supported.sample_format() {
        SampleFormat::F32 => build_stream::<f32>(device, &config, pipeline, src),
        SampleFormat::I16 => build_stream::<i16>(device, &config, pipeline, src),
        SampleFormat::U16 => build_stream::<u16>(device, &config, pipeline, src),
        SampleFormat::I32 => build_stream::<i32>(device, &config, pipeline, src),
        f => return Err(format!("unsupported sample format {f:?}")),
    }
    .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(stream)
}

// ---------------------------------------------------------------- engine

pub fn start(cfg: AudioConfig) -> AudioHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let sink: Sink = Arc::new(Mutex::new(SinkSlot::default()));
    let sink_failed = Arc::new(AtomicBool::new(false));
    let mic_gain = Arc::new(AtomicF32::new(cfg.mic_gain));
    let sys_gain = Arc::new(AtomicF32::new(cfg.sys_gain));
    let mic_peak = Arc::new(AtomicF32::default());
    let sys_peak = Arc::new(AtomicF32::default());
    let (ready_tx, ready_rx) = mpsc::channel::<(bool, bool, Vec<String>)>();

    let thread = {
        let (stop, sink, sink_failed) = (stop.clone(), sink.clone(), sink_failed.clone());
        let mic_src = Arc::new(Source { buf: Mutex::default(), gain: mic_gain.clone(), peak: mic_peak.clone() });
        let sys_src = Arc::new(Source { buf: Mutex::default(), gain: sys_gain.clone(), peak: sys_peak.clone() });
        std::thread::Builder::new()
            .name("audio-mixer".into())
            .spawn(move || {
                // cpal streams are not Send, so they live on this thread for their whole life.
                let host = cpal::default_host();
                let mut streams = Vec::new();
                let mut warnings = Vec::new();
                let mut sources: Vec<Arc<Source>> = Vec::new();

                if let Some(name) = cfg.mic.as_deref() {
                    let dev = if name == "default" {
                        host.default_input_device()
                    } else {
                        host.input_devices().ok().and_then(|mut it| it.find(|d| d.name().ok().as_deref() == Some(name)))
                            .or_else(|| host.default_input_device())
                    };
                    match dev.ok_or_else(|| "fant ingen mikrofon".to_string())
                        .and_then(|d| open(&d, false, true, cfg.noise_suppression, mic_src.clone()))
                    {
                        Ok(s) => { streams.push(s); sources.push(mic_src.clone()); }
                        Err(e) => warnings.push(format!("Mikrofon: {e}")),
                    }
                }
                let mic_ok = !sources.is_empty();
                if cfg.loopback {
                    match host.default_output_device().ok_or_else(|| "fant ingen lydutgang".to_string())
                        .and_then(|d| open(&d, true, false, false, sys_src.clone()))
                    {
                        Ok(s) => { streams.push(s); sources.push(sys_src.clone()); }
                        Err(e) => warnings.push(format!("Systemlyd: {e}")),
                    }
                }
                let sys_ok = sources.len() > mic_ok as usize;
                let _ = ready_tx.send((mic_ok, sys_ok, warnings));

                // A source only plays once it has PRIME samples buffered, and re-primes after running dry
                // (e.g. loopback while the game is silent). That absorbs callback jitter without crackles.
                const PRIME: usize = (RATE as usize / 25) * 2; // 40 ms stereo
                let mut primed = vec![false; sources.len()];
                let started = Instant::now();
                let mut produced: u64 = 0;
                let mut mix: Vec<f32> = Vec::new();
                let mut bytes: Vec<u8> = Vec::new();
                while !stop.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(10));
                    let due = (started.elapsed().as_secs_f64() * RATE as f64) as u64;
                    let frames = due.saturating_sub(produced) as usize;
                    if frames == 0 {
                        continue;
                    }
                    produced = due;
                    mix.clear();
                    mix.resize(frames * 2, 0.0);
                    for (src, primed) in sources.iter().zip(primed.iter_mut()) {
                        let gain = src.gain.get();
                        let mut buf = src.buf.lock().unwrap();
                        if !*primed {
                            if buf.len() < PRIME {
                                continue;
                            }
                            *primed = true;
                        }
                        let n = buf.len().min(mix.len());
                        if n < mix.len() {
                            *primed = false;
                        }
                        let mut peak = 0f32;
                        for (m, v) in mix.iter_mut().zip(buf.drain(..n)) {
                            let v = v * gain;
                            peak = peak.max(v.abs());
                            *m += v;
                        }
                        src.peak.max(peak);
                    }
                    let mut slot = sink.lock().unwrap();
                    if let Some(w) = slot.writer.as_mut() {
                        bytes.clear();
                        for v in &mix {
                            bytes.extend_from_slice(&v.clamp(-1.0, 1.0).to_le_bytes());
                        }
                        if w.write_all(&bytes).is_err() {
                            slot.writer = None;
                            sink_failed.store(true, Ordering::Relaxed);
                        }
                    }
                }
                drop(streams);
            })
            .expect("spawn audio thread")
    };

    let (mic_ok, sys_ok, warnings) = ready_rx
        .recv_timeout(Duration::from_secs(5))
        .unwrap_or((false, false, vec!["Lydmotoren svarte ikke".into()]));
    AudioHandle { stop, thread: Some(thread), sink, sink_failed, mic_gain, sys_gain, mic_peak, sys_peak, mic_ok, sys_ok, warnings }
}

/// Peak amplitude → 0..1 meter position on a -60..0 dB scale.
pub fn meter(peak: f32) -> f32 {
    let db = 20.0 * peak.max(1e-6).log10();
    ((db + 60.0) / 60.0).clamp(0.0, 1.0)
}
