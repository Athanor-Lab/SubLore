//! The update check: one request, and only when the user presses for it (interface-spec §3.8).
//!
//! This is the second place in Sublore that opens a socket, beside the model download in
//! `sublore-asr`. Both are behind an explicit press and neither runs on its own: CLAUDE.md §1
//! allows exactly these calls, and nothing here is scheduled, retried in the background, or run at
//! startup. The reference checks automatically behind a preference; that half stays out.
//!
//! The address is a constant, so the webview asks for a check and never for a URL.

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::log;

/// Where the newest release is described. The repository's own, until a site exists that answers
/// this better (update-check-tasks.md, a stated assumption the owner changes in this one line).
const RELEASES_URL: &str = "https://api.github.com/repos/Athanor-Lab/SubLore/releases/latest";

/// The endpoint the battery points at a stand-in, so a run never reaches the real network. Read
/// once here rather than threaded through the command, the way `SUBLORE_TEST_MODEL_DIR` is.
const ENDPOINT_ENV: &str = "SUBLORE_UPDATE_ENDPOINT";

/// Long enough for a slow link, short enough that a dead server is not forever. The whole exchange
/// is small, so unlike the model download there is nothing here worth waiting minutes for.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(15);

/// The page of the newest release the last check found, if it found one.
///
/// Kept here rather than handed to the webview and back: the panel says "open what you found", the
/// same way the Help links name a place. A URL that has been through the webview is a URL the
/// webview could have chosen.
static FOUND: Mutex<Option<String>> = Mutex::new(None);

/// What the check found. A closed set, because the panel draws one of exactly these three.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Verdict {
    /// Nothing newer than what is running, which includes a project with no releases at all.
    UpToDate,
    /// A newer release, named, with the page describing it.
    Newer { version: String, url: String },
    /// The check did not happen. The app is fine; the answer is unknown.
    Failed { reason: String },
}

/// The two fields of a release this reads. Everything else the endpoint sends is ignored.
#[derive(Debug, Deserialize)]
struct Release {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    html_url: String,
}

