//! The mpv core: options, lifecycle, the single event thread, and the blocking command surface.
//! Nothing here touches Tauri windows; the native surface lives in `super::surface`.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use libmpv2::events::{Event, PropertyData};
use libmpv2::{Format, Mpv};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::error::{from_mpv, VideoError, VideoErrorCode};
use crate::log;

pub const EVENT_POSITION: &str = "video://position";
pub const EVENT_STATE: &str = "video://state";
pub const EVENT_ERROR: &str = "video://error";
pub const EVENT_PICTURE: &str = "video://picture";

const OPEN_TIMEOUT: Duration = Duration::from_secs(10);
const POSITION_EVENT_INTERVAL: Duration = Duration::from_millis(100);
const EVENT_POLL_SECONDS: f64 = 0.1;
/// How long shutdown waits for in-flight commands to release their mpv handle.
const SHUTDOWN_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

/// More external subtitle tracks than any document could have put there, so clearing them is a
/// loop that ends whatever mpv does.
const MAX_SUBTITLE_REMOVALS: usize = 16;

const OBSERVE_TIME_POS: u64 = 1;
const OBSERVE_PAUSE: u64 = 2;
const OBSERVE_SUB_TEXT: u64 = 3;

/// mpv defaults that would write files, read config, follow references or grab input are all
/// turned off explicitly rather than assumed. See CONTRIBUTING.md section 3 and the M0.2 design.
const SAFE_OPTIONS: &[(&str, &str)] = &[
    ("config", "no"),
    ("load-scripts", "no"),
    ("terminal", "no"),
    ("ytdl", "no"),
    ("save-position-on-quit", "no"),
    ("resume-playback", "no"),
    ("watch-later-options", ""),
    ("sub-auto", "no"),
    ("audio-file-auto", "no"),
    ("access-references", "no"),
    ("input-default-bindings", "no"),
    ("input-vo-keyboard", "no"),
    ("input-cursor", "no"),
    ("osd-level", "0"),
    ("keep-open", "yes"),
    // A machine with no working audio device still has a video to time subtitles against. mpv
    // defaults this to no, which ends the file when the device will not open: measured at
    // "finished playback, audio output initialization failed (reason 4)", about a second in. That
    // is N13. See BACKLOG.md N13 and N35.
    ("audio-fallback-to-null", "yes"),
    ("idle", "yes"),
    ("pause", "yes"),
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoOpened {
    pub path: String,
    pub duration: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlayerStatus {
    Idle,
    Loading,
    Ready,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoPlayerState {
    pub status: PlayerStatus,
    pub path: Option<String>,
    pub duration: Option<f64>,
    pub paused: bool,
}

impl VideoPlayerState {
    fn idle() -> Self {
        Self {
            status: PlayerStatus::Idle,
            path: None,
            duration: None,
            paused: true,
        }
    }
}

/// One audio track of the open media, as mpv reports it. mpv is the authority on which one is
/// playing (decision 24 E2), so `playing` comes from `track-list` and from nothing else.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrack {
    /// mpv's own `aid`, which is what switching a track sets.
    pub id: i64,
    /// ffmpeg's index for the stream, which is what an extraction maps with `-map 0:n`.
    pub ff_index: u32,
    /// The stream's language tag, when the file carries one.
    pub lang: Option<String>,
    pub title: Option<String>,
    pub playing: bool,
}

/// One subtitle stream the open media carries inside it, as `track-list` reports it.
///
/// Every field mpv gives is kept and none is judged here: which codecs hold text a document can be
/// made from is the subtitle side's question, not the player's. See N116.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleTrack {
    /// mpv's own `sid`.
    pub id: i64,
    /// ffmpeg's index for the stream, which is what an extraction maps with `-map 0:n`.
    pub ff_index: u32,
    /// mpv's codec name, `subrip` or `ass` or a picture codec, lower case as mpv writes it.
    pub codec: String,
    pub lang: Option<String>,
    pub title: Option<String>,
}

/// What mpv reports about the subtitles it is drawing, read back from mpv rather than remembered
/// here: mpv is the authority on its own track list, as it is on which audio track plays.
#[derive(Clone, Copy, Debug)]
pub struct SubtitlesDrawn {
    /// External subtitle tracks mpv holds. More than one means a rewrite added a track instead of
    /// re-reading the one already there.
    pub tracks: usize,
    /// Whether the one loaded from the path just given is the track mpv draws.
    pub selected: bool,
    pub visible: bool,
    /// Characters in the line mpv has at the playhead, or none where no line covers it. The line
    /// itself stays out of here: a subtitle line is the user's own writing.
    pub chars: Option<usize>,
    /// Where the playhead was when `chars` was read, or none when mpv would not say. Without it
    /// "no line at the playhead" cannot be told from "the playhead is somewhere no line covers",
    /// which are two defects with two cures (N102).
    pub at: Option<f64>,
}

/// What the details dialog reads off the open media. Every field but the path is optional: a
/// container that does not carry a number is said to not carry it, never guessed at.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoDetails {
    pub path: String,
    pub fps: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub frames: Option<i64>,
    pub duration: Option<f64>,
    pub codec: Option<String>,
}

/// One external subtitle track, as `track-list` reports it.
struct ExternalSubtitle {
    id: i64,
    selected: bool,
    /// Where mpv read it from, which is the path `sub-add` was given.
    filename: String,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PositionPayload {
    position: f64,
}

/// The box the picture fills, in pixels, with the file's pixel aspect and its rotation both in it.
/// Built from mpv's `dwidth` and `dheight` by `read_picture`; the storage size is a different
/// number and is wrong for anamorphic and rotated media. See docs/video-aspect-tasks.md.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PictureSize {
    pub width: i64,
    pub height: i64,
}

/// Absence is `None` and never a zero size: a cap computed from a zero-wide picture is a cap of
/// zero, so the block would collapse instead of falling back. See docs/video-aspect-tasks.md.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PicturePayload {
    picture: Option<PictureSize>,
}

/// The box a picture of this display size fills once `rotate`, the quarter turn the output still
/// owes it, has been made. A zero is no box for a picture to fill, so it reads as absence.
fn drawn_box(width: i64, height: i64, rotate: Option<i64>) -> Option<PictureSize> {
    let (width, height) = match rotate {
        Some(90) | Some(270) => (height, width),
        _ => (width, height),
    };
    (width > 0 && height > 0).then_some(PictureSize { width, height })
}

/// The box mpv draws the picture in, read as one set so its parts can never come from different
/// files. Absent for a media with no picture and until the first frame is decoded.
///
/// Every part is taken from `video-out-params`, which is what the output says it will draw, so the
/// size and the turn describe one state: the turn is the one the output has still to make, and it
/// is zero exactly when the size is already turned.
///
/// **And the size has to agree with the aspect it is drawn at before it is worth reporting.** On a
/// machine slow enough to send two reconfigures for one file, the first carries the frame as stored
/// while the aspect that stretches it has not arrived, so an anamorphic file reads 640 by 360 for
/// one event and 1280 by 360 afterwards. Reading the aspect too and refusing a pair that does not
/// match it turns that event into no event, which is what the interface wants: it holds no number
/// until there is a right one. See docs/video-aspect-tasks.md and BACKLOG N36.
/// Whether a drawn size is the one that aspect describes, within the pixel that rounding a ratio
/// into whole pixels costs. A pair mpv has not finished reconfiguring misses by the whole aspect.
/// An aspect that is not a number says nothing, so it agrees with everything.
fn size_agrees_with_aspect(width: i64, height: i64, aspect: f64) -> bool {
    if !aspect.is_finite() || aspect <= 0.0 || height <= 0 {
        return true;
    }
    let drawn = width as f64;
    let tall = height as f64;
    (drawn - tall * aspect).abs() <= 1.0
}

fn read_picture(mpv: &Mpv) -> Option<PictureSize> {
    let width = mpv.get_property::<i64>("video-out-params/dw").ok()?;
    let height = mpv.get_property::<i64>("video-out-params/dh").ok()?;
    if let Ok(aspect) = mpv.get_property::<f64>("video-out-params/aspect") {
        if !size_agrees_with_aspect(width, height, aspect) {
            return None;
        }
    }
    drawn_box(
        width,
        height,
        mpv.get_property::<i64>("video-out-params/rotate").ok(),
    )
}

