//! The Help menu's three browser links. The webview names a place, never a URL.
//!
//! Interface-spec §3.8: Project website and Report a bug open the user's default browser. That is
//! the browser's network request and not Sublore's, so it is in scope where CLAUDE.md §1's own list
//! of allowed calls is not (help-menu-tasks.md). The command takes a key and the URL is a constant
//! here, so nothing the webview says can name an arbitrary address to launch.

use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::log;

/// Sublore's home on the web until a dedicated site exists (help-menu-tasks.md, a stated assumption
/// the owner changes in this one line).
const WEBSITE_URL: &str = "https://github.com/Athanor-Lab/SubLore";
/// Where a bug report goes today.
const BUGS_URL: &str = "https://github.com/Athanor-Lab/SubLore/issues";
/// The manual, which lives in the repository until a documentation site exists (manual-tasks.md,
/// a stated assumption the owner changes in this one line).
const MANUAL_URL: &str = "https://github.com/Athanor-Lab/SubLore/blob/main/docs/manual.md";

/// Which Help link to open. A closed set on purpose: the webview picks a place, never a URL.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HelpLink {
    Website,
    Bugs,
    Manual,
}

impl HelpLink {
    fn url(self) -> &'static str {
        match self {
            HelpLink::Website => WEBSITE_URL,
            HelpLink::Bugs => BUGS_URL,
            HelpLink::Manual => MANUAL_URL,
        }
    }
}

/// Open one of the Help links in the user's default browser.
///
/// The URL is logged before it is opened, so a run under Xvfb with no browser still proves which
/// address was asked for (help-menu-tasks.md H2). A launcher that fails is a warning, not a crash: a
/// browser that will not open is the user's to fix and never Sublore's to fall over on.
#[tauri::command]
pub fn open_help_link(app: AppHandle, which: HelpLink) {
    let url = which.url();
    log::info!("help: opening {url} in the default browser");
    if let Err(error) = app.opener().open_url(url, None::<&str>) {
        log::warn!("help: the browser would not open for {url} ({error})");
    }
}
