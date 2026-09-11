//! Reading the subtitles a video carries inside it (N116).
//!
//! mpv lists the streams and says which ffmpeg index each one is; ffmpeg writes the one that was
//! asked for to a pipe. The video is named once, after `-i`, where it can only be read: nothing is
//! written beside the user's file (CONTRIBUTING.md §3.1).

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};

use sublore_formats::SubtitleFormat;

use super::error::{SubtitleError, SubtitleErrorCode};
use super::MAX_SUBTITLE_BYTES;

/// Which format a stream of this codec is written out as, or `None` when it holds no text.
///
/// An allow list and not a deny list: a codec nobody here has seen stays out instead of becoming a
/// `-map` argument that fails halfway through. The picture codecs, `hdmv_pgs_subtitle` and the
/// `dvd_subtitle` family, are exactly what this keeps out: they carry bitmaps and there is no text
/// in them to open.
pub fn openable_format(codec: &str) -> Option<SubtitleFormat> {
    match codec {
        "ass" | "ssa" => Some(SubtitleFormat::Ass),
        "webvtt" | "vtt" => Some(SubtitleFormat::Vtt),
        "subrip" | "srt" | "text" | "mov_text" => Some(SubtitleFormat::Srt),
        _ => None,
    }
}

/// How much of ffmpeg's complaint is kept for the log. The head of it: a failure longer than this
/// says nothing its first lines did not.
const STDERR_HEAD_BYTES: usize = 4096;

/// Read a pipe to its end and answer the head of what it held. Never fails: a pipe that will not
/// read has no detail to give, and the exit status is still the verdict.
fn head_of(mut pipe: impl Read) -> String {
    let mut kept: Vec<u8> = Vec::new();
    let mut buffer = [0u8; 1024];
    loop {
        match pipe.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                let room = STDERR_HEAD_BYTES.saturating_sub(kept.len());
                kept.extend_from_slice(&buffer[..read.min(room)]);
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    String::from_utf8_lossy(&kept).trim().to_owned()
}

/// The name ffmpeg's muxer goes by for a format of ours.
fn muxer(format: SubtitleFormat) -> &'static str {
    match format {
        SubtitleFormat::Ass => "ass",
        SubtitleFormat::Vtt => "webvtt",
        SubtitleFormat::Srt => "srt",
    }
}