/// How the mpv core is wired to its output. `headless` exists for the integration tests;
/// it is never reachable over IPC.
pub struct PlayerConfig {
    pub wid: Option<i64>,
    pub headless: bool,
}

impl PlayerConfig {
    pub fn headless() -> Self {
        Self {
            wid: None,
            headless: true,
        }
    }

    pub fn embedded(wid: i64) -> Self {
        Self {
            wid: Some(wid),
            headless: false,
        }
    }
}

/// State the command threads and the event thread both reach.
struct Shared {
    app: Option<AppHandle>,
    state: Mutex<VideoPlayerState>,
    pending_open: Mutex<Option<SyncSender<Result<f64, VideoError>>>>,
    /// The last pause this app asked mpv for. A `pause` that arrives while this is false is one
    /// nobody here wanted, and BACKLOG N13 is exactly that going unrecorded.
    asked_paused: AtomicBool,
    /// Where a range playback stops, in seconds, or nothing. mpv has no "play to here and pause":
    /// its A-B loop repeats or is ignored, and its own issue 9716 answers the same question by
    /// watching `time-pos`. The event thread does that, and it sees every frame.
    stop_at: Mutex<Option<f64>>,
    /// The box the picture fills, as the interface was last told it. The event thread is the only
    /// writer; `Player::picture` reads it for callers that have no `AppHandle`.
    picture: Mutex<Option<PictureSize>>,
    /// Set when a preview refresh found `sub-text` absent or empty, which is mpv not having drawn
    /// the line yet rather than there being none. The event thread clears it the first time the
    /// property arrives with words in it, and asks for one more refresh then. Bounded on purpose:
    /// `sub-text` changes on every line during playback, and refreshing per line would be far too
    /// much. See BACKLOG.md N92.
    awaiting_sub_text: AtomicBool,
    /// Held across a whole transport gesture. Play, pause, seek and a range each touch `stop_at`
    /// and mpv's `pause`, and interleaved they can undo one another: a pause that lands between a
    /// range setting its target and starting playback leaves the picture running with nowhere to
    /// stop. Measured on the runner, where it ran to the end of the file. See BACKLOG.md N171.
    transport: Mutex<()>,
}

impl Shared {
    fn emit_state(&self) {
        let Ok(state) = self.state.lock() else {
            return;
        };
        let payload = state.clone();
        drop(state);
        if let Some(app) = &self.app {
            let _ = app.emit(EVENT_STATE, payload);
        }
    }

    fn emit_position(&self, position: f64) {
        if let Some(app) = &self.app {
            let _ = app.emit(EVENT_POSITION, PositionPayload { position });
        }
    }

    /// Tell the interface the drawn size, and only when it moved. mpv reconfigures its output
    /// several times per file and the shape almost never changes, so most calls send nothing.
    fn tell_picture(&self, size: Option<PictureSize>) {
        let Ok(mut told) = self.picture.lock() else {
            return;
        };
        if *told == size {
            return;
        }
        *told = size;
        drop(told);
        // One line per file, so the box is in the log an owner reads by hand. The absence is said
        // at FileLoaded instead, which is where mpv can tell no picture from one not decoded yet.
        if let Some(size) = size {
            log::info!(
                "video: the picture is drawn {} by {}",
                size.width,
                size.height
            );
        }
        if let Some(app) = &self.app {
            let _ = app.emit(EVENT_PICTURE, PicturePayload { picture: size });
            // What is on the frame is worth saying once there is a frame. `video::open` refreshes
            // the preview when its task resolves, which on a slow machine is before mpv has drawn
            // anything, so mpv answered "no line at the playhead" and nothing ever asked again
            // (N88). Off this thread, because a refresh sends commands back into mpv and this is
            // mpv's own event thread. Only on a picture arriving: a size going to `None` is a file
            // closing, and there is nothing to draw a document on.
            if size.is_some() {
                let handle = app.clone();
                tauri::async_runtime::spawn_blocking(move || crate::preview::refresh_now(&handle));
            }
        }
    }

    fn emit_error(&self, error: &VideoError) {
        crate::log::error!("player error {:?}: {}", error.code, error.detail);
        if let Some(app) = &self.app {
            let _ = app.emit(EVENT_ERROR, error.clone());
        }
    }

    /// Hand the outcome of a load to whoever is blocked in `Player::open`.
    fn resolve_open(&self, outcome: Result<f64, VideoError>) -> bool {
        let Ok(mut pending) = self.pending_open.lock() else {
            return false;
        };
        match pending.take() {
            Some(sender) => {
                let _ = sender.send(outcome);
                true
            }
            None => false,
        }
    }
}

pub struct Player {
    /// `None` once shut down, which is what makes every later command fail fast.
    mpv: Mutex<Option<Arc<Mpv>>>,
    shared: Arc<Shared>,
    stop: Arc<AtomicBool>,
    event_thread: Mutex<Option<JoinHandle<()>>>,
    /// Set once mpv_destroy has really run, so a second `shutdown` reports the same verdict.
    core_destroyed: AtomicBool,
}

/// The context Sublore asks for when it hands mpv a `wid`, and the one a rejected override falls
/// back to.
#[cfg(target_os = "linux")]
const GPU_CONTEXT_PIN: &str = "x11egl";

/// The X11 context mpv is asked to use, and where that choice came from.
///
/// Pure so it can be tested without touching the process environment: `requested_gpu_context` is
/// the one line that reads it.
#[cfg(target_os = "linux")]
fn gpu_context_from(
    value: Option<&std::ffi::OsStr>,
) -> (std::borrow::Cow<'static, str>, &'static str) {
    const DEFAULT: &str = GPU_CONTEXT_PIN;
    match value {
        // An empty value falls through to the default, the same reading `SUBLORE_WEBKIT_WORKAROUNDS`
        // settled in main.rs: two hatches with one prefix must not disagree about one input.
        Some(raw) => match raw.to_str() {
            Some(name) if !name.trim().is_empty() => (
                std::borrow::Cow::Owned(name.trim().to_owned()),
                "SUBLORE_MPV_GPU_CONTEXT",
            ),
            Some(_) => (
                std::borrow::Cow::Borrowed(DEFAULT),
                "default, the variable was empty",
            ),
            // Reported rather than shown as unset: a variable that is set and unreadable is a
            // different fact from one nobody set (gate 2, the OsString lesson of `startup_files`).
            None => (
                std::borrow::Cow::Borrowed(DEFAULT),
                "default, the variable was not valid Unicode",
            ),
        },
        None => (std::borrow::Cow::Borrowed(DEFAULT), "default"),
    }
}

#[cfg(target_os = "linux")]
fn requested_gpu_context() -> (std::borrow::Cow<'static, str>, &'static str) {
    gpu_context_from(std::env::var_os("SUBLORE_MPV_GPU_CONTEXT").as_deref())
}

