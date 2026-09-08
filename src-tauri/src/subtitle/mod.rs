//! One open subtitle file and the commands that edit it. The session lives here, behind a mutex,
//! because the document is the authority on its own bytes: the frontend holds a list of rows and a
//! revision number, never a second model. The IPC names and payloads here are a public interface
//! (CONTRIBUTING.md section 6). See BACKLOG.md M2.3.

pub mod error;

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use sublore_edit::diff::{CuePatch, CueView};
use sublore_edit::history::Run;
use sublore_edit::plan::{self, AssStyleField, Edit};
use sublore_edit::session::EditSession;
use sublore_formats::override_tags::StyleFlag;
use sublore_formats::{
    parse, AssField, Newline, ScriptInfo, Segment, SegmentKind, SubtitleDocument, SubtitleFormat,
};
use sublore_io::atomic::save_with_backup;
use sublore_io::backup::BackupStore;
use tauri::{AppHandle, Manager, State};

use crate::asr::AsrState;
use crate::dialog::CloseAnswer;
use error::{SubtitleError, SubtitleErrorCode};

/// Bigger than any subtitle file that exists. A user who points at a 4 GB video gets a sentence
/// rather than an out-of-memory kill.
pub const MAX_SUBTITLE_BYTES: u64 = 16 * 1024 * 1024;

/// Backups live under Sublore's own data directory, never beside the user's file (CONTRIBUTING.md §3.5).
const BACKUP_DIR: &str = "backups";

/// The one open file, or none. A plain `Mutex`: every command body runs inside `spawn_blocking`,
/// so the guard is never held across an await.
pub type SessionSlot = Mutex<Option<EditSession>>;

/// The two documents a translator has open: the one being written, and the one being read from.
///
/// They are two slots and not one with a flag, so that no edit can reach the source by taking the
/// wrong branch: every mutating command asks for `slot()` and there is no command anywhere that
/// asks for `source_slot()` and then writes. See side-by-side-tasks.md S1.
#[derive(Default)]
pub struct SubtitleState {
    session: Arc<SessionSlot>,
    source: Arc<SessionSlot>,
}

impl SubtitleState {
    /// A handle the blocking half of a command can own, as `VideoState` hands out its player.
    // TODO(M2.6): narrow back to private. Public only so the close gate in `lib.rs` can read the
    // session.
    pub fn slot(&self) -> Arc<SessionSlot> {
        Arc::clone(&self.session)
    }

    /// The document being read from. Opened and closed and never written to.
    fn source_slot(&self) -> Arc<SessionSlot> {
        Arc::clone(&self.source)
    }

    /// Which of the two the frame should draw. `source` is the View toggle asking for the document
    /// being read; it gets one only while there is one, so a toggle left on when the source closes
    /// draws the translation rather than nothing. The only way out of here to the source, and it
    /// is named for drawing so that nothing reaches for it to write. See side-by-side-tasks.md S3.
    pub fn drawn_slot(&self, source: bool) -> Arc<SessionSlot> {
        if source
            && self
                .source
                .lock()
                .map(|guard| guard.is_some())
                .unwrap_or(false)
        {
            return Arc::clone(&self.source);
        }
        Arc::clone(&self.session)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleSummary {
    /// Where the document came from, or none while it has never had a file (BACKLOG.md M3.5).
    pub path: Option<String>,
    /// "srt" | "vtt" | "ass".
    pub format: String,
    /// Cues a player would draw; ASS `Comment:` events are not among them.
    pub cue_count: usize,
    pub has_bom: bool,
    /// "lf" | "crlf" | "mixed" | "none".
    pub newline: String,
    pub byte_length: u64,
    /// The styles the ASS section declares, in its own order. Empty for every other format, and for
    /// an ASS with no styles section: a control that offers them is greyed on both.
    pub styles: Vec<AssStyleDto>,
}

/// One declared style as an editor reads it: every value the file's own spelling, and the four
/// flags as booleans because that is what a line's override tags start from. See edit-bar B9.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssStyleDto {
    pub name: String,
    pub fontname: String,
    pub fontsize: String,
    pub primary: String,
    pub secondary: String,
    pub outline: String,
    pub back: String,
    /// The rest of what a style declares, as the file spells each. `outline_width` and `shadow`
    /// are the border's width and the shadow's depth, not the two colour columns above them.
    pub scale_x: String,
    pub scale_y: String,
    pub spacing: String,
    pub angle: String,
    pub border_style: String,
    pub outline_width: String,
    pub shadow: String,
    pub alignment: String,
    pub margin_l: String,
    pub margin_r: String,
    pub margin_v: String,
    pub encoding: String,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strikeout: bool,
}

/// A row of the cue list. Its index is its position in the list, so a patch that moves rows can
/// never leave a stale index behind on the rows it did not resend.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CueRowDto {
    pub start_ms: u32,
    pub end_ms: u32,
    /// Line breaks are always "\n" here, whatever the file uses.
    pub text: String,
    /// An ASS `Comment:` event: listed and editable, but not a line a player draws.
    pub comment: bool,
    /// The cue's own number, when the file wrote one. Never renumbered.
    pub number: Option<u32>,
    /// The ASS style the event names, empty when the format declares none and for SRT and VTT.
    pub style: String,
    /// The ASS `Name` (or `Actor`) field, under the same rule.
    pub actor: String,
    /// The ASS `Effect` field, under the same rule.
    pub effect: String,
    /// The ASS `Layer` field as the file spells it, not as a number: `"0000"` stays `"0000"` and a
    /// value that is no integer at all stays itself. See styles-and-fields-tasks.md F2.
    pub layer: String,
    /// The ASS `MarginL` field, under the same rule as the layer.
    pub margin_l: String,
    /// The ASS `MarginR` field, under the same rule as the layer.
    pub margin_r: String,
    /// The ASS `MarginV` field, under the same rule as the layer.
    pub margin_v: String,
    /// Which of the seven this row's own `Format:` line declares, spelled the way
    /// `subtitle_set_field` takes them. A blank declared field and a field the line never declared
    /// both carry `""`, so this is what tells them apart and what a control reads to know whether
    /// it may be used: a write to a field absent from this list is refused and moves no byte.
    /// Empty for SRT and VTT. See styles-and-fields-tasks.md F2.
    pub declared_fields: Vec<AssFieldDto>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleOpened {
    pub summary: SubtitleSummary,
    pub revision: u64,
    /// Every cue, in `cues()` order: ASS comments included, unlike `summary.cue_count`.
    pub cues: Vec<CueRowDto>,
    pub can_undo: bool,
    pub can_redo: bool,
    pub dirty: bool,
    pub truncated: bool,
}

/// One contiguous run of rows replaced by another, plus the state that changed with it. Every
/// mutation, undo and redo answers with one of these, so the UI has a single reply shape.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CuePatchDto {
    pub revision: u64,
    pub from: usize,
    pub removed: usize,
    pub cues: Vec<CueRowDto>,
    /// For the status line: ASS `Comment:` events excluded, as at open.
    pub cue_count: usize,
    pub can_undo: bool,
    pub can_redo: bool,
    pub dirty: bool,
    pub truncated: bool,
    /// The styles as they stand. On every patch because a style write changes no cue, so nothing
    /// else in this shape would tell the interface that one moved.
    pub styles: Vec<AssStyleDto>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleSaved {
    pub path: String,
    pub bytes_written: u64,
    /// Absent when the destination did not exist before.
    pub backup_path: Option<String>,
    /// Whether the document still holds edits that are not on disk. A copy written elsewhere leaves
    /// a file-backed document unsaved and an untitled one saved, so the write reports it rather
    /// than the UI guessing. See BACKLOG.md M3.5.
    pub dirty: bool,
}

/// The script-level metadata a Properties dialog shows (interface-spec 9.5). Every field is absent
/// for a format that carries no `[Script Info]`, which is what the dialog then says of it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptInfoDto {
    pub title: Option<String>,
    pub play_res_x: Option<String>,
    pub play_res_y: Option<String>,
    pub wrap_style: Option<String>,
}

impl From<ScriptInfo> for ScriptInfoDto {
    fn from(info: ScriptInfo) -> Self {
        Self {
            title: info.title,
            play_res_x: info.play_res_x,
            play_res_y: info.play_res_y,
            wrap_style: info.wrap_style,
        }
    }
}

/// The bytes the open document would write, and what they are. What the video preview draws from,
/// and the only reader of the document that is not a save (decision 7).
pub struct DocumentBytes {
    /// "srt" | "vtt" | "ass", which is also the shadow copy's extension.
    pub format: &'static str,
    /// Cues a player would draw. None of them means there is nothing to put on a frame.
    pub cues: usize,
    /// Byte for byte what a save would put on disk.
    pub bytes: Vec<u8>,
}

/// Read the open document. `None` when none is open, and when the lock is held by a command that
/// panicked: a preview is not the place to recover a session.
pub fn open_document(slot: &SessionSlot) -> Option<DocumentBytes> {
    let guard = lock(slot).ok()?;
    let session = guard.as_ref()?;
    Some(DocumentBytes {
        format: session.document().format().as_str(),
        cues: session.document().displayed_cue_count(),
        bytes: session.to_bytes(),
    })
}

// -------------------------------------------------------------------------------------------
// Commands
// -------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn subtitle_open(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    path: String,
) -> Result<SubtitleOpened, SubtitleError> {
    let slot = state.slot();
    let opened = blocking(move || open_session(&slot, &path)).await;
    // Whatever the open did, the frame follows it: a refused open leaves the old document drawn,
    // and one that failed after clearing the session leaves nothing (decision 7).
    crate::preview::refresh(&app).await;
    opened
}

/// Open the file the user picked, decoding it as the charset they named instead of auto-detecting
/// UTF-8 (interface-spec 9.8). `label` is an `encoding_rs` charset label from the dialog's own list.
#[tauri::command]
pub async fn subtitle_open_with_encoding(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    path: String,
    label: String,
) -> Result<SubtitleOpened, SubtitleError> {
    let slot = state.slot();
    let opened = blocking(move || open_session_with_encoding(&slot, &path, &label)).await;
    // The frame follows the open exactly as it does for plain open above.
    crate::preview::refresh(&app).await;
    opened
}

