//! The colour under a pixel of the screen, asked of the desktop rather than read off it.
//!
//! The reference has two implementations and takes the portal wherever it can, falling back to a
//! screen grab only where no portal exists. The portal is also the only correct answer here:
//! Sublore forces `GDK_BACKEND=x11`, so it runs under XWayland, and an X11 grab sees X windows and
//! not Wayland-native ones. It would answer with a colour off the wrong picture and say nothing.
//!
//! So there is no fallback. Where no portal answers, the command says the eyedropper is unavailable
//! and nothing changes, which is a smaller feature and an honest one. See BACKLOG.md N54.

use serde::Serialize;

/// What the picker gets back. A closed set: the panel draws one of exactly these.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Picked {
    /// The colour that was clicked, as `#RRGGBB`, which is the shape the picker's field takes.
    Colour { hex: String },
    /// The portal was closed without a choice. Not a failure and nothing to say.
    Cancelled,
    /// No portal, or it refused. The panel says so; nothing changes.
    Unavailable { reason: String },
}

/// Three doubles from 0 to 1, as a portal answers, into the bytes a colour is written with.
///
/// Rounded rather than truncated, so a half is 128 and not 127, and clamped rather than wrapped,
/// because a portal answering outside the range is one to disbelieve, not to overflow on.
pub fn hex_from_portal(red: f64, green: f64, blue: f64) -> String {
    let byte = |value: f64| -> u8 {
        let scaled = if value.is_nan() {
            0.0
        } else {
            value.clamp(0.0, 1.0)
        };
        (scaled * 255.0).round() as u8
    };
    format!("#{:02X}{:02X}{:02X}", byte(red), byte(green), byte(blue))
}

#[cfg(target_os = "linux")]
mod portal {
    use std::collections::HashMap;
    use std::time::Duration;

    use futures_util::StreamExt;
    use zbus::zvariant::{OwnedValue, Value};
    use zbus::{proxy, Connection};

    use super::{hex_from_portal, Picked};
    use crate::log;

    /// Long, because a person is choosing a pixel; bounded, because a portal that never answers
    /// must not hold a command open for the rest of the session.
    const PICK_TIMEOUT: Duration = Duration::from_secs(120);

    #[proxy(
        interface = "org.freedesktop.portal.Screenshot",
        default_service = "org.freedesktop.portal.Desktop",
        default_path = "/org/freedesktop/portal/desktop"
    )]
    trait Screenshot {
        fn pick_color(
            &self,
            parent_window: &str,
            options: HashMap<&str, Value<'_>>,
        ) -> zbus::Result<zbus::zvariant::OwnedObjectPath>;
    }

    #[proxy(
        interface = "org.freedesktop.portal.Request",
        default_service = "org.freedesktop.portal.Desktop"
    )]
    trait Request {
        #[zbus(signal)]
        fn response(&self, code: u32, results: HashMap<String, OwnedValue>) -> zbus::Result<()>;
    }

    pub async fn pick() -> Picked {
        match ask().await {
            Ok(picked) => picked,
            Err(error) => {
                log::warn!("eyedropper: the desktop portal did not answer ({error})");
                Picked::Unavailable {
                    reason: error.to_string(),
                }
            }
        }
    }

    async fn ask() -> zbus::Result<Picked> {
        log::info!("eyedropper: asking org.freedesktop.portal.Screenshot for a colour");
        let connection = Connection::session().await?;
        let screenshot = ScreenshotProxy::new(&connection).await?;

        // No parent window handle: under XWayland there is no portable one to give, and a portal
        // reads an empty string as "no parent" rather than refusing the request.
        let request = screenshot.pick_color("", HashMap::new()).await?;
        let listener = RequestProxy::builder(&connection)
            .path(request)?
            .build()
            .await?;
        let mut answers = listener.receive_response().await?;

        // Spawned on the runtime that has a timer. A task that cannot be joined and one that timed
        // out are the same outcome here, and both read as unavailable.
        let waited = tauri::async_runtime::spawn(async move {
            tokio::time::timeout(PICK_TIMEOUT, answers.next())
                .await
                .ok()
                .flatten()
        })
        .await;
        let answer = match waited {
            Ok(Some(answer)) => answer,
            Ok(None) => {
                return Ok(Picked::Unavailable {
                    reason: "the portal did not answer".to_owned(),
                })
            }
            Err(_) => {
                return Ok(Picked::Unavailable {
                    reason: "the eyedropper's own task could not be joined".to_owned(),
                })
            }
        };

        let args = answer.args()?;
        // 0 is a choice, 1 is the portal being closed, anything else is the portal refusing.
        if args.code != 0 {
            log::info!(
                "eyedropper: the portal answered {} rather than a colour",
                args.code
            );
            return Ok(Picked::Cancelled);
        }
        let Some(colour) = args.results.get("color") else {
            return Ok(Picked::Unavailable {
                reason: "the portal answered without a colour".to_owned(),
            });
        };
        let Ok((red, green, blue)) = <(f64, f64, f64)>::try_from(colour.clone()) else {
            return Ok(Picked::Unavailable {
                reason: "the portal's colour is not three numbers".to_owned(),
            });
        };
        let hex = hex_from_portal(red, green, blue);
        log::info!("eyedropper: the portal answered {hex}");
        Ok(Picked::Colour { hex })
    }
}

/// Ask the desktop for a colour. Never called except from the picker's own button.
///
/// Linux only, because the portal is. Anywhere else the panel is told there is none, which is the
/// same answer a Linux desktop without a portal gives and the one the panel already draws, so the
/// Windows compile stays green without claiming a Windows behaviour.
#[tauri::command]
pub async fn eyedropper_pick() -> Picked {
    #[cfg(target_os = "linux")]
    {
        portal::pick().await
    }
    #[cfg(not(target_os = "linux"))]
    {
        Picked::Unavailable {
            reason: "the eyedropper asks a desktop portal, which this platform has not got"
                .to_owned(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::hex_from_portal;

    /// The ends and the middle, and the middle is the one that catches a truncation (E4).
    #[test]
    fn three_doubles_become_the_bytes_a_colour_is_written_with() {
        assert_eq!(hex_from_portal(0.0, 0.0, 0.0), "#000000");
        assert_eq!(hex_from_portal(1.0, 1.0, 1.0), "#FFFFFF");
        assert_eq!(
            hex_from_portal(0.5, 0.5, 0.5),
            "#808080",
            "half is 128, not 127"
        );
        assert_eq!(hex_from_portal(1.0, 0.0, 0.0), "#FF0000");
    }

    /// A portal answering outside the range is one to disbelieve, not to overflow on (E4).
    #[test]
    fn a_value_outside_the_range_comes_back_inside() {
        assert_eq!(hex_from_portal(-1.0, 2.0, f64::NAN), "#00FF00");
    }
}