/// `v1.2.3` and `1.2.3` both read as (1, 2, 3). Anything else reads as nothing, which is how a tag
/// that is not a version stays out of the answer instead of being offered as one.
fn version_of(tag: &str) -> Option<(u64, u64, u64)> {
    let digits = tag.trim().strip_prefix('v').unwrap_or(tag.trim());
    let mut parts = digits.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    // A patch may carry a suffix a release names, `3-rc1`, and the numbers before it are the
    // version. A suffix does not make one release newer than another here: v1 has no pre-releases.
    let patch = parts
        .next()?
        .split(|c: char| !c.is_ascii_digit())
        .next()?
        .parse()
        .ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

/// What the running app is, from its own package version.
fn running() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

fn endpoint() -> String {
    std::env::var(ENDPOINT_ENV).unwrap_or_else(|_| RELEASES_URL.to_owned())
}

/// Read a release document into a verdict. Split out from the request so every shape of answer is
/// covered by a test that opens no socket.
fn verdict_from(body: &str, running: &str) -> Verdict {
    let release = match serde_json::from_str::<Release>(body) {
        Ok(release) => release,
        Err(error) => {
            log::warn!("update: the answer is not a release document ({error})");
            return Verdict::UpToDate;
        }
    };
    let (Some(found), Some(here)) = (version_of(&release.tag_name), version_of(running)) else {
        log::warn!(
            "update: {:?} against {running:?} is not a pair of versions, so nothing is offered",
            release.tag_name
        );
        return Verdict::UpToDate;
    };
    if found <= here {
        return Verdict::UpToDate;
    }
    let url = if release.html_url.is_empty() {
        RELEASES_URL.to_owned()
    } else {
        release.html_url
    };
    Verdict::Newer {
        version: release.tag_name.clone(),
        url,
    }
}

/// The one request. Blocking, on the thread Tauri gives a blocking command, so the window keeps
/// answering while it is in flight.
fn ask(url: &str) -> Verdict {
    let config = ureq::Agent::config_builder()
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .timeout_recv_response(Some(RESPONSE_TIMEOUT))
        // Statuses are read rather than thrown, because a 404 is not a failure here: a project with
        // no releases yet answers exactly that, and the honest reading is "nothing newer".
        .http_status_as_error(false)
        .user_agent(concat!("Sublore/", env!("CARGO_PKG_VERSION")))
        .build();
    let agent = ureq::Agent::new_with_config(config);

    log::info!(
        "update: asking {url} whether there is anything newer than {}",
        running()
    );
    let mut response = match agent.get(url).header("Accept", "application/json").call() {
        Ok(response) => response,
        Err(error) => {
            log::warn!("update: {url} could not be reached ({error})");
            return Verdict::Failed {
                reason: error.to_string(),
            };
        }
    };

    let status = response.status().as_u16();
    if status == 404 {
        log::info!("update: {url} has no releases yet, so there is nothing newer");
        return Verdict::UpToDate;
    }
    if !(200..300).contains(&status) {
        log::warn!("update: {url} answered {status}");
        return Verdict::Failed {
            reason: format!("the server answered {status}"),
        };
    }
    match response.body_mut().read_to_string() {
        Ok(body) => verdict_from(&body, running()),
        Err(error) => {
            log::warn!("update: the answer from {url} could not be read ({error})");
            Verdict::Failed {
                reason: error.to_string(),
            }
        }
    }
}

/// Check once. Never called except from the Help menu's own command.
#[tauri::command]
pub async fn update_check() -> Verdict {
    let url = endpoint();
    let verdict = tauri::async_runtime::spawn_blocking(move || ask(&url))
        .await
        .unwrap_or_else(|error| {
            log::warn!("update: the check could not be run ({error})");
            Verdict::Failed {
                reason: error.to_string(),
            }
        });
    // What a later press may open, replaced every check so a stale page is never the one offered.
    *FOUND.lock().unwrap_or_else(|poison| poison.into_inner()) = match &verdict {
        Verdict::Newer { url, .. } => Some(url.clone()),
        _ => None,
    };
    verdict
}

/// Open the page of the release the last check found. Nothing happens when the last check found
/// none, which is the same greying the command itself carries.
#[tauri::command]
pub fn update_open_release(app: AppHandle) {
    let found = FOUND
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone();
    let Some(url) = found else {
        log::warn!("update: there is no release page to open");
        return;
    };
    log::info!("update: opening {url} in the default browser");
    if let Err(error) = app.opener().open_url(&url, None::<&str>) {
        log::warn!("update: the browser would not open for {url} ({error})");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tags a release really carries, and the ones that are not versions at all (U6).
    #[test]
    fn a_tag_reads_as_a_version_or_as_nothing() {
        assert_eq!(version_of("v1.2.3"), Some((1, 2, 3)));
        assert_eq!(version_of("1.2.3"), Some((1, 2, 3)));
        assert_eq!(version_of(" v0.1.0 "), Some((0, 1, 0)));
        assert_eq!(version_of("v1.2.3-rc1"), Some((1, 2, 3)));
        for tag in ["", "v", "nightly", "v1", "v1.2", "v1.2.3.4", "vx.y.z"] {
            assert_eq!(version_of(tag), None, "{tag:?}");
        }
    }

    /// A higher release is the only thing offered (U3, U6).
    #[test]
    fn only_something_newer_is_offered() {
        let newer = verdict_from(r#"{"tag_name":"v0.2.0","html_url":"https://x/y"}"#, "0.1.0");
        assert_eq!(
            newer,
            Verdict::Newer {
                version: "v0.2.0".to_owned(),
                url: "https://x/y".to_owned(),
            }
        );
        for body in [
            r#"{"tag_name":"v0.1.0","html_url":"https://x/y"}"#,
            r#"{"tag_name":"v0.0.9","html_url":"https://x/y"}"#,
            r#"{"tag_name":"nightly","html_url":"https://x/y"}"#,
            r#"{"tag_name":""}"#,
            "not json at all",
            "{}",
        ] {
            assert_eq!(verdict_from(body, "0.1.0"), Verdict::UpToDate, "{body:?}");
        }
    }

    /// A release with no page of its own still points somewhere real.
    #[test]
    fn a_release_with_no_page_falls_back_to_the_releases_address() {
        assert_eq!(
            verdict_from(r#"{"tag_name":"v9.9.9"}"#, "0.1.0"),
            Verdict::Newer {
                version: "v9.9.9".to_owned(),
                url: RELEASES_URL.to_owned(),
            }
        );
    }
}