/// Open the document to read from, beside the one being written. It is never edited and never
/// saved, so it has no dirty state to guard and replacing it loses nothing. See S1.
#[tauri::command]
pub async fn subtitle_open_source(
    state: State<'_, SubtitleState>,
    path: String,
) -> Result<SubtitleOpened, SubtitleError> {
    let slot = state.source_slot();
    blocking(move || open_session(&slot, &path)).await
}

/// Close the document being read from. The frame draws the target, so nothing on screen moves with
/// it, and the target is left exactly as it was.
#[tauri::command]
pub async fn subtitle_close_source(state: State<'_, SubtitleState>) -> Result<(), SubtitleError> {
    let slot = state.source_slot();
    // Discarding is free here and not a choice made for the user: nothing ever wrote to it.
    blocking(move || close_session(&slot, true)).await
}

/// A translation that starts from the source: every cue and every timing carried over, all the
/// text empty, and no file behind it until the first save. See side-by-side-tasks.md S2.
#[tauri::command]
pub async fn subtitle_new_translation(
    app: AppHandle,
    state: State<'_, SubtitleState>,
) -> Result<SubtitleOpened, SubtitleError> {
    let source = state.source_slot();
    let target = state.slot();
    let made = blocking(move || new_translation(&source, &target)).await;
    // A new document is a new thing to draw on the frame, whether it was made or refused.
    crate::preview::refresh(&app).await;
    made
}

/// A document with nothing in it, which is what File then New opens. See interface-spec 3.1.
#[tauri::command]
pub async fn subtitle_new(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    discard: bool,
) -> Result<SubtitleOpened, SubtitleError> {
    let slot = state.slot();
    let made = blocking(move || new_document(&slot, discard)).await;
    // A new document is a new thing to draw on the frame, whether it was made or refused.
    crate::preview::refresh(&app).await;
    made
}

#[tauri::command]
pub async fn subtitle_close(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    discard: bool,
) -> Result<(), SubtitleError> {
    let slot = state.slot();
    let closed = blocking(move || close_session(&slot, discard)).await;
    crate::preview::refresh(&app).await;
    closed
}

/// One mutation, and then the frame follows it. Every mutating command goes through here, so none
/// of them can forget the preview (decision 7).
///
/// The refresh runs outside the session lock and takes it again itself, so the bytes it writes are
/// the ones the document holds then, never the ones this call happened to leave.
async fn edited(
    app: &AppHandle,
    slot: Arc<SessionSlot>,
    revision: u64,
    edit: Edit,
) -> Result<CuePatchDto, SubtitleError> {
    let patch = blocking(move || apply_edit(&slot, revision, edit)).await;
    crate::preview::refresh(app).await;
    patch
}

#[tauri::command]
pub async fn subtitle_set_text(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    revision: u64,
    cue: usize,
    text: String,
) -> Result<CuePatchDto, SubtitleError> {
    edited(&app, state.slot(), revision, Edit::SetText { cue, text }).await
}

/// One cue's new text. A list of these is one replace, and it lands as one undo step (F1).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CueTextDto {
    pub cue: usize,
    pub text: String,
}

/// One cue's new pair of times, for a write that names several at once.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CueTimesDto {
    pub cue: usize,
    pub start_ms: u32,
    pub end_ms: u32,
}

/// Several cues retimed as one undo step: what shifting a selection and making times continuous
/// both are. See docs/timing-tasks.md.
#[tauri::command]
pub async fn subtitle_set_many_times(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    revision: u64,
    edits: Vec<CueTimesDto>,
) -> Result<CuePatchDto, SubtitleError> {
    let edits = edits
        .into_iter()
        .map(|one| (one.cue, one.start_ms, one.end_ms))
        .collect();
    edited(&app, state.slot(), revision, Edit::SetManyTimes { edits }).await
}

#[tauri::command]
pub async fn subtitle_set_texts(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    revision: u64,
    edits: Vec<CueTextDto>,
) -> Result<CuePatchDto, SubtitleError> {
    let edits = edits.into_iter().map(|one| (one.cue, one.text)).collect();
    edited(&app, state.slot(), revision, Edit::SetTexts { edits }).await
}

/// Which ASS event field a write names. A closed list on the wire too: the text field is not on
/// it, and no payload can spell it. See docs/ass-field-write-tasks.md W2.
///
/// Serialized as well as deserialized, so the names a row reports as declared are the very names a
/// write takes: one list, no second spelling to drift. See styles-and-fields-tasks.md F2.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AssFieldDto {
    Style,
    Actor,
    Effect,
    Layer,
    MarginL,
    MarginR,
    MarginV,
}

impl From<AssField> for AssFieldDto {
    fn from(field: AssField) -> Self {
        match field {
            AssField::Style => AssFieldDto::Style,
            AssField::Actor => AssFieldDto::Actor,
            AssField::Effect => AssFieldDto::Effect,
            AssField::Layer => AssFieldDto::Layer,
            AssField::MarginL => AssFieldDto::MarginL,
            AssField::MarginR => AssFieldDto::MarginR,
            AssField::MarginV => AssFieldDto::MarginV,
        }
    }
}

impl From<AssFieldDto> for AssField {
    fn from(field: AssFieldDto) -> Self {
        match field {
            AssFieldDto::Style => AssField::Style,
            AssFieldDto::Actor => AssField::Actor,
            AssFieldDto::Effect => AssField::Effect,
            AssFieldDto::Layer => AssField::Layer,
            AssFieldDto::MarginL => AssField::MarginL,
            AssFieldDto::MarginR => AssField::MarginR,
            AssFieldDto::MarginV => AssField::MarginV,
        }
    }
}

/// One committed field of one cue. A field the document cannot hold is refused rather than added,
/// and the panel draws that control greyed instead of asking. See ass-field-write-tasks.md W5.
#[tauri::command]
pub async fn subtitle_set_field(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    revision: u64,
    cue: usize,
    field: AssFieldDto,
    value: String,
) -> Result<CuePatchDto, SubtitleError> {
    edited(
        &app,
        state.slot(),
        revision,
        Edit::SetField {
            cue,
            field: field.into(),
            value,
        },
    )
    .await
}

/// One of the four inline style flags, over a stretch of one cue's text. Spelled the way the
/// interface names them, so a value the enum does not hold is refused by the deserializer rather
/// than reaching the planner. See edit-bar-tasks.md B11.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StyleFlagDto {
    Bold,
    Italic,
    Underline,
    Strikeout,
}

impl From<StyleFlagDto> for StyleFlag {
    fn from(flag: StyleFlagDto) -> Self {
        match flag {
            StyleFlagDto::Bold => StyleFlag::Bold,
            StyleFlagDto::Italic => StyleFlag::Italic,
            StyleFlagDto::Underline => StyleFlag::Underline,
            StyleFlagDto::Strikeout => StyleFlag::Strikeout,
        }
    }
}

/// Turn one flag on or off over a stretch of a cue's text. `from` and `to` are byte offsets into
/// the text as the file spells it, and equal offsets are a caret rather than a selection.
#[tauri::command]
pub async fn subtitle_toggle_style(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    revision: u64,
    cue: usize,
    flag: StyleFlagDto,
    from: usize,
    to: usize,
) -> Result<CuePatchDto, SubtitleError> {
    edited(
        &app,
        state.slot(),
        revision,
        Edit::ToggleStyle {
            cue,
            flag: flag.into(),
            from,
            to,
        },
    )
    .await
}

/// The open document's script-level metadata, for the Properties dialog (interface-spec 9.5). A
/// read, so no revision and no patch: it never changes the document.
#[tauri::command]
pub async fn subtitle_script_info(
    state: State<'_, SubtitleState>,
) -> Result<ScriptInfoDto, SubtitleError> {
    let slot = state.slot();
    blocking(move || {
        let guard = lock(&slot)?;
        let session = current_ref(&guard)?;
        Ok(ScriptInfoDto::from(session.document().script_info()))
    })
    .await
}

/// The lines the named cues are written as, exactly as the file spells them, one after another.
///
/// The raw line and not the text: what a copy carries is the cue, times and fields and all, which
/// is what makes it paste back as a cue rather than as a sentence. See the clipboard's own slice.
#[tauri::command]
pub async fn subtitle_copy_cues(
    state: State<'_, SubtitleState>,
    cues: Vec<usize>,
) -> Result<String, SubtitleError> {
    let slot = state.slot();
    blocking(move || {
        let guard = lock(&slot)?;
        let session = current_ref(&guard)?;
        let document = session.document();
        let lines: Vec<&Segment> = document
            .segments()
            .iter()
            .filter(|segment| matches!(segment.kind, SegmentKind::Cue(_)))
            .collect();
        // What separates two cues, between them and not after the last: an SRT or VTT block is
        // followed by a blank line and an ASS event by nothing, and a copy of two cues that left
        // the blank out would read back as one cue with the other's words stuck to it.
        let between = match document.format() {
            SubtitleFormat::Ass => "",
            SubtitleFormat::Srt | SubtitleFormat::Vtt => match document.source().newline() {
                Newline::Crlf => "\r\n",
                Newline::Lf | Newline::Mixed | Newline::None => "\n",
            },
        };
        let mut out = String::new();
        for (written, index) in cues.into_iter().enumerate() {
            let Some(segment) = lines.get(index) else {
                return Err(SubtitleError::new(
                    SubtitleErrorCode::InvalidCue,
                    format!("no cue {index} in this document"),
                ));
            };
            if written > 0 {
                out.push_str(between);
            }
            out.push_str(document.slice(segment.span));
        }
        Ok(out)
    })
    .await
}