impl Player {
    pub fn new(config: PlayerConfig, app: Option<AppHandle>) -> Result<Self, VideoError> {
        force_c_numeric_locale()?;

        let mpv = Mpv::with_initializer(|init| {
            for (name, value) in SAFE_OPTIONS {
                init.set_option(name, *value)?;
            }
            if config.headless {
                init.set_option("vo", "null")?;
                init.set_option("ao", "null")?;
            }
            if let Some(wid) = config.wid {
                init.set_option("wid", wid)?;
                #[cfg(target_os = "linux")]
                {
                    // `wid` is an X11 window id, and mpv's `gpu-context=auto` picks Wayland over it
                    // when a Wayland display is in the environment.
                    let (context, source) = requested_gpu_context();
                    // Tried, not imposed, and twice: a name from the hatch that mpv rejects falls
                    // back to the pin, and a pin mpv rejects leaves the user an application rather
                    // than an error. See BACKLOG N2b.
                    if let Err(error) = init.set_option("gpu-context", context.as_ref()) {
                        let can_fall_back = context.as_ref() != GPU_CONTEXT_PIN;
                        crate::log::warn!(
                            "video: mpv refused gpu-context={context} ({source}): {error}"
                        );
                        if !can_fall_back
                            || init.set_option("gpu-context", GPU_CONTEXT_PIN).is_err()
                        {
                            crate::log::warn!(
                                "video: no gpu-context pinned; if the video area stays black, this is why"
                            );
                        } else {
                            // Said, not left silent: only the failure was logged, so a support log
                            // could not tell a pin in force from no pin at all (N78).
                            crate::log::info!(
                                "video: gpu-context fell back to {GPU_CONTEXT_PIN}"
                            );
                        }
                    }
                }
            }
            Ok(())
        })
        .map_err(|error| from_mpv(error, "mpv initialisation"))?;

        mpv.observe_property("time-pos", Format::Double, OBSERVE_TIME_POS)
            .map_err(|error| from_mpv(error, "observe time-pos"))?;
        mpv.observe_property("sub-text", Format::String, OBSERVE_SUB_TEXT)
            .map_err(|error| from_mpv(error, "observe sub-text"))?;
        mpv.observe_property("pause", Format::Flag, OBSERVE_PAUSE)
            .map_err(|error| from_mpv(error, "observe pause"))?;

        let mpv = Arc::new(mpv);
        let shared = Arc::new(Shared {
            app,
            state: Mutex::new(VideoPlayerState::idle()),
            pending_open: Mutex::new(None),
            // Nothing is loaded yet, so nothing has been asked to play.
            asked_paused: AtomicBool::new(true),
            stop_at: Mutex::new(None),
            picture: Mutex::new(None),
            // Nothing has asked for a line yet.
            awaiting_sub_text: AtomicBool::new(false),
            transport: Mutex::new(()),
        });
        let stop = Arc::new(AtomicBool::new(false));

        let event_thread = std::thread::Builder::new()
            .name("sublore-mpv-events".to_owned())
            .spawn({
                let mpv = Arc::clone(&mpv);
                let shared = Arc::clone(&shared);
                let stop = Arc::clone(&stop);
                move || event_loop(&mpv, &shared, &stop)
            })
            .map_err(|error| {
                VideoError::player_unavailable(format!("could not start the event thread: {error}"))
            })?;

        Ok(Self {
            mpv: Mutex::new(Some(mpv)),
            shared,
            stop,
            event_thread: Mutex::new(Some(event_thread)),
            core_destroyed: AtomicBool::new(false),
        })
    }

    /// Load a file, paused at position 0, and wait for mpv's verdict.
    pub fn open(&self, path: &str) -> Result<VideoOpened, VideoError> {
        let target = validate_path(path)?;

        // Taking the handle and arming the channel under one lock is what stops `shutdown` from
        // slipping between them and leaving this call waiting on a stopped event thread. See M0.2.
        let (mpv, receiver) = {
            let guard = self
                .mpv
                .lock()
                .map_err(|_| VideoError::player_unavailable("player lock poisoned"))?;
            let mpv = guard
                .clone()
                .ok_or_else(|| VideoError::player_unavailable("the player is not running"))?;
            let mut pending = self
                .shared
                .pending_open
                .lock()
                .map_err(|_| VideoError::player_unavailable("pending open lock poisoned"))?;
            if pending.is_some() {
                return Err(VideoError::command_failed(
                    "another open is already in progress",
                ));
            }
            let (sender, receiver) = sync_channel(1);
            *pending = Some(sender);
            (mpv, receiver)
        };

        self.set_state(|state| {
            state.status = PlayerStatus::Loading;
            state.path = Some(target.clone());
            state.duration = None;
            state.paused = true;
        })?;
        self.shared.emit_state();

        // A file opens stopped, and that is a pause this app asked for.
        self.shared.asked_paused.store(true, Ordering::Relaxed);
        let issued = mpv
            .set_property("pause", true)
            .and_then(|()| mpv.command("loadfile", &[&target]));
        if let Err(error) = issued {
            self.shared
                .resolve_open(Err(VideoError::command_failed("loadfile")));
            self.reset_to_idle();
            return Err(from_mpv(error, "loadfile"));
        }

        // loadfile returns Ok even for a file mpv cannot play; the verdict arrives on the event queue.
        let outcome = receiver.recv_timeout(OPEN_TIMEOUT);
        let _ = self
            .shared
            .pending_open
            .lock()
            .map(|mut pending| pending.take());

        match outcome {
            Ok(Ok(duration)) => {
                self.set_state(|state| {
                    state.status = PlayerStatus::Ready;
                    state.duration = Some(duration);
                    state.paused = true;
                })?;
                self.shared.emit_state();
                Ok(VideoOpened {
                    path: target,
                    duration,
                })
            }
            Ok(Err(error)) => {
                self.reset_to_idle();
                Err(error)
            }
            Err(RecvTimeoutError::Timeout) => {
                self.reset_to_idle();
                Err(VideoError::new(VideoErrorCode::OpenTimeout, target))
            }
            Err(RecvTimeoutError::Disconnected) => {
                self.reset_to_idle();
                Err(VideoError::player_unavailable(
                    "the player stopped while opening",
                ))
            }
        }
    }

    pub fn play(&self) -> Result<(), VideoError> {
        let _gesture = self.gesture();
        self.clear_stop();
        self.set_pause(false)
    }

    pub fn pause(&self) -> Result<(), VideoError> {
        let _gesture = self.gesture();
        self.clear_stop();
        self.set_pause(true)
    }

    /// Take the transport for one gesture. A poisoned lock means an earlier gesture panicked, and
    /// serialising after that is still better than not serialising at all.
    fn gesture(&self) -> std::sync::MutexGuard<'_, ()> {
        self.shared
            .transport
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Play from one second to another, then pause. Both are absolute, and both are clamped into
    /// the file the way a seek is.
    ///
    /// It talks to mpv itself rather than through `seek` and `play`, which clear the target: those
    /// three exist so that anything the user does during a range cancels its stop instead of
    /// leaving one armed. Setting the target before playback starts is the other half of that: a
    /// frame cannot slip past a target that is not there yet.
    /// One line per range asked for, the twin of the one `set_pause` writes. Without it the only
    /// trace a range leaves is the line it writes when it stops, so a range that never stopped and
    /// a range that never started read exactly the same from outside: measured on 2026-09-12,
    /// where a CI failure could not be told apart for that reason. See BACKLOG.md N163.
    pub fn play_range(&self, from: f64, to: f64) -> Result<(), VideoError> {
        log::info!("playback: asked mpv for the range {from:.3} to {to:.3}");
        let _gesture = self.gesture();
        let mpv = self.handle()?;
        let duration = self.loaded_duration()?;
        if !from.is_finite() || !to.is_finite() {
            return Err(VideoError::command_failed("a range bound is not a number"));
        }
        let start = from.clamp(0.0, duration);
        let end = to.clamp(start, duration);
        if let Ok(mut target) = self.shared.stop_at.lock() {
            *target = Some(end);
        }
        mpv.command("seek", &[&format!("{start}"), "absolute"])
            .map_err(|error| from_mpv(error, "seek"))?;
        self.shared.asked_paused.store(false, Ordering::Relaxed);
        mpv.set_property("pause", false)
            .map_err(|error| from_mpv(error, "pause"))
    }

    /// Forget where a range was going to stop. Anything the user asks for cancels it.
    fn clear_stop(&self) {
        if let Ok(mut target) = self.shared.stop_at.lock() {
            *target = None;
        }
    }

    /// Absolute seconds from the start, clamped into the file's range.
    pub fn seek(&self, position: f64) -> Result<(), VideoError> {
        let _gesture = self.gesture();
        let mpv = self.handle()?;
        let duration = self.loaded_duration()?;
        if !position.is_finite() {
            return Err(VideoError::command_failed("seek position is not a number"));
        }
        let target = position.clamp(0.0, duration);
        self.clear_stop();
        mpv.command("seek", &[&format!("{target}"), "absolute"])
            .map_err(|error| from_mpv(error, "seek"))
    }

    pub fn position(&self) -> Result<f64, VideoError> {
        let mpv = self.handle()?;
        mpv.get_property::<f64>("time-pos")
            .map_err(|error| from_mpv(error, "time-pos"))
    }

