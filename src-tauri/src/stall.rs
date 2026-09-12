//! A beat on the main loop, so a stall is seen rather than guessed at.
//!
//! Twice in one battery on 2026-09-12 the app processed nothing for thirty and thirty-two seconds,
//! in two specs and at two different moments, and the same silence has been red on the runner more
//! than once. A repeated duration is a timeout somewhere rather than a machine under load, and four
//! attempts at reproducing it looked for the cause without ever asking the first question: whether
//! the main thread is blocked at all. This answers that question and nothing else. See N101.

#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};

// Not behind a cfg: `page_stalled` is the page's own report and the page runs on every platform.
use crate::log;

/// How often the beat runs. Cheap: one wake a second on a loop that already wakes for every frame.
#[cfg(target_os = "linux")]
const BEAT: Duration = Duration::from_secs(1);

/// How late a beat has to be before it is worth a line. One late beat is the scheduler; the stalls
/// this exists for are tens of seconds, so this is generous on purpose and still catches them.
#[cfg(target_os = "linux")]
const LATE: Duration = Duration::from_secs(2);

/// Start the beat. Must be called on the thread the main loop runs on, which is where Tauri's
/// `setup` runs.
#[cfg(target_os = "linux")]
pub fn watch_main_loop() {
    let mut last = Instant::now();
    gtk::glib::timeout_add_local(BEAT, move || {
        let now = Instant::now();
        let since = now.duration_since(last);
        last = now;
        if since >= BEAT + LATE {
            // The gap, and the floor it puts under the block. A beat can be due at any point inside
            // the hold, so the thread was held for somewhere between the gap less one beat and the
            // gap itself: reporting the lateness alone read four seconds of freeze as three.
            let gap = since.as_millis();
            let least = since.saturating_sub(BEAT).as_millis();
            log::warn!(
                "main loop: {gap} ms between two beats, so the thread was held at least {least} ms"
            );
        }
        gtk::glib::ControlFlow::Continue
    });
}

/// Nothing to watch where there is no GTK loop. Windows gets its own instrument with MW.1b.
#[cfg(not(target_os = "linux"))]
#[inline(always)]
pub fn watch_main_loop() {}

/// What the page says when one of its own ticks came late. The page keeps the clock; this writes it
/// down beside the main loop's, so the two halves of a stall can be told apart: a gap here with no
/// gap above is the web process, which is where the window's keystrokes turn into commands.
#[tauri::command]
pub fn page_stalled(ms: u64) {
    let least = ms.saturating_sub(1000);
    log::warn!("page: {ms} ms between two ticks, so the page was busy at least {least} ms");
}

/// Test hook: block the main thread once, so the beat above has something to report and a check can
/// read it. Debug builds only, like the close gate's delay hook.
#[cfg(all(debug_assertions, target_os = "linux"))]
pub fn stall_once() {
    const ENV_VAR: &str = "SUBLORE_STALL_MAIN_MS";

    // Anything unreadable selects nothing, and thirty seconds is the ceiling: a typo must not be
    // able to freeze the window for the life of the process.
    let Some(ms) = std::env::var(ENV_VAR)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(|ms| ms.min(30_000))
    else {
        return;
    };
    // Two seconds in, so the beat has run normally first and the window is up to be frozen.
    gtk::glib::timeout_add_local_once(Duration::from_secs(2), move || {
        log::warn!("main loop: {ENV_VAR}={ms}, holding the main thread for that long");
        std::thread::sleep(Duration::from_millis(ms));
    });
}

/// Release builds carry no hook: the environment variable is never read.
#[cfg(not(all(debug_assertions, target_os = "linux")))]
#[inline(always)]
pub fn stall_once() {}