/// The texts of the cues in `text`, read with this document's own header in front of them.
///
/// Borrowing the header is what makes the fragment parseable at all: an ASS event means nothing
/// without the `Format:` line that names its columns, and a VTT cue means nothing without the
/// file's first word. It also means a copy from one document pastes into another of the same
/// format the way that document spells things, not the way its own did.
#[tauri::command]
pub async fn subtitle_paste_over(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    revision: u64,
    cues: Vec<usize>,
    text: String,
) -> Result<CuePatchDto, SubtitleError> {
    let slot = state.slot();
    let read = {
        let slot = Arc::clone(&slot);
        let text = text.clone();
        blocking(move || {
            let guard = lock(&slot)?;
            let session = current_ref(&guard)?;
            texts_in_fragment(session.document(), &text)
        })
        .await?
    };
    if read.is_empty() {
        return Err(SubtitleError::new(
            SubtitleErrorCode::EditRefused,
            "the clipboard holds no cue this document could read",
        ));
    }
    // As many as there are to give, and no further: a paste over three rows from a clipboard of
    // two leaves the third alone rather than emptying it.
    let edits: Vec<(usize, String)> = cues
        .into_iter()
        .zip(read)
        .collect::<Vec<_>>()
        .into_iter()
        .collect();
    edited(&app, slot, revision, Edit::SetTexts { edits }).await
}

/// Parse `fragment` behind `document`'s own header and hand back the text of every cue in it.
fn texts_in_fragment(
    document: &SubtitleDocument,
    fragment: &str,
) -> Result<Vec<String>, SubtitleError> {
    let body = document.source().body();
    let first_cue = document
        .segments()
        .iter()
        .find(|segment| matches!(segment.kind, SegmentKind::Cue(_)))
        .map(|segment| segment.span.start)
        .unwrap_or(body.len());
    let header = body.get(..first_cue).unwrap_or("");
    let whole = format!("{header}{fragment}");
    let parsed = parse(document.format(), whole.as_bytes()).map_err(SubtitleError::from_parse)?;
    Ok(parsed
        .cues()
        .map(|cue| parsed.slice(cue.text).to_owned())
        .collect())
}

/// Which column of a `Style:` line a write names, on the wire. The name is not on it: renaming a
/// style means rewriting every event that names it, which is a different operation. See B10.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssStyleFieldDto {
    Fontname,
    Fontsize,
    Primary,
    Secondary,
    Outline,
    Back,
    Bold,
    Italic,
    Underline,
    Strikeout,
    ScaleX,
    ScaleY,
    Spacing,
    Angle,
    BorderStyle,
    OutlineWidth,
    Shadow,
    Alignment,
    MarginL,
    MarginR,
    MarginV,
    Encoding,
}

impl From<AssStyleFieldDto> for AssStyleField {
    fn from(field: AssStyleFieldDto) -> Self {
        match field {
            AssStyleFieldDto::Fontname => AssStyleField::Fontname,
            AssStyleFieldDto::Fontsize => AssStyleField::Fontsize,
            AssStyleFieldDto::Primary => AssStyleField::Primary,
            AssStyleFieldDto::Secondary => AssStyleField::Secondary,
            AssStyleFieldDto::Outline => AssStyleField::Outline,
            AssStyleFieldDto::Back => AssStyleField::Back,
            AssStyleFieldDto::Bold => AssStyleField::Bold,
            AssStyleFieldDto::Italic => AssStyleField::Italic,
            AssStyleFieldDto::Underline => AssStyleField::Underline,
            AssStyleFieldDto::Strikeout => AssStyleField::Strikeout,
            AssStyleFieldDto::ScaleX => AssStyleField::ScaleX,
            AssStyleFieldDto::ScaleY => AssStyleField::ScaleY,
            AssStyleFieldDto::Spacing => AssStyleField::Spacing,
            AssStyleFieldDto::Angle => AssStyleField::Angle,
            AssStyleFieldDto::BorderStyle => AssStyleField::BorderStyle,
            AssStyleFieldDto::OutlineWidth => AssStyleField::OutlineWidth,
            AssStyleFieldDto::Shadow => AssStyleField::Shadow,
            AssStyleFieldDto::Alignment => AssStyleField::Alignment,
            AssStyleFieldDto::MarginL => AssStyleField::MarginL,
            AssStyleFieldDto::MarginR => AssStyleField::MarginR,
            AssStyleFieldDto::MarginV => AssStyleField::MarginV,
            AssStyleFieldDto::Encoding => AssStyleField::Encoding,
        }
    }
}

/// One field of one declared style. Answers with a patch like every other edit, and the patch
/// carries the styles, which is how the interface learns that one moved. See B10.
#[tauri::command]
pub async fn subtitle_set_style_field(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    revision: u64,
    style: usize,
    field: AssStyleFieldDto,
    value: String,
) -> Result<CuePatchDto, SubtitleError> {
    edited(
        &app,
        state.slot(),
        revision,
        Edit::SetStyleField {
            style,
            field: field.into(),
            value,
        },
    )
    .await
}

/// Empty one cue's text. `keep_tags` is the reference's Clear Text: the braced runs stay where
/// they are and only the words go. See edit-bar-tasks.md B13.
#[tauri::command]
pub async fn subtitle_clear_text(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    revision: u64,
    cue: usize,
    keep_tags: bool,
) -> Result<CuePatchDto, SubtitleError> {
    edited(
        &app,
        state.slot(),
        revision,
        Edit::ClearText { cue, keep_tags },
    )
    .await
}

/// Several override tags at one caret, as one step. A font picker names the family and the size,
/// which is one thing a translator did. See side-by-side-tasks.md and edit-bar-tasks.md B12.
#[derive(Debug, Deserialize)]
pub struct OverrideTagsWrite {
    /// `(tag, value)` in the order they are written.
    pub tags: Vec<(String, String)>,
    pub at: usize,
}

#[tauri::command]
pub async fn subtitle_set_override_tags(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    revision: u64,
    cue: usize,
    write: OverrideTagsWrite,
) -> Result<CuePatchDto, SubtitleError> {
    let OverrideTagsWrite { tags, at } = write;
    edited(
        &app,
        state.slot(),
        revision,
        Edit::SetOverrideTags { cue, tags, at },
    )
    .await
}

/// Whether one cue is a line a player draws. Refused on a format that has no descriptor to
/// rewrite, and the panel draws that control greyed instead of asking. See edit-bar-tasks.md B8.
#[tauri::command]
pub async fn subtitle_set_comment(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    revision: u64,
    cue: usize,
    comment: bool,
) -> Result<CuePatchDto, SubtitleError> {
    edited(
        &app,
        state.slot(),
        revision,
        Edit::SetComment { cue, comment },
    )
    .await
}

#[tauri::command]
pub async fn subtitle_set_times(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    revision: u64,
    cue: usize,
    start_ms: u32,
    end_ms: u32,
) -> Result<CuePatchDto, SubtitleError> {
    edited(
        &app,
        state.slot(),
        revision,
        Edit::SetTimes {
            cue,
            start_ms,
            end_ms,
        },
    )
    .await
}

#[tauri::command]
pub async fn subtitle_insert(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    revision: u64,
    before: usize,
    start_ms: u32,
    end_ms: u32,
    text: String,
) -> Result<CuePatchDto, SubtitleError> {
    edited(
        &app,
        state.slot(),
        revision,
        Edit::Insert {
            before,
            start_ms,
            end_ms,
            text,
        },
    )
    .await
}

/// Every named cue written again straight after itself, as one undo step. In file order, each named
/// once; they need not be next to each other.
#[tauri::command]
pub async fn subtitle_duplicate(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    revision: u64,
    cues: Vec<usize>,
) -> Result<CuePatchDto, SubtitleError> {
    edited(&app, state.slot(), revision, Edit::Duplicate { cues }).await
}

/// Two or more cues joined into the first of them, as one undo step. In file order, each named
/// once; `keep_first_text` drops the others' words and keeps their time.
#[tauri::command]
pub async fn subtitle_join(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    revision: u64,
    cues: Vec<usize>,
    keep_first_text: bool,
) -> Result<CuePatchDto, SubtitleError> {
    edited(
        &app,
        state.slot(),
        revision,
        Edit::Join {
            cues,
            keep_first_text,
        },
    )
    .await
}

/// The clipboard's own lines put in before `before`, as one undo step. `before` equal to the cue
/// count appends. The fragment is read behind this document's header before anything is written.
#[tauri::command]
pub async fn subtitle_paste(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    revision: u64,
    before: usize,
    text: String,
) -> Result<CuePatchDto, SubtitleError> {
    edited(
        &app,
        state.slot(),
        revision,
        Edit::Paste {
            before,
            fragment: text,
        },
    )
    .await
}

/// Several cues removed as one undo step. In file order, each named once; they need not be next to
/// each other, because a selection need not be.
#[tauri::command]
pub async fn subtitle_delete_many(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    revision: u64,
    cues: Vec<usize>,
) -> Result<CuePatchDto, SubtitleError> {
    edited(&app, state.slot(), revision, Edit::DeleteMany { cues }).await
}

/// A contiguous run of cues put back in a new order, as one undo step. `order` is a permutation of
/// `from..from + order.len()`: the same cues rearranged, nothing renumbered. See reorder-tasks.md.
#[tauri::command]
pub async fn subtitle_reorder(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    revision: u64,
    from: usize,
    order: Vec<usize>,
) -> Result<CuePatchDto, SubtitleError> {
    edited(&app, state.slot(), revision, Edit::Reorder { from, order }).await
}

#[tauri::command]
pub async fn subtitle_split(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    revision: u64,
    cue: usize,
    text_offset: usize,
    at_ms: u32,
) -> Result<CuePatchDto, SubtitleError> {
    edited(
        &app,
        state.slot(),
        revision,
        Edit::Split {
            cue,
            text_offset,
            at_ms,
        },
    )
    .await
}

/// Split the cue in two at the playhead's frame, the whole text kept in both halves. `before` cuts on
/// the near edge of the current frame, otherwise on the far edge. The caller passes the cue's own
/// times and the playhead so the frame math has what it needs; when the playhead is not inside the
/// cue at frame level the split falls back to the playhead millisecond, which the caller has already
/// checked is inside. See docs/split-at-playhead-tasks.md.
/// The frame geometry a playhead split needs, bundled so the command stays under seven arguments.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayheadSplit {
    start_ms: u32,
    end_ms: u32,
    playhead_ms: u32,
    fps: f64,
    before: bool,
}