    /// The box the picture fills, or nothing when the media has none and while the first frame of
    /// one is still undecoded. The same value the interface is sent on `video://picture`.
    pub fn picture(&self) -> Option<PictureSize> {
        self.shared.picture.lock().ok().and_then(|told| *told)
    }

    pub fn paused(&self) -> Result<bool, VideoError> {
        let mpv = self.handle()?;
        mpv.get_property::<bool>("pause")
            .map_err(|error| from_mpv(error, "pause"))
    }

    /// The file that is open, or nothing when none is. `Loading` is not open: a peak job started
    /// against a file mpv has not finished loading would be peaking the file before it. See
    /// BACKLOG.md M2.4, W4.
    pub fn loaded_path(&self) -> Option<String> {
        let state = self.state().ok()?;
        match state.status {
            PlayerStatus::Ready => state.path.clone(),
            PlayerStatus::Idle | PlayerStatus::Loading => None,
        }
    }

    /// The open media's audio tracks, in mpv's own order, with the playing one marked.
    ///
    /// Read property by property rather than as one node: libmpv2 hands back scalars, and the six
    /// fields below are the whole of what the waveform and the Audio menu need. See M2.4, W4.
    pub fn audio_tracks(&self) -> Result<Vec<AudioTrack>, VideoError> {
        let mpv = self.handle()?;
        // No file open is not an empty track list, and the caller has to be able to tell them
        // apart: one is "this media has no audio", the other is "there is no media".
        self.loaded_duration()?;

        let count = mpv
            .get_property::<i64>("track-list/count")
            .map_err(|error| from_mpv(error, "track-list/count"))?;
        let mut tracks = Vec::new();
        for index in 0..count.max(0) {
            let kind = mpv
                .get_property::<String>(&format!("track-list/{index}/type"))
                .map_err(|error| from_mpv(error, "track-list type"))?;
            if kind != "audio" {
                continue;
            }
            let id = mpv
                .get_property::<i64>(&format!("track-list/{index}/id"))
                .map_err(|error| from_mpv(error, "track-list id"))?;
            let ff_index = mpv
                .get_property::<i64>(&format!("track-list/{index}/ff-index"))
                .map_err(|error| from_mpv(error, "track-list ff-index"))?;
            // ffmpeg is mapped by this number, so one that is not a stream index is refused here
            // rather than turned into a `-map` argument nothing can satisfy.
            let ff_index = u32::try_from(ff_index).map_err(|_| {
                VideoError::command_failed(format!(
                    "mpv reported ff-index {ff_index} for audio track {id}"
                ))
            })?;
            tracks.push(AudioTrack {
                id,
                ff_index,
                // A file with no language tag has no `lang` property; that is absence, not
                // failure, so it is read as None rather than propagated.
                lang: mpv
                    .get_property::<String>(&format!("track-list/{index}/lang"))
                    .ok(),
                title: mpv
                    .get_property::<String>(&format!("track-list/{index}/title"))
                    .ok(),
                playing: mpv
                    .get_property::<bool>(&format!("track-list/{index}/selected"))
                    .map_err(|error| from_mpv(error, "track-list selected"))?,
            });
        }
        Ok(tracks)
    }

    /// The subtitle streams the open media carries inside it, in mpv's own order.
    ///
    /// External tracks are left out: they came from a file the user already has, and the command
    /// this feeds exists to reach the ones only the container holds. Read property by property for
    /// the reason [`Self::audio_tracks`] gives. See N116.
    pub fn embedded_subtitle_tracks(&self) -> Result<Vec<SubtitleTrack>, VideoError> {
        let mpv = self.handle()?;
        // No file open is not an empty track list, the same distinction the audio list draws.
        self.loaded_duration()?;

        let count = mpv
            .get_property::<i64>("track-list/count")
            .map_err(|error| from_mpv(error, "track-list/count"))?;
        let mut tracks = Vec::new();
        for index in 0..count.max(0) {
            let kind = mpv
                .get_property::<String>(&format!("track-list/{index}/type"))
                .map_err(|error| from_mpv(error, "track-list type"))?;
            if kind != "sub" {
                continue;
            }
            // A track Sublore itself added with `sub-add` is external and is skipped here.
            if mpv
                .get_property::<bool>(&format!("track-list/{index}/external"))
                .unwrap_or(false)
            {
                continue;
            }
            let id = mpv
                .get_property::<i64>(&format!("track-list/{index}/id"))
                .map_err(|error| from_mpv(error, "track-list id"))?;
            let ff_index = mpv
                .get_property::<i64>(&format!("track-list/{index}/ff-index"))
                .map_err(|error| from_mpv(error, "track-list ff-index"))?;
            // Skipped rather than refused, which is where this parts from the audio list: that one
            // is asked for one named track and has to say it cannot have it, and this one is asked
            // which tracks can be opened, so a track with no stream index behind it is simply not
            // one of them and the rest of the list still is.
            let Ok(ff_index) = u32::try_from(ff_index) else {
                crate::log::debug!(
                    "video: subtitle track {id} has ff-index {ff_index}, which is no stream index"
                );
                continue;
            };
            // A container that names no codec is a track nothing can be extracted from, so it is
            // reported with an empty name and the caller's allow list drops it.
            let codec = mpv
                .get_property::<String>(&format!("track-list/{index}/codec"))
                .unwrap_or_default();
            tracks.push(SubtitleTrack {
                id,
                ff_index,
                codec,
                lang: mpv
                    .get_property::<String>(&format!("track-list/{index}/lang"))
                    .ok(),
                title: mpv
                    .get_property::<String>(&format!("track-list/{index}/title"))
                    .ok(),
            });
        }
        Ok(tracks)
    }

    /// Deterministic and idempotent. Order matters: no new handles, then stop the event thread,
    /// then destroy the core. Reports whether the core is actually gone, which is what callers
    /// need before they destroy the native surface it was drawing into.
    #[must_use]
    pub fn shutdown(&self) -> bool {
        // Same lock order as `open`, so an open racing this either finds a live player or never
        // arms its channel. Dropping the sender releases anyone already blocked there. See M0.2.
        let mpv = {
            let mut guard = match self.mpv.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            let taken = guard.take();
            match self.shared.pending_open.lock() {
                Ok(mut pending) => drop(pending.take()),
                Err(poisoned) => drop(poisoned.into_inner().take()),
            }
            taken
        };

        self.stop.store(true, Ordering::Relaxed);
        let thread = match self.event_thread.lock() {
            Ok(mut guard) => guard.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        };
        if let Some(thread) = thread {
            let _ = thread.join();
        }

        if let Some(mpv) = mpv {
            // mpv_destroy must run here, so wait for in-flight commands to drop their clones.
            let deadline = Instant::now() + SHUTDOWN_DRAIN_TIMEOUT;
            while Arc::strong_count(&mpv) > 1 && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            // Only dropping the last clone runs mpv_destroy; a straggler means the core outlives
            // this call, so the surface has to stay. See M0.2.
            let destroyed = Arc::strong_count(&mpv) == 1;
            drop(mpv);
            self.core_destroyed.store(destroyed, Ordering::Release);
        }
        self.core_destroyed.load(Ordering::Acquire)
    }

    fn handle(&self) -> Result<Arc<Mpv>, VideoError> {
        let guard = self
            .mpv
            .lock()
            .map_err(|_| VideoError::player_unavailable("player lock poisoned"))?;
        guard
            .clone()
            .ok_or_else(|| VideoError::player_unavailable("the player is not running"))
    }

