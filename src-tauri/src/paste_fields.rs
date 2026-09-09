//! Which fields a paste over takes, remembered between one paste and the next.
//!
//! The reference opens its dialog on every paste over, and what survives between them is only the
//! set of boxes it opens with (paste-over-tasks.md P2). This is that set: beside `layout.json` and
//! the rest, under the same rule that a preference is derived convenience and never the user's own
//! work, so a broken file costs the last answer and never a launch.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::log;

const PASTE_FIELDS_FILE: &str = "paste-fields.json";

/// The eleven, in the order the reference's own dialog lists them. Text alone is the default,
/// because it is what Sublore did before this dialog existed and what a translator reaches for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PasteFields {
    pub comment: bool,
    pub layer: bool,
    pub start: bool,
    pub end: bool,
    pub style: bool,
    pub actor: bool,
    pub margin_l: bool,
    pub margin_r: bool,
    pub margin_v: bool,
    pub effect: bool,
    pub text: bool,
}

impl Default for PasteFields {
    fn default() -> Self {
        Self {
            comment: false,
            layer: false,
            start: false,
            end: false,
            style: false,
            actor: false,
            margin_l: false,
            margin_r: false,
            margin_v: false,
            effect: false,
            text: true,
        }
    }
}

fn read_from(path: &Path) -> PasteFields {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) => {
            // A first launch has no file, which is not something to say anything about.
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!("paste fields: the stored answer could not be read: {error}");
            }
            return PasteFields::default();
        }
    };
    match serde_json::from_str::<PasteFields>(&text) {
        Ok(fields) => fields,
        Err(error) => {
            log::warn!("paste fields: the stored answer is not readable JSON: {error}");
            PasteFields::default()
        }
    }
}

/// Written whole and renamed over the old one, so a crash mid-write leaves the previous answer
/// rather than a file that reads as none.
fn write_to(path: &Path, fields: &PasteFields) -> std::io::Result<()> {
    let text = serde_json::to_string(fields).map_err(std::io::Error::other)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text)?;
    std::fs::rename(&temp, path)
}

fn paste_fields_path(app: &AppHandle) -> Option<PathBuf> {
    use tauri::Manager;

    match app.path().app_data_dir() {
        Ok(dir) => Some(dir.join(PASTE_FIELDS_FILE)),
        Err(error) => {
            log::warn!("paste fields: no app data directory, so nothing is remembered: {error}");
            None
        }
    }
}

#[tauri::command]
pub fn paste_fields_read(app: AppHandle) -> PasteFields {
    paste_fields_path(&app).map_or_else(PasteFields::default, |path| read_from(&path))
}

#[tauri::command]
pub fn paste_fields_write(app: AppHandle, fields: PasteFields) -> Result<(), String> {
    let Some(path) = paste_fields_path(&app) else {
        return Err("no app data directory to remember the answer in".to_owned());
    };
    write_to(&path, &fields).map_err(|error| {
        log::warn!("paste fields: the answer could not be stored: {error}");
        error.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "sublore-paste-fields-{}-{name}",
                std::process::id()
            ));
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

    /// Before anything is stored, the answer is what Sublore did before the dialog existed (P2).
    #[test]
    fn a_first_launch_takes_the_text_and_nothing_else() {
        let dir = TempDir::new("missing");
        let read = read_from(&dir.join("paste-fields.json"));
        assert_eq!(read, PasteFields::default());
        assert!(read.text);
        assert!(!read.style);
    }

    /// A hand-broken file costs the last answer, never the launch.
    #[test]
    fn an_unreadable_file_reads_as_the_default() {
        let dir = TempDir::new("garbage");
        let path = dir.join("paste-fields.json");
        std::fs::write(&path, b"not json at all").expect("the broken file");
        assert_eq!(read_from(&path), PasteFields::default());
    }

    /// A file naming only some of the eleven reads the rest as the default rather than failing.
    /// The app always writes all eleven, so a partial file is one somebody edited by hand.
    #[test]
    fn a_partial_file_fills_the_rest_from_the_default() {
        let dir = TempDir::new("partial");
        let path = dir.join("paste-fields.json");
        std::fs::write(&path, br#"{"style":true}"#).expect("the partial file");
        let read = read_from(&path);
        assert!(read.style, "what the file named");
        assert!(
            read.text,
            "and the rest from the default, which takes the text: a hand-edited file that named \
             nothing else would otherwise take no field at all, and a paste that takes nothing is \
             refused"
        );
        assert!(!read.actor, "a default that is off stays off");
    }

    #[test]
    fn a_stored_answer_round_trips() {
        let dir = TempDir::new("roundtrip");
        let path = dir.join("paste-fields.json");
        let wanted = PasteFields {
            start: true,
            end: true,
            text: false,
            ..PasteFields::default()
        };
        write_to(&path, &wanted).expect("the write");
        assert_eq!(read_from(&path), wanted);
    }
}