#[tauri::command]
pub async fn subtitle_split_at_playhead(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    revision: u64,
    cue: usize,
    split: PlayheadSplit,
) -> Result<CuePatchDto, SubtitleError> {
    let (first_end_ms, second_start_ms) = match crate::frames::split_at_playhead(
        split.start_ms,
        split.end_ms,
        split.playhead_ms,
        split.fps,
        split.before,
    ) {
        crate::frames::SplitAt::Between {
            first_end_ms,
            second_start_ms,
        } => (first_end_ms, second_start_ms),
        // The frame check put the playhead outside the cue, which the caller's own millisecond
        // check said was inside: split on the playhead itself rather than refuse.
        crate::frames::SplitAt::Degenerate { .. } => (split.playhead_ms, split.playhead_ms),
    };
    edited(
        &app,
        state.slot(),
        revision,
        Edit::SplitInTwo {
            cue,
            first_end_ms,
            second_start_ms,
        },
    )
    .await
}

#[tauri::command]
pub async fn subtitle_merge(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    revision: u64,
    cue: usize,
) -> Result<CuePatchDto, SubtitleError> {
    edited(&app, state.slot(), revision, Edit::Merge { cue }).await
}

#[tauri::command]
pub async fn subtitle_undo(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    revision: u64,
) -> Result<CuePatchDto, SubtitleError> {
    let slot = state.slot();
    let patch = blocking(move || undo(&slot, revision)).await;
    crate::preview::refresh(&app).await;
    patch
}

#[tauri::command]
pub async fn subtitle_redo(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    revision: u64,
) -> Result<CuePatchDto, SubtitleError> {
    let slot = state.slot();
    let patch = blocking(move || redo(&slot, revision)).await;
    crate::preview::refresh(&app).await;
    patch
}

#[tauri::command]
pub async fn subtitle_save(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    revision: u64,
) -> Result<SubtitleSaved, SubtitleError> {
    let slot = state.slot();
    let backups = backup_root(&app)?;
    blocking(move || save(&slot, revision, backups)).await
}

#[tauri::command]
pub async fn subtitle_save_as(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    revision: u64,
    destination: String,
) -> Result<SubtitleSaved, SubtitleError> {
    let slot = state.slot();
    let backups = backup_root(&app)?;
    blocking(move || save_as(&slot, revision, &destination, backups)).await
}

/// Write a copy of the open document at `destination`, encoded as the charset `label` names
/// (interface-spec 3.1 item 9). The document on screen adopts nothing: its file, its dirty state
/// and its undo history stay exactly as they were, the way Save a copy leaves them.
#[tauri::command]
pub async fn subtitle_export(
    app: AppHandle,
    state: State<'_, SubtitleState>,
    revision: u64,
    destination: String,
    label: String,
) -> Result<SubtitleSaved, SubtitleError> {
    let slot = state.slot();
    let backups = backup_root(&app)?;
    blocking(move || export_copy(&slot, revision, &destination, &label, backups)).await
}

/// Make the cues a finished transcription produced the open document.
///
/// Nothing is written to disk here: the result lives in the session until the user saves it, and
/// the media file is never touched (CONTRIBUTING.md §3.1). `Ok(None)` is the user answering Cancel,
/// or dismissing the first-save chooser Save raises, and either leaves the document that was open
/// and the transcription result exactly as they were. See BACKLOG.md M3.5 and M3.6.
#[tauri::command]
pub async fn subtitle_adopt_transcription(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, SubtitleState>,
    asr: State<'_, AsrState>,
    run_id: u64,
) -> Result<Option<SubtitleOpened>, SubtitleError> {
    let srt = crate::asr::finished_srt(&asr, run_id).ok_or_else(|| {
        SubtitleError::new(
            SubtitleErrorCode::TranscriptionGone,
            format!("run {run_id} is not the transcription that finished last"),
        )
    })?;
    let slot = state.slot();
    let backups = backup_root(&app)?;
    let label = window.label().to_owned();

    let adopted = adopt_through_dialogs(&app, &label, slot, srt, backups).await;
    // Replaced, saved, or left exactly as it was: the frame follows whichever of the three.
    crate::preview::refresh(&app).await;
    adopted
}

/// The body of [`subtitle_adopt_transcription`], so the refresh above covers every way out of it.
async fn adopt_through_dialogs(
    app: &AppHandle,
    label: &str,
    slot: Arc<SessionSlot>,
    srt: Vec<u8>,
    backups: PathBuf,
) -> Result<Option<SubtitleOpened>, SubtitleError> {
    let adopted = {
        let (slot, srt) = (Arc::clone(&slot), srt.clone());
        blocking(move || adopt_if_clean(&slot, &srt)).await?
    };
    if let Some(opened) = adopted {
        return Ok(Some(opened));
    }

    // Unsaved work is in the way, so the user is asked the same three answers the close gate asks
    // before anything replaces it (decision 24, B1).
    let answer = ask_about_unsaved(app, label).await?;
    let answered = {
        let (slot, srt, backups) = (Arc::clone(&slot), srt.clone(), backups.clone());
        blocking(move || adopt_answered(&slot, &srt, answer, backups)).await
    };
    match answered {
        // Save on a document that has never had a file asks where it goes, as the toolbar's Save
        // and the close gate's already do (decision 24 B2, BACKLOG.md M3.6).
        Err(error) if error.code == SubtitleErrorCode::NoPath => {
            let Some(destination) = ask_first_save_path(app).await? else {
                // Cancelled: nothing is written, nothing is replaced, the cues stay.
                return Ok(None);
            };
            blocking(move || adopt_answered_at(&slot, &srt, &destination, backups))
                .await
                .map(Some)
        }
        other => other,
    }
}

// -------------------------------------------------------------------------------------------
// The bodies, free of Tauri so the suite can drive them
// -------------------------------------------------------------------------------------------

/// Read `path`, parse it, and make it the open file. Refused while the open file has unsaved
/// edits: dropping the user's work is a decision only the user makes (CONTRIBUTING.md §3).
pub fn open_session(slot: &SessionSlot, path: &str) -> Result<SubtitleOpened, SubtitleError> {
    open_read(slot, path, read_document)
}

/// Open a file the user named a charset for (interface-spec 9.8). The same as [`open_session`] but
/// the read decodes with `label` instead of auto-detecting UTF-8.
pub fn open_session_with_encoding(
    slot: &SessionSlot,
    path: &str,
    label: &str,
) -> Result<SubtitleOpened, SubtitleError> {
    open_read(slot, path, |target| {
        read_document_with_encoding(target, label)
    })
}

/// The body both opens share: guard the unsaved file, read through `read`, and install the result
/// as the file on screen. `read` is the only difference between an auto-detected open and one the
/// user named a charset for.
fn open_read(
    slot: &SessionSlot,
    path: &str,
    read: impl FnOnce(&Path) -> Result<SubtitleDocument, SubtitleError>,
) -> Result<SubtitleOpened, SubtitleError> {
    let mut guard = lock(slot)?;
    if guard.as_ref().is_some_and(EditSession::dirty) {
        return Err(SubtitleError::new(
            SubtitleErrorCode::UnsavedChanges,
            "the open file has edits that are not on disk",
        ));
    }

    // A file that did not open is not the file on screen either, and the one being replaced was
    // just proven saved, so closing it first loses nothing.
    *guard = None;
    let document = read(Path::new(path))?;
    let summary = summarize(Some(path), &document);
    let session = EditSession::open(PathBuf::from(path), document);
    let opened = opened_payload(&session, summary);
    // Said out loud because it is the one moment a document becomes the one on screen, and because
    // nothing else could observe it: the harness had to guess with fixed waits, and the guess was
    // calibrated on fast hardware (gate 2, the CI run of 2026-08-30).
    crate::log::info!(
        "subtitle: opened {path} — {} cues, {}",
        opened.cues.len(),
        if opened.truncated {
            "truncated"
        } else {
            "whole"
        }
    );
    *guard = Some(session);
    Ok(opened)
}

/// Make the target from the source: the same cues and the same timings, with nothing written yet.
///
/// The emptying happens on a scratch session and the result is parsed again, so the document the
/// translator gets has nothing to undo: the first Ctrl+Z takes back their own first word, never
/// the source's line. See side-by-side-tasks.md S2.
pub fn new_translation(
    source: &SessionSlot,
    target: &SessionSlot,
) -> Result<SubtitleOpened, SubtitleError> {
    let (format, bytes) = {
        let guard = lock(source)?;
        let session = guard.as_ref().ok_or_else(|| {
            SubtitleError::new(
                SubtitleErrorCode::NoDocument,
                "no source file is open to translate from",
            )
        })?;
        (session.document().format(), session.to_bytes())
    };

    let mut guard = lock(target)?;
    if guard.as_ref().is_some_and(EditSession::dirty) {
        return Err(SubtitleError::new(
            SubtitleErrorCode::UnsavedChanges,
            "the open file has edits that are not on disk",
        ));
    }

    let mut scratch =
        EditSession::untitled(parse(format, &bytes).map_err(SubtitleError::from_parse)?);
    let count = scratch.views().len();
    if count > 0 {
        let edits = (0..count).map(|at| (at, String::new())).collect();
        scratch
            .apply(&Edit::SetTexts { edits }, Run::New, Instant::now())
            .map_err(SubtitleError::from_edit)?;
    }
    let document = parse(format, &scratch.to_bytes()).map_err(SubtitleError::from_parse)?;
    let summary = summarize(None, &document);
    let session = EditSession::untitled(document);
    let opened = opened_payload(&session, summary);
    // The third moment a document becomes the one on screen, said out loud for the reason the
    // other two are: nothing outside the window can observe it.
    crate::log::info!(
        "subtitle: a translation begun from the source — {} cues, unsaved",
        opened.cues.len()
    );
    *guard = Some(session);
    Ok(opened)
}

