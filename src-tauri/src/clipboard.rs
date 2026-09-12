//! The system clipboard, which the page cannot reach on its own.
//!
//! Measured on 2026-09-07: WebKitGTK answers `navigator.clipboard.writeText` and `readText` with
//! `NotAllowedError` inside the app's own page, both of them, so every copy and paste has to go
//! through here. On Linux that is GTK's own clipboard, which is already linked because Tauri pulls
//! `gtk` in on this platform; nothing new is downloaded for it.
//!
//! Windows is not implemented and says so rather than pretending: under the 2026-09-04 ruling the
//! behavioural suite is Linux only and no Windows behaviour is claimed, so a stub that returns an
//! error is honest where a stub that silently succeeds would not be. See BACKLOG.md.

use crate::log;

/// Put text on the clipboard. Blocking, and it must run where GTK's own loop runs.
#[cfg(target_os = "linux")]
fn write_text(text: &str) -> Result<(), String> {
    let display =
        gtk::gdk::Display::default().ok_or_else(|| "no display to copy through".to_owned())?;
    let clipboard = gtk::Clipboard::default(&display)
        .ok_or_else(|| "this display has no clipboard".to_owned())?;
    clipboard.set_text(text);
    // Without this the text is gone the moment the app exits, and a copy a user made before
    // quitting is exactly the one they meant to keep.
    clipboard.store();
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn write_text(_text: &str) -> Result<(), String> {
    Err("the clipboard is not implemented on this platform yet".to_owned())
}

/// Read the clipboard's text, or an empty string when it holds none.
#[cfg(target_os = "linux")]
fn read_text() -> Result<String, String> {
    let display =
        gtk::gdk::Display::default().ok_or_else(|| "no display to read from".to_owned())?;
    let clipboard = gtk::Clipboard::default(&display)
        .ok_or_else(|| "this display has no clipboard".to_owned())?;
    Ok(clipboard
        .wait_for_text()
        .map(String::from)
        .unwrap_or_default())
}

#[cfg(not(target_os = "linux"))]
fn read_text() -> Result<String, String> {
    Err("the clipboard is not implemented on this platform yet".to_owned())
}

/// Run one clipboard call where GTK's loop runs, and wait for its answer.
///
/// The call is short and the channel is what carries the result back, because `run_on_main_thread`
/// takes a closure that answers nothing and a copy that silently did not happen is the worst of
/// the failures this could have.
fn on_main_thread<T, F>(app: &tauri::AppHandle, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let (tell, hear) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tell.send(work());
    })
    .map_err(|error| format!("the clipboard call could not be scheduled: {error}"))?;
    hear.recv()
        .map_err(|error| format!("the clipboard call answered nothing: {error}"))?
}

/// Test hook: make the write refuse without reaching GTK, so a check can see what the app says when
/// the clipboard will not take the text. Debug builds only, like the close gate's own delay hook.
#[cfg(debug_assertions)]
fn refuses() -> bool {
    const ENV_VAR: &str = "SUBLORE_CLIPBOARD_REFUSES";

    if std::env::var(ENV_VAR).as_deref() != Ok("1") {
        return false;
    }
    log::warn!("clipboard: {ENV_VAR}=1, refusing the write");
    true
}

/// Release builds carry no hook: the environment variable is never read.
#[cfg(not(debug_assertions))]
#[inline(always)]
fn refuses() -> bool {
    false
}

#[tauri::command]
pub async fn clipboard_write(app: tauri::AppHandle, text: String) -> Result<(), String> {
    let outcome = if refuses() {
        Err("the clipboard refused the text".to_owned())
    } else {
        on_main_thread(&app, move || write_text(&text))
    };
    if let Err(error) = &outcome {
        log::warn!("clipboard: the copy failed: {error}");
    }
    outcome
}

#[tauri::command]
pub async fn clipboard_read(app: tauri::AppHandle) -> Result<String, String> {
    let outcome = on_main_thread(&app, read_text);
    if let Err(error) = &outcome {
        log::warn!("clipboard: the read failed: {error}");
    }
    outcome
}