    fn state(&self) -> Result<MutexGuard<'_, VideoPlayerState>, VideoError> {
        self.shared
            .state
            .lock()
            .map_err(|_| VideoError::player_unavailable("state lock poisoned"))
    }

    fn set_state(&self, update: impl FnOnce(&mut VideoPlayerState)) -> Result<(), VideoError> {
        let mut state = self.state()?;
        update(&mut state);
        Ok(())
    }

    fn reset_to_idle(&self) {
        if self
            .set_state(|state| *state = VideoPlayerState::idle())
            .is_ok()
        {
            self.shared.emit_state();
        }
        // An open that never reached mpv leaves no StartFile behind, so the picture is cleared
        // here too: nothing is on screen after a failed open.
        self.shared.tell_picture(None);
    }

    /// Unload the open media and leave the player running.
    ///
    /// `stop` and not a shutdown: the window keeps its surface and the next open costs no new
    /// process, which is what closing a video means here. Everything the interface draws about the
    /// media follows the state and the picture, so both are cleared before this answers.
    pub fn close(&self) -> Result<(), VideoError> {
        let mpv = self.handle()?;
        mpv.command("stop", &[])
            .map_err(|error| from_mpv(error, "stop"))?;
        // The same reset a failed open does, which is the whole of what the interface reads: the
        // state says idle, the state is told, and the picture goes.
        self.reset_to_idle();
        Ok(())
    }

    /// Move the picture by whole frames, forward or back.
    ///
    /// One frame either way is mpv's own step, which lands exactly on the next decoded frame. More
    /// than one is a relative seek of that many frames at the media's own rate, because mpv has no
    /// command for stepping several and calling the one-frame step in a loop would decode each of
    /// them. A picture that is playing is left alone, which is what the reference does: the keys
    /// are for looking at a still. See interface-spec 10.5.
    pub fn step(&self, frames: i64) -> Result<(), VideoError> {
        let mpv = self.handle()?;
        self.loaded_duration()?;
        if !self.state()?.paused || frames == 0 {
            return Ok(());
        }
        // Forward is mpv's own step, which lands on the next decoded frame. Backwards is a seek of
        // one frame at the media's rate: mpv's `frame-back-step` needs to decode backwards and,
        // measured here, sometimes leaves the picture where it was. See N45.
        if frames == 1 {
            return mpv
                .command("frame-step", &[])
                .map_err(|error| from_mpv(error, "frame-step"));
        }
        let rate = self.frame_rate()?;
        let seconds = frames as f64 / rate;
        mpv.command("seek", &[&format!("{seconds}"), "relative+exact"])
            .map_err(|error| from_mpv(error, "seek"))
    }

    /// How many frames a second the open media runs at, as the container says or as the output
    /// estimates. A media that will not say is one this cannot count frames on.
    fn frame_rate(&self) -> Result<f64, VideoError> {
        let mpv = self.handle()?;
        let rate = mpv
            .get_property::<f64>("container-fps")
            .ok()
            .or_else(|| mpv.get_property::<f64>("estimated-vf-fps").ok())
            .filter(|rate| rate.is_finite() && *rate > 0.0);
        rate.ok_or_else(|| {
            VideoError::new(
                VideoErrorCode::CommandFailed,
                "this media does not say how many frames a second it runs at",
            )
        })
    }

    /// What the open media is, for the details dialog. See interface-spec 9.9.
    pub fn details(&self) -> Result<VideoDetails, VideoError> {
        let mpv = self.handle()?;
        // Nothing loaded is not a media with nothing to say about it, so it is an error and not an
        // answer full of empty fields.
        self.loaded_duration()?;
        let path = self.loaded_path().unwrap_or_default();
        Ok(VideoDetails {
            path,
            fps: mpv.get_property::<f64>("container-fps").ok(),
            width: mpv.get_property::<i64>("width").ok(),
            height: mpv.get_property::<i64>("height").ok(),
            frames: mpv.get_property::<i64>("estimated-frame-count").ok(),
            duration: mpv.get_property::<f64>("duration").ok(),
            codec: mpv.get_property::<String>("video-codec").ok(),
        })
    }

    fn loaded_duration(&self) -> Result<f64, VideoError> {
        let state = self.state()?;
        match (state.status, state.duration) {
            (PlayerStatus::Ready, Some(duration)) => Ok(duration),
            _ => Err(VideoError::new(
                VideoErrorCode::NotLoaded,
                "no file is open",
            )),
        }
    }

    /// Switch which audio track mpv plays. `aid` is mpv's own numbering, which is what the track
    /// list reports as `id`.
    pub fn set_audio_track(&self, id: i64) -> Result<(), VideoError> {
        let mpv = self.handle()?;
        self.loaded_duration()?;
        mpv.set_property("aid", id)
            .map_err(|error| from_mpv(error, "aid"))
    }

    /// Make `path` the one external subtitle track mpv draws, and say what mpv reports afterwards.
    ///
    /// A track already loaded from this path is re-read in place with `sub-reload`; adding it again
    /// would leave the old one behind and stack one track per edit. `reread` is false when the file
    /// on disk has not changed, so a View toggle does not make mpv read it again for nothing.
    pub fn show_subtitles(
        &self,
        path: &Path,
        reread: bool,
        visible: bool,
    ) -> Result<SubtitlesDrawn, VideoError> {
        let mpv = self.handle()?;
        // Nothing is loaded, so there is no frame to draw on: mpv refuses `sub-add` outright there.
        self.loaded_duration()?;
        let wanted = mpv_path(path);

        // Any other external track is a shadow from before: the document changed format, so its
        // file has a different extension and the old one would stay loaded beside the new one.
        for stale in external_subtitles(&mpv)?
            .into_iter()
            .filter(|track| track.filename != wanted)
        {
            mpv.command("sub-remove", &[&stale.id.to_string()])
                .map_err(|error| from_mpv(error, "sub-remove"))?;
        }

        let added = match external_subtitles(&mpv)?
            .into_iter()
            .find(|track| track.filename == wanted)
        {
            Some(track) if reread => {
                mpv.command("sub-reload", &[&track.id.to_string()])
                    .map_err(|error| from_mpv(error, "sub-reload"))?;
                false
            }
            Some(_) => false,
            None => {
                mpv.command("sub-add", &[&wanted, "select"])
                    .map_err(|error| from_mpv(error, "sub-add"))?;
                true
            }
        };

        mpv.set_property("sub-visibility", visible)
            .map_err(|error| from_mpv(error, "sub-visibility"))?;
        self.draw_the_paused_frame(&mpv, added);
        let tracks = external_subtitles(&mpv)?;
        // No line covering the playhead has no `sub-text` at all. That is absence, not failure.
        let chars = mpv
            .get_property::<String>("sub-text")
            .ok()
            .map(|line| line.chars().count());
        // Absent or empty is mpv not having rendered yet as often as it is a playhead with no line
        // over it, and the two cannot be told apart from here. So the event thread is asked to
        // watch for the words arriving, once (N92).
        self.shared
            .awaiting_sub_text
            .store(chars.unwrap_or(0) == 0, Ordering::Relaxed);
        Ok(SubtitlesDrawn {
            at: mpv.get_property::<f64>("time-pos").ok(),
            tracks: tracks.len(),
            selected: tracks
                .iter()
                .any(|track| track.filename == wanted && track.selected),
            visible: mpv
                .get_property::<bool>("sub-visibility")
                .map_err(|error| from_mpv(error, "sub-visibility"))?,
            chars,
        })
    }

    /// Take every external subtitle track off. mpv holding none already is not a failure.
    ///
    /// The list is read again after each removal rather than walked once: whether mpv renumbers
    /// what is left is its business, and a stale id would either miss a track or remove the wrong
    /// one. The bound is what stops a removal mpv accepts without acting on from looping forever.
    pub fn drop_subtitles(&self) -> Result<(), VideoError> {
        let mpv = self.handle()?;
        self.loaded_duration()?;
        for _ in 0..MAX_SUBTITLE_REMOVALS {
            let Some(track) = external_subtitles(&mpv)?.into_iter().next() else {
                return Ok(());
            };
            mpv.command("sub-remove", &[&track.id.to_string()])
                .map_err(|error| from_mpv(error, "sub-remove"))?;
        }
        Err(VideoError::command_failed(
            "mpv still holds external subtitle tracks after removing them",
        ))
    }

    /// One line per gesture, never per frame: Play and Pause are things a translator does tens of
    /// times in a session. Every road out of here writes it, including the two that used to return
    /// before reaching it, so an absent line means the command never arrived and nothing else
    /// (N108). Without it a transport that never changes cannot be told from a command that never
    /// arrived or one mpv refused, which is what left N13 open with a timeout that named neither.
    fn set_pause(&self, paused: bool) -> Result<(), VideoError> {
        let outcome = self.ask_pause(paused);
        match &outcome {
            Ok(()) => log::info!("{}", pause_line(paused, None)),
            Err(error) => log::warn!("{}", pause_line(paused, Some(error))),
        }
        outcome
    }

    /// Make mpv draw the frame it is sitting on again, after a track was added under it.
    ///
    /// mpv fills `sub-text` when it draws, and adding a track to a paused player does not make it
    /// draw: on a host with no GPU the line never arrived, the frame kept the picture it had, and
    /// the event thread waited for a property change that was never coming. A zero length exact
    /// seek makes it decode and draw that frame again. Only while paused: a running player draws by
    /// itself, and a seek under one is a jump it walks straight back off. See BACKLOG.md N101.
    ///
    /// Only on the add, never on a reload: the runner's own log shows a reload drawing at once, and
    /// a reload happens on every committed edit, which is while the translator is typing.
    fn draw_the_paused_frame(&self, mpv: &Mpv, added: bool) {
        if !added || mpv.get_property::<bool>("pause") != Ok(true) {
            return;
        }
        match mpv.command("seek", &["0", "relative+exact"]) {
            Ok(()) => log::info!("preview: asked mpv to draw the paused frame again"),
            Err(error) => log::warn!("preview: the paused frame could not be drawn again: {error}"),
        }
    }

    fn ask_pause(&self, paused: bool) -> Result<(), VideoError> {
        let mpv = self.handle()?;
        self.loaded_duration()?;
        // Recorded before the property is set, so the event thread never sees the change while the
        // flag still says the app wanted the other thing.
        self.shared.asked_paused.store(paused, Ordering::Relaxed);
        mpv.set_property("pause", paused)
            .map_err(|error| from_mpv(error, "pause"))
    }
}