/// The document New starts from: an ASS script with one declared style and no events.
///
/// ASS and not SRT because it is the format that can hold everything the editor writes, styles and
/// override tags included, and a translator who starts here can still export the rest. The style
/// line is the one the reference's own new script carries, at Sublore's own default size.
const NEW_DOCUMENT: &str = "[Script Info]\r
ScriptType: v4.00+\r
WrapStyle: 0\r
ScaledBorderAndShadow: yes\r
PlayResX: 1920\r
PlayResY: 1080\r
\r
[V4+ Styles]\r
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\r
Style: Default,Arial,54,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,60,60,40,1\r
\r
[Events]\r
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\r
";

/// An empty document, open and untitled. `discard` is the user having chosen to lose the edits the
/// open file has; without it the refusal comes back and the file on screen stays.
pub fn new_document(slot: &SessionSlot, discard: bool) -> Result<SubtitleOpened, SubtitleError> {
    let mut guard = lock(slot)?;
    if !discard && guard.as_ref().is_some_and(EditSession::dirty) {
        return Err(SubtitleError::new(
            SubtitleErrorCode::UnsavedChanges,
            "the open file has edits that are not on disk",
        ));
    }
    let document =
        parse(SubtitleFormat::Ass, NEW_DOCUMENT.as_bytes()).map_err(SubtitleError::from_parse)?;
    let summary = summarize(None, &document);
    // Blank and not untitled: an empty document holds no work, so it is not unsaved work either.
    let session = EditSession::blank(document);
    let opened = opened_payload(&session, summary);
    crate::log::info!("subtitle: a new document, empty and with nothing to lose");
    *guard = Some(session);
    Ok(opened)
}

/// Close the open file. `discard` is the user having chosen to lose the edits; without it an
/// unsaved file stays open.
pub fn close_session(slot: &SessionSlot, discard: bool) -> Result<(), SubtitleError> {
    let mut guard = lock(slot)?;
    if !discard && guard.as_ref().is_some_and(EditSession::dirty) {
        return Err(SubtitleError::new(
            SubtitleErrorCode::UnsavedChanges,
            "the open file has edits that are not on disk",
        ));
    }
    *guard = None;
    Ok(())
}

/// Make `srt` the open document, unless unsaved edits are in the way. `Ok(None)` means the user
/// has to be asked before anything is replaced.
pub fn adopt_if_clean(
    slot: &SessionSlot,
    srt: &[u8],
) -> Result<Option<SubtitleOpened>, SubtitleError> {
    let mut guard = lock(slot)?;
    if guard.as_ref().is_some_and(EditSession::dirty) {
        return Ok(None);
    }
    adopt_locked(&mut guard, srt).map(Some)
}

/// Act on what the user answered about the unsaved document in the way. `Ok(None)` is Cancel.
///
/// The save and the replacement happen under one lock, so a save that fails replaces nothing and
/// nothing can be typed between the two (CONTRIBUTING.md §3).
pub fn adopt_answered(
    slot: &SessionSlot,
    srt: &[u8],
    answer: CloseAnswer,
    backup_root: PathBuf,
) -> Result<Option<SubtitleOpened>, SubtitleError> {
    if answer == CloseAnswer::Cancel {
        return Ok(None);
    }
    let mut guard = lock(slot)?;
    if answer == CloseAnswer::Save {
        // Nothing to save if the document was closed while the question was up, and a clean one
        // needs no write.
        if let Some(session) = guard.as_mut().filter(|session| session.dirty()) {
            save_locked(session, backup_root)?;
        }
    }
    adopt_locked(&mut guard, srt).map(Some)
}

/// Write the document in the way where the user has just been asked to put it, then replace it.
///
/// The write and the replacement share one lock for the reason [`adopt_answered`] holds one: a
/// save that fails replaces nothing. See BACKLOG.md M3.6.
pub fn adopt_answered_at(
    slot: &SessionSlot,
    srt: &[u8],
    destination: &str,
    backup_root: PathBuf,
) -> Result<SubtitleOpened, SubtitleError> {
    let mut guard = lock(slot)?;
    // A document closed or saved while the chooser was up has nothing to write; one given a file in
    // the meantime writes there instead, and the chosen path is left alone (decision 24, B2).
    if let Some(session) = guard.as_mut().filter(|session| session.dirty()) {
        if session.path().is_some() {
            save_locked(session, backup_root)?;
        } else {
            save_as_locked(session, destination, backup_root)?;
        }
    }
    adopt_locked(&mut guard, srt)
}

/// The replacement itself: the generated SRT becomes a document with no file, unsaved from the
/// first moment because these bytes exist nowhere else. See BACKLOG.md M3.5.
fn adopt_locked(
    guard: &mut MutexGuard<'_, Option<EditSession>>,
    srt: &[u8],
) -> Result<SubtitleOpened, SubtitleError> {
    // A document Sublore could not open again must not be creatable either, so the same bound the
    // reader and the editor hold applies here.
    if srt.len() as u64 > MAX_SUBTITLE_BYTES {
        return Err(SubtitleError::new(
            SubtitleErrorCode::TooLarge,
            format!("{} bytes, limit {MAX_SUBTITLE_BYTES}", srt.len()),
        ));
    }
    let document = parse(SubtitleFormat::Srt, srt).map_err(SubtitleError::from_parse)?;
    let summary = summarize(None, &document);
    let session = EditSession::untitled(document);
    let opened = opened_payload(&session, summary);
    // The other moment a document becomes the one on screen, said out loud for the same reason
    // `open_session` says it: nothing else outside the window can observe it.
    crate::log::info!(
        "subtitle: adopted a transcription — {} cues, unsaved",
        opened.cues.len()
    );
    **guard = Some(session);
    Ok(opened)
}

/// Raise the unsaved-changes question and wait for its answer.
///
/// The answer is delivered on a thread of the dialog's own, and every way of losing the dialog
/// answers Cancel (`dialog::Delivery`), so the wait below always ends.
async fn ask_about_unsaved(app: &AppHandle, label: &str) -> Result<CloseAnswer, SubtitleError> {
    let (send, receive) = mpsc::channel();
    crate::dialog::ask_unsaved(
        app,
        label,
        crate::strings::REPLACE_UNSAVED_BODY,
        move |answer| {
            // The receiver is gone only if this command was dropped, and then the answer decides
            // nothing: the document has not been touched.
            let _ = send.send(answer);
        },
    )
    .map_err(|error| {
        SubtitleError::new(
            SubtitleErrorCode::CommandFailed,
            format!("the unsaved-changes question could not be raised: {error}"),
        )
    })?;
    // Off the poll thread: this waits for a person. A dropped sender means the answer thread died
    // holding the question, which is the one case nobody answers, and Cancel keeps both documents.
    blocking(move || Ok(receive.recv().unwrap_or(CloseAnswer::Cancel))).await
}

/// Ask where a document that has never had a file goes. `Ok(None)` is the user dismissing the
/// chooser; a chooser that could not be raised is a failed save rather than a cancellation, because
/// the user asked for one and was never given the question. See BACKLOG.md M3.6.
async fn ask_first_save_path(app: &AppHandle) -> Result<Option<String>, SubtitleError> {
    let app = app.clone();
    // Off the poll thread: the chooser waits for a person, and it refuses the main thread outright.
    blocking(move || {
        crate::chooser::choose(&app, crate::chooser::Choice::SubtitleFirstSave, None).map_err(
            |error| {
                SubtitleError::new(
                    SubtitleErrorCode::CommandFailed,
                    format!("the save chooser could not be raised: {error:?}"),
                )
            },
        )
    })
    .await
}

/// Apply one mutation. Nothing is written to disk here: a save is its own command.
pub fn apply_edit(
    slot: &SessionSlot,
    revision: u64,
    edit: Edit,
) -> Result<CuePatchDto, SubtitleError> {
    let mut guard = lock(slot)?;
    let session = current(&mut guard)?;
    check_revision(session, revision)?;
    guard_size(session, &edit)?;

    // Every command carries one finished edit: the editor sends a field when it is committed,
    // never a keystroke, so two of them are two undo steps. See BACKLOG.md M2.2.
    let patch = session
        .apply(&edit, Run::New, Instant::now())
        .map_err(SubtitleError::from_edit)?;
    // One line per committed edit, not per keystroke: the editor sends a field when it is finished.
    // It is the only outside evidence that an edit landed. The text length is here and the text is
    // not: a length is enough to tell a real edit from a field committed unchanged, and a subtitle
    // line is the user's own writing.
    crate::log::info!(
        "subtitle: edit committed, revision {}, {}, {} cues, cue {} now {} chars",
        session.revision(),
        if session.dirty() { "dirty" } else { "clean" },
        patch.cues.len(),
        patch.from,
        patch.cues.first().map_or(0, |cue| cue.text.chars().count())
    );
    Ok(describe(session, patch))
}

pub fn undo(slot: &SessionSlot, revision: u64) -> Result<CuePatchDto, SubtitleError> {
    let mut guard = lock(slot)?;
    let session = current(&mut guard)?;
    check_revision(session, revision)?;

    let patch = session
        .undo()
        .map_err(SubtitleError::from_edit)?
        .unwrap_or_else(nothing_changed);
    Ok(describe(session, patch))
}

pub fn redo(slot: &SessionSlot, revision: u64) -> Result<CuePatchDto, SubtitleError> {
    let mut guard = lock(slot)?;
    let session = current(&mut guard)?;
    check_revision(session, revision)?;

    let patch = session
        .redo()
        .map_err(SubtitleError::from_edit)?
        .unwrap_or_else(nothing_changed);
    Ok(describe(session, patch))
}

/// Write the document back where it came from, and call it saved.
pub fn save(
    slot: &SessionSlot,
    revision: u64,
    backup_root: PathBuf,
) -> Result<SubtitleSaved, SubtitleError> {
    let mut guard = lock(slot)?;
    let session = current(&mut guard)?;
    check_revision(session, revision)?;
    save_locked(session, backup_root)
}