/// Write stream `ff_index` of `media` out as `format`, and answer its bytes.
///
/// `ffmpeg` is the program to run, discovered by the caller, the same way the waveform discovers
/// it. The encoder is the muxer's own and is not named here: `-c:s copy` is what a stream whose
/// codec already matches would want, and it refuses the ones that need converting, `mov_text` into
/// SRT among them. Measured on 2026-09-11: an ASS stream written through the ASS muxer comes back
/// with its `[V4+ Styles]` block and its override tags intact, so nothing is lost by letting the
/// muxer choose.
pub fn extract(
    ffmpeg: &Path,
    media: &Path,
    ff_index: u32,
    format: SubtitleFormat,
) -> Result<Vec<u8>, SubtitleError> {
    // The path comes from the player's own state, so it is checked here rather than trusted: a
    // media removed since it was opened is a missing file, not a failed extraction.
    if !media.is_file() {
        return Err(SubtitleError::new(
            SubtitleErrorCode::NotAFile,
            format!("{} is not a file", media.display()),
        ));
    }

    let map = format!("0:{ff_index}");
    let mut child = Command::new(ffmpeg)
        .arg("-nostdin")
        .arg("-hide_banner")
        .args(["-loglevel", "error"])
        .arg("-i")
        .arg(media)
        .args(["-vn", "-an", "-dn"])
        .args(["-map", &map])
        .args(["-f", muxer(format)])
        .arg("-")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            SubtitleError::new(
                SubtitleErrorCode::ExtractionFailed,
                format!("{} would not start: {error}", ffmpeg.display()),
            )
        })?;

    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        let _ = child.kill();
        return Err(SubtitleError::new(
            SubtitleErrorCode::ExtractionFailed,
            "the pipes to ffmpeg were not there to read",
        ));
    };

    // stderr is drained on a thread of its own while stdout is read, the way the waveform's own
    // extraction does it: a child that filled the stderr pipe would stop writing stdout and the
    // read below would never end.
    let mut bytes = Vec::new();
    let (taken, complaint) = std::thread::scope(|scope| {
        let draining = scope.spawn(|| head_of(stderr));
        // Capped: a stream Sublore could not open again must not be built here either, and an
        // unbounded read would hold whatever the container holds.
        let taken = stdout.take(MAX_SUBTITLE_BYTES + 1).read_to_end(&mut bytes);
        (taken, draining.join().unwrap_or_default())
    });
    let status = child.wait().map_err(|error| {
        SubtitleError::new(
            SubtitleErrorCode::ExtractionFailed,
            format!("{} would not finish: {error}", ffmpeg.display()),
        )
    })?;
    taken.map_err(|error| {
        SubtitleError::new(
            SubtitleErrorCode::ExtractionFailed,
            format!("reading from {} failed: {error}", ffmpeg.display()),
        )
    })?;

    // Read before the exit status, and that order is the point: the cap stops reading and the pipe
    // closes under ffmpeg, which then dies of it. Asking the status first would call a stream that
    // is too big a failed extraction and say the wrong thing about it.
    if bytes.len() as u64 > MAX_SUBTITLE_BYTES {
        return Err(SubtitleError::new(
            SubtitleErrorCode::TooLarge,
            format!("over {MAX_SUBTITLE_BYTES} bytes"),
        ));
    }
    if !status.success() {
        return Err(SubtitleError::new(
            SubtitleErrorCode::ExtractionFailed,
            format!("ffmpeg {status}: {complaint}"),
        ));
    }
    if bytes.is_empty() {
        return Err(SubtitleError::new(
            SubtitleErrorCode::ExtractionFailed,
            format!("ffmpeg wrote nothing for stream {ff_index}"),
        ));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_text_codecs_are_openable_and_each_names_its_own_format() {
        assert_eq!(openable_format("ass"), Some(SubtitleFormat::Ass));
        assert_eq!(openable_format("ssa"), Some(SubtitleFormat::Ass));
        assert_eq!(openable_format("webvtt"), Some(SubtitleFormat::Vtt));
        assert_eq!(openable_format("subrip"), Some(SubtitleFormat::Srt));
        assert_eq!(openable_format("mov_text"), Some(SubtitleFormat::Srt));
    }

    /// The half the battery cannot reach: ffmpeg will not build a picture subtitle out of a text
    /// one, so no fixture can carry one. See docs/open-from-video-tasks.md V2.
    #[test]
    fn a_picture_track_and_an_unknown_name_are_not_openable() {
        assert_eq!(openable_format("hdmv_pgs_subtitle"), None);
        assert_eq!(openable_format("dvd_subtitle"), None);
        assert_eq!(openable_format("dvb_subtitle"), None);
        assert_eq!(openable_format("xsub"), None);
        assert_eq!(openable_format("something_new"), None);
        assert_eq!(openable_format(""), None);
    }

    /// Codec names arrive from mpv in lower case, and an allow list that matched loosely would let
    /// a picture codec through on a container that spelled it differently.
    #[test]
    fn the_allow_list_matches_the_whole_name_and_matches_it_exactly() {
        assert_eq!(openable_format("ASS"), None);
        assert_eq!(openable_format("subrip2"), None);
        assert_eq!(openable_format(" subrip"), None);
    }

    #[test]
    fn a_media_that_is_not_there_is_a_missing_file_and_not_a_failed_extraction() {
        let error = extract(
            Path::new("ffmpeg"),
            Path::new("/nonexistent-sublore-media.mkv"),
            2,
            SubtitleFormat::Srt,
        )
        .expect_err("a media that does not exist cannot be extracted from");
        assert_eq!(error.code, SubtitleErrorCode::NotAFile);
    }
}