/// What one play or pause gesture says about itself. Pure so it can be tested: the half that cannot
/// be reached from a gesture is which road `set_pause` took, and the half that can be checked is
/// that each road says a different thing. See BACKLOG.md N108.
fn pause_line(paused: bool, error: Option<&VideoError>) -> String {
    let what = if paused { "pause" } else { "play" };
    match error {
        None => format!("playback: asked mpv to {what}, and it took it"),
        // Before mpv was reached at all: no player, or no file open. mpv refused nothing here, and
        // saying it did is what made an absent line ambiguous in the first place.
        Some(error)
            if matches!(
                error.code,
                VideoErrorCode::PlayerUnavailable | VideoErrorCode::NotLoaded
            ) =>
        {
            format!(
                "playback: asked mpv to {what}, and there was nothing to ask: {}",
                error.detail
            )
        }
        Some(error) => format!("playback: asked mpv to {what}, and it refused: {error}"),
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        // Nothing owns the surface here, so the verdict has no caller to act on it.
        let _ = self.shutdown();
    }
}

/// libmpv refuses to start unless LC_NUMERIC is exactly "C", and GTK sets the user's locale during
/// its own init, so this has to run after GTK and immediately before mpv_create. See BACKLOG.md M0.2.
fn force_c_numeric_locale() -> Result<(), VideoError> {
    // SAFETY: setlocale with a valid category and a NUL-terminated string.
    let applied = unsafe { libc::setlocale(libc::LC_NUMERIC, c"C".as_ptr()) };
    if applied.is_null() {
        return Err(VideoError::player_unavailable(
            "could not set LC_NUMERIC to C, which libmpv requires",
        ));
    }
    Ok(())
}

/// Reject anything that is not an existing regular file before mpv sees it. This is what keeps a
/// crafted path away from mpv's protocol handlers. See CONTRIBUTING.md section 3.
fn validate_path(path: &str) -> Result<String, VideoError> {
    if path.trim().is_empty() {
        return Err(VideoError::invalid_path("empty path"));
    }
    let candidate = Path::new(path);
    if !candidate.is_file() {
        return Err(VideoError::invalid_path(path.to_owned()));
    }
    let resolved = candidate
        .canonicalize()
        .map_err(|error| VideoError::invalid_path(format!("{path}: {error}")))?;
    Ok(mpv_path(&resolved))
}

/// Every external subtitle track mpv holds. Read property by property, as `audio_tracks` reads the
/// audio ones: libmpv2 hands back scalars.
fn external_subtitles(mpv: &Mpv) -> Result<Vec<ExternalSubtitle>, VideoError> {
    let count = mpv
        .get_property::<i64>("track-list/count")
        .map_err(|error| from_mpv(error, "track-list/count"))?;
    let mut tracks = Vec::new();
    for index in 0..count.max(0) {
        let kind = mpv
            .get_property::<String>(&format!("track-list/{index}/type"))
            .map_err(|error| from_mpv(error, "track-list type"))?;
        if kind != "sub" {
            continue;
        }
        // A track that came out of the media file is the media's own and is never touched here.
        if !mpv
            .get_property::<bool>(&format!("track-list/{index}/external"))
            .map_err(|error| from_mpv(error, "track-list external"))?
        {
            continue;
        }
        tracks.push(ExternalSubtitle {
            id: mpv
                .get_property::<i64>(&format!("track-list/{index}/id"))
                .map_err(|error| from_mpv(error, "track-list id"))?,
            selected: mpv
                .get_property::<bool>(&format!("track-list/{index}/selected"))
                .map_err(|error| from_mpv(error, "track-list selected"))?,
            filename: mpv
                .get_property::<String>(&format!("track-list/{index}/external-filename"))
                .map_err(|error| from_mpv(error, "track-list external-filename"))?,
        });
    }
    Ok(tracks)
}

/// Windows canonicalisation yields a `\\?\` verbatim path, which mpv does not accept. See M0.2.
fn mpv_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.chars().nth(1) == Some(':') => rest.to_owned(),
        _ => text.into_owned(),
    }
}

/// The only caller of `wait_event` in the codebase, so a second mpv client handle is never needed
/// and libmpv2's unchecked `create_client` is never reached. See the M0.2 design, section 2.1.
/// What the duration read at `FileLoaded` means for the pending open (BACKLOG N40).
enum OpenVerdict {
    /// The open has its answer, a duration or a failure.
    Resolve(Result<f64, VideoError>),
    /// mpv has the file but not its duration yet, seen on a stalled runner with an audio-only
    /// file: retry on the next event-loop pass, with `OPEN_TIMEOUT` in `open` as the backstop.
    /// Resolving this read as an error painted "no file is open" over an open about to succeed.
    Wait,
}

/// The one mapping N40 was about, pure so a check can pin it: `PropertyUnavailable` is a demuxer
/// that has not answered yet, never a file that is not open.
fn open_verdict(read: Result<f64, libmpv2::Error>) -> OpenVerdict {
    match read {
        Ok(duration) if duration > 0.0 => OpenVerdict::Resolve(Ok(duration)),
        Ok(duration) => OpenVerdict::Resolve(Err(VideoError::open_failed(format!(
            "mpv reported duration {duration}"
        )))),
        Err(libmpv2::Error::Raw(code)) if code == libmpv2::mpv_error::PropertyUnavailable => {
            OpenVerdict::Wait
        }
        Err(error) => OpenVerdict::Resolve(Err(from_mpv(error, "duration"))),
    }
}

