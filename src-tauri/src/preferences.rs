//! The three numbers a translator may change, remembered beside the layout (interface-spec 9.6).
//!
//! Small on purpose: lead-in, lead-out and how long a cue the user has just made lasts. The CPS
//! limit stays fixed (decision 24 A8) and the interface language has a dialog of its own, so
//! neither is here. The defaults are the reference's own, inherited rather than reinvented.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::log;

/// Beside `layout.json` and `language.json`, for the same reason both are there: a preference is
/// derived convenience, never the user's own work.
const PREFERENCES_FILE: &str = "preferences.json";

/// The reference's own numbers (`src/libresrc/default_config.json`): lead 100 and 350, and a new
/// cue three seconds long.
const DEFAULT_LEAD_IN_MS: u32 = 100;
const DEFAULT_LEAD_OUT_MS: u32 = 350;
const DEFAULT_NEW_CUE_MS: u32 = 3000;

/// What a number may be. A lead of a whole minute is not a lead, and a cue of no length is not a
/// cue: a value outside these comes back inside rather than being refused, because a preference
/// file is hand-editable and the app has to draw in something.
const MIN_LEAD_MS: u32 = 0;
const MAX_LEAD_MS: u32 = 10_000;
const MIN_NEW_CUE_MS: u32 = 100;
const MAX_NEW_CUE_MS: u32 = 60_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    /// How far Add lead-in pulls a start back, in milliseconds.
    pub lead_in_ms: u32,
    /// How far Add lead-out pushes an end on, in milliseconds.
    pub lead_out_ms: u32,
    /// How long a cue the user has just made lasts, in milliseconds.
    pub new_cue_ms: u32,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            lead_in_ms: DEFAULT_LEAD_IN_MS,
            lead_out_ms: DEFAULT_LEAD_OUT_MS,
            new_cue_ms: DEFAULT_NEW_CUE_MS,
        }
    }
}

impl Preferences {
    /// Every number inside the range it may hold. Applied on the way in as well as on the way out,
    /// because the file on disk is editable by hand.
    fn sane(self) -> Self {
        Self {
            lead_in_ms: clamp(self.lead_in_ms, MIN_LEAD_MS, MAX_LEAD_MS, "a lead-in"),
            lead_out_ms: clamp(self.lead_out_ms, MIN_LEAD_MS, MAX_LEAD_MS, "a lead-out"),
            new_cue_ms: clamp(
                self.new_cue_ms,
                MIN_NEW_CUE_MS,
                MAX_NEW_CUE_MS,
                "a new cue's length",
            ),
        }
    }
}

fn clamp(value: u32, min: u32, max: u32, what: &str) -> u32 {
    let kept = value.clamp(min, max);
    if kept != value {
        log::warn!("preferences: {what} of {value} ms is outside {min}..{max}, using {kept}");
    }
    kept
}

/// The stored numbers, or the defaults. Nothing here is worth refusing to start over.
fn read_from(path: &Path) -> Preferences {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) => {
            // A first launch has no file, which is not something to say anything about.
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!("preferences: the stored numbers could not be read: {error}");
            }
            return Preferences::default();
        }
    };
    match serde_json::from_str::<Preferences>(&text) {
        Ok(preferences) => preferences.sane(),
        Err(error) => {
            log::warn!("preferences: the stored numbers are not readable JSON: {error}");
            Preferences::default()
        }
    }
}

/// Written whole and renamed over the old one, so a crash mid-write leaves the previous numbers
/// rather than a file that reads as none.
fn write_to(path: &Path, preferences: &Preferences) -> std::io::Result<()> {
    let text = serde_json::to_string(preferences).map_err(std::io::Error::other)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text)?;
    std::fs::rename(&temp, path)
}

fn preferences_path(app: &AppHandle) -> Option<PathBuf> {
    use tauri::Manager;

    match app.path().app_data_dir() {
        Ok(dir) => Some(dir.join(PREFERENCES_FILE)),
        Err(error) => {
            log::warn!("preferences: no app data directory, so nothing is remembered: {error}");
            None
        }
    }
}

#[tauri::command]
pub fn preferences_read(app: AppHandle) -> Preferences {
    preferences_path(&app).map_or_else(Preferences::default, |path| read_from(&path))
}

/// Store the numbers the dialog was left holding. Each is brought inside its range first, so a
/// value the dialog let through is stored as one the app can draw with.
#[tauri::command]
pub fn preferences_write(app: AppHandle, preferences: Preferences) -> Result<(), String> {
    let Some(path) = preferences_path(&app) else {
        return Err("no app data directory to remember the numbers in".to_owned());
    };
    write_to(&path, &preferences.sane()).map_err(|error| {
        log::warn!("preferences: the numbers could not be stored: {error}");
        error.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory of this test's own, removed when it returns. Same shape as `language`'s.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir()
                .join(format!("sublore-preferences-{}-{name}", std::process::id()));
            std::fs::remove_dir_all(&path).ok();
            std::fs::create_dir_all(&path).expect("a directory under the temp dir");
            Self(path)
        }

        fn join(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    /// The reference's own numbers, inherited rather than reinvented (preferences-tasks, P1).
    #[test]
    fn a_first_launch_reads_the_references_numbers() {
        let dir = TempDir::new("missing");
        let read = read_from(&dir.join("preferences.json"));
        assert_eq!(read.lead_in_ms, 100);
        assert_eq!(read.lead_out_ms, 350);
        assert_eq!(read.new_cue_ms, 3000);
    }

    /// A hand-broken file costs the numbers, never the launch (P4).
    #[test]
    fn an_unreadable_file_reads_as_the_defaults() {
        let dir = TempDir::new("garbage");
        let path = dir.join("preferences.json");
        std::fs::write(&path, b"not json at all").expect("the broken file");
        assert_eq!(read_from(&path), Preferences::default());
    }

    /// A number outside its range comes back inside rather than being refused (P4).
    #[test]
    fn a_number_outside_its_range_comes_back_inside() {
        let wild = Preferences {
            lead_in_ms: 999_999,
            lead_out_ms: 0,
            new_cue_ms: 1,
        };
        let kept = wild.sane();
        assert_eq!(kept.lead_in_ms, MAX_LEAD_MS);
        assert_eq!(
            kept.lead_out_ms, 0,
            "no lead at all is a choice, not a mistake"
        );
        assert_eq!(kept.new_cue_ms, MIN_NEW_CUE_MS);
    }

    /// The round trip: what was written is what is read (P2).
    #[test]
    fn stored_numbers_round_trip() {
        let dir = TempDir::new("roundtrip");
        let path = dir.join("preferences.json");
        let wanted = Preferences {
            lead_in_ms: 500,
            lead_out_ms: 120,
            new_cue_ms: 5000,
        };
        write_to(&path, &wanted).expect("the write");
        assert_eq!(read_from(&path), wanted);
    }
}
