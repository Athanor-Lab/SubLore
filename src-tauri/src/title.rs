//! What the window is called, which is what a task bar shows when three of them are open.
//!
//! The webview composes the words, because every string a user reads lives in `en.ts` and a second
//! copy here would drift from it. What this module owns is the rest: a title is a line, so anything
//! that could turn one into several is refused rather than passed to the window (N57).

use tauri::{Manager, Runtime};

use crate::log;

/// Longer than any file name a title bar shows, and short enough that a pathological one cannot be
/// used to push the rest of the title off a bar. Counted in characters, not bytes: a name in a
/// script whose letters are three bytes each is not a longer name.
const MAX_TITLE_CHARS: usize = 300;

/// The window whose name this sets. One window today; named rather than assumed so a second one
/// cannot silently take this call.
const MAIN_WINDOW: &str = "main";

/// Everything the title may not contain. A newline or a carriage return would make the rest of the
/// line invisible on some window managers and would land in the X property either way.
fn is_refused(character: char) -> bool {
    character == '\n' || character == '\r' || character == '\0'
}

/// The title as it will be set, or why it will not be.
fn sanitised(title: &str) -> Result<&str, String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("it is empty".to_owned());
    }
    if trimmed.chars().count() > MAX_TITLE_CHARS {
        return Err(format!("it is longer than {MAX_TITLE_CHARS} characters"));
    }
    if trimmed.chars().any(is_refused) {
        return Err("it holds a line break".to_owned());
    }
    Ok(trimmed)
}

/// Name the main window.
///
/// A refused title is a warning and the window keeps the name it had: a window called nothing at
/// all is worse than a window called what it was called a moment ago.
#[tauri::command]
pub fn window_title_set<R: Runtime>(app: tauri::AppHandle<R>, title: String) {
    let wanted = match sanitised(&title) {
        Ok(wanted) => wanted,
        Err(why) => {
            log::warn!("title: refusing to name the window {title:?} because {why}");
            return;
        }
    };
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        // Between the last paint and the window going away, which is not a fault.
        log::info!("title: there is no {MAIN_WINDOW} window to name {wanted:?}");
        return;
    };
    if let Err(error) = window.set_title(wanted) {
        log::warn!("title: the window would not take the name {wanted:?} ({error})");
    }
}

#[cfg(test)]
mod tests {
    use super::sanitised;

    #[test]
    fn takes_an_ordinary_title() {
        assert_eq!(
            sanitised("* episode-01.ass - Sublore"),
            Ok("* episode-01.ass - Sublore")
        );
    }

    #[test]
    fn trims_the_edges() {
        assert_eq!(
            sanitised("  Untitled - Sublore  "),
            Ok("Untitled - Sublore")
        );
    }

    #[test]
    fn refuses_a_title_that_is_only_space() {
        assert!(sanitised("   ").is_err());
    }

    #[test]
    fn refuses_a_line_break_anywhere_in_it() {
        assert!(sanitised("first.srt\nsecond.srt - Sublore").is_err());
        assert!(sanitised("first.srt\r - Sublore").is_err());
        assert!(sanitised("first.srt\0 - Sublore").is_err());
    }

    #[test]
    fn counts_characters_and_not_bytes() {
        // Three hundred of a three-byte letter is three hundred characters, so it is allowed.
        let long_name = "\u{4e00}".repeat(300);
        assert!(sanitised(&long_name).is_ok());
        assert!(sanitised(&"a".repeat(301)).is_err());
    }
}