fn event_loop(mpv: &Mpv, shared: &Shared, stop: &AtomicBool) {
    let mut last_position = Instant::now() - POSITION_EVENT_INTERVAL;
    // A position the throttle held back, waiting for the interval to pass.
    let mut held: Option<f64> = None;
    // FileLoaded arrived before mpv had a duration, so the open's verdict is still owed (N40).
    let mut awaiting_duration = false;

    while !stop.load(Ordering::Relaxed) {
        match mpv.wait_event(EVENT_POLL_SECONDS) {
            Some(Ok(Event::PropertyChange {
                name: "time-pos",
                change: PropertyData::Double(position),
                ..
            })) => {
                // A range's stop is checked here and not on the throttled path below: mpv reports
                // time-pos at frame rate, so this overshoots by a frame, and the UI's ten updates a
                // second would overshoot by a tenth. See docs/play-range-tasks.md.
                let stopping = shared
                    .stop_at
                    .lock()
                    .ok()
                    .and_then(|mut target| target.take_if(|end| position >= *end))
                    .is_some_and(|end| {
                        // Said out loud, because nothing else can see it. The harness reads the
                        // transport slider, which is the copy the throttle below hands the
                        // interface, and that lags by up to the tenth this branch exists to avoid:
                        // through that instrument a stop checked here and a stop checked there are
                        // the same reading. This line is mpv's own account, and it makes the frame
                        // precision assertable. See BACKLOG.md N20.
                        log::info!(
                            "playback: range stopped at {position:.3} for a target of {end:.3}"
                        );
                        true
                    });
                if stopping {
                    shared.asked_paused.store(true, Ordering::Relaxed);
                    if let Err(error) = mpv.set_property("pause", true) {
                        log::warn!("playback: a range could not be stopped: {error}");
                    }
                }
                // mpv reports time-pos at frame rate; the UI gets at most 10 updates per second.
                // What the throttle holds back is kept rather than dropped: two moves inside one
                // interval, a frame step and the seek back off it, report twice and never again,
                // and dropping the second would leave the interface a frame ahead of the picture.
                if last_position.elapsed() >= POSITION_EVENT_INTERVAL {
                    last_position = Instant::now();
                    held = None;
                    shared.emit_position(position);
                } else {
                    held = Some(position);
                }
            }
            Some(Ok(Event::PropertyChange {
                name: "sub-text",
                change: PropertyData::Str(text),
                ..
            })) => {
                // Only after a refresh reported the line absent or empty, and only once: mpv fills
                // `sub-text` when it renders, which is after the track is added, so a refresh that
                // read it straight away saw nothing and nothing looked again (N92).
                if !text.is_empty() && shared.awaiting_sub_text.swap(false, Ordering::Relaxed) {
                    if let Some(app) = &shared.app {
                        let handle = app.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            crate::preview::refresh_now(&handle);
                        });
                    }
                }
            }
            Some(Ok(Event::PropertyChange {
                name: "pause",
                change: PropertyData::Flag(paused),
                ..
            })) => {
                // A pause the app never asked for is the only kind worth a line: it is playback
                // stopping on its own, and until now the only sign of it was a test going red on a
                // machine nobody could look at. See BACKLOG.md N13.
                if paused && !shared.asked_paused.load(Ordering::Relaxed) {
                    let at = match mpv.get_property::<f64>("time-pos") {
                        Ok(seconds) => format!("{seconds} s"),
                        Err(_) => "a position mpv would not report".to_owned(),
                    };
                    log::info!("playback: mpv paused itself at {at}, which nothing here asked for");
                }
                if let Ok(mut state) = shared.state.lock() {
                    state.paused = paused;
                }
                shared.emit_state();
            }
            Some(Ok(Event::StartFile)) => {
                // Measured: mpv leaves the last file's dwidth standing until the new one
                // reconfigures, so the interface is told the size is unknown rather than left
                // holding the file before's. See docs/video-aspect-tasks.md.
                shared.tell_picture(None);
                // A new load began, so a duration still owed belongs to a file that is gone (N40).
                awaiting_duration = false;
            }
            Some(Ok(Event::VideoReconfig)) => {
                // mpv's own notice that its video output changed, and the one that arrives for
                // every file: a `dwidth` property change does not, when the next file is drawn at
                // the same size, and never says the picture went away at all.
                //
                // Only ever a size, never an absence. mpv reinitialises its output while a file
                // plays and a read taken in that moment answers "unavailable" for a picture that
                // has not gone anywhere, which was seen once as a stray null mid-playback. Losing
                // the picture is a file boundary and the arm above owns it.
                if let Some(size) = read_picture(mpv) {
                    shared.tell_picture(Some(size));
                }
            }
            Some(Ok(Event::FileLoaded)) => {
                // A media with no picture is as ordinary as one with no audio: said once, at info,
                // never as an error. `video-format` is what mpv has here; the drawn size is not yet.
                if mpv.get_property::<String>("video-format").is_err() {
                    log::info!(
                        "video: this media carries no picture, so there is no size to report"
                    );
                }
                match open_verdict(mpv.get_property::<f64>("duration")) {
                    OpenVerdict::Resolve(outcome) => {
                        awaiting_duration = false;
                        shared.resolve_open(outcome);
                    }
                    // The demuxer can reach FileLoaded before it has a duration, seen on a stalled
                    // CI runner with an audio-only file: resolving that read as an error painted
                    // "no file is open" over an open about to succeed. Retried below; `open`'s own
                    // timeout stays the backstop. See BACKLOG N40.
                    OpenVerdict::Wait => {
                        awaiting_duration = true;
                        log::info!("video: mpv has no duration yet at FileLoaded, waiting for it");
                    }
                }
            }
            Some(Ok(Event::Shutdown)) => break,
            // libmpv2 turns a failed load or a failed playback into Err rather than an EndFile
            // reason, so this arm is the only place a load failure can be observed.
            Some(Err(error)) => {
                let no_audio_output = matches!(
                    &error,
                    libmpv2::Error::Raw(code) if *code == libmpv2::mpv_error::AoInitFailed
                );
                // A machine with no sound is still one a media can be open on. mpv reports a
                // failed audio output through this arm, and for a media that is only audio it is
                // the whole of the playback, so it must not be allowed to answer the open: an open
                // resolved as a failure never reaches Ready, and everything that then asks for the
                // duration is told no file is open. The load's own path answers instead. See N35.
                if no_audio_output {
                    crate::log::warn!(
                        "video: this machine has no audio output, so the media is silent"
                    );
                    continue;
                }
                let mapped = from_mpv(error, "playback");
                let mapped = VideoError::new(VideoErrorCode::OpenFailed, mapped.detail);
                if !shared.resolve_open(Err(mapped.clone())) {
                    let stopped = VideoError::new(VideoErrorCode::PlaybackStopped, mapped.detail);
                    shared.emit_error(&stopped);
                }
            }
            _ => {}
        }
        // The duration the open is still owed, retried until mpv has one or the open's own
        // timeout gives up waiting for it (N40). A resolve into a channel the open no longer
        // holds returns false, and there is then nothing left to keep asking for.
        if awaiting_duration {
            if let OpenVerdict::Resolve(outcome) = open_verdict(mpv.get_property::<f64>("duration"))
            {
                awaiting_duration = false;
                shared.resolve_open(outcome);
            }
        }
        // The held report, once the interval it was waiting for has passed. Every path through the
        // loop reaches here, and the wait above returns at least ten times a second.
        if let Some(position) = held.take_if(|_| last_position.elapsed() >= POSITION_EVENT_INTERVAL)
        {
            last_position = Instant::now();
            shared.emit_position(position);
        }
    }
}

#[cfg(test)]
mod picture_tests {
    use super::{drawn_box, size_agrees_with_aspect, PictureSize, Player, PlayerConfig};
    use std::path::Path;
    use std::time::{Duration, Instant};

    /// Absence is absence: a size with a zero or a negative in it is not a box a picture fills,
    /// and reporting it would hand the arithmetic a cap of zero. See docs/video-aspect-tasks.md.
    /// The exact pair CI printed on the runner, and the one it printed beside it. The anamorphic
    /// fixture is stored 640 by 360 and drawn 1280 by 360, so its aspect is 1280 over 360. The
    /// first of the two reconfigures carries the stored size against that aspect, which is what
    /// this refuses. See BACKLOG N36.
    #[test]
    fn a_size_from_a_reconfigure_that_has_not_finished_does_not_agree_with_its_aspect() {
        let anamorphic = 1280.0 / 360.0;
        assert!(size_agrees_with_aspect(1280, 360, anamorphic));
        assert!(!size_agrees_with_aspect(640, 360, anamorphic));
        // A square picture agrees with its own aspect and with nothing stretched.
        assert!(size_agrees_with_aspect(640, 360, 640.0 / 360.0));
        assert!(!size_agrees_with_aspect(640, 360, 1.0));
        // Rounding a ratio into whole pixels costs a pixel and no more.
        assert!(size_agrees_with_aspect(853, 480, 16.0 / 9.0));
        assert!(!size_agrees_with_aspect(851, 480, 16.0 / 9.0));
        // An aspect mpv will not answer for says nothing, so it refuses nothing.
        assert!(size_agrees_with_aspect(640, 360, f64::NAN));
        assert!(size_agrees_with_aspect(640, 360, 0.0));
        assert!(size_agrees_with_aspect(640, 0, 1.5));
    }