/// The write itself, under a lock the caller already holds. Shared so the close gate cannot drift
/// from the command, and so neither of them takes the lock twice.
fn save_locked(
    session: &mut EditSession,
    backup_root: PathBuf,
) -> Result<SubtitleSaved, SubtitleError> {
    // A document that has never had a file has nowhere to be written back to; naming a destination
    // is what Save as is for. See BACKLOG.md M3.5.
    let path = session
        .path()
        .ok_or_else(|| {
            SubtitleError::new(
                SubtitleErrorCode::NoPath,
                "this document has never had a file, so there is nowhere to write it back to",
            )
        })?
        .to_path_buf();
    let bytes = session.to_bytes();
    let outcome = save_with_backup(&path, &bytes, &BackupStore::new(backup_root))
        .map_err(SubtitleError::from_io)?;
    session.mark_saved();
    // What was written and where, because "the save succeeded" and "the file on disk changed" are
    // different claims and CI has already shown them disagreeing (gate 2, run 33363671401).
    crate::log::info!("subtitle: saved {} — {} bytes", path.display(), bytes.len());
    Ok(saved(outcome, session.dirty()))
}

/// What the close gate needs before it decides whether to ask (BACKLOG N1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionState {
    Clean,
    Dirty,
    /// The lock could not be taken: a command holds it, or one panicked holding it. Both mean the
    /// gate must ask, because a needless question costs a click and a skipped one costs the work.
    Unknown,
}

/// Never blocks. The gate runs on the main loop, and this mutex is held for the whole of
/// `read_document` and of `save_with_backup`, so waiting here would freeze the window mid-save
/// (CONTRIBUTING.md §7).
pub fn session_state(slot: &SessionSlot) -> SessionState {
    match slot.try_lock() {
        Ok(guard) => match guard.as_ref() {
            Some(session) if session.dirty() => SessionState::Dirty,
            _ => SessionState::Clean,
        },
        Err(_) => SessionState::Unknown,
    }
}

/// Save at whatever revision the session holds, recovering a poisoned lock. `Ok(None)` means there
/// was nothing to write.
///
/// A clean session writes nothing. The gate can open on a session that is merely busy, and an
/// unasked-for write would change the mtime of a file the user only opened, and would overwrite
/// whatever another program put there in the meantime (CONTRIBUTING.md §3.1).
pub fn save_current(
    slot: &SessionSlot,
    backup_root: PathBuf,
) -> Result<Option<SubtitleSaved>, SubtitleError> {
    let mut guard = lock_recovering(slot);
    let session = current(&mut guard)?;
    if !session.dirty() {
        return Ok(None);
    }
    save_locked(session, backup_root).map(Some)
}

/// The gate's save for a document that has never had a file: write it where the user has just been
/// asked, and the session points there afterwards (decision 24, B2).
///
/// Unconditional, unlike [`save_current`]: the user was asked for this path because the document
/// was dirty and had nowhere to go, and a session that has been closed under the question is
/// `NoDocument` here rather than a silent write.
pub fn save_current_as(
    slot: &SessionSlot,
    destination: &str,
    backup_root: PathBuf,
) -> Result<SubtitleSaved, SubtitleError> {
    let mut guard = lock_recovering(slot);
    let session = current(&mut guard)?;
    // A file given to the document while the question was up answers it: Save writes there, and the
    // gate never closes over a document that a copy elsewhere left unsaved.
    if let Some(own) = session.path().map(Path::to_path_buf) {
        crate::log::info!(
            "close gate: the document was given {} while it was being asked, so {destination} is \
             not written",
            own.display()
        );
        return save_locked(session, backup_root);
    }
    save_as_locked(session, destination, backup_root)
}

/// Write the document somewhere else. A document with its own file keeps its unsaved edits and
/// keeps pointing at that file: saying otherwise would be a lie the user pays for.
pub fn save_as(
    slot: &SessionSlot,
    revision: u64,
    destination: &str,
    backup_root: PathBuf,
) -> Result<SubtitleSaved, SubtitleError> {
    let mut guard = lock(slot)?;
    let session = current(&mut guard)?;
    check_revision(session, revision)?;
    save_as_locked(session, destination, backup_root)
}

/// The export write: the same atomic machinery as Save as, the bytes encoded first, and nothing
/// adopted. The revision gate holds here too, so an export cannot write a list that has moved.
pub fn export_copy(
    slot: &SessionSlot,
    revision: u64,
    destination: &str,
    label: &str,
    backup_root: PathBuf,
) -> Result<SubtitleSaved, SubtitleError> {
    let mut guard = lock(slot)?;
    let session = current(&mut guard)?;
    check_revision(session, revision)?;
    if destination.is_empty() {
        return Err(SubtitleError::new(
            SubtitleErrorCode::InvalidPath,
            "the destination path is empty",
        ));
    }

    let bytes = encode_for_export(&session.to_bytes(), label)?;
    let outcome = save_with_backup(
        Path::new(destination),
        &bytes,
        &BackupStore::new(backup_root),
    )
    .map_err(SubtitleError::from_io)?;
    crate::log::info!(
        "subtitle: exported a copy to {} as {label}",
        outcome.destination.display(),
    );
    // A copy adopts nothing, so the dirty state going back is the one the document already had.
    Ok(saved(outcome, session.dirty()))
}

/// Encode a document's UTF-8 bytes as the charset `label` names. UTF-8 passes through untouched,
/// BOM and all. A legacy code page has no byte-order mark, so the UTF-8 one is stripped first; a
/// character the charset cannot hold refuses the whole export, never a substitution (CLAUDE.md §3
/// over the reference's lenient write, the same one-point departure the open-side decode took).
fn encode_for_export(bytes: &[u8], label: &str) -> Result<Vec<u8>, SubtitleError> {
    let encoding = encoding_rs::Encoding::for_label(label.as_bytes()).ok_or_else(|| {
        SubtitleError::new(
            SubtitleErrorCode::CommandFailed,
            format!("unknown text encoding {label:?}"),
        )
    })?;
    if encoding == encoding_rs::UTF_8 {
        return Ok(bytes.to_vec());
    }
    // UTF-16 labels encode as UTF-8 on the WHATWG path, which would write a file that lies about
    // itself. Only Sublore's own dialog names the label, so this is a bug, never the user's choice.
    if encoding.output_encoding() != encoding {
        return Err(SubtitleError::new(
            SubtitleErrorCode::CommandFailed,
            format!("{} is not writable", encoding.name()),
        ));
    }
    let rest = bytes
        .strip_prefix(&sublore_formats::text::UTF8_BOM)
        .unwrap_or(bytes);
    let text = std::str::from_utf8(rest).map_err(|error| {
        SubtitleError::new(
            SubtitleErrorCode::CommandFailed,
            format!("the session bytes are not UTF-8: {error}"),
        )
    })?;
    let (encoded, _actual, had_unmappable) = encoding.encode(text);
    if had_unmappable {
        return Err(SubtitleError::new(
            SubtitleErrorCode::UnencodableCharacter,
            format!(
                "the document holds a character {} cannot write",
                encoding.name()
            ),
        ));
    }
    Ok(encoded.into_owned())
}

/// The write to a named destination, under a lock the caller already holds.
fn save_as_locked(
    session: &mut EditSession,
    destination: &str,
    backup_root: PathBuf,
) -> Result<SubtitleSaved, SubtitleError> {
    if destination.is_empty() {
        return Err(SubtitleError::new(
            SubtitleErrorCode::InvalidPath,
            "the destination path is empty",
        ));
    }

    let bytes = session.to_bytes();
    let outcome = save_with_backup(
        Path::new(destination),
        &bytes,
        &BackupStore::new(backup_root),
    )
    .map_err(SubtitleError::from_io)?;
    // The document takes the file it was just written to, whether or not it had one before: this is
    // Save as, not Save a copy, and what a translator goes on editing is the file they named. Its
    // bytes are on disk now, so it is not unsaved work any more (interface-spec 3.1, item 8).
    let had_none = session.path().is_none();
    session.adopt_path(outcome.destination.clone());
    session.mark_saved();
    crate::log::info!(
        "subtitle: the document is {} now{}",
        outcome.destination.display(),
        if had_none { ", having had no file" } else { "" }
    );
    Ok(saved(outcome, session.dirty()))
}

/// What the file is, in the order a translator reads it.
pub fn summarize(path: Option<&str>, document: &SubtitleDocument) -> SubtitleSummary {
    let source = document.source();
    SubtitleSummary {
        path: path.map(str::to_owned),
        format: document.format().as_str().to_owned(),
        cue_count: document.displayed_cue_count(),
        has_bom: source.has_bom(),
        newline: newline_str(source.newline()).to_owned(),
        byte_length: source.byte_len() as u64,
        styles: ass_styles(document),
    }
}

// -------------------------------------------------------------------------------------------
// Plumbing
// -------------------------------------------------------------------------------------------

/// Reading, parsing and saving all block, so no command body runs on the async runtime's poll
/// thread (CONTRIBUTING.md §7).
async fn blocking<T, F>(work: F) -> Result<T, SubtitleError>
where
    F: FnOnce() -> Result<T, SubtitleError> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| {
            SubtitleError::new(
                SubtitleErrorCode::CommandFailed,
                format!("the subtitle task failed: {error}"),
            )
        })?
}

// TODO(M2.6): narrow back to private, together with `SubtitleState::slot`.
pub fn backup_root(app: &AppHandle) -> Result<PathBuf, SubtitleError> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| {
            SubtitleError::new(
                SubtitleErrorCode::BackupFailed,
                format!("no app data directory: {error}"),
            )
        })?
        .join(BACKUP_DIR))
}

