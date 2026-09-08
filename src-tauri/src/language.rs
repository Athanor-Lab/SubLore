//! The interface language, chosen in View > Language and remembered beside the layout
//! (interface-spec 3.7 item 12).
//!
//! One language ships today: `src/i18n/en.ts` is the whole catalogue. The store and the startup
//! read are the seam a second language plugs into; until it exists a choice can never differ from
//! the active language, so the restart the reference offers has nothing to apply and is not asked.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::log;

/// Beside `layout.json` in the app data directory, for the same reason it is: a preference,
/// derived convenience rather than the user's own work.
const LANGUAGE_FILE: &str = "language.json";

/// The interface languages Sublore ships. The dialog draws this list; the store refuses the rest.
pub const KNOWN: [&str; 1] = ["en"];

const FALLBACK: &str = "en";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Language {
    pub language: String,
}

impl Default for Language {
    fn default() -> Self {
        Self {
            language: FALLBACK.to_owned(),
        }
    }
}

impl Language {
    /// A stored language Sublore does not ship reads back as the fallback, never as a failure:
    /// the file is hand-editable and the app has to draw in something.
    fn sane(self) -> Self {
        if KNOWN.contains(&self.language.as_str()) {
            return self;
        }
        log::warn!(
            "language: {:?} is not a language Sublore ships, using {FALLBACK}",
            self.language
        );
        Self::default()
    }
}

/// The stored choice, or the fallback. Nothing here is worth refusing to start over.
fn read_from(path: &Path) -> Language {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) => {
            // A first launch has no file, which is not something to say anything about.
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!("language: the stored choice could not be read: {error}");
            }
            return Language::default();
        }
    };
    match serde_json::from_str::<Language>(&text) {
        Ok(language) => language.sane(),
        Err(error) => {
            log::warn!("language: the stored choice is not readable JSON: {error}");
            Language::default()
        }
    }
}

/// Written whole and renamed over the old one, so a crash mid-write leaves the previous choice
/// rather than a file that reads as none.
fn write_to(path: &Path, language: &Language) -> std::io::Result<()> {
    let text = serde_json::to_string(language).map_err(std::io::Error::other)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text)?;
    std::fs::rename(&temp, path)
}

fn language_path(app: &AppHandle) -> Option<PathBuf> {
    use tauri::Manager;

    match app.path().app_data_dir() {
        Ok(dir) => Some(dir.join(LANGUAGE_FILE)),
        Err(error) => {
            log::warn!("language: no app data directory, so no choice is remembered: {error}");
            None
        }
    }
}

/// What the app draws in. Read once at startup for the modules, and by the dialog for its
/// selection.
pub fn stored(app: &AppHandle) -> String {
    language_path(app).map_or_else(
        || Language::default().language,
        |path| read_from(&path).language,
    )
}

#[tauri::command]
pub fn language_read(app: AppHandle) -> Language {
    language_path(&app).map_or_else(Language::default, |path| read_from(&path))
}

/// Store the chosen language. An unknown one can only come from a bug in Sublore's own dialog,
/// never from the user, so it is refused rather than stored and laundered by the fallback later.
#[tauri::command]
pub fn language_set(app: AppHandle, language: String) -> Result<(), String> {
    if !KNOWN.contains(&language.as_str()) {
        return Err(format!("{language:?} is not a language Sublore ships"));
    }
    let Some(path) = language_path(&app) else {
        return Err("no app data directory to remember the choice in".to_owned());
    };
    write_to(&path, &Language { language }).map_err(|error| {
        log::warn!("language: the choice could not be stored: {error}");
        error.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory of this test's own, removed when it returns. Same shape as `layout`'s: no
    /// `tempfile` dependency for a handful of tests that need a path that exists and one that
    /// does not.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir()
                .join(format!("sublore-language-{}-{name}", std::process::id()));
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

    /// A first launch has no file, and draws in English (language-tasks L3).
    #[test]
    fn a_missing_file_reads_as_english() {
        let dir = TempDir::new("missing");
        assert_eq!(read_from(&dir.join("language.json")).language, "en");
    }

    /// A hand-broken file costs the choice, never the launch (L3).
    #[test]
    fn an_unreadable_file_reads_as_english() {
        let dir = TempDir::new("garbage");
        let path = dir.join("language.json");
        std::fs::write(&path, b"not json at all").expect("the broken file");
        assert_eq!(read_from(&path).language, "en");
    }

    /// A stored language Sublore does not ship falls back rather than failing (L3).
    #[test]
    fn a_language_sublore_does_not_ship_reads_as_english() {
        let dir = TempDir::new("unknown");
        let path = dir.join("language.json");
        std::fs::write(&path, br#"{"language":"tlh"}"#).expect("the martian file");
        assert_eq!(read_from(&path).language, "en");
    }

    /// The round trip: what was written is what is read (L2, L3).
    #[test]
    fn a_stored_choice_round_trips() {
        let dir = TempDir::new("roundtrip");
        let path = dir.join("language.json");
        write_to(
            &path,
            &Language {
                language: "en".to_owned(),
            },
        )
        .expect("the write");
        assert_eq!(read_from(&path).language, "en");
    }
}
