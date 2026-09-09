//! The recent internal messages, kept in memory so Help's Event log can read them back.
//!
//! Interface-spec §9.12 wants a window listing what the app has been saying, and it is worth having
//! precisely because the owner verifies behaviour rather than code: "open the log window and read it
//! back to me" is a step anyone can follow.
//!
//! The file on disk stays the source for a bug report. This is the same lines, in memory, so the
//! window can show them without reading a file the log plugin is still writing to.

use std::sync::{Mutex, MutexGuard};

use tauri_plugin_log::{fern, Target, TargetKind};

/// How many lines the window can hold. Enough for a session of opening files and running commands,
/// and small enough that handing the whole of it to the webview stays cheap.
const KEPT_LINES: usize = 2000;

/// The lines, oldest first. A plain `Vec` rather than a queue: the trim below is a batch, so the
/// cost of moving the buffer is paid once per thousand lines instead of once per line.
struct Ring {
    lines: Vec<String>,
}

impl Ring {
    const fn new() -> Self {
        Self { lines: Vec::new() }
    }

    /// One line in, and the oldest half out when the cap is reached.
    fn push(&mut self, line: String) {
        if self.lines.len() >= KEPT_LINES {
            self.lines.drain(..KEPT_LINES / 2);
        }
        self.lines.push(line);
    }

    fn recent(&self) -> Vec<String> {
        self.lines.clone()
    }
}

static RING: Mutex<Ring> = Mutex::new(Ring::new());

/// The buffer, poisoned or not. A panic somewhere else must not stop the app logging: what is on
/// the other side of a poisoned lock here is a list of strings, and there is nothing about it to
/// leave half written.
fn held(lock: &Mutex<Ring>) -> MutexGuard<'_, Ring> {
    lock.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// The log target that fills the buffer. Added beside the file target rather than instead of it.
///
/// The callback is handed the line the plugin has already formatted, timestamp and level and all,
/// which is what the window should show. It logs nothing itself, so there is no way round for a
/// message to come back through here.
pub fn target() -> Target {
    Target::new(TargetKind::Dispatch(fern::Dispatch::new().chain(
        fern::Output::call(|record| {
            held(&RING).push(record.args().to_string());
        }),
    )))
}

/// Everything the app has said this run, oldest first.
#[tauri::command]
pub fn log_events_read() -> Vec<String> {
    held(&RING).recent()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cap holds, and what falls out is the oldest (L5).
    #[test]
    fn the_ring_stays_inside_its_cap() {
        let mut ring = Ring::new();
        for number in 0..KEPT_LINES + 10 {
            ring.push(format!("line {number}"));
        }
        let kept = ring.recent();
        assert!(
            kept.len() <= KEPT_LINES,
            "{} lines kept, cap is {KEPT_LINES}",
            kept.len()
        );
        assert_eq!(
            kept.last().map(String::as_str),
            Some(format!("line {}", KEPT_LINES + 9).as_str()),
            "the newest line is the last one in"
        );
        assert!(
            !kept.iter().any(|line| line == "line 0"),
            "the oldest line is the one that left"
        );
    }

    /// A panic elsewhere costs nothing here: the buffer is read and written through the poison (L5).
    #[test]
    fn a_poisoned_buffer_is_still_read_and_written() {
        let lock = Mutex::new(Ring::new());
        // The panic below is this test's own, so its message is kept off the suite's output.
        let hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let fell_over = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = lock.lock().expect("the buffer");
            panic!("a panic while the buffer was held");
        }));
        std::panic::set_hook(hook);
        assert!(fell_over.is_err(), "the panic is what poisons the lock");
        assert!(lock.is_poisoned());

        held(&lock).push("after the poison".to_owned());
        assert_eq!(held(&lock).recent(), vec!["after the poison".to_owned()]);
    }
}