/// The lock the close gate takes, which recovers a poisoned session instead of refusing it.
///
/// The interactive commands refuse a poisoned session and that is right for them: a refused edit
/// costs a retry. The close gate is the user's last chance to keep the work, so it recovers
/// instead. Sound here because a mutation never edits the document in place: `plan::edit` builds a
/// whole new document, `EditSession::commit` assigns it in one move, and `history` is only touched
/// after the new document exists, so a panic leaves the session holding one whole document or the
/// other and never half of one. The poison flag is cleared once the guard is in hand, or every
/// later command would keep refusing a session this call just proved usable.
fn lock_recovering(slot: &SessionSlot) -> MutexGuard<'_, Option<EditSession>> {
    match slot.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            slot.clear_poison();
            poisoned.into_inner()
        }
    }
}

/// A poisoned lock means a command panicked holding it, so the commands refuse rather than build on
/// it. The close gate's saves deliberately do not: see [`lock_recovering`].
fn lock(slot: &SessionSlot) -> Result<MutexGuard<'_, Option<EditSession>>, SubtitleError> {
    slot.lock().map_err(|_| {
        SubtitleError::new(
            SubtitleErrorCode::CommandFailed,
            "the subtitle session lock is poisoned",
        )
    })
}

/// The open session, read only. The mutable one below is what an edit takes.
fn current_ref<'a>(
    guard: &'a MutexGuard<'_, Option<EditSession>>,
) -> Result<&'a EditSession, SubtitleError> {
    guard.as_ref().ok_or_else(|| {
        SubtitleError::new(SubtitleErrorCode::NoDocument, "no subtitle file is open")
    })
}

fn current<'a>(
    guard: &'a mut MutexGuard<'_, Option<EditSession>>,
) -> Result<&'a mut EditSession, SubtitleError> {
    guard.as_mut().ok_or_else(|| {
        SubtitleError::new(SubtitleErrorCode::NoDocument, "no subtitle file is open")
    })
}

/// The caller's cue indices describe the list at its revision. If the session has moved on, the
/// safe answer is a refusal and a refetch, never an edit at a guessed index.
pub(crate) fn check_revision(session: &EditSession, revision: u64) -> Result<(), SubtitleError> {
    if session.revision() == revision {
        return Ok(());
    }
    Err(SubtitleError::new(
        SubtitleErrorCode::StaleRevision,
        format!(
            "the caller is at revision {revision}, the session at {}",
            session.revision()
        ),
    ))
}

/// An edit that would grow the file past what Sublore re-opens is refused before it is applied:
/// a document that cannot be opened again must not be creatable.
pub(crate) fn guard_size(session: &EditSession, edit: &Edit) -> Result<(), SubtitleError> {
    let planned = plan::plan(session.document(), edit).map_err(SubtitleError::from_edit)?;
    let grown = session
        .document()
        .source()
        .byte_len()
        .saturating_sub(planned.splice.removed.len())
        .saturating_add(planned.splice.inserted.len());
    if u64::try_from(grown).unwrap_or(u64::MAX) > MAX_SUBTITLE_BYTES {
        return Err(SubtitleError::new(
            SubtitleErrorCode::TooLarge,
            format!("the edit would make the file {grown} bytes, limit {MAX_SUBTITLE_BYTES}"),
        ));
    }
    Ok(())
}

/// A call that replayed nothing: the bottom of the undo stack, or the top of the redo tail.
fn nothing_changed() -> CuePatch {
    CuePatch {
        from: 0,
        removed: 0,
        cues: Vec::new(),
    }
}

fn opened_payload(session: &EditSession, summary: SubtitleSummary) -> SubtitleOpened {
    SubtitleOpened {
        summary,
        revision: session.revision(),
        cues: rows(session.views()),
        can_undo: session.can_undo(),
        can_redo: session.can_redo(),
        dirty: session.dirty(),
        truncated: session.truncated(),
    }
}

/// The declared styles as an editor reads them. Carried on every patch as well as on the
/// summary, because a style write changes no cue and the interface has to be told some other
/// way that one moved.
fn ass_styles(document: &SubtitleDocument) -> Vec<AssStyleDto> {
    document
        .ass_styles()
        .iter()
        .map(|style| {
            let [
                name,
                fontname,
                fontsize,
                primary,
                secondary,
                outline,
                back,
                scale_x,
                scale_y,
                spacing,
                angle,
                border_style,
                outline_width,
                shadow,
                alignment,
                margin_l,
                margin_r,
                margin_v,
                encoding,
            ] = document.ass_style_text(style);
            AssStyleDto {
                name: name.to_owned(),
                fontname: fontname.to_owned(),
                fontsize: fontsize.to_owned(),
                primary: primary.to_owned(),
                secondary: secondary.to_owned(),
                outline: outline.to_owned(),
                back: back.to_owned(),
                scale_x: scale_x.to_owned(),
                scale_y: scale_y.to_owned(),
                spacing: spacing.to_owned(),
                angle: angle.to_owned(),
                border_style: border_style.to_owned(),
                outline_width: outline_width.to_owned(),
                shadow: shadow.to_owned(),
                alignment: alignment.to_owned(),
                margin_l: margin_l.to_owned(),
                margin_r: margin_r.to_owned(),
                margin_v: margin_v.to_owned(),
                encoding: encoding.to_owned(),
                bold: style.bold,
                italic: style.italic,
                underline: style.underline,
                strikeout: style.strikeout,
            }
        })
        .collect()
}

pub(crate) fn describe(session: &EditSession, patch: CuePatch) -> CuePatchDto {
    CuePatchDto {
        revision: session.revision(),
        from: patch.from,
        removed: patch.removed,
        cues: rows(&patch.cues),
        cue_count: session.document().displayed_cue_count(),
        can_undo: session.can_undo(),
        can_redo: session.can_redo(),
        dirty: session.dirty(),
        truncated: session.truncated(),
        styles: ass_styles(session.document()),
    }
}

fn rows(views: &[CueView]) -> Vec<CueRowDto> {
    views
        .iter()
        .map(|view| CueRowDto {
            start_ms: view.start_ms,
            end_ms: view.end_ms,
            text: view.text.clone(),
            comment: view.comment,
            number: view.number,
            style: view.style.clone(),
            actor: view.actor.clone(),
            effect: view.effect.clone(),
            layer: view.layer.clone(),
            margin_l: view.margin_l.clone(),
            margin_r: view.margin_r.clone(),
            margin_v: view.margin_v.clone(),
            declared_fields: view
                .declared_fields
                .iter()
                .map(|field| AssFieldDto::from(*field))
                .collect(),
        })
        .collect()
}

fn saved(outcome: sublore_io::atomic::SaveOutcome, dirty: bool) -> SubtitleSaved {
    SubtitleSaved {
        path: outcome.destination.to_string_lossy().into_owned(),
        bytes_written: outcome.bytes_written,
        backup_path: outcome
            .backup
            .map(|path| path.to_string_lossy().into_owned()),
        dirty,
    }
}

pub(crate) fn read_document(path: &Path) -> Result<SubtitleDocument, SubtitleError> {
    let bytes = read_capped_bytes(path)?;
    document_from_bytes(path, &bytes)
}

/// Read a file the user names with an explicit charset instead of the auto-detection
/// [`read_document`] does (interface-spec 9.8). The bytes are decoded to UTF-8 first, so the parser
/// and everything after it see the UTF-8 they always see and a later save writes UTF-8; a legacy
/// code page becoming UTF-8 on open is the wanted outcome. `sublore-formats` never sees the charset.
pub(crate) fn read_document_with_encoding(
    path: &Path,
    label: &str,
) -> Result<SubtitleDocument, SubtitleError> {
    let bytes = read_capped_bytes(path)?;
    let text = decode_with_label(&bytes, label)?;
    document_from_bytes(path, text.as_bytes())
}

/// Decode `bytes` as the named charset. A byte-order mark is honoured and stripped; anything that
/// does not decode cleanly is refused rather than turned into U+FFFD the user could then save
/// (CLAUDE.md §3 over the reference's lenient decode). An unknown label is a bug in Sublore's own
/// dialog, never something the user typed, so it is `CommandFailed`, not a file problem.
fn decode_with_label<'a>(
    bytes: &'a [u8],
    label: &str,
) -> Result<std::borrow::Cow<'a, str>, SubtitleError> {
    let encoding = encoding_rs::Encoding::for_label(label.as_bytes()).ok_or_else(|| {
        SubtitleError::new(
            SubtitleErrorCode::CommandFailed,
            format!("unknown text encoding {label:?}"),
        )
    })?;
    let (text, _actual, had_errors) = encoding.decode(bytes);
    if had_errors {
        return Err(SubtitleError::new(
            SubtitleErrorCode::UnsupportedEncoding,
            format!("the bytes do not decode as {}", encoding.name()),
        ));
    }
    Ok(text)
}

/// Read a subtitle file's bytes, refusing an empty path, a non-file and anything past the size cap.
/// Shared by the auto-detecting read and the explicit-charset one.
fn read_capped_bytes(path: &Path) -> Result<Vec<u8>, SubtitleError> {
    if path.as_os_str().is_empty() {
        return Err(SubtitleError::new(
            SubtitleErrorCode::InvalidPath,
            "the path is empty",
        ));
    }

    // Metadata before opening: a directory opens fine on Linux, and "that is not a file" is the
    // sentence the user needs on both platforms.
    let metadata =
        std::fs::metadata(path).map_err(|error| SubtitleError::from_read(&error, path))?;
    if !metadata.is_file() {
        return Err(SubtitleError::new(
            SubtitleErrorCode::NotAFile,
            format!("{} is not a regular file", path.display()),
        ));
    }
    if metadata.len() > MAX_SUBTITLE_BYTES {
        return Err(SubtitleError::new(
            SubtitleErrorCode::TooLarge,
            format!("{} bytes, limit {MAX_SUBTITLE_BYTES}", metadata.len()),
        ));
    }

    let file = File::open(path).map_err(|error| SubtitleError::from_read(&error, path))?;
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    // One byte past the limit, so a file that grew since it was measured is refused, not truncated.
    let read = file
        .take(MAX_SUBTITLE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| SubtitleError::from_read(&error, path))?;
    if read as u64 > MAX_SUBTITLE_BYTES {
        return Err(SubtitleError::new(
            SubtitleErrorCode::TooLarge,
            format!("more than {MAX_SUBTITLE_BYTES} bytes"),
        ));
    }
    Ok(bytes)
}

