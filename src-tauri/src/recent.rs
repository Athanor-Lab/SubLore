//! The media opened lately, so the Video menu can offer it again.
//!
//! Sixteen paths, newest first, each once. It lives in the app's own store beside the layout and
//! the chooser's remembered folders, and it is read the same way: a missing or unreadable file is
//! an empty list and a warning, never a failure. Losing it costs one trip through the chooser.
//!
//! Projects keep their own list in `project/session.rs`, which is where the File menu's recents
//! come from; this one is the Video menu's (interface-spec 3.5 item 3).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::log;

/// Beside `layout.json` in the app data directory, for the same reason it is: derived convenience
/// rather than the user's own work.
const RECENT_FILE: &str = "recent.json";

/// What the reference keeps, and what this keeps: sixteen of each kind.
const KEEP: usize = 16;

/// A path longer than any filesystem writes, so a hand-edited file cannot grow the list without
/// bound. Nothing is truncated: a line past this is dropped, because half a path opens nothing.
const MAX_PATH_BYTES: usize = 4096;

/// The list, newest first. A named field rather than a bare array, so a second list can join it
/// later without the file having to change shape.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recent {
    #[serde(default)]
    pub videos: Vec<String>,
}

impl Recent {
    /// The list as it may be held: each path once, the newest first, sixteen of them, and nothing
    /// empty or absurdly long. A hand-edited file reaches this before anything is drawn from it.
    fn sane(mut self) -> Self {
        self.videos = tidy(std::mem::take(&mut self.videos));
        self
    }
}

fn tidy(paths: Vec<String>) -> Vec<String> {
    let mut kept: Vec<String> = Vec::with_capacity(paths.len().min(KEEP));
    for path in paths {
        if path.is_empty() || path.len() > MAX_PATH_BYTES || kept.contains(&path) {
            continue;
        }
        kept.push(path);
        if kept.len() >= KEEP {
            break;
        }
    }
    kept
}

/// The list on disk, or an empty one. Nothing here is worth refusing to open the app over.
fn read_from(path: &Path) -> Recent {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) => {
            // A first launch has no file, which is not something to say anything about.
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!("recent: the stored list could not be read: {error}");
            }
            return Recent::default();
        }
    };
    match serde_json::from_str::<Recent>(&text) {
        Ok(recent) => recent.sane(),
        Err(error) => {
            log::warn!("recent: the stored list is not readable JSON: {error}");
            Recent::default()
        }
    }
}

/// Written whole and renamed over the old one, so a crash mid-write leaves the previous list rather
/// than a file that reads as none.
fn write_to(path: &Path, recent: &Recent) -> std::io::Result<()> {
    let text = serde_json::to_string(recent).map_err(std::io::Error::other)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text)?;
    std::fs::rename(&temp, path)
}

fn recent_path(app: &AppHandle) -> Option<PathBuf> {
    use tauri::Manager;

    match app.path().app_data_dir() {
        Ok(dir) => Some(dir.join(RECENT_FILE)),
        Err(error) => {
            log::warn!("recent: no app data directory, so nothing is remembered: {error}");
            None
        }
    }
}

/// The media opened lately. Called once, when the shell mounts.
#[tauri::command]
pub fn recent_read(app: AppHandle) -> Recent {
    recent_path(&app).map_or_else(Recent::default, |path| read_from(&path))
}

/// Put a path at the top of its list and hand the list back.
///
/// The whole list comes back rather than an acknowledgement: the menu is drawn from it, and a
/// caller that had to read it again would draw the list as it was for one frame.
#[tauri::command]
pub fn recent_remember(app: AppHandle, path: String) -> Recent {
    let Some(store) = recent_path(&app) else {
        return Recent::default();
    };
    let mut recent = read_from(&store);
    recent.videos.retain(|seen| *seen != path);
    recent.videos.insert(0, path);
    let recent = recent.sane();
    if let Err(error) = write_to(&store, &recent) {
        log::warn!("recent: what was just opened could not be remembered: {error}");
    }
    recent
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_each_path_once_and_no_more_than_sixteen() {
        let recent = Recent {
            videos: (0..20)
                .map(|at| format!("/tmp/{at}.mkv"))
                .chain(std::iter::once("/tmp/0.mkv".to_owned()))
                .collect(),
        }
        .sane();

        assert_eq!(recent.videos.len(), KEEP, "sixteen and no more");
        assert_eq!(recent.videos[0], "/tmp/0.mkv", "the newest stays first");
        assert_eq!(
            recent
                .videos
                .iter()
                .filter(|path| *path == "/tmp/0.mkv")
                .count(),
            1,
            "and it is there once"
        );
    }

    #[test]
    fn drops_what_could_never_be_opened() {
        let recent = Recent {
            videos: vec![
                String::new(),
                "x".repeat(MAX_PATH_BYTES + 1),
                "/tmp/real.mkv".to_owned(),
            ],
        }
        .sane();

        assert_eq!(recent.videos, vec!["/tmp/real.mkv".to_owned()]);
    }

    #[test]
    fn remembering_moves_a_path_to_the_top_rather_than_writing_it_twice() {
        let mut recent = Recent {
            videos: vec!["/tmp/a.mkv".to_owned(), "/tmp/b.mkv".to_owned()],
        };
        recent.videos.retain(|seen| seen != "/tmp/b.mkv");
        recent.videos.insert(0, "/tmp/b.mkv".to_owned());

        assert_eq!(
            recent.sane().videos,
            vec!["/tmp/b.mkv".to_owned(), "/tmp/a.mkv".to_owned()],
            "the one just opened is first and is not there twice"
        );
    }
}