    #[test]
    fn a_zero_or_a_negative_is_no_size_at_all() {
        assert_eq!(drawn_box(0, 360, None), None);
        assert_eq!(drawn_box(1280, 0, None), None);
        assert_eq!(drawn_box(-1280, -360, None), None);
        assert_eq!(
            drawn_box(1280, 360, Some(0)),
            Some(PictureSize {
                width: 1280,
                height: 360
            })
        );
    }

    /// Measured on both outputs the app builds: a renderer that turns the picture itself leaves
    /// `dwidth` upright and owes a quarter turn, and one that cannot has had the turn made for it
    /// in the filter chain and owes nothing. Both have to end at the same box.
    #[test]
    fn a_quarter_turn_the_output_still_owes_swaps_the_box_and_a_half_turn_does_not() {
        let upright = Some(PictureSize {
            width: 360,
            height: 640,
        });
        assert_eq!(drawn_box(640, 360, Some(270)), upright);
        assert_eq!(drawn_box(640, 360, Some(90)), upright);
        assert_eq!(drawn_box(360, 640, Some(0)), upright);
        assert_eq!(
            drawn_box(640, 360, Some(180)),
            Some(PictureSize {
                width: 640,
                height: 360
            })
        );
        // A media with no picture has no rotation to read either, and that is not a turn.
        assert_eq!(
            drawn_box(640, 360, None),
            Some(PictureSize {
                width: 640,
                height: 360
            })
        );
    }

    /// The whole path through a real mpv core: nothing before a file, the drawn size once the
    /// first frame is decoded, and the same answer again for a second file drawn at the same size.
    ///
    /// That second open is the regression: mpv announces a property change only when the value
    /// moves, so a build triggered by `dwidth` alone answers once and then goes silent for every
    /// file after it. The anamorphic and rotated cases are checked by the E2E spec, which is where
    /// their fixtures are.
    #[test]
    fn a_square_picture_is_reported_at_its_own_size_and_not_before() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/video/sample.mkv");
        assert!(
            fixture.is_file(),
            "missing fixture {}: run fixtures/video/make-sample.sh",
            fixture.display()
        );
        let player = Player::new(PlayerConfig::headless(), None)
            .expect("headless player should start; is libmpv installed?");
        assert_eq!(player.picture(), None, "nothing is loaded yet");

        player
            .open(&fixture.to_string_lossy())
            .expect("fixture should open");

        let deadline = Instant::now() + Duration::from_secs(10);
        while player.picture().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        let square = Some(PictureSize {
            width: 640,
            height: 360,
        });
        assert_eq!(player.picture(), square);

        player
            .open(&fixture.to_string_lossy())
            .expect("fixture should open a second time");
        let deadline = Instant::now() + Duration::from_secs(10);
        while player.picture().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        assert_eq!(player.picture(), square, "the second open of the same file");
    }
}

#[cfg(all(test, target_os = "linux"))]
mod gpu_context_tests {
    use super::gpu_context_from;
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    #[test]
    fn nothing_set_asks_for_the_pin() {
        let (context, source) = gpu_context_from(None);
        assert_eq!(context.as_ref(), "x11egl");
        assert_eq!(source, "default");
    }

    #[test]
    fn a_name_is_taken_as_written() {
        let (context, source) = gpu_context_from(Some(OsStr::new(" x11 ")));
        assert_eq!(context.as_ref(), "x11");
        assert_eq!(source, "SUBLORE_MPV_GPU_CONTEXT");
    }

    /// The sibling hatch in `main.rs` reads an empty value as "not set". Two hatches under one
    /// prefix must not disagree about one input (gate 2, `gate2b-fixes-review.md` finding 5).
    #[test]
    fn an_empty_value_reads_as_unset() {
        for empty in ["", "   "] {
            let (context, source) = gpu_context_from(Some(OsStr::new(empty)));
            assert_eq!(context.as_ref(), "x11egl", "{empty:?}");
            assert_eq!(source, "default, the variable was empty");
        }
    }

    /// A value Rust cannot decode is a variable that *was* set, and reporting it as unset sends
    /// whoever reads a "no picture" report looking in the wrong place.
    #[test]
    fn a_value_that_is_not_unicode_is_named_as_such_not_as_unset() {
        let raw = OsStr::from_bytes(&[0x78, 0x31, 0x31, 0xff]);
        let (context, source) = gpu_context_from(Some(raw));
        assert_eq!(context.as_ref(), "x11egl");
        assert_eq!(source, "default, the variable was not valid Unicode");
    }
}

#[cfg(test)]
mod open_verdict_tests {
    use super::*;

    /// The mapping N40 pinned down: a demuxer that has not answered yet is a wait, never a
    /// failure (n40-open-verdict-tasks V1).
    #[test]
    fn a_duration_not_yet_available_waits_instead_of_failing() {
        let read = Err(libmpv2::Error::Raw(libmpv2::mpv_error::PropertyUnavailable));
        assert!(matches!(open_verdict(read), OpenVerdict::Wait));
    }

    #[test]
    fn a_positive_duration_resolves_the_open() {
        assert!(matches!(
            open_verdict(Ok(61.5)),
            OpenVerdict::Resolve(Ok(duration)) if duration == 61.5
        ));
    }

    /// Zero is a file mpv cannot measure, which is a failed open and not a wait.
    #[test]
    fn a_zero_duration_is_a_failed_open() {
        assert!(matches!(
            open_verdict(Ok(0.0)),
            OpenVerdict::Resolve(Err(error)) if error.code == VideoErrorCode::OpenFailed
        ));
    }

    /// Any other mpv error keeps its own mapping; nothing else is allowed to wait.
    #[test]
    fn any_other_error_resolves_as_its_own_failure() {
        let read = Err(libmpv2::Error::Raw(libmpv2::mpv_error::Generic));
        assert!(matches!(
            open_verdict(read),
            OpenVerdict::Resolve(Err(error)) if error.code == VideoErrorCode::CommandFailed
        ));
    }
}

#[cfg(test)]
mod pause_line_tests {
    use super::pause_line;
    use crate::video::error::{VideoError, VideoErrorCode};

    #[test]
    fn a_gesture_that_reached_mpv_says_so() {
        assert_eq!(
            pause_line(false, None),
            "playback: asked mpv to play, and it took it"
        );
        assert_eq!(
            pause_line(true, None),
            "playback: asked mpv to pause, and it took it"
        );
    }

    #[test]
    fn a_gesture_that_never_reached_mpv_says_that_instead_of_blaming_it() {
        // The two roads that used to return before writing anything, which is what made an absent
        // line mean three things (N108).
        for code in [VideoErrorCode::PlayerUnavailable, VideoErrorCode::NotLoaded] {
            let line = pause_line(false, Some(&VideoError::new(code, "no file is open")));
            assert_eq!(
                line,
                "playback: asked mpv to play, and there was nothing to ask: no file is open"
            );
        }
    }

    #[test]
    fn a_gesture_mpv_turned_down_is_the_only_one_that_says_refused() {
        let line = pause_line(
            true,
            Some(&VideoError::new(VideoErrorCode::CommandFailed, "denied")),
        );
        assert!(
            line.starts_with("playback: asked mpv to pause, and it refused:"),
            "{line}"
        );
    }

    #[test]
    fn every_outcome_reads_differently_from_every_other() {
        // The point of the whole change: three roads, three sentences. A reader of the log can tell
        // which one was taken without opening the source.
        //
        // One detail for all three, so a difference here is a difference in the sentence rather
        // than in what was passed in. It still cannot see two roads put on the same sentence, since
        // `VideoError`'s own Display carries the code: measured by doing exactly that and watching
        // this stay green while the check above went red. That check is the one that guards it.
        const DETAIL: &str = "the same words either way";
        let lines = [
            pause_line(false, None),
            pause_line(
                false,
                Some(&VideoError::new(VideoErrorCode::NotLoaded, DETAIL)),
            ),
            pause_line(
                false,
                Some(&VideoError::new(VideoErrorCode::CommandFailed, DETAIL)),
            ),
        ];
        for (first, second) in [(0, 1), (0, 2), (1, 2)] {
            assert_ne!(lines[first], lines[second]);
        }
    }
}