/// Detect the format and parse. The bytes are already UTF-8: either the file was UTF-8 or the
/// charset decode above turned it into UTF-8.
fn document_from_bytes(path: &Path, bytes: &[u8]) -> Result<SubtitleDocument, SubtitleError> {
    let format = detect(path, bytes).ok_or_else(|| {
        SubtitleError::new(
            SubtitleErrorCode::UnknownFormat,
            format!("{} is not an SRT, VTT or ASS file", path.display()),
        )
    })?;
    parse(format, bytes).map_err(SubtitleError::from_parse)
}

/// Content decides, extension breaks ties. Undecodable bytes make the content say nothing, and the
/// extension then picks the parser that reports the encoding problem properly.
fn detect(path: &Path, bytes: &[u8]) -> Option<SubtitleFormat> {
    let extension = path.extension().and_then(|value| value.to_str());
    SubtitleFormat::detect(extension, &String::from_utf8_lossy(bytes))
}

/// The wire spelling of a line terminator. Stable: the UI maps it to copy.
fn newline_str(newline: Newline) -> &'static str {
    match newline {
        Newline::Lf => "lf",
        Newline::Crlf => "crlf",
        Newline::Mixed => "mixed",
        Newline::None => "none",
    }
}

#[cfg(test)]
mod tests {
    use super::{
        decode_with_label, encode_for_export, new_document, rows, AssField, AssFieldDto,
        SessionSlot, SubtitleErrorCode,
    };
    use sublore_edit::diff::CueView;

    /// Pure ASCII is the same bytes in UTF-8 and in any single-byte code page, so an export that
    /// changes them would be an export that rewrote the document (export-tasks E1).
    #[test]
    fn ascii_exports_byte_identically_in_a_single_byte_charset() {
        let bytes = b"1\n00:00:01,000 --> 00:00:02,000\nplain words\n";
        let encoded = encode_for_export(bytes, "windows-1252").expect("ascii");
        assert_eq!(encoded, bytes);
    }

    /// UTF-8 passes through untouched, byte-order mark included: the export is then a byte copy.
    #[test]
    fn utf8_export_is_a_byte_copy_bom_included() {
        let bytes = b"\xef\xbb\xbfCaf\xc3\xa9";
        assert_eq!(encode_for_export(bytes, "utf-8").expect("utf-8"), bytes);
    }

    /// An é encodes to the one byte Windows-1252 spells it with, and the UTF-8 byte-order mark is
    /// stripped on the way: a legacy code page has no byte-order mark to carry (E2).
    #[test]
    fn accents_encode_to_the_legacy_byte_and_the_bom_is_stripped() {
        let encoded =
            encode_for_export(b"\xef\xbb\xbfCaf\xc3\xa9", "windows-1252").expect("cp1252");
        assert_eq!(encoded, b"Caf\xe9");
    }

    /// A character the charset cannot hold refuses the export outright: no substitution byte is
    /// ever produced, because a silent substitution is data loss (E3, CLAUDE.md §3).
    #[test]
    fn a_character_the_charset_cannot_hold_refuses_the_export() {
        let error =
            encode_for_export("a \u{2192} b".as_bytes(), "windows-1252").expect_err("refused");
        assert_eq!(error.code, SubtitleErrorCode::UnencodableCharacter);
    }

    /// UTF-16 encodes as UTF-8 on the WHATWG path, which would write a file that lies about itself,
    /// so the label is refused as Sublore's own bug: only its dialog ever names one.
    #[test]
    fn a_utf16_export_label_is_a_command_failure() {
        let error = encode_for_export(b"anything", "utf-16le").expect_err("refused");
        assert_eq!(error.code, SubtitleErrorCode::CommandFailed);
    }

    /// The common single-byte case: every accented letter is one byte and maps straight across, so
    /// the é a Windows-1252 file spells `0xE9` comes back as é (interface-spec 9.8, O1/O3).
    #[test]
    fn windows_1252_bytes_decode_to_their_accented_letters() {
        let decoded = decode_with_label(b"Caf\xe9 y Se\xf1ora", "windows-1252").expect("cp1252");
        assert_eq!(decoded, "Café y Señora");
    }

    /// A UTF-16LE byte-order mark is honoured and stripped, so a file plain open refuses on the wide
    /// BOM opens here (O2). `31 00` is `1`, the low byte first.
    #[test]
    fn a_utf16le_byte_order_mark_is_honoured_and_stripped() {
        let bytes = b"\xff\xfe1\x00\x0a\x00H\x00\xe9\x00";
        let decoded = decode_with_label(bytes, "utf-16le").expect("utf-16le");
        assert_eq!(decoded, "1\nHé");
    }

    /// An unknown label can only come from a bug in Sublore's own dialog, never from the user, so
    /// it is a command failure and not a claim about the file (O3).
    #[test]
    fn an_unknown_charset_label_is_a_command_failure() {
        let error = decode_with_label(b"anything", "not-a-real-charset").expect_err("refused");
        assert_eq!(error.code, SubtitleErrorCode::CommandFailed);
    }

    /// Bytes that do not decode as the named charset are refused, not turned into U+FFFD the user
    /// could save. `D8 00` is a lone high surrogate in UTF-16BE, unpaired by the `00 41` after it.
    #[test]
    fn bytes_that_do_not_decode_as_the_named_charset_are_refused() {
        let error =
            decode_with_label(b"\xd8\x00\x00\x41", "utf-16be").expect_err("a lone surrogate");
        assert_eq!(error.code, SubtitleErrorCode::UnsupportedEncoding);
        assert!(
            !error.detail.contains('\u{fffd}'),
            "the refusal names the charset, it does not carry the replacement char: {}",
            error.detail
        );
    }

    /// The document New opens has to be one the parser accepts, one the style editor finds a style
    /// in, and one with no line in it: an empty script that carried a cue would be a surprise.
    #[test]
    fn a_new_document_is_an_empty_script_with_a_style_in_it() {
        let slot = SessionSlot::default();
        let opened = new_document(&slot, false).expect("a new document");
        assert_eq!(opened.summary.format, "ass");
        assert_eq!(opened.summary.cue_count, 0);
        assert!(opened.cues.is_empty());
        assert_eq!(
            opened
                .summary
                .styles
                .iter()
                .map(|style| style.name.as_str())
                .collect::<Vec<_>>(),
            ["Default"],
        );
        assert_eq!(opened.summary.path, None);
    }

    /// The same refusal opening a file gives, and for the same reason: unsaved work is never lost
    /// without the user having said so.
    #[test]
    fn a_new_document_waits_for_the_unsaved_work_in_its_way() {
        let slot = SessionSlot::default();
        new_document(&slot, false).expect("the first new document");
        {
            let mut guard = slot.lock().expect("the session lock");
            let session = guard.as_mut().expect("a session");
            session
                .apply(
                    &sublore_edit::plan::Edit::Insert {
                        before: 0,
                        start_ms: 0,
                        end_ms: 1000,
                        text: "Something unsaved".to_owned(),
                    },
                    sublore_edit::history::Run::New,
                    std::time::Instant::now(),
                )
                .expect("an edit on the new document");
        }
        let refused = new_document(&slot, false).expect_err("a refusal");
        assert_eq!(refused.code, SubtitleErrorCode::UnsavedChanges);
        // And it goes through once the user has said the work may go.
        assert_eq!(
            new_document(&slot, true)
                .expect("a new document after discarding")
                .summary
                .cue_count,
            0,
        );
    }

    fn view() -> CueView {
        CueView {
            start_ms: 1,
            end_ms: 2,
            text: "Hello".to_owned(),
            comment: false,
            number: None,
            style: "Default".to_owned(),
            actor: "Ingrid".to_owned(),
            effect: "fad".to_owned(),
            layer: "0000".to_owned(),
            margin_l: "10".to_owned(),
            margin_r: "20".to_owned(),
            margin_v: "30".to_owned(),
            declared_fields: vec![AssField::Style, AssField::MarginL],
        }
    }

    /// `CueRow` in src/types/subtitle.ts is this same interface in another language, and the three
    /// margin keys are spelled the way `AssFieldName` spells them. A rename on one side and not the
    /// other would leave a control reading `undefined`.
    #[test]
    fn a_row_goes_on_the_wire_under_the_names_the_ui_reads() {
        let row = rows(&[view()]).remove(0);
        let json = serde_json::to_value(&row).expect("a row serializes");
        let object = json.as_object().expect("a row is an object");
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "actor",
                "comment",
                "declaredFields",
                "effect",
                "endMs",
                "layer",
                "marginL",
                "marginR",
                "marginV",
                "number",
                "startMs",
                "style",
                "text",
            ]
        );
        assert_eq!(
            object.get("marginL").and_then(|value| value.as_str()),
            Some("10")
        );
        assert_eq!(
            object.get("layer").and_then(|value| value.as_str()),
            Some("0000")
        );
    }

    /// A row reports its declared fields under the same names `subtitle_set_field` takes, so a
    /// control can pass one straight back. One list, no second spelling to drift.
    /// See styles-and-fields-tasks.md F2.
    #[test]
    fn a_row_names_its_declared_fields_the_way_a_write_names_them() {
        let json = serde_json::to_value(rows(&[view()]).remove(0)).expect("a row serializes");
        assert_eq!(
            json.get("declaredFields"),
            Some(&serde_json::json!(["style", "marginL"]))
        );
        for name in [
            "style", "actor", "effect", "layer", "marginL", "marginR", "marginV",
        ] {
            let sent = serde_json::to_value(AssFieldDto::from(AssField::from(
                serde_json::from_value::<AssFieldDto>(serde_json::json!(name))
                    .expect("the wire name deserializes"),
            )))
            .expect("a field name serializes");
            assert_eq!(
                sent,
                serde_json::json!(name),
                "{name} survives the round trip"
            );
        }
    }
}
