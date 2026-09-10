//! Turning an edit request into a byte splice, per format. See BACKLOG.md M2.1.
//!
//! Every mutation is one byte-range replacement over the document body. The bytes the replacement
//! does not name are memcpy'd by `splice::apply`, so "every other byte of the file is identical" is
//! structural rather than careful; re-parsing the result re-runs the M1 coverage guard on every
//! edit, and `verify` holds the parse to what the plan predicted. Nothing here reaches into
//! `sublore-formats`: the parsers stay the only authority on grammar.

use sublore_formats::override_tags::{self, StyleFlag};
use sublore_formats::{
    AssEvent, AssEventKind, AssField, Cue, CueDetail, Newline, Segment, SegmentKind, Span, SrtCue,
    SubtitleDocument, SubtitleFormat, MAX_TIMECODE_MS,
};

use crate::diff;
use crate::error::{EditError, EditErrorKind};
use crate::splice::{self, EditKind, EditLabel, Splice};
use crate::verify;

/// Re-emitted byte for byte when the document had one; `sublore_formats` keeps its copy private.
const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

/// The SRT scanner reads at most 9 digits as an index line, so a wider number would become text.
const MAX_INDEX: u32 = 999_999_999;

/// What the caller asked for. `cue` is an index into [`SubtitleDocument::cues`], which includes ASS
/// `Comment:` events; it is NOT the displayed count the status line shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Edit {
    /// `text` uses "\n" for every line break whatever the file uses.
    SetText {
        cue: usize,
        text: String,
    },
    /// The same edit over several cues, as one undo step. Pairs are `(cue, text)`, strictly
    /// ascending by cue, each cue named once. See docs/find-replace-tasks.md F1.
    SetTexts {
        edits: Vec<(usize, String)>,
    },
    /// Empty one cue's text. `keep_tags` leaves every braced run where it stands and drops only the
    /// words a reader sees, which is the difference between the reference's Clear and Clear Text.
    ClearText {
        cue: usize,
        keep_tags: bool,
    },
    /// One field of one declared style. The name is not among them: renaming a style means
    /// rewriting every event that names it, which is a different operation and a different undo
    /// step. See edit-bar-tasks.md and the style editor's own slice.
    SetStyleField {
        style: usize,
        field: AssStyleField,
        value: String,
    },
    /// Several override tags written at one caret, as one undo step. A font picker names two, the
    /// family and the size, and a colour with its transparency names two more: neither is two
    /// things a translator did. Pairs are `(tag, value)` in the order they are written.
    SetOverrideTags {
        cue: usize,
        tags: Vec<(String, String)>,
        at: usize,
    },
    SetTimes {
        cue: usize,
        start_ms: u32,
        end_ms: u32,
    },
    /// The same edit over several cues, as one undo step. Triples are `(cue, start_ms, end_ms)`,
    /// strictly ascending by cue, each cue named once. What the times mean is the caller's: this
    /// writes them and checks them back. See docs/timing-tasks.md.
    SetManyTimes {
        edits: Vec<(usize, u32, u32)>,
    },
    /// A paste over: for each named cue, the fields the user chose to take from the clipboard,
    /// written together as one undo step. Pairs are `(cue, fields)`, strictly ascending by cue,
    /// each cue named once. A field the caller left out keeps whatever the target already has,
    /// which is what the dialog exists to decide. See docs/paste-over-tasks.md.
    PasteOverCues {
        edits: Vec<(usize, PastedFields)>,
    },
    /// One declared field of one ASS event, written verbatim. The text field is not among the
    /// fields `AssField` can name. See docs/ass-field-write-tasks.md W3.
    SetField {
        cue: usize,
        field: AssField,
        value: String,
    },
    /// Turn one of the four inline style flags on or off over a stretch of a cue's text. `from` and
    /// `to` are byte offsets into the text as the file spells it, braces included, which is what
    /// the panel's own box shows and therefore what its caret reports. Equal offsets are a caret
    /// rather than a selection, and the tag then takes effect to the end of the line.
    /// See edit-bar-tasks.md B11.
    ToggleStyle {
        cue: usize,
        flag: StyleFlag,
        from: usize,
        to: usize,
    },
    /// Turn an ASS event into a `Comment:` or back into a `Dialogue:`. The descriptor is not one
    /// of the fields `AssField` can name, and this changes how many cues a player would draw, so it
    /// is its own edit. See edit-bar-tasks.md B8.
    SetComment {
        cue: usize,
        comment: bool,
    },
    /// `before == cues().count()` appends.
    Insert {
        before: usize,
        start_ms: u32,
        end_ms: u32,
        text: String,
    },
    /// The clipboard's own lines, put in before `before` exactly as they are spelled.
    /// `before == cues().count()` appends.
    ///
    /// The fragment is read behind this document's own header before anything is written: an ASS
    /// event means nothing without the `Format:` line that names its columns, and a fragment this
    /// document cannot read is refused rather than written. What lands is the fragment itself, so a
    /// paste keeps every field the copy carried.
    Paste {
        before: usize,
        fragment: String,
    },
    Delete {
        cue: usize,
    },
    /// The same edit over several cues, as one undo step. Strictly ascending, each cue named once;
    /// they need not be next to each other, because a selection need not be. The cues left standing
    /// between them are kept exactly as they are written.
    DeleteMany {
        cues: Vec<usize>,
    },
    /// Every named cue written again straight after itself, as one undo step. Strictly ascending,
    /// each named once. The copy is the line as the file spells it, so it carries every field.
    Duplicate {
        cues: Vec<usize>,
    },
    /// Two or more cues joined into the first of them, as one undo step. Strictly ascending, each
    /// named once; they need not be next to each other. The first keeps its start and its fields
    /// and takes the latest end of them all, and its text is either every text in turn or its own.
    Join {
        cues: Vec<usize>,
        keep_first_text: bool,
    },
    /// `text_offset` is a byte offset into the normalized text of `cue`.
    Split {
        cue: usize,
        text_offset: usize,
        at_ms: u32,
    },
    /// A cue cut in two at a frame boundary, the whole text kept in both halves rather than divided.
    /// The first cue becomes `[start, first_end_ms]`, the second `[second_start_ms, end]`; the two
    /// boundaries need not be the same millisecond, because a frame edge sits between them. This is
    /// what the playhead split writes; the text caret split above is the other one. See
    /// docs/split-at-playhead-tasks.md.
    SplitInTwo {
        cue: usize,
        first_end_ms: u32,
        second_start_ms: u32,
    },
    /// Merges `cue` and `cue + 1`.
    Merge {
        cue: usize,
    },
    /// A contiguous run of cues put back in a new order, as one undo step. `order` is a permutation
    /// of `from..from + order.len()`: the same cues, rearranged. Move up and down are a rotation of
    /// the run; a sort is the order a key gives. Nothing is renumbered and no cue's bytes change,
    /// only their sequence, so an SRT index rides along with its block exactly as an insert leaves
    /// it. See docs/reorder-tasks.md.
    Reorder {
        from: usize,
        order: Vec<usize>,
    },
}

impl Edit {
    /// A short, stable name for logs. Never the content: a subtitle line is the user's own
    /// writing, and the line that carries this already says so. The match has no wildcard, so a
    /// new variant does not compile until it is named here. See BACKLOG.md N83.
    pub fn kind_name(&self) -> &'static str {
        match self {
            Edit::SetText { .. } => "set-text",
            Edit::SetTexts { .. } => "set-texts",
            Edit::ClearText { .. } => "clear-text",
            Edit::SetStyleField { .. } => "set-style-field",
            Edit::SetOverrideTags { .. } => "set-override-tags",
            Edit::SetTimes { .. } => "set-times",
            Edit::SetManyTimes { .. } => "set-many-times",
            Edit::PasteOverCues { .. } => "paste-over-cues",
            Edit::SetField { .. } => "set-field",
            Edit::ToggleStyle { .. } => "toggle-style",
            Edit::SetComment { .. } => "set-comment",
            Edit::Insert { .. } => "insert",
            Edit::Paste { .. } => "paste",
            Edit::Delete { .. } => "delete",
            Edit::DeleteMany { .. } => "delete-many",
            Edit::Duplicate { .. } => "duplicate",
            Edit::Join { .. } => "join",
            Edit::Split { .. } => "split",
            Edit::SplitInTwo { .. } => "split-in-two",
            Edit::Merge { .. } => "merge",
            Edit::Reorder { .. } => "reorder",
        }
    }
}

/// What a paste over takes from one clipboard cue. Every part is optional, and absent means "keep
/// what is there": the eleven checkboxes of the reference's own dialog, in the shape this crate can
/// write. See docs/paste-over-tasks.md.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PastedFields {
    /// Whether the target becomes a `Comment:` or a `Dialogue:`. ASS only.
    pub comment: Option<bool>,
    pub start_ms: Option<u32>,
    pub end_ms: Option<u32>,
    /// Line breaks as "\n", like every other text this crate takes.
    pub text: Option<String>,
    /// The declared ASS fields to take, each named once. Order does not matter: the plan sorts its
    /// writes by where they sit in the line, so the caller never has to know the Format order.
    pub fields: Vec<(AssField, String)>,
}

impl PastedFields {
    /// Whether this asks for anything at all. A paste over that takes no field is not an edit, and
    /// making it one would put an empty step on the undo stack.
    pub fn is_empty(&self) -> bool {
        self.comment.is_none()
            && self.start_ms.is_none()
            && self.end_ms.is_none()
            && self.text.is_none()
            && self.fields.is_empty()
    }
}

/// The byte replacement, its label, and what the document must look like once the edited bytes are
/// parsed again.
#[derive(Clone, Debug)]
pub struct Planned {
    pub splice: Splice,
    pub label: EditLabel,
    pub expect: Expectation,
}

/// What [`verify::verify`] holds the re-parsed document to.
#[derive(Clone, Debug)]
pub struct Expectation {
    /// The run of cue indices replaced, in the document as it was.
    pub from: usize,
    pub removed: usize,
    /// What the cues that replace them must read back as, in order. Text is in FILE form: the
    /// document's own line terminator, not the normalized "\n" the caller passed in.
    pub cues: Vec<ExpectedCue>,
    /// The run of segment indices the splice covers, in the document as it was.
    pub segments_from: usize,
    pub segments_removed: usize,
    /// How many segments replace them.
    pub segments_inserted: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExpectedCue {
    pub text_raw: String,
    pub start_ms: u32,
    pub end_ms: u32,
}

#[derive(Debug)]
pub struct Edited {
    pub document: SubtitleDocument,
    pub splice: Splice,
    pub label: EditLabel,
    /// `after.cues().count() - before.cues().count()`, for the history's replay check.
    pub cue_delta: isize,
}

/// Turn a request into a plan. Reads the document, writes nothing.
pub fn plan(document: &SubtitleDocument, edit: &Edit) -> Result<Planned, EditError> {
    match edit {
        Edit::SetText { cue, text } => plan_set_text(document, *cue, text),
        Edit::SetTexts { edits } => plan_set_texts(document, edits),
        Edit::PasteOverCues { edits } => plan_paste_over_cues(document, edits),
        Edit::SetManyTimes { edits } => plan_set_many_times(document, edits),
        Edit::SetTimes {
            cue,
            start_ms,
            end_ms,
        } => plan_set_times(document, *cue, *start_ms, *end_ms),
        Edit::SetField { cue, field, value } => plan_set_field(document, *cue, *field, value),
        Edit::SetComment { cue, comment } => plan_set_comment(document, *cue, *comment),
        Edit::ToggleStyle {
            cue,
            flag,
            from,
            to,
        } => plan_toggle_style(document, *cue, *flag, *from, *to),
        Edit::ClearText { cue, keep_tags } => plan_clear_text(document, *cue, *keep_tags),
        Edit::SetStyleField {
            style,
            field,
            value,
        } => plan_set_style_field(document, *style, *field, value),
        Edit::SetOverrideTags { cue, tags, at } => {
            plan_set_override_tags(document, *cue, tags, *at)
        }
        Edit::Insert {
            before,
            start_ms,
            end_ms,
            text,
        } => plan_insert(document, *before, *start_ms, *end_ms, text),
        Edit::Paste { before, fragment } => plan_paste(document, *before, fragment),
        Edit::Delete { cue } => plan_delete(document, *cue),
        Edit::DeleteMany { cues } => plan_delete_many(document, cues),
        Edit::Duplicate { cues } => plan_duplicate(document, cues),
        Edit::Join {
            cues,
            keep_first_text,
        } => plan_join(document, cues, *keep_first_text),
        Edit::Split {
            cue,
            text_offset,
            at_ms,
        } => plan_split(document, *cue, *text_offset, *at_ms),
        Edit::SplitInTwo {
            cue,
            first_end_ms,
            second_start_ms,
        } => plan_split_in_two(document, *cue, *first_end_ms, *second_start_ms),
        Edit::Merge { cue } => plan_merge(document, *cue),
        Edit::Reorder { from, order } => plan_reorder(document, *from, order),
    }
}

/// Plan, splice, re-parse, verify. The only way a document is ever edited. On any failure the
/// caller still holds the document it passed in, untouched.
pub fn edit(document: &SubtitleDocument, edit: &Edit) -> Result<Edited, EditError> {
    let planned = plan(document, edit)?;
    let body = splice::apply(document.source().body(), &planned.splice)?;
    // The format is carried over, never re-detected: an edit to the first lines of a file must not
    // change which parser reads it. See BACKLOG.md M2.1.
    let after = sublore_formats::parse(document.format(), &assemble(document, &body))
        .map_err(|error| EditError::from_parse(EditErrorKind::Reparse, error))?;
    verify::verify(document, &after, &planned.expect)?;
    // `verify` reads cue counts, times and text and no other field, so a field write proves
    // itself against the re-parsed document. See docs/ass-field-write-tasks.md W6.
    if let Edit::SetField { cue, field, value } = edit {
        verify_field(document, &after, *cue, *field, value)?;
    }
    // The same reason: `verify` reads no descriptor, so the one thing this edit changes proves
    // itself against the re-parsed document.
    if let Edit::SetComment { cue, comment } = edit {
        verify_comment(&after, *cue, *comment)?;
    }

    let cue_delta = delta(document.cues().count(), after.cues().count());
    Ok(Edited {
        document: after,
        splice: planned.splice,
        label: planned.label,
        cue_delta,
    })
}

/// Apply a splice the history produced (undo, redo). Re-parses and refuses anything that does not
/// come back as a document; `apply`'s `removed` check is what makes a stale entry safe.
/// `expect_cue_delta` is the delta the entry recorded, negated for an undo.
pub fn replay(
    document: &SubtitleDocument,
    splice: &Splice,
    expect_cue_delta: isize,
) -> Result<SubtitleDocument, EditError> {
    let body = splice::apply(document.source().body(), splice)?;
    let after = sublore_formats::parse(document.format(), &assemble(document, &body))
        .map_err(|error| EditError::from_parse(EditErrorKind::Reparse, error))?;

    let moved = delta(document.cues().count(), after.cues().count());
    if moved != expect_cue_delta {
        return Err(EditError::new(
            EditErrorKind::Unverified,
            format!(
                "the replay moved the cue count by {moved}, the entry recorded {expect_cue_delta}"
            ),
        ));
    }
    Ok(after)
}

/// The file the edited body spells: the document's byte-order mark, then the body.
fn assemble(document: &SubtitleDocument, body: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(body.len().saturating_add(UTF8_BOM.len()));
    if document.source().has_bom() {
        bytes.extend_from_slice(&UTF8_BOM);
    }
    bytes.extend_from_slice(body.as_bytes());
    bytes
}

fn delta(before: usize, after: usize) -> isize {
    let before = isize::try_from(before).unwrap_or(isize::MAX);
    let after = isize::try_from(after).unwrap_or(isize::MAX);
    after.saturating_sub(before)
}

// ---------------------------------------------------------------------------------------------
// Reading the document
// ---------------------------------------------------------------------------------------------

/// A cue, the segment that owns it, and where that segment sits.
struct Located<'a> {
    segment_index: usize,
    segment: &'a Segment,
    cue: &'a Cue,
}

fn locate(document: &SubtitleDocument, index: usize) -> Result<Located<'_>, EditError> {
    let mut seen = 0usize;
    for (segment_index, segment) in document.segments().iter().enumerate() {
        let SegmentKind::Cue(cue) = &segment.kind else {
            continue;
        };
        if seen == index {
            return Ok(Located {
                segment_index,
                segment,
                cue,
            });
        }
        seen += 1;
    }
    Err(EditError::new(
        EditErrorKind::NoSuchCue,
        format!("cue {index}: the document holds {seen}"),
    ))
}

/// The line terminator this segment writes: the first one inside it, or the file's own when the
/// segment holds none (the last block of a file with no final newline).
fn newline_of(document: &SubtitleDocument, segment: &Segment) -> &'static str {
    let text = document.slice(segment.span);
    match text.find('\n') {
        Some(at) if at > 0 && text.as_bytes().get(at - 1) == Some(&b'\r') => "\r\n",
        Some(_) => "\n",
        None => match document.source().newline() {
            Newline::Crlf => "\r\n",
            Newline::Lf | Newline::Mixed | Newline::None => "\n",
        },
    }
}

/// The terminator this cue's text lines are written with: the one just above the text, or the one
/// that ends the timing line when the text is empty, or the block's own.
fn text_newline(document: &SubtitleDocument, located: &Located<'_>) -> &'static str {
    let body = document.source().body();
    let span = located.cue.text;
    let local = if span.is_empty() {
        terminator_at(body, span.end)
    } else {
        terminator_before(body, span.start)
    };
    local.unwrap_or_else(|| newline_of(document, located.segment))
}

/// The line terminator ending `body[..at]`, when there is one.
fn terminator_before(body: &str, at: usize) -> Option<&'static str> {
    let head = body.get(..at)?;
    if head.ends_with("\r\n") {
        Some("\r\n")
    } else if head.ends_with('\n') {
        Some("\n")
    } else {
        None
    }
}

/// The line terminator starting at `at`, when one starts there.
fn terminator_at(body: &str, at: usize) -> Option<&'static str> {
    let tail = body.get(at..)?;
    if tail.starts_with("\r\n") {
        Some("\r\n")
    } else if tail.starts_with('\n') {
        Some("\n")
    } else {
        None
    }
}

/// How many bytes of line terminator `text` ends with.
fn terminator_len(text: &str) -> usize {
    if text.ends_with("\r\n") {
        2
    } else if text.ends_with('\n') {
        1
    } else {
        0
    }
}

/// The cue's two timestamps in the order the file wrote them: an ASS `Format:` line may put End
/// before Start.
fn ordered(cue: &Cue) -> (Span, Span) {
    let (start, end) = (cue.start.raw(), cue.end.raw());
    if start.start <= end.start {
        (start, end)
    } else {
        (end, start)
    }
}

fn srt_detail(cue: &Cue) -> Option<&SrtCue> {
    match &cue.detail {
        CueDetail::Srt(srt) => Some(srt),
        CueDetail::Vtt(_) | CueDetail::Ass(_) => None,
    }
}

// ---------------------------------------------------------------------------------------------
// Writing text and timestamps
// ---------------------------------------------------------------------------------------------

/// A replacement the format cannot hold. SRT and VTT break blocks on blank lines, so a blank line
/// inside cue text would split the cue in two; an ASS event is one line.
fn validate_text(format: SubtitleFormat, text: &str) -> Result<(), EditError> {
    let unwritable = |detail: &str| EditError::new(EditErrorKind::UnwritableText, detail);
    match format {
        SubtitleFormat::Ass => {
            if text.contains(['\n', '\r']) {
                return Err(unwritable("an ASS event holds no line break; use \\N"));
            }
        }
        SubtitleFormat::Srt | SubtitleFormat::Vtt => {
            if text.is_empty() {
                return Ok(());
            }
            if text.starts_with('\n') || text.ends_with('\n') {
                return Err(unwritable(
                    "cue text may not start or end with a line break",
                ));
            }
            // A `\r` against a line break cannot be told from a terminator once written back.
            if text.ends_with('\r') || text.contains("\r\n") {
                return Err(unwritable(
                    "a carriage return may not end a line of cue text",
                ));
            }
            if text.split('\n').any(is_blank_line) {
                return Err(unwritable(
                    "a blank line inside cue text would split the cue",
                ));
            }
        }
    }
    Ok(())
}

/// Blank by the parsers' own rule: nothing a reader would see.
fn is_blank_line(line: &str) -> bool {
    line.bytes()
        .all(|byte| matches!(byte, b' ' | b'\t' | b'\r'))
}

/// Normalized text in file form: every `\n` becomes the terminator the block writes.
fn render_text(text: &str, newline: &str) -> String {
    if newline == "\n" {
        text.to_owned()
    } else {
        text.replace('\n', newline)
    }
}

/// How a timestamp was spelled, so a rewritten one is spelled the same way.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TimeShape {
    /// Digit width of the hours field; `None` for the VTT `mm:ss` short form.
    hours: Option<usize>,
    /// `,` or `.`, as the file wrote it.
    separator: char,
    /// 1 for tenths, 2 for centiseconds, 3 for milliseconds.
    fraction: usize,
}

fn shape_of(raw: &str) -> TimeShape {
    let separator = if raw.contains(',') { ',' } else { '.' };
    let (clock, fraction) = raw.rsplit_once(separator).unwrap_or((raw, ""));
    let hours = (clock.matches(':').count() >= 2)
        .then(|| clock.split(':').next().unwrap_or("").len().clamp(1, 9));
    TimeShape {
        hours,
        separator,
        fraction: fraction.len().clamp(1, 3),
    }
}

fn default_shape(format: SubtitleFormat) -> TimeShape {
    match format {
        SubtitleFormat::Srt => TimeShape {
            hours: Some(2),
            separator: ',',
            fraction: 3,
        },
        SubtitleFormat::Vtt => TimeShape {
            hours: Some(2),
            separator: '.',
            fraction: 3,
        },
        SubtitleFormat::Ass => TimeShape {
            hours: Some(1),
            separator: '.',
            fraction: 2,
        },
    }
}

/// Spell `millis` the way `shape` was spelled. Widening is allowed where it loses nothing; rounding
/// never is, because rounding a value the caller asked for is a silent change to the user's data.
fn render_timecode(millis: u32, shape: TimeShape) -> Result<String, EditError> {
    if millis > MAX_TIMECODE_MS {
        return Err(EditError::new(
            EditErrorKind::UnwritableTimecode,
            format!("{millis} ms is past the {MAX_TIMECODE_MS} ms ceiling"),
        ));
    }
    let width = shape.fraction.clamp(1, 3);
    let step: u32 = match width {
        1 => 100,
        2 => 10,
        _ => 1,
    };
    let fraction = millis % 1_000;
    if !fraction.is_multiple_of(step) {
        return Err(EditError::new(
            EditErrorKind::UnwritableTimecode,
            format!("{millis} ms needs more than {width} fraction digit(s)"),
        ));
    }

    let seconds = millis / 1_000;
    let clock = match shape.hours {
        Some(digits) => format!(
            "{:0width$}:{:02}:{:02}",
            seconds / 3_600,
            (seconds / 60) % 60,
            seconds % 60,
            width = digits.clamp(1, 9)
        ),
        None if seconds / 60 > 59 => {
            // The `mm:ss` short form cannot hold an hour, and WEBVTT spells hours with two digits
            // or more, so the promotion widens rather than writing `1:00:00.000`.
            return render_timecode(
                millis,
                TimeShape {
                    hours: Some(2),
                    ..shape
                },
            );
        }
        None => format!("{:02}:{:02}", seconds / 60, seconds % 60),
    };
    Ok(format!(
        "{clock}{}{:0width$}",
        shape.separator,
        fraction / step,
        width = width
    ))
}

// ---------------------------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------------------------

/// The shape one SRT or VTT block is written in. Everything here is bytes the file already had,
/// except the timestamps and the text.
#[derive(Clone, Copy, Debug)]
struct Block<'a> {
    newline: &'static str,
    /// Whatever sits between the two timestamps, `" --> "` in every file anyone has shipped.
    arrow: &'a str,
    start_shape: TimeShape,
    end_shape: TimeShape,
    /// SRT: the index line's number, when the block has one.
    number: Option<u32>,
    /// SRT: whatever followed the end timestamp, DVD coordinates included.
    trailer: Option<&'a str>,
    /// VTT: the cue identifier line, when the block has one.
    id: Option<&'a str>,
    /// VTT: the cue settings after the end timestamp.
    settings: Option<&'a str>,
}

impl Block<'_> {
    fn render(
        &self,
        format: SubtitleFormat,
        start_ms: u32,
        end_ms: u32,
        text: &str,
        terminate: bool,
    ) -> Result<String, EditError> {
        let newline = self.newline;
        let mut block = String::new();
        match format {
            SubtitleFormat::Srt => {
                if let Some(number) = self.number {
                    if number > MAX_INDEX {
                        return Err(EditError::new(
                            EditErrorKind::NotApplicable,
                            format!("index {number} is wider than an SRT index line"),
                        ));
                    }
                    block.push_str(&number.to_string());
                    block.push_str(newline);
                }
            }
            SubtitleFormat::Vtt => {
                if let Some(id) = self.id {
                    block.push_str(id);
                    block.push_str(newline);
                }
            }
            SubtitleFormat::Ass => {
                return Err(EditError::new(
                    EditErrorKind::NotApplicable,
                    "an ASS event is built from its own line, not from a block",
                ))
            }
        }

        block.push_str(&render_timecode(start_ms, self.start_shape)?);
        block.push_str(self.arrow);
        block.push_str(&render_timecode(end_ms, self.end_shape)?);
        match format {
            SubtitleFormat::Srt => block.push_str(self.trailer.unwrap_or("")),
            SubtitleFormat::Vtt => {
                if let Some(settings) = self.settings {
                    // The parser trims the settings span, so the separator is written back here.
                    block.push(' ');
                    block.push_str(settings);
                }
            }
            SubtitleFormat::Ass => {}
        }

        if !text.is_empty() {
            block.push_str(newline);
            block.push_str(&render_text(text, newline));
        }
        if terminate {
            block.push_str(newline);
        }
        Ok(block)
    }
}

/// The shape of an existing block, identity included: a split or a merge keeps the index line, the
/// identifier, the settings and the trailer the user already had.
fn block_of<'a>(
    document: &'a SubtitleDocument,
    located: &Located<'a>,
) -> Result<Block<'a>, EditError> {
    let cue = located.cue;
    let (number, trailer) = match srt_detail(cue) {
        Some(srt) => (
            srt.number,
            srt.timing_trailer.map(|span| document.slice(span)),
        ),
        None => (None, None),
    };
    let (id, settings) = match &cue.detail {
        CueDetail::Vtt(vtt) => (
            vtt.id.map(|span| document.slice(span)),
            vtt.settings.map(|span| document.slice(span)),
        ),
        CueDetail::Srt(_) | CueDetail::Ass(_) => (None, None),
    };
    Ok(Block {
        newline: newline_of(document, located.segment),
        arrow: arrow_of(document, cue)?,
        start_shape: shape_of(document.slice(cue.start.raw())),
        end_shape: shape_of(document.slice(cue.end.raw())),
        number,
        trailer,
        id,
        settings,
    })
}

fn arrow_of<'a>(document: &'a SubtitleDocument, cue: &Cue) -> Result<&'a str, EditError> {
    let (start, end) = (cue.start.raw(), cue.end.raw());
    if start.end > end.start {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "the cue's timestamps are not written in order",
        ));
    }
    Ok(document.slice(Span::new(start.end, end.start)))
}

/// One ASS event line built from an existing one: the two timing fields and the text field are
/// replaced, every other field is copied byte for byte, so the new line still satisfies the
/// section's `Format:` line.
fn ass_line(
    document: &SubtitleDocument,
    from: &Located<'_>,
    start_ms: u32,
    end_ms: u32,
    text: &str,
    as_dialogue: bool,
    terminate: bool,
) -> Result<String, EditError> {
    let CueDetail::Ass(event) = &from.cue.detail else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "the cue is not an ASS event",
        ));
    };
    let line = document.slice(from.segment.span);
    let content_end = from
        .segment
        .span
        .end
        .saturating_sub(terminator_len(line))
        .max(from.segment.span.start);

    let Some(text_span) = event.fields.get(event.text_field).copied() else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "the event declares no text field",
        ));
    };

    let mut fields = vec![
        (
            from.cue.start.raw(),
            render_timecode(start_ms, shape_of(document.slice(from.cue.start.raw())))?,
        ),
        (
            from.cue.end.raw(),
            render_timecode(end_ms, shape_of(document.slice(from.cue.end.raw())))?,
        ),
        (text_span, text.to_owned()),
    ];
    // A new event is a Dialogue even when the line it was copied from is a Comment.
    if as_dialogue && event.kind == sublore_formats::AssEventKind::Comment {
        fields.push((event.descriptor, "Dialogue".to_owned()));
    }
    fields.sort_by_key(|(span, _)| span.start);

    let mut out = String::with_capacity(line.len().saturating_add(text.len()));
    let mut at = from.segment.span.start;
    for (span, replacement) in fields {
        if span.start < at || span.end > content_end {
            return Err(EditError::new(
                EditErrorKind::NotApplicable,
                "the event's fields overlap or escape their line",
            ));
        }
        out.push_str(document.slice(Span::new(at, span.start)));
        out.push_str(&replacement);
        at = span.end;
    }
    out.push_str(document.slice(Span::new(at, content_end)));
    if terminate {
        out.push_str(newline_of(document, from.segment));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// The mutations
// ---------------------------------------------------------------------------------------------

/// What one cue's text edit replaces and what it writes there.
///
/// The one implementation both the single-cue plan and the many-cue plan use, so the two cannot
/// spell a cue differently. `written` is what the re-parse must read back, which is not always what
/// lands in the body: text written into an empty SRT span takes a line terminator in front of it.
struct TextWrite {
    range: Span,
    inserted: String,
    written: String,
}

fn plan_text_write(
    document: &SubtitleDocument,
    located: &Located<'_>,
    text: &str,
) -> Result<TextWrite, EditError> {
    let format = document.format();
    let text = diff::normalize(text);
    validate_text(format, &text)?;

    let body = document.source().body();
    let span = located.cue.text;
    let newline = text_newline(document, located);
    let written = render_text(&text, newline);

    // An SRT or VTT cue with no text parks an empty span at the end of its timing line: writing
    // into it directly would grow a timing trailer instead of a text line.
    let (range, inserted) = match format {
        SubtitleFormat::Ass => (span, written.clone()),
        SubtitleFormat::Srt | SubtitleFormat::Vtt => match (span.is_empty(), text.is_empty()) {
            (false, false) => (span, written.clone()),
            (false, true) => {
                let lead = terminator_before(body, span.start).unwrap_or("").len();
                (
                    Span::new(span.start.saturating_sub(lead), span.end),
                    String::new(),
                )
            }
            (true, false) => (span, format!("{newline}{written}")),
            (true, true) => {
                return Err(EditError::new(
                    EditErrorKind::NotApplicable,
                    "the cue already has no text",
                ))
            }
        },
    };

    Ok(TextWrite {
        range,
        inserted,
        written,
    })
}

fn plan_set_text(
    document: &SubtitleDocument,
    index: usize,
    text: &str,
) -> Result<Planned, EditError> {
    let located = locate(document, index)?;
    let write = plan_text_write(document, &located, text)?;

    Ok(Planned {
        splice: Splice::new(
            write.range.start,
            document.slice(write.range).to_owned(),
            write.inserted,
        ),
        label: EditLabel {
            kind: EditKind::SetText,
            cue: index,
        },
        expect: Expectation {
            from: index,
            removed: 1,
            cues: vec![ExpectedCue {
                text_raw: write.written,
                start_ms: located.cue.start.millis(),
                end_ms: located.cue.end.millis(),
            }],
            segments_from: located.segment_index,
            segments_removed: 1,
            segments_inserted: 1,
        },
    })
}

/// Every cue from `from` to `to` inclusive, with the segment each sits in, in one pass.
///
/// `locate` answers for one cue, and a many-cue plan calling it per cue would walk the document
/// once per cue. Errors with `NoSuchCue` when the run does not fit, exactly as `locate` does.
fn locate_run<'a>(
    document: &'a SubtitleDocument,
    from: usize,
    to: usize,
) -> Result<Vec<Located<'a>>, EditError> {
    let wanted = to.saturating_sub(from).saturating_add(1);
    let mut found = Vec::with_capacity(wanted);
    let mut seen = 0usize;
    for (segment_index, segment) in document.segments().iter().enumerate() {
        let SegmentKind::Cue(cue) = &segment.kind else {
            continue;
        };
        if seen >= from && seen <= to {
            found.push(Located {
                segment_index,
                segment,
                cue,
            });
        }
        seen += 1;
        if seen > to {
            break;
        }
    }
    if found.len() != wanted {
        return Err(EditError::new(
            EditErrorKind::NoSuchCue,
            format!("cues {from}..={to}: the document holds {seen}"),
        ));
    }
    Ok(found)
}

/// Rewrite the text of several cues as one splice, from the first byte any of them changes to the
/// last. The bytes between them ride along unchanged, which is what makes this one undo step
/// instead of one per cue; the history can only merge edits that rewrite each other's bytes, and
/// forty cues at forty offsets are not that. See docs/find-replace-tasks.md F1.
fn plan_set_texts(
    document: &SubtitleDocument,
    edits: &[(usize, String)],
) -> Result<Planned, EditError> {
    let (Some((first, _)), Some((last, _))) = (edits.first(), edits.last()) else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "a text edit naming no cues",
        ));
    };
    // Strictly ascending: a repeated cue would put two writes over one range, and an unordered list
    // would build the span out of order. Both are caller bugs, so neither is repaired here.
    if edits.windows(2).any(|pair| pair[0].0 >= pair[1].0) {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "the cues must be given in file order, each one named once",
        ));
    }

    let run = locate_run(document, *first, *last)?;
    let (Some(head), Some(tail)) = (run.first(), run.last()) else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "a text edit naming no cues",
        ));
    };
    let segments_from = head.segment_index;
    let segments_run = tail
        .segment_index
        .saturating_sub(segments_from)
        .saturating_add(1);

    let mut writes = Vec::with_capacity(edits.len());
    let mut cues = Vec::with_capacity(run.len());
    let mut pending = edits.iter().peekable();
    for (offset, located) in run.iter().enumerate() {
        let index = first.saturating_add(offset);
        let start_ms = located.cue.start.millis();
        let end_ms = located.cue.end.millis();
        match pending.next_if(|(at, _)| *at == index) {
            Some((_, text)) => {
                let write = plan_text_write(document, located, text)?;
                cues.push(ExpectedCue {
                    text_raw: write.written.clone(),
                    start_ms,
                    end_ms,
                });
                writes.push(write);
            }
            // Untouched, and named in the expectation anyway: the splice replaces the bytes it sits
            // in, so "it did not move" is something the verification has to prove rather than skip.
            None => cues.push(ExpectedCue {
                text_raw: document.slice(located.cue.text).to_owned(),
                start_ms,
                end_ms,
            }),
        }
    }

    let (Some(opening), Some(closing)) = (writes.first(), writes.last()) else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "a text edit naming no cues",
        ));
    };
    let span = Span::new(opening.range.start, closing.range.end);

    let body = document.source().body();
    let mut inserted = String::new();
    let mut cursor = span.start;
    for write in &writes {
        // Two writes over one range would drop bytes between them. Ascending indices make it
        // unreachable through a cue's own text span; a format whose spans overlap would reach it.
        let Some(between) = body.get(cursor..write.range.start) else {
            return Err(EditError::new(
                EditErrorKind::BadRange,
                format!(
                    "the write at {} does not follow the one ending at {cursor}",
                    write.range.start
                ),
            ));
        };
        inserted.push_str(between);
        inserted.push_str(&write.inserted);
        cursor = write.range.end;
    }

    Ok(Planned {
        splice: Splice::new(span.start, document.slice(span).to_owned(), inserted),
        label: EditLabel {
            kind: EditKind::SetTexts,
            cue: *first,
        },
        expect: Expectation {
            from: *first,
            removed: run.len(),
            cues,
            segments_from,
            segments_removed: segments_run,
            segments_inserted: segments_run,
        },
    })
}

/// One replacement inside one cue: where it goes and what goes there.
struct CueWrite {
    range: Span,
    inserted: String,
}

/// The writes one paste over makes in one cue, and what that cue must read back as.
///
/// Each chosen part is located on its own, so what the user did not choose is not rewritten and its
/// bytes are not touched. That is what keeps a paste over lossless: an untaken field is not
/// re-serialised from a parsed value, it is simply left alone.
fn paste_writes(
    document: &SubtitleDocument,
    located: &Located<'_>,
    pasted: &PastedFields,
) -> Result<(Vec<CueWrite>, ExpectedCue), EditError> {
    let mut writes: Vec<CueWrite> = Vec::new();

    if let Some(comment) = pasted.comment {
        let CueDetail::Ass(event) = &located.cue.detail else {
            return Err(EditError::new(
                EditErrorKind::NotApplicable,
                "the cue is not an ASS event, so it has no descriptor to rewrite",
            ));
        };
        writes.push(CueWrite {
            range: event.descriptor,
            inserted: if comment { "Comment" } else { "Dialogue" }.to_owned(),
        });
    }

    // One write covers both timestamps, so a paste that takes only one of them writes the other
    // back as it already reads. `time_write` is what decides where that region begins and ends.
    let start_ms = pasted
        .start_ms
        .unwrap_or_else(|| located.cue.start.millis());
    let end_ms = pasted.end_ms.unwrap_or_else(|| located.cue.end.millis());
    if pasted.start_ms.is_some() || pasted.end_ms.is_some() {
        if start_ms > end_ms {
            return Err(EditError::new(
                EditErrorKind::NotApplicable,
                format!("the start {start_ms} is after the end {end_ms}"),
            ));
        }
        let write = time_write(document, located, start_ms, end_ms)?;
        writes.push(CueWrite {
            range: Span::new(write.range.start, write.range.end),
            inserted: write.inserted,
        });
    }

    for (field, value) in &pasted.fields {
        let CueDetail::Ass(event) = &located.cue.detail else {
            return Err(EditError::new(
                EditErrorKind::NotApplicable,
                "the cue is not an ASS event, so it holds no declared field",
            ));
        };
        // Refused, never added, for the reason `plan_set_field` gives: declaring a field means
        // rewriting the Format line and every event under it (W5.1).
        let Some(at) = event.field_index(*field) else {
            return Err(EditError::new(
                EditErrorKind::NotApplicable,
                format!(
                    "the section's Format line declares no {} before the text",
                    field.as_str()
                ),
            ));
        };
        let Some(span) = event.fields.get(at).copied() else {
            return Err(EditError::new(
                EditErrorKind::NotApplicable,
                format!(
                    "field {at} is outside the event's {} fields",
                    event.fields.len()
                ),
            ));
        };
        validate_field_value(*field, value)?;
        writes.push(CueWrite {
            range: field_core(document, span),
            inserted: written_value(value).to_owned(),
        });
    }

    let text_raw = match &pasted.text {
        Some(text) => {
            let write = plan_text_write(document, located, text)?;
            writes.push(CueWrite {
                range: write.range,
                inserted: write.inserted,
            });
            write.written
        }
        None => document.slice(located.cue.text).to_owned(),
    };

    writes.sort_by_key(|write| write.range.start);
    // A Format line may put a field between the two timestamps, and then the timing region swallows
    // it and this paste would write the same bytes twice. Refused rather than guessed at: dropping
    // one of the two writes would silently take a field the user asked for, or lose one they did.
    if let Some(pair) = writes
        .windows(2)
        .find(|pair| pair[0].range.end > pair[1].range.start)
    {
        return Err(EditError::new(
            EditErrorKind::BadRange,
            format!(
                "this cue's fields overlap in the file: a write ending at {} sits inside the one starting at {}",
                pair[0].range.end, pair[1].range.start
            ),
        ));
    }

    Ok((
        writes,
        ExpectedCue {
            text_raw,
            start_ms,
            end_ms,
        },
    ))
}

/// Several cues pasted over in one splice, so the whole paste is one undo step.
///
/// Built the way `plan_set_texts` and `plan_set_many_times` are: one splice over the run the edits
/// touch, every cue in between copied through and named in the expectation. What differs is that a
/// cue here may take several writes rather than one, because the fields a paste takes sit in
/// different places on the line. See docs/paste-over-tasks.md.
fn plan_paste_over_cues(
    document: &SubtitleDocument,
    edits: &[(usize, PastedFields)],
) -> Result<Planned, EditError> {
    let (Some((first, _)), Some((last, _))) = (edits.first(), edits.last()) else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "a paste over naming no cues",
        ));
    };
    if edits.windows(2).any(|pair| pair[0].0 >= pair[1].0) {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "the cues must be given in file order, each one named once",
        ));
    }
    // A paste that takes nothing is not an edit. Refused here rather than planned into an empty
    // splice, so it never reaches the undo stack as a step that undoes nothing.
    if edits.iter().all(|(_, pasted)| pasted.is_empty()) {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "a paste over taking no field from any cue",
        ));
    }

    let run = locate_run(document, *first, *last)?;
    let (Some(head), Some(tail)) = (run.first(), run.last()) else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "a paste over naming no cues",
        ));
    };
    let segments_from = head.segment_index;
    let segments_run = tail
        .segment_index
        .saturating_sub(segments_from)
        .saturating_add(1);

    let mut writes: Vec<CueWrite> = Vec::new();
    let mut cues = Vec::with_capacity(run.len());
    let mut pending = edits.iter().peekable();
    for (offset, located) in run.iter().enumerate() {
        let index = first.saturating_add(offset);
        match pending.next_if(|(at, _)| *at == index) {
            Some((_, pasted)) if !pasted.is_empty() => {
                let (mut mine, expected) = paste_writes(document, located, pasted)?;
                writes.append(&mut mine);
                cues.push(expected);
            }
            // Named but taking nothing, or not named at all: copied through either way, and named
            // in the expectation because the splice replaces the bytes it sits in.
            _ => cues.push(ExpectedCue {
                text_raw: document.slice(located.cue.text).to_owned(),
                start_ms: located.cue.start.millis(),
                end_ms: located.cue.end.millis(),
            }),
        }
    }

    let (Some(opening), Some(closing)) = (writes.first(), writes.last()) else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "a paste over with nothing to write",
        ));
    };
    let span = Span::new(opening.range.start, closing.range.end);

    let body = document.source().body();
    let mut inserted = String::new();
    let mut cursor = span.start;
    for write in &writes {
        let Some(between) = body.get(cursor..write.range.start) else {
            return Err(EditError::new(
                EditErrorKind::BadRange,
                format!(
                    "the write at {} does not follow the one ending at {cursor}",
                    write.range.start
                ),
            ));
        };
        inserted.push_str(between);
        inserted.push_str(&write.inserted);
        cursor = write.range.end;
    }

    Ok(Planned {
        splice: Splice::new(span.start, document.slice(span).to_owned(), inserted),
        label: EditLabel {
            kind: EditKind::PasteOverCues,
            cue: *first,
        },
        expect: Expectation {
            from: *first,
            removed: run.len(),
            cues,
            segments_from,
            segments_removed: segments_run,
            segments_inserted: segments_run,
        },
    })
}

/// One region of a cue's line holding both its timestamps, rewritten.
struct TimeWrite {
    range: std::ops::Range<usize>,
    inserted: String,
}

/// The bytes that carry a cue's two timestamps, with the new ones in them.
///
/// The region runs from the first timestamp to the second and keeps whatever the file wrote between
/// them: the arrow, the ASS fields, a VTT setting. Which of the two comes first in the line is the
/// file's business, not the caller's.
fn time_write(
    document: &SubtitleDocument,
    located: &Located<'_>,
    start_ms: u32,
    end_ms: u32,
) -> Result<TimeWrite, EditError> {
    let cue = located.cue;
    let (first_span, second_span) = ordered(cue);
    if first_span.end > second_span.start {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "the cue's timestamps overlap in the file",
        ));
    }
    let (first_ms, second_ms) = if cue.start.raw().start <= cue.end.raw().start {
        (start_ms, end_ms)
    } else {
        (end_ms, start_ms)
    };
    let first = render_timecode(first_ms, shape_of(document.slice(first_span)))?;
    let second = render_timecode(second_ms, shape_of(document.slice(second_span)))?;
    let between = document.slice(Span::new(first_span.end, second_span.start));
    Ok(TimeWrite {
        range: first_span.start..second_span.end,
        inserted: format!("{first}{between}{second}"),
    })
}

/// Several cues retimed in one splice, so they are one undo step.
///
/// Built the way `plan_set_texts` builds its own: one splice over the whole run the edits touch,
/// with every cue in between copied through and named in the expectation, because a splice that
/// replaces a range has to prove that what it did not mean to change did not change.
fn plan_set_many_times(
    document: &SubtitleDocument,
    edits: &[(usize, u32, u32)],
) -> Result<Planned, EditError> {
    let (Some((first, _, _)), Some((last, _, _))) = (edits.first(), edits.last()) else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "a timing edit naming no cues",
        ));
    };
    // Strictly ascending, each cue once: two writes over one line would drop the bytes between them.
    if edits.windows(2).any(|pair| pair[0].0 >= pair[1].0) {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "the cues must be given in file order, each one named once",
        ));
    }
    if let Some((cue, start_ms, end_ms)) = edits.iter().find(|(_, start, end)| start > end) {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            format!("cue {cue}: the start {start_ms} is after the end {end_ms}"),
        ));
    }

    let run = locate_run(document, *first, *last)?;
    let (Some(head), Some(tail)) = (run.first(), run.last()) else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "a timing edit naming no cues",
        ));
    };
    let segments_from = head.segment_index;
    let segments_run = tail
        .segment_index
        .saturating_sub(segments_from)
        .saturating_add(1);

    let mut writes = Vec::with_capacity(edits.len());
    let mut cues = Vec::with_capacity(run.len());
    let mut pending = edits.iter().peekable();
    for (offset, located) in run.iter().enumerate() {
        let index = first.saturating_add(offset);
        let text_raw = document.slice(located.cue.text).to_owned();
        match pending.next_if(|(at, _, _)| *at == index) {
            Some((_, start_ms, end_ms)) => {
                writes.push(time_write(document, located, *start_ms, *end_ms)?);
                cues.push(ExpectedCue {
                    text_raw,
                    start_ms: *start_ms,
                    end_ms: *end_ms,
                });
            }
            None => cues.push(ExpectedCue {
                text_raw,
                start_ms: located.cue.start.millis(),
                end_ms: located.cue.end.millis(),
            }),
        }
    }

    let (Some(opening), Some(closing)) = (writes.first(), writes.last()) else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "a timing edit naming no cues",
        ));
    };
    let span = Span::new(opening.range.start, closing.range.end);

    let body = document.source().body();
    let mut inserted = String::new();
    let mut cursor = span.start;
    for write in &writes {
        let Some(between) = body.get(cursor..write.range.start) else {
            return Err(EditError::new(
                EditErrorKind::BadRange,
                format!(
                    "the write at {} does not follow the one ending at {cursor}",
                    write.range.start
                ),
            ));
        };
        inserted.push_str(between);
        inserted.push_str(&write.inserted);
        cursor = write.range.end;
    }

    Ok(Planned {
        splice: Splice::new(span.start, document.slice(span).to_owned(), inserted),
        label: EditLabel {
            kind: EditKind::SetManyTimes,
            cue: *first,
        },
        expect: Expectation {
            from: *first,
            removed: run.len(),
            cues,
            segments_from,
            segments_removed: segments_run,
            segments_inserted: segments_run,
        },
    })
}

fn plan_set_times(
    document: &SubtitleDocument,
    index: usize,
    start_ms: u32,
    end_ms: u32,
) -> Result<Planned, EditError> {
    let located = locate(document, index)?;
    let cue = located.cue;
    let (first_span, second_span) = ordered(cue);
    if first_span.end > second_span.start {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "the cue's timestamps overlap in the file",
        ));
    }
    let (first_ms, second_ms) = if cue.start.raw().start <= cue.end.raw().start {
        (start_ms, end_ms)
    } else {
        (end_ms, start_ms)
    };

    // Only the two timestamps are rewritten; whatever the file wrote between and around them --
    // the arrow, ASS fields, DVD coordinates, VTT settings -- is never looked at.
    let first = render_timecode(first_ms, shape_of(document.slice(first_span)))?;
    let second = render_timecode(second_ms, shape_of(document.slice(second_span)))?;
    let between = document.slice(Span::new(first_span.end, second_span.start));
    let region = Span::new(first_span.start, second_span.end);

    Ok(Planned {
        splice: Splice::new(
            region.start,
            document.slice(region).to_owned(),
            format!("{first}{between}{second}"),
        ),
        label: EditLabel {
            kind: EditKind::SetTimes,
            cue: index,
        },
        expect: Expectation {
            from: index,
            removed: 1,
            cues: vec![ExpectedCue {
                text_raw: document.slice(cue.text).to_owned(),
                start_ms,
                end_ms,
            }],
            segments_from: located.segment_index,
            segments_removed: 1,
            segments_inserted: 1,
        },
    })
}

// ---------------------------------------------------------------------------------------------
// One ASS event field
// ---------------------------------------------------------------------------------------------

/// The ASS event a cue index names, or a refusal. SRT blocks and VTT cues have no declared fields
/// and their formats have nowhere to put one.
fn ass_event_of(document: &SubtitleDocument, index: usize) -> Result<&AssEvent, EditError> {
    let cue = locate(document, index)?.cue;
    match &cue.detail {
        CueDetail::Ass(event) => Ok(event),
        CueDetail::Srt(_) | CueDetail::Vtt(_) => Err(EditError::new(
            EditErrorKind::NotApplicable,
            "the cue is not an ASS event, so it holds no declared field",
        )),
    }
}

/// The part of a field's span a write replaces: the span without its leading spaces and tabs and
/// its trailing spaces, tabs and carriage return, which is the trim a column renders it with.
///
/// Keeping the padding outside the splice is what leaves the space after `Dialogue:` and a
/// hand-spaced line exactly as the file wrote them, and what makes committing a field unchanged a
/// no-op rather than a silent reformat. See docs/ass-field-write-tasks.md W4.
/// What a field value is written as. A value with anything in it goes in as it was given, because
/// C5.2 rules that trimming for display must never trim on the way back out and a style may
/// genuinely be named `Sign Top `. A value that is nothing but padding is written as empty: the
/// panel already draws it as empty, and written whole it landed outside the core and appended a
/// byte and an undo step on every commit. See W4.
fn written_value(value: &str) -> &str {
    if value
        .trim_start_matches([' ', '\t'])
        .trim_end_matches([' ', '\t', '\r'])
        .is_empty()
    {
        return "";
    }
    value
}

/// One rule, shared with the grid column that reads the same field back: a control that showed a
/// value trimmed differently from the one a commit writes would commit something else.
/// See styles-and-fields-tasks.md F3.
fn field_core(document: &SubtitleDocument, span: Span) -> Span {
    sublore_formats::ass::trim_field(document.source().body(), span)
}

/// Whether the field holds an integer, and whether that integer may be negative: a margin may, a
/// layer may not.
fn integer_field(field: AssField) -> Option<bool> {
    match field {
        AssField::Layer => Some(false),
        AssField::MarginL | AssField::MarginR | AssField::MarginV => Some(true),
        AssField::Style | AssField::Actor | AssField::Effect => None,
    }
}

/// Digits, an optional single leading `-` where `signed`, and a value an `i32` holds. Leading
/// zeros are kept: `ssa-v4.ssa` spells its margins `0000` and the file is written what it is given.
fn is_integer(value: &str, signed: bool) -> bool {
    let digits = match value.strip_prefix('-') {
        Some(rest) if signed => rest,
        Some(_) => return false,
        None => value,
    };
    !digits.is_empty()
        && digits.bytes().all(|byte| byte.is_ascii_digit())
        && value.parse::<i32>().is_ok()
}

/// What a field may not hold, refused before anything is spliced. See ass-field-write-tasks.md W5.
fn validate_field_value(field: AssField, value: &str) -> Result<(), EditError> {
    let unwritable = |detail: &str| EditError::new(EditErrorKind::UnwritableText, detail);
    // The worst one: a comma cuts a field the `Format:` line does not declare, so every field
    // after it shifts and the text field swallows the tail. It moves the user's own writing.
    if value.contains(',') {
        return Err(unwritable(
            "a comma separates ASS fields, so a field value may not hold one",
        ));
    }
    if value.contains('\n') {
        return Err(unwritable("an ASS event holds no line break"));
    }
    if value.contains('\r') {
        return Err(unwritable(
            "a carriage return in an ASS field cannot be read back",
        ));
    }
    // Refused and never stripped: dropping a byte the caller passed in changes the user's data
    // without saying so, which is what `render_timecode` refuses to do with a rounded timestamp.
    if value
        .chars()
        .any(|character| matches!(character, '\u{0}'..='\u{1f}' | '\u{7f}'))
    {
        return Err(unwritable(
            "a control character cannot be written into an ASS field",
        ));
    }
    if let Some(signed) = integer_field(field) {
        if !is_integer(value, signed) {
            return Err(EditError::new(
                EditErrorKind::NotApplicable,
                format!("{} holds an integer, not {value:?}", field.as_str()),
            ));
        }
    }
    Ok(())
}

/// Write one declared field of one ASS event, verbatim, inside that field's own span.
///
/// One cue: a write across a selection is a loop over this and the loop belongs with the panel
/// that has a selection (W7). The commas belong to no field, so a splice that stays inside a core
/// cannot reach one whether the field is first, last before the text, or in between.
/// A splice over the event's own descriptor, which is the word before the colon. Nothing else on
/// the line moves, so the times and the text the verifier checks are the ones that were there.
/// The flag's state at the caret, then the opposite of it written there, and the state it had put
/// back at the far end of the selection shifted by whatever the first write inserted. That is the
/// whole of it, and it is why the writer returns a shift.
/// The same write a style toggle makes, with the value given rather than worked out. A tag name
/// that is not a backslash and letters is refused: everything downstream reads a name that way, and
/// a value carrying a brace would close the block it was written into.
/// Refuse a name that is not one and a value that could break the block it is written into.
///
/// One digit may lead the name, because the numbered colours and alphas are spelt `\\2c` and
/// `\\1a`, and after it the name is letters to the end: whatever follows those is the value.
fn check_tag(tag: &str, value: &str) -> Result<(), EditError> {
    let named = tag.strip_prefix('\\').unwrap_or("");
    let letters = named
        .strip_prefix(|first: char| first.is_ascii_digit())
        .unwrap_or(named);
    if letters.is_empty() || !letters.bytes().all(|byte| byte.is_ascii_alphabetic()) {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            format!(
                "{tag} is not a tag name: a name is a backslash, one digit at most, then letters"
            ),
        ));
    }
    if value.contains(['{', '}', '\\']) {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "a tag value may not carry a brace or a backslash",
        ));
    }
    Ok(())
}

/// Which column of a `Style:` line a write names. Closed on purpose, and the name is not on it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AssStyleField {
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

impl AssStyleField {
    pub fn as_str(self) -> &'static str {
        match self {
            AssStyleField::Fontname => "fontname",
            AssStyleField::Fontsize => "fontsize",
            AssStyleField::Primary => "primary colour",
            AssStyleField::Secondary => "secondary colour",
            AssStyleField::Outline => "outline colour",
            AssStyleField::Back => "shadow colour",
            AssStyleField::Bold => "bold",
            AssStyleField::Italic => "italic",
            AssStyleField::Underline => "underline",
            AssStyleField::Strikeout => "strikeout",
            AssStyleField::ScaleX => "horizontal scale",
            AssStyleField::ScaleY => "vertical scale",
            AssStyleField::Spacing => "spacing",
            AssStyleField::Angle => "rotation",
            AssStyleField::BorderStyle => "border style",
            AssStyleField::OutlineWidth => "outline width",
            AssStyleField::Shadow => "shadow depth",
            AssStyleField::Alignment => "alignment",
            AssStyleField::MarginL => "left margin",
            AssStyleField::MarginR => "right margin",
            AssStyleField::MarginV => "vertical margin",
            AssStyleField::Encoding => "encoding",
        }
    }

    /// Where the field sits in the style the document read, or an empty span where the section's
    /// own `Format:` line declares no such column.
    fn span(self, style: &sublore_formats::AssStyle) -> Span {
        match self {
            AssStyleField::Fontname => style.fontname,
            AssStyleField::Fontsize => style.fontsize,
            AssStyleField::Primary => style.primary,
            AssStyleField::Secondary => style.secondary,
            AssStyleField::Outline => style.outline,
            AssStyleField::Back => style.back,
            AssStyleField::Bold => style.bold_field,
            AssStyleField::Italic => style.italic_field,
            AssStyleField::Underline => style.underline_field,
            AssStyleField::Strikeout => style.strikeout_field,
            AssStyleField::ScaleX => style.scale_x,
            AssStyleField::ScaleY => style.scale_y,
            AssStyleField::Spacing => style.spacing,
            AssStyleField::Angle => style.angle,
            AssStyleField::BorderStyle => style.border_style,
            AssStyleField::OutlineWidth => style.outline_width,
            AssStyleField::Shadow => style.shadow,
            AssStyleField::Alignment => style.alignment,
            AssStyleField::MarginL => style.margin_l,
            AssStyleField::MarginR => style.margin_r,
            AssStyleField::MarginV => style.margin_v,
            AssStyleField::Encoding => style.encoding,
        }
    }
}

/// Write one field of one declared style.
///
/// The same shape a cue's field write has, over a different line: the span the parser recorded is
/// replaced and nothing else moves. A field the section's `Format:` line does not declare is
/// refused rather than added, for the reason a cue's is: declaring one means rewriting every line
/// under that header, including the ones nobody edited.
fn plan_set_style_field(
    document: &SubtitleDocument,
    index: usize,
    field: AssStyleField,
    value: &str,
) -> Result<Planned, EditError> {
    let Some(style) = document.ass_styles().get(index) else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            format!("no style {index} in this document"),
        ));
    };
    let span = field.span(style);
    if span.start == span.end && span.start == 0 {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            format!(
                "the styles section's Format line declares no {}",
                field.as_str()
            ),
        ));
    }
    validate_style_value(field, value)?;

    let Some(segment_index) = document
        .segments()
        .iter()
        .position(|segment| segment.span.start <= span.start && span.end <= segment.span.end)
    else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "the style line is not inside any segment of this document",
        ));
    };

    let core = field_core(document, span);
    Ok(Planned {
        splice: Splice::new(
            core.start,
            document.slice(core).to_owned(),
            value.to_owned(),
        ),
        label: EditLabel {
            kind: EditKind::SetStyleField(field),
            // A style is not a cue, and the history keys a run on the pair: a style write and a
            // cue write must never coalesce, so this names a row no cue can have.
            cue: usize::MAX,
        },
        expect: Expectation {
            // No cue changes, which is the whole of what this asserts: every one of them is read
            // back and compared, because a style line that swallowed a comma would move them all.
            from: 0,
            removed: 0,
            cues: Vec::new(),
            segments_from: segment_index,
            segments_removed: 1,
            segments_inserted: 1,
        },
    })
}

/// What a style's field may hold. The comma is the dangerous one, for the reason it is in an event.
fn validate_style_value(field: AssStyleField, value: &str) -> Result<(), EditError> {
    let unwritable = |detail: &str| EditError::new(EditErrorKind::UnwritableText, detail);
    if value.contains(',') {
        return Err(unwritable(
            "a comma separates the fields of a style line, so a value may not hold one",
        ));
    }
    if value.contains(['\n', '\r']) {
        return Err(unwritable(
            "a style line is one line, so a value may not break it",
        ));
    }
    if value
        .chars()
        .any(|character| matches!(character, '\u{0}'..='\u{1f}' | '\u{7f}'))
    {
        return Err(unwritable(
            "a control character cannot be written into a style field",
        ));
    }
    if value.trim() != value {
        return Err(unwritable(
            "a style field's padding belongs to the file, so a value may not carry its own",
        ));
    }
    // The four flags are what a renderer reads as on or off, and nothing else belongs there.
    if matches!(
        field,
        AssStyleField::Bold
            | AssStyleField::Italic
            | AssStyleField::Underline
            | AssStyleField::Strikeout
    ) && value != "0"
        && value != "-1"
    {
        return Err(unwritable(
            "a style's flag is written -1 for on and 0 for off",
        ));
    }
    Ok(())
}

/// Write several override tags at one caret, as one step.
///
/// Every name and every value is checked before anything is written, so a list with one bad entry
/// in it changes nothing at all.
///
/// Every write goes at the same caret, and `set_tag` joins the block already there, so a pick of
/// two tags is one block: what a person means by "this line, in this font, at this size". Moving
/// the caret by each write's shift was tried and taken back out, because no line could be found
/// where it changed the result: `set_tag` writes where the caret is and the block it just made is
/// what the next write finds there, shifted or not.
fn plan_set_override_tags(
    document: &SubtitleDocument,
    index: usize,
    tags: &[(String, String)],
    at: usize,
) -> Result<Planned, EditError> {
    if tags.is_empty() {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "no tag to write",
        ));
    }
    for (tag, value) in tags {
        check_tag(tag, value)?;
    }
    let located = locate(document, index)?;
    if !matches!(&located.cue.detail, CueDetail::Ass(_)) {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "only an ASS event carries override tags",
        ));
    }
    let text = document.slice(located.cue.text);
    if at > text.len() || !text.is_char_boundary(at) {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            format!("the offset {at} is outside the cue's text or cuts a character"),
        ));
    }

    let mut written = text.to_owned();
    for (tag, value) in tags {
        let (next, _) = override_tags::set_tag(&written, at, tag, value);
        written = next;
    }

    let write = plan_text_write(document, &located, &written)?;
    Ok(Planned {
        splice: Splice::new(
            write.range.start,
            document.slice(write.range).to_owned(),
            write.inserted,
        ),
        label: EditLabel {
            kind: EditKind::SetOverrideTag,
            cue: index,
        },
        expect: Expectation {
            from: index,
            removed: 1,
            cues: vec![ExpectedCue {
                text_raw: write.written,
                start_ms: located.cue.start.millis(),
                end_ms: located.cue.end.millis(),
            }],
            segments_from: located.segment_index,
            segments_removed: 1,
            segments_inserted: 1,
        },
    })
}

/// Empty a cue's text, keeping the braced runs when asked.
///
/// Keeping them is the reference's Clear Text: every block that is not words stays where it is, in
/// the order it was in, and only the plain runs go. See edit-bar-tasks.md B13.
fn plan_clear_text(
    document: &SubtitleDocument,
    index: usize,
    keep_tags: bool,
) -> Result<Planned, EditError> {
    let located = locate(document, index)?;
    let text = document.slice(located.cue.text);
    let written = if keep_tags {
        override_tags::blocks(text)
            .into_iter()
            .filter(|block| block.kind != override_tags::BlockKind::Plain)
            .map(|block| &text[block.span.range()])
            .collect::<String>()
    } else {
        String::new()
    };

    let write = plan_text_write(document, &located, &written)?;
    Ok(Planned {
        splice: Splice::new(
            write.range.start,
            document.slice(write.range).to_owned(),
            write.inserted,
        ),
        label: EditLabel {
            kind: EditKind::ClearText,
            cue: index,
        },
        expect: Expectation {
            from: index,
            removed: 1,
            cues: vec![ExpectedCue {
                text_raw: write.written,
                start_ms: located.cue.start.millis(),
                end_ms: located.cue.end.millis(),
            }],
            segments_from: located.segment_index,
            segments_removed: 1,
            segments_inserted: 1,
        },
    })
}

fn plan_toggle_style(
    document: &SubtitleDocument,
    index: usize,
    flag: StyleFlag,
    from: usize,
    to: usize,
) -> Result<Planned, EditError> {
    let located = locate(document, index)?;
    let CueDetail::Ass(event) = &located.cue.detail else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "only an ASS event carries override tags",
        ));
    };
    let text = document.slice(located.cue.text);
    if from > text.len()
        || to > text.len()
        || !text.is_char_boundary(from)
        || !text.is_char_boundary(to)
    {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            format!(
                "the {} range {from}..{to} is outside the cue's text or cuts a character",
                flag.as_str()
            ),
        ));
    }
    let (start, end) = if from <= to { (from, to) } else { (to, from) };

    // Where the line starts from: the style it names, and then any tag of its own before the caret.
    let named = event
        .field_index(AssField::Style)
        .and_then(|at| event.fields.get(at).copied())
        .map(|span| document.slice(field_core(document, span)))
        .unwrap_or("");
    let from_style = document
        .ass_styles()
        .iter()
        .find(|style| document.ass_style_text(style)[0] == named)
        .is_some_and(|style| flag.of(style));
    let state = override_tags::block_at(text, start)
        .and_then(|block| override_tags::value_at(text, block, flag.tag()))
        .map_or(from_style, |value| {
            override_tags::flag_value(&value, from_style)
        });

    let (written, shift) =
        override_tags::set_tag(text, start, flag.tag(), if state { "0" } else { "1" });
    let written = if start == end {
        written
    } else {
        let at = end.saturating_add_signed(shift);
        override_tags::set_tag(&written, at, flag.tag(), if state { "1" } else { "0" }).0
    };

    let write = plan_text_write(document, &located, &written)?;
    Ok(Planned {
        splice: Splice::new(
            write.range.start,
            document.slice(write.range).to_owned(),
            write.inserted,
        ),
        label: EditLabel {
            kind: EditKind::ToggleStyle(flag),
            cue: index,
        },
        expect: Expectation {
            from: index,
            removed: 1,
            cues: vec![ExpectedCue {
                text_raw: write.written,
                start_ms: located.cue.start.millis(),
                end_ms: located.cue.end.millis(),
            }],
            segments_from: located.segment_index,
            segments_removed: 1,
            segments_inserted: 1,
        },
    })
}

fn plan_set_comment(
    document: &SubtitleDocument,
    index: usize,
    comment: bool,
) -> Result<Planned, EditError> {
    let located = locate(document, index)?;
    let CueDetail::Ass(event) = &located.cue.detail else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "the cue is not an ASS event, so it has no descriptor to rewrite",
        ));
    };
    let written = if comment { "Comment" } else { "Dialogue" };
    Ok(Planned {
        splice: Splice::new(
            event.descriptor.start,
            document.slice(event.descriptor).to_owned(),
            written.to_owned(),
        ),
        label: EditLabel {
            kind: EditKind::SetComment,
            cue: index,
        },
        expect: Expectation {
            from: index,
            removed: 1,
            cues: vec![ExpectedCue {
                text_raw: document.slice(located.cue.text).to_owned(),
                start_ms: located.cue.start.millis(),
                end_ms: located.cue.end.millis(),
            }],
            segments_from: located.segment_index,
            segments_removed: 1,
            segments_inserted: 1,
        },
    })
}

fn plan_set_field(
    document: &SubtitleDocument,
    index: usize,
    field: AssField,
    value: &str,
) -> Result<Planned, EditError> {
    let located = locate(document, index)?;
    let CueDetail::Ass(event) = &located.cue.detail else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "the cue is not an ASS event, so it holds no declared field",
        ));
    };
    // Refused, never added: declaring a field means rewriting the `Format:` line and every event
    // under it, which touches the bytes of every cue the user did not edit (W5.1).
    let Some(at) = event.field_index(field) else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            format!(
                "the section's Format line declares no {} before the text",
                field.as_str()
            ),
        ));
    };
    let Some(span) = event.fields.get(at).copied() else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            format!(
                "field {at} is outside the event's {} fields",
                event.fields.len()
            ),
        ));
    };
    validate_field_value(field, value)?;

    let written = written_value(value);
    let core = field_core(document, span);
    Ok(Planned {
        splice: Splice::new(
            core.start,
            document.slice(core).to_owned(),
            written.to_owned(),
        ),
        label: EditLabel {
            kind: EditKind::SetField(field),
            cue: index,
        },
        expect: Expectation {
            from: index,
            removed: 1,
            cues: vec![ExpectedCue {
                text_raw: document.slice(located.cue.text).to_owned(),
                start_ms: located.cue.start.millis(),
                end_ms: located.cue.end.millis(),
            }],
            segments_from: located.segment_index,
            segments_removed: 1,
            segments_inserted: 1,
        },
    })
}

/// The three things `verify` does not look at: the edited event still carries the same number of
/// fields, the named field reads back exactly the bytes the plan wrote, and every other field of
/// that event slices to the same string. See docs/ass-field-write-tasks.md W6.
/// The one thing a comment edit changes, read back off the re-parsed document: the event is the
/// kind that was asked for. Everything else about the line is `verify`'s to check.
fn verify_comment(after: &SubtitleDocument, index: usize, comment: bool) -> Result<(), EditError> {
    let event = ass_event_of(after, index)?;
    let wanted = if comment {
        AssEventKind::Comment
    } else {
        AssEventKind::Dialogue
    };
    if event.kind != wanted {
        return Err(EditError::new(
            EditErrorKind::Unverified,
            format!(
                "cue {index} was asked to be {wanted:?} and came back {:?}",
                event.kind
            ),
        ));
    }
    Ok(())
}

fn verify_field(
    before: &SubtitleDocument,
    after: &SubtitleDocument,
    index: usize,
    field: AssField,
    value: &str,
) -> Result<(), EditError> {
    let old = ass_event_of(before, index)?;
    let new = ass_event_of(after, index)?;
    // The field count is what catches a separator smuggled in whatever else went wrong.
    if old.fields.len() != new.fields.len() {
        return Err(EditError::new(
            EditErrorKind::Unverified,
            format!(
                "cue {index} carried {} fields and now carries {}",
                old.fields.len(),
                new.fields.len()
            ),
        ));
    }
    let Some((at, span)) = old
        .field_index(field)
        .and_then(|at| Some((at, old.fields.get(at).copied()?)))
    else {
        return Err(EditError::new(
            EditErrorKind::Unverified,
            format!("cue {index} no longer declares a {}", field.as_str()),
        ));
    };

    let core = field_core(before, span);
    let expected = format!(
        "{}{}{}",
        before.slice(Span::new(span.start, core.start)),
        written_value(value),
        before.slice(Span::new(core.end, span.end))
    );
    for (position, written) in new.fields.iter().enumerate() {
        let read_back = after.slice(*written);
        if position == at {
            if read_back != expected {
                return Err(EditError::new(
                    EditErrorKind::Unverified,
                    format!(
                        "cue {index} field {at} reads {read_back:?}, the plan wrote {expected:?}"
                    ),
                ));
            }
            continue;
        }
        let Some(kept) = old.fields.get(position).copied() else {
            return Err(EditError::new(
                EditErrorKind::Unverified,
                format!("cue {index} field {position} went missing"),
            ));
        };
        if before.slice(kept) != read_back {
            return Err(EditError::new(
                EditErrorKind::Unverified,
                format!("cue {index} field {position} was not edited and changed"),
            ));
        }
    }
    Ok(())
}

fn plan_insert(
    document: &SubtitleDocument,
    before: usize,
    start_ms: u32,
    end_ms: u32,
    text: &str,
) -> Result<Planned, EditError> {
    let count = document.cues().count();
    if before > count {
        return Err(EditError::new(
            EditErrorKind::NoSuchCue,
            format!("cue {before}: the document holds {count}"),
        ));
    }
    let format = document.format();
    let text = diff::normalize(text);
    validate_text(format, &text)?;

    // The new cue mirrors a neighbour's spelling: the cue before it, or the one after it.
    let neighbour = match before
        .checked_sub(1)
        .and_then(|at| locate(document, at).ok())
    {
        Some(previous) => Some(previous),
        None => locate(document, before).ok(),
    };

    let (splice, expected_text, segments_from, segments_inserted) = match format {
        SubtitleFormat::Ass => insert_ass(
            document,
            before,
            count,
            start_ms,
            end_ms,
            &text,
            neighbour.as_ref(),
        )?,
        SubtitleFormat::Srt | SubtitleFormat::Vtt => insert_block(
            document,
            before,
            count,
            start_ms,
            end_ms,
            &text,
            neighbour.as_ref(),
        )?,
    };

    Ok(Planned {
        splice,
        label: EditLabel {
            kind: EditKind::Insert,
            cue: before,
        },
        expect: Expectation {
            from: before,
            removed: 0,
            cues: vec![ExpectedCue {
                text_raw: expected_text,
                start_ms,
                end_ms,
            }],
            segments_from,
            segments_removed: 0,
            segments_inserted,
        },
    })
}

fn insert_block(
    document: &SubtitleDocument,
    before: usize,
    count: usize,
    start_ms: u32,
    end_ms: u32,
    text: &str,
    neighbour: Option<&Located<'_>>,
) -> Result<(Splice, String, usize, usize), EditError> {
    let format = document.format();
    let block = match neighbour {
        Some(near) => Block {
            newline: newline_of(document, near.segment),
            arrow: arrow_of(document, near.cue)?,
            start_shape: shape_of(document.slice(near.cue.start.raw())),
            end_shape: shape_of(document.slice(near.cue.end.raw())),
            // A new block carries no identity of its own: no DVD trailer, no identifier, no
            // settings. Duplicating a neighbour's identifier would be worse than having none.
            number: insert_number(document, before, near),
            trailer: None,
            id: None,
            settings: None,
        },
        None => Block {
            newline: default_newline(document),
            arrow: " --> ",
            start_shape: default_shape(format),
            end_shape: default_shape(format),
            number: (format == SubtitleFormat::Srt).then_some(1),
            trailer: None,
            id: None,
            settings: None,
        },
    };
    let newline = block.newline;
    let body = document.source().body();

    if before < count {
        let target = locate(document, before)?;
        let block_text = block.render(format, start_ms, end_ms, text, true)?;
        let inserted = format!("{block_text}{newline}");
        return Ok((
            Splice::new(target.segment.span.start, String::new(), inserted),
            render_text(text, newline),
            target.segment_index,
            2,
        ));
    }

    if let Some(last) = count
        .checked_sub(1)
        .and_then(|at| locate(document, at).ok())
    {
        let terminated = terminator_len(document.slice(last.segment.span)) > 0;
        // A separator on the side facing existing content: one blank line, plus the terminator the
        // last block never got when the file ends without one.
        let separator = if terminated {
            newline.to_owned()
        } else {
            format!("{newline}{newline}")
        };
        let block_text = block.render(format, start_ms, end_ms, text, terminated)?;
        return Ok((
            Splice::new(
                last.segment.span.end,
                String::new(),
                separator + &block_text,
            ),
            render_text(text, newline),
            last.segment_index.saturating_add(1),
            2,
        ));
    }

    let segments = document.segments();
    let last_is_blank = segments
        .last()
        .is_some_and(|segment| matches!(segment.kind, SegmentKind::Blank));
    let mut prefix = String::new();
    if !body.is_empty() && terminator_len(body) == 0 {
        prefix.push_str(newline);
    }
    let blank_added = !body.is_empty() && !last_is_blank;
    if blank_added {
        prefix.push_str(newline);
    }
    let terminate = body.is_empty() || terminator_len(body) > 0;
    let block_text = block.render(format, start_ms, end_ms, text, terminate)?;
    Ok((
        Splice::new(body.len(), String::new(), prefix + &block_text),
        render_text(text, newline),
        segments.len(),
        1 + usize::from(blank_added),
    ))
}

/// The first event of a file that has none: written from the section's own `Format:` line.
///
/// Every field the list declares is written, empty unless it is one of the six that would make the
/// line unreadable empty: the two timings, the text, the layer and the three margins take a zero,
/// and the style takes the first one the file declares. The line goes straight after the `Format:`
/// line, not at the end of the file, because `[Events]` is not always the last section.
fn first_ass_event(
    document: &SubtitleDocument,
    start_ms: u32,
    end_ms: u32,
    text: &str,
) -> Result<(Splice, String, usize, usize), EditError> {
    let Some(format) = document.ass_event_format() else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "the file declares no events section to put a line in",
        ));
    };
    let (Some(start_index), Some(end_index)) = (format.start_index, format.end_index) else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "the events section declares no start and end for a line to carry",
        ));
    };
    // The text is the last field: everything after the last comma belongs to it, which is what the
    // parser reads and what a shorter list would break.
    let text_index = format.count.saturating_sub(1);
    if start_index >= text_index || end_index >= text_index {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "the events section puts a timing where the text has to be",
        ));
    }

    let shape = default_shape(SubtitleFormat::Ass);
    let mut fields = vec![String::new(); format.count];
    fields[start_index] = render_timecode(start_ms, shape)?;
    fields[end_index] = render_timecode(end_ms, shape)?;
    fields[text_index] = text.to_owned();
    for zero in [
        format.layer_index,
        format.margin_l_index,
        format.margin_r_index,
        format.margin_v_index,
    ]
    .into_iter()
    .flatten()
    .filter(|at| *at < text_index)
    {
        fields[zero] = "0".to_owned();
    }
    if let Some(at) = format.style_index.filter(|at| *at < text_index) {
        if let Some(style) = document.ass_styles().first() {
            fields[at] = document.slice(style.name).trim().to_owned();
        }
    }

    let segments = document.segments();
    let anchor = segments.get(format.format_segment).ok_or_else(|| {
        EditError::new(
            EditErrorKind::NotApplicable,
            "the events section's format line is not where the parser left it",
        )
    })?;
    let line = document.slice(anchor.span);
    let terminated = terminator_len(line) > 0;
    let newline = default_newline(document);
    let mut written = String::new();
    if !terminated {
        written.push_str(newline);
    }
    written.push_str("Dialogue: ");
    written.push_str(&fields.join(","));
    written.push_str(newline);
    Ok((
        Splice::new(anchor.span.end, String::new(), written),
        text.to_owned(),
        format.format_segment.saturating_add(1),
        1,
    ))
}

/// The fragment with this document's own line terminator, ending in one.
fn as_written(fragment: &str, newline: &str) -> String {
    let normalized = diff::normalize(fragment);
    let mut written = normalized.replace('\n', newline);
    if !written.ends_with(newline) {
        written.push_str(newline);
    }
    written
}

/// What a fragment holds, read behind this document's own header: its cues, and how many segments
/// it adds to the file it is going into.
///
/// The header is what makes the fragment mean anything at all, and reading it through this
/// document's header rather than its own is also what makes a copy from another file land spelled
/// the way this one spells things.
fn read_fragment(
    document: &SubtitleDocument,
    fragment: &str,
) -> Result<(Vec<ExpectedCue>, usize), EditError> {
    let body = document.source().body();
    let segments = document.segments();
    let first_cue = segments
        .iter()
        .position(|segment| matches!(segment.kind, SegmentKind::Cue(_)));
    let head_end = first_cue
        .and_then(|at| segments.get(at))
        .map_or(body.len(), |segment| segment.span.start);
    let head_segments = first_cue.unwrap_or(segments.len());
    let Some(head) = body.get(..head_end) else {
        return Err(EditError::new(
            EditErrorKind::BadRange,
            "the document's header does not end where its first cue starts",
        ));
    };

    let mut whole = String::with_capacity(head.len().saturating_add(fragment.len()));
    whole.push_str(head);
    // A header that never got a terminator would take the fragment's first line onto its own.
    if !head.is_empty() && terminator_len(head) == 0 {
        whole.push_str(default_newline(document));
    }
    whole.push_str(fragment);

    let parsed = sublore_formats::parse(document.format(), whole.as_bytes())
        .map_err(|error| EditError::from_parse(EditErrorKind::NotApplicable, error))?;
    let cues: Vec<ExpectedCue> = parsed
        .cues()
        .map(|cue| ExpectedCue {
            text_raw: parsed.slice(cue.text).to_owned(),
            start_ms: cue.start.millis(),
            end_ms: cue.end.millis(),
        })
        .collect();
    if cues.is_empty() {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "the fragment holds no cue this document could read",
        ));
    }
    let added = parsed
        .segments()
        .len()
        .checked_sub(head_segments)
        .ok_or_else(|| {
            EditError::new(
                EditErrorKind::NotApplicable,
                "the fragment read back shorter than the header it was read behind",
            )
        })?;
    Ok((cues, added))
}

fn plan_paste(
    document: &SubtitleDocument,
    before: usize,
    fragment: &str,
) -> Result<Planned, EditError> {
    let count = document.cues().count();
    if before > count {
        return Err(EditError::new(
            EditErrorKind::NoSuchCue,
            format!("cue {before}: the document holds {count}"),
        ));
    }
    let newline = default_newline(document);
    let written = as_written(fragment, newline);
    let (cues, added) = read_fragment(document, &written)?;

    // A blank line separates two blocks in an SRT or a VTT; an ASS event is followed by the next
    // one. It goes on the side facing the content already there.
    let blank = match document.format() {
        SubtitleFormat::Ass => "",
        SubtitleFormat::Srt | SubtitleFormat::Vtt => newline,
    };
    let blanks = usize::from(!blank.is_empty());

    let (at, inserted, segments_from, segments_inserted) = if before < count {
        let target = locate(document, before)?;
        (
            target.segment.span.start,
            format!("{written}{blank}"),
            target.segment_index,
            added.saturating_add(blanks),
        )
    } else if let Some(last) = count
        .checked_sub(1)
        .and_then(|at| locate(document, at).ok())
    {
        let slice = document.slice(last.segment.span);
        let mut inserted = String::new();
        // The last block never got a terminator when the file ends without one.
        if terminator_len(slice) == 0 {
            inserted.push_str(newline);
        }
        inserted.push_str(blank);
        inserted.push_str(&written);
        (
            last.segment.span.end,
            inserted,
            last.segment_index.saturating_add(1),
            added.saturating_add(blanks),
        )
    } else {
        empty_document_paste(document, &written, added)?
    };

    Ok(Planned {
        splice: Splice::new(at, String::new(), inserted),
        label: EditLabel {
            kind: EditKind::Paste,
            cue: before,
        },
        expect: Expectation {
            from: before,
            removed: 0,
            cues,
            segments_from,
            segments_removed: 0,
            segments_inserted,
        },
    })
}

/// Where a paste goes in a document with no cue in it: after the events section's own `Format:`
/// line in an ASS, which is not always the last section, and at the end of the body otherwise.
fn empty_document_paste(
    document: &SubtitleDocument,
    written: &str,
    added: usize,
) -> Result<(usize, String, usize, usize), EditError> {
    let newline = default_newline(document);
    if document.format() == SubtitleFormat::Ass {
        let Some(format) = document.ass_event_format() else {
            return Err(EditError::new(
                EditErrorKind::NotApplicable,
                "the file declares no events section to put a line in",
            ));
        };
        let anchor = document
            .segments()
            .get(format.format_segment)
            .ok_or_else(|| {
                EditError::new(
                    EditErrorKind::NotApplicable,
                    "the events section's format line is not where the parser left it",
                )
            })?;
        let mut inserted = String::new();
        if terminator_len(document.slice(anchor.span)) == 0 {
            inserted.push_str(newline);
        }
        inserted.push_str(written);
        return Ok((
            anchor.span.end,
            inserted,
            format.format_segment.saturating_add(1),
            added,
        ));
    }

    let body = document.source().body();
    let segments = document.segments();
    let last_is_blank = segments
        .last()
        .is_some_and(|segment| matches!(segment.kind, SegmentKind::Blank));
    let mut inserted = String::new();
    if !body.is_empty() && terminator_len(body) == 0 {
        inserted.push_str(newline);
    }
    let blank_added = !body.is_empty() && !last_is_blank;
    if blank_added {
        inserted.push_str(newline);
    }
    inserted.push_str(written);
    Ok((
        body.len(),
        inserted,
        segments.len(),
        added.saturating_add(usize::from(blank_added)),
    ))
}

fn insert_ass(
    document: &SubtitleDocument,
    before: usize,
    count: usize,
    start_ms: u32,
    end_ms: u32,
    text: &str,
    neighbour: Option<&Located<'_>>,
) -> Result<(Splice, String, usize, usize), EditError> {
    // With no event to copy from, the section's own `Format:` line says what one looks like.
    let Some(near) = neighbour else {
        return first_ass_event(document, start_ms, end_ms, text);
    };

    if before < count {
        let target = locate(document, before)?;
        let line = ass_line(document, near, start_ms, end_ms, text, true, true)?;
        return Ok((
            Splice::new(target.segment.span.start, String::new(), line),
            text.to_owned(),
            target.segment_index,
            1,
        ));
    }

    let last = locate(document, count.saturating_sub(1))?;
    let terminated = terminator_len(document.slice(last.segment.span)) > 0;
    let mut inserted = String::new();
    if !terminated {
        inserted.push_str(newline_of(document, last.segment));
    }
    inserted.push_str(&ass_line(
        document, near, start_ms, end_ms, text, true, terminated,
    )?);
    Ok((
        Splice::new(last.segment.span.end, String::new(), inserted),
        text.to_owned(),
        last.segment_index.saturating_add(1),
        1,
    ))
}

/// The index line a new SRT block gets: only when its neighbour has one, and never renumbering any
/// cue the user did not edit. Duplicates and gaps are what every player already tolerates.
fn insert_number(
    document: &SubtitleDocument,
    before: usize,
    neighbour: &Located<'_>,
) -> Option<u32> {
    if document.format() != SubtitleFormat::Srt {
        return None;
    }
    srt_detail(neighbour.cue)?.number?;
    let previous = before
        .checked_sub(1)
        .and_then(|at| locate(document, at).ok())
        .and_then(|located| srt_detail(located.cue).and_then(|srt| srt.number));
    Some(previous.map_or(1, |number| number.saturating_add(1)))
}

fn default_newline(document: &SubtitleDocument) -> &'static str {
    match document.source().newline() {
        Newline::Crlf => "\r\n",
        Newline::Lf | Newline::Mixed | Newline::None => "\n",
    }
}

/// Which segments go with the cue at segment `at`: itself, and the blank line that separates its
/// block from the next.
///
/// The blank belongs to the block being removed. An ASS blank separates sections, so it stays
/// unless it would join the one on the other side. M2.1.
fn delete_region(document: &SubtitleDocument, at: usize) -> (usize, usize) {
    let segments = document.segments();
    let follows = segments
        .get(at.saturating_add(1))
        .is_some_and(|segment| matches!(segment.kind, SegmentKind::Blank));
    let precedes = at > 0
        && segments
            .get(at.saturating_sub(1))
            .is_some_and(|segment| matches!(segment.kind, SegmentKind::Blank));

    match document.format() {
        SubtitleFormat::Ass => {
            if follows && precedes {
                (at, at.saturating_add(1))
            } else {
                (at, at)
            }
        }
        SubtitleFormat::Srt | SubtitleFormat::Vtt => {
            if follows {
                (at, at.saturating_add(1))
            } else if precedes {
                (at.saturating_sub(1), at)
            } else {
                (at, at)
            }
        }
    }
}

/// Two or more cues joined into the first of them, as one undo step.
///
/// The first named cue keeps its start, its style and every other field it declares, takes the
/// latest end of the cues named with it, and takes their texts too unless the caller asked to keep
/// its own. The rest go. A selection with a hole in it joins what it named and leaves what it did
/// not, which is what the reference does and what a translator means by choosing four lines out of
/// six.
fn plan_join(
    document: &SubtitleDocument,
    cues: &[usize],
    keep_first_text: bool,
) -> Result<Planned, EditError> {
    let (Some(first), Some(last)) = (cues.first(), cues.last()) else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "a join naming no cues",
        ));
    };
    if cues.len() < 2 {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "a join needs two cues or more",
        ));
    }
    if cues.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "the cues must be given in file order, each one named once",
        ));
    }

    let run = locate_run(document, *first, *last)?;
    let segments = document.segments();
    // The named cues, in file order, and what the first of them becomes.
    let mut named = Vec::with_capacity(cues.len());
    let mut naming = cues.iter().peekable();
    for (offset, located) in run.iter().enumerate() {
        if naming
            .next_if(|want| **want == first.saturating_add(offset))
            .is_some()
        {
            named.push(located);
        }
    }
    let (Some(head), Some(tail)) = (named.first(), named.last()) else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "a join naming no cues",
        ));
    };
    let start_ms = head.cue.start.millis();
    let end_ms = named
        .iter()
        .map(|located| located.cue.end.millis())
        .max()
        .unwrap_or_else(|| head.cue.end.millis());
    if end_ms < start_ms {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "the joined cue would end before it starts",
        ));
    }
    // A space between one text and the next, which is what joins two half sentences into one.
    let text = if keep_first_text {
        diff::normalize(document.slice(head.cue.text))
    } else {
        named
            .iter()
            .map(|located| diff::normalize(document.slice(located.cue.text)))
            .filter(|piece| !piece.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    };

    let times = time_write(document, head, start_ms, end_ms)?;
    let words = plan_text_write(document, head, &text)?;
    if times.range.end > words.range.start {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "the cue's text is written before its timestamps",
        ));
    }

    // Every segment the cues that go take with them, by the rule a single delete follows.
    let dropped: Vec<(usize, usize)> = named
        .iter()
        .skip(1)
        .map(|located| delete_region(document, located.segment_index))
        .collect();
    let region_from = head.segment_index;
    let region_to = dropped
        .iter()
        .map(|(_, to)| *to)
        .max()
        .unwrap_or(tail.segment_index)
        .max(head.segment_index);

    let body = document.source().body();
    let mut inserted = String::new();
    let mut cues_after = Vec::new();
    let mut segments_inserted = 0usize;
    for at in region_from..=region_to {
        if dropped.iter().any(|(from, to)| at >= *from && at <= *to) {
            continue;
        }
        let Some(segment) = segments.get(at) else {
            return Err(EditError::new(
                EditErrorKind::NotApplicable,
                "the cues' segments moved while the edit was planned",
            ));
        };
        segments_inserted = segments_inserted.saturating_add(1);
        if at != head.segment_index {
            inserted.push_str(document.slice(segment.span));
            if let SegmentKind::Cue(cue) = &segment.kind {
                cues_after.push(ExpectedCue {
                    text_raw: document.slice(cue.text).to_owned(),
                    start_ms: cue.start.millis(),
                    end_ms: cue.end.millis(),
                });
            }
            continue;
        }
        // The line that stays, with its new end and its new text written into the bytes it already
        // has: everything else on it, the style and the speaker and the margins, is untouched.
        let Some(before_times) = body.get(segment.span.start..times.range.start) else {
            return Err(EditError::new(
                EditErrorKind::BadRange,
                "the cue's timestamps are not inside its own line",
            ));
        };
        let Some(between) = body.get(times.range.end..words.range.start) else {
            return Err(EditError::new(
                EditErrorKind::BadRange,
                "the cue's text does not follow its timestamps",
            ));
        };
        let Some(after_text) = body.get(words.range.end..segment.span.end) else {
            return Err(EditError::new(
                EditErrorKind::BadRange,
                "the cue's text is not inside its own line",
            ));
        };
        inserted.push_str(before_times);
        inserted.push_str(&times.inserted);
        inserted.push_str(between);
        inserted.push_str(&words.inserted);
        inserted.push_str(after_text);
        cues_after.push(ExpectedCue {
            text_raw: words.written.clone(),
            start_ms,
            end_ms,
        });
    }

    let (Some(opening), Some(closing)) = (segments.get(region_from), segments.get(region_to))
    else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "the cues' segments moved while the edit was planned",
        ));
    };
    let region = Span::new(opening.span.start, closing.span.end);

    Ok(Planned {
        splice: Splice::new(region.start, document.slice(region).to_owned(), inserted),
        label: EditLabel {
            kind: EditKind::Join,
            cue: *first,
        },
        expect: Expectation {
            from: *first,
            removed: last.saturating_sub(*first).saturating_add(1),
            cues: cues_after,
            segments_from: region_from,
            segments_removed: region_to.saturating_sub(region_from).saturating_add(1),
            segments_inserted,
        },
    })
}

/// Every named cue written again straight after itself, as one undo step.
///
/// One splice from the first named cue to the last, so a scattered selection is one step as well as
/// a run: what goes back is the region as it stands with a second copy of each named line after it.
/// The copy is the line's own bytes, so it carries every field the format declares, and on an SRT it
/// carries the index line too. Nothing is renumbered, which is the rule an insert already follows:
/// duplicates and gaps are what every player tolerates, and renumbering would rewrite lines the
/// translator did not touch.
fn plan_duplicate(document: &SubtitleDocument, cues: &[usize]) -> Result<Planned, EditError> {
    let (Some(first), Some(last)) = (cues.first(), cues.last()) else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "a duplicate naming no cues",
        ));
    };
    if cues.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "the cues must be given in file order, each one named once",
        ));
    }

    let run = locate_run(document, *first, *last)?;
    let (Some(head), Some(tail)) = (run.first(), run.last()) else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "a duplicate naming no cues",
        ));
    };
    let region_from = head.segment_index;
    let region_to = tail.segment_index;
    let segments = document.segments();
    let newline = default_newline(document);
    // What separates two blocks: a blank line in an SRT or a VTT, nothing at all between two ASS
    // events.
    let blank = match document.format() {
        SubtitleFormat::Ass => "",
        SubtitleFormat::Srt | SubtitleFormat::Vtt => newline,
    };

    let mut inserted = String::new();
    let mut cues_after = Vec::with_capacity(run.len().saturating_mul(2));
    let mut segments_inserted = 0usize;
    let mut naming = cues.iter().peekable();
    let mut index = *first;
    // The copies of the run being walked, held until its last line is written: a block of lines
    // duplicated is a block after the block, not a copy wedged after each line, which is what keeps
    // an exchange of dialogue in the order it was written in.
    let mut pending: Vec<(&str, ExpectedCue)> = Vec::new();
    for at in region_from..=region_to {
        let Some(segment) = segments.get(at) else {
            return Err(EditError::new(
                EditErrorKind::NotApplicable,
                "the cues' segments moved while the edit was planned",
            ));
        };
        let slice = document.slice(segment.span);
        inserted.push_str(slice);
        segments_inserted = segments_inserted.saturating_add(1);
        let SegmentKind::Cue(cue) = &segment.kind else {
            continue;
        };
        let copy = ExpectedCue {
            text_raw: document.slice(cue.text).to_owned(),
            start_ms: cue.start.millis(),
            end_ms: cue.end.millis(),
        };
        cues_after.push(copy.clone());
        let wanted = naming.next_if(|want| **want == index).is_some();
        index = index.saturating_add(1);
        if wanted {
            pending.push((slice, copy));
        }
        // The run ends where the next cue is not one of the named ones.
        if wanted && naming.peek().is_some_and(|next| **next == index) {
            continue;
        }
        for (line, expected) in pending.drain(..) {
            // A file that ends without a terminator never gave its last block one, and a copy
            // cannot start on the line it is copying.
            if !inserted.ends_with('\n') && !inserted.ends_with('\r') {
                inserted.push_str(newline);
            }
            inserted.push_str(blank);
            inserted.push_str(line);
            segments_inserted = segments_inserted
                .saturating_add(1)
                .saturating_add(usize::from(!blank.is_empty()));
            cues_after.push(expected);
        }
    }

    let (Some(opening), Some(closing)) = (segments.get(region_from), segments.get(region_to))
    else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "the cues' segments moved while the edit was planned",
        ));
    };
    let region = Span::new(opening.span.start, closing.span.end);

    Ok(Planned {
        splice: Splice::new(region.start, document.slice(region).to_owned(), inserted),
        label: EditLabel {
            kind: EditKind::Duplicate,
            cue: *first,
        },
        expect: Expectation {
            from: *first,
            removed: last.saturating_sub(*first).saturating_add(1),
            cues: cues_after,
            segments_from: region_from,
            segments_removed: region_to.saturating_sub(region_from).saturating_add(1),
            segments_inserted,
        },
    })
}

/// Several cues removed as one undo step, each with the blank line that follows it.
///
/// One splice from the first named cue to the last, with everything between them that was not named
/// written back exactly as it stands: a selection is not always a run, and the cues left standing
/// inside it must come through a cut untouched.
fn plan_delete_many(document: &SubtitleDocument, cues: &[usize]) -> Result<Planned, EditError> {
    let (Some(first), Some(last)) = (cues.first(), cues.last()) else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "a delete naming no cues",
        ));
    };
    // Strictly ascending, each cue once: a cue named twice would have its bytes counted twice.
    if cues.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "the cues must be given in file order, each one named once",
        ));
    }

    let run = locate_run(document, *first, *last)?;
    let segments = document.segments();
    let mut region_from = usize::MAX;
    let mut region_to = 0usize;
    let mut dropped = Vec::new();
    let mut kept = Vec::new();
    let mut naming = cues.iter().peekable();
    for (offset, located) in run.iter().enumerate() {
        let index = first.saturating_add(offset);
        if naming.next_if(|at| **at == index).is_some() {
            let (from, to) = delete_region(document, located.segment_index);
            region_from = region_from.min(from);
            region_to = region_to.max(to);
            dropped.push((from, to));
        } else {
            region_from = region_from.min(located.segment_index);
            region_to = region_to.max(located.segment_index);
            kept.push(ExpectedCue {
                text_raw: document.slice(located.cue.text).to_owned(),
                start_ms: located.cue.start.millis(),
                end_ms: located.cue.end.millis(),
            });
        }
    }
    if region_from > region_to {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "a delete naming no cues",
        ));
    }

    // Written back rather than sliced around: the region holds the blanks and the cues that were
    // not named, and those come through unchanged whatever order the naming was in.
    let mut inserted = String::new();
    let mut stays = 0usize;
    for at in region_from..=region_to {
        if dropped.iter().any(|(from, to)| at >= *from && at <= *to) {
            continue;
        }
        let Some(segment) = segments.get(at) else {
            return Err(EditError::new(
                EditErrorKind::NotApplicable,
                "the cues' segments moved while the edit was planned",
            ));
        };
        inserted.push_str(document.slice(segment.span));
        stays += 1;
    }

    let (Some(opening), Some(closing)) = (segments.get(region_from), segments.get(region_to))
    else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "the cues' segments moved while the edit was planned",
        ));
    };
    let region = Span::new(opening.span.start, closing.span.end);

    Ok(Planned {
        splice: Splice::new(region.start, document.slice(region).to_owned(), inserted),
        label: EditLabel {
            kind: EditKind::DeleteMany,
            cue: *first,
        },
        expect: Expectation {
            from: *first,
            removed: last.saturating_sub(*first).saturating_add(1),
            cues: kept,
            segments_from: region_from,
            segments_removed: region_to.saturating_sub(region_from).saturating_add(1),
            segments_inserted: stays,
        },
    })
}

/// A contiguous run of cues written back in `order`, a permutation of `from..from + order.len()`.
///
/// The cue blocks move whole and the separators between them keep their positions, so an SRT index
/// rides along with its block and nothing is renumbered, the rule an insert already follows. A run
/// already in `order` is refused with `NotApplicable`, so a move at a boundary or a sort of an
/// already-sorted run adds no undo step; the caller is not meant to ask, and this is the safety net.
fn plan_reorder(
    document: &SubtitleDocument,
    from: usize,
    order: &[usize],
) -> Result<Planned, EditError> {
    let count = order.len();
    if count == 0 {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "a reorder naming no cues",
        ));
    }
    // A permutation of exactly `from..from + count`, each index named once.
    let mut sorted = order.to_vec();
    sorted.sort_unstable();
    if sorted
        .iter()
        .enumerate()
        .any(|(offset, at)| *at != from.saturating_add(offset))
    {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "a reorder must name each cue of one run once",
        ));
    }
    // Already in this order: nothing to write, no undo step.
    if order
        .iter()
        .enumerate()
        .all(|(offset, at)| *at == from.saturating_add(offset))
    {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "a reorder that leaves the order unchanged",
        ));
    }

    let last = from.saturating_add(count).saturating_sub(1);
    let run = locate_run(document, from, last)?;
    // Each cue's whole block, and the exact bytes between one block and the next: a blank line in an
    // SRT or a VTT, nothing at all between two ASS events. The separators are read from the byte gap
    // rather than assumed, so any format's spacing comes through unchanged.
    let blocks: Vec<&str> = run
        .iter()
        .map(|located| document.slice(located.segment.span))
        .collect();
    let separators: Vec<&str> = run
        .windows(2)
        .map(|pair| {
            document.slice(Span::new(
                pair[0].segment.span.end,
                pair[1].segment.span.start,
            ))
        })
        .collect();

    let mut inserted = String::new();
    let mut cues_after = Vec::with_capacity(count);
    for (position, at) in order.iter().enumerate() {
        let offset = at.saturating_sub(from);
        // The separator that structurally sits between output slot `position - 1` and `position`
        // stays where it is while the blocks move.
        if let Some(before) = position.checked_sub(1) {
            inserted.push_str(separators[before]);
        }
        inserted.push_str(blocks[offset]);
        let cue = run[offset].cue;
        cues_after.push(ExpectedCue {
            text_raw: document.slice(cue.text).to_owned(),
            start_ms: cue.start.millis(),
            end_ms: cue.end.millis(),
        });
    }

    let (Some(opening), Some(closing)) = (run.first(), run.last()) else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "a reorder naming no cues",
        ));
    };
    let region = Span::new(opening.segment.span.start, closing.segment.span.end);
    let region_from = opening.segment_index;
    let region_to = closing.segment_index;
    let segments = region_to.saturating_sub(region_from).saturating_add(1);

    Ok(Planned {
        splice: Splice::new(region.start, document.slice(region).to_owned(), inserted),
        label: EditLabel {
            kind: EditKind::Reorder,
            cue: from,
        },
        expect: Expectation {
            from,
            removed: count,
            cues: cues_after,
            segments_from: region_from,
            segments_removed: segments,
            // The same segments come back, reordered: the cue blocks and the separators between
            // them, so the count is what it was.
            segments_inserted: segments,
        },
    })
}

fn plan_delete(document: &SubtitleDocument, index: usize) -> Result<Planned, EditError> {
    let located = locate(document, index)?;
    let segments = document.segments();
    let (from, to) = delete_region(document, located.segment_index);

    let (Some(first), Some(last)) = (segments.get(from), segments.get(to)) else {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "the cue's segments moved while the edit was planned",
        ));
    };
    let region = Span::new(first.span.start, last.span.end);

    Ok(Planned {
        splice: Splice::new(
            region.start,
            document.slice(region).to_owned(),
            String::new(),
        ),
        label: EditLabel {
            kind: EditKind::Delete,
            cue: index,
        },
        expect: Expectation {
            from: index,
            removed: 1,
            cues: Vec::new(),
            segments_from: from,
            segments_removed: to.saturating_sub(from).saturating_add(1),
            segments_inserted: 0,
        },
    })
}

fn plan_split(
    document: &SubtitleDocument,
    index: usize,
    text_offset: usize,
    at_ms: u32,
) -> Result<Planned, EditError> {
    let located = locate(document, index)?;
    let cue = located.cue;
    let format = document.format();
    let text = diff::normalize(document.slice(cue.text));

    if text_offset > text.len() || !text.is_char_boundary(text_offset) {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            format!(
                "offset {text_offset} is not a character offset of {} bytes",
                text.len()
            ),
        ));
    }
    let (low, high) = (
        cue.start.millis().min(cue.end.millis()),
        cue.start.millis().max(cue.end.millis()),
    );
    if at_ms < low || at_ms > high {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            format!("{at_ms} ms is outside the cue's {low}..{high} ms"),
        ));
    }

    let first = text.get(..text_offset).unwrap_or("").trim_matches('\n');
    let second = text.get(text_offset..).unwrap_or("").trim_matches('\n');
    if first.is_empty() || second.is_empty() {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "a split half would hold no text",
        ));
    }
    validate_text(format, first)?;
    validate_text(format, second)?;

    let span = located.segment.span;
    let terminated = terminator_len(document.slice(span)) > 0;
    let (start_ms, end_ms) = (cue.start.millis(), cue.end.millis());

    let (inserted, expected, segments_inserted) = match format {
        SubtitleFormat::Ass => {
            let head = ass_line(document, &located, start_ms, at_ms, first, false, true)?;
            let tail = ass_line(document, &located, at_ms, end_ms, second, false, terminated)?;
            (
                format!("{head}{tail}"),
                vec![first.to_owned(), second.to_owned()],
                2,
            )
        }
        SubtitleFormat::Srt | SubtitleFormat::Vtt => {
            let block = block_of(document, &located)?;
            let newline = block.newline;
            let head = block.render(format, start_ms, at_ms, first, true)?;
            // The second half keeps the block's shape but not its identity: a duplicated VTT
            // identifier would name two cues.
            let tail_block = Block {
                number: block.number.map(|number| number.saturating_add(1)),
                id: None,
                ..block
            };
            let tail = tail_block.render(format, at_ms, end_ms, second, terminated)?;
            (
                format!("{head}{newline}{tail}"),
                vec![render_text(first, newline), render_text(second, newline)],
                3,
            )
        }
    };

    let mut cues = Vec::with_capacity(2);
    for (offset, text_raw) in expected.into_iter().enumerate() {
        let (from_ms, to_ms) = if offset == 0 {
            (start_ms, at_ms)
        } else {
            (at_ms, end_ms)
        };
        cues.push(ExpectedCue {
            text_raw,
            start_ms: from_ms,
            end_ms: to_ms,
        });
    }

    Ok(Planned {
        splice: Splice::new(span.start, document.slice(span).to_owned(), inserted),
        label: EditLabel {
            kind: EditKind::Split,
            cue: index,
        },
        expect: Expectation {
            from: index,
            removed: 1,
            cues,
            segments_from: located.segment_index,
            segments_removed: 1,
            segments_inserted,
        },
    })
}

fn plan_split_in_two(
    document: &SubtitleDocument,
    index: usize,
    first_end_ms: u32,
    second_start_ms: u32,
) -> Result<Planned, EditError> {
    let located = locate(document, index)?;
    let cue = located.cue;
    let format = document.format();
    // The whole text rides into both halves, unlike the caret split which divides it.
    let text = diff::normalize(document.slice(cue.text));
    let text = text.trim_matches('\n');
    if text.is_empty() {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "a split of a cue with no text",
        ));
    }
    validate_text(format, text)?;

    let (low, high) = (
        cue.start.millis().min(cue.end.millis()),
        cue.start.millis().max(cue.end.millis()),
    );
    // Both boundaries inside the cue, and the first half may not end after the second begins. A
    // frame edge is allowed to sit between them, so equality and a gap are both fine.
    if first_end_ms < low || first_end_ms > high || second_start_ms < low || second_start_ms > high
    {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            format!("a split boundary is outside the cue's {low}..{high} ms"),
        ));
    }
    if first_end_ms > second_start_ms {
        return Err(EditError::new(
            EditErrorKind::NotApplicable,
            "the first half would end after the second begins",
        ));
    }

    let span = located.segment.span;
    let terminated = terminator_len(document.slice(span)) > 0;
    let (start_ms, end_ms) = (cue.start.millis(), cue.end.millis());

    let (inserted, expected, segments_inserted) = match format {
        SubtitleFormat::Ass => {
            let head = ass_line(
                document,
                &located,
                start_ms,
                first_end_ms,
                text,
                false,
                true,
            )?;
            let tail = ass_line(
                document,
                &located,
                second_start_ms,
                end_ms,
                text,
                false,
                terminated,
            )?;
            (
                format!("{head}{tail}"),
                vec![text.to_owned(), text.to_owned()],
                2,
            )
        }
        SubtitleFormat::Srt | SubtitleFormat::Vtt => {
            let block = block_of(document, &located)?;
            let newline = block.newline;
            let head = block.render(format, start_ms, first_end_ms, text, true)?;
            let tail_block = Block {
                number: block.number.map(|number| number.saturating_add(1)),
                id: None,
                ..block
            };
            let tail = tail_block.render(format, second_start_ms, end_ms, text, terminated)?;
            (
                format!("{head}{newline}{tail}"),
                vec![render_text(text, newline), render_text(text, newline)],
                3,
            )
        }
    };

    let mut cues = Vec::with_capacity(2);
    for (offset, text_raw) in expected.into_iter().enumerate() {
        let (from_ms, to_ms) = if offset == 0 {
            (start_ms, first_end_ms)
        } else {
            (second_start_ms, end_ms)
        };
        cues.push(ExpectedCue {
            text_raw,
            start_ms: from_ms,
            end_ms: to_ms,
        });
    }

    Ok(Planned {
        splice: Splice::new(span.start, document.slice(span).to_owned(), inserted),
        label: EditLabel {
            kind: EditKind::SplitInTwo,
            cue: index,
        },
        expect: Expectation {
            from: index,
            removed: 1,
            cues,
            segments_from: located.segment_index,
            segments_removed: 1,
            segments_inserted,
        },
    })
}

fn plan_merge(document: &SubtitleDocument, index: usize) -> Result<Planned, EditError> {
    let first = locate(document, index)?;
    let second = locate(document, index.saturating_add(1))?;
    let format = document.format();
    let segments = document.segments();

    // Merging two cues may only swallow the blank lines between them. A VTT NOTE or an ASS comment
    // line in the gap belongs to no cue and must not disappear with them. See CONTRIBUTING.md §3.
    for position in first.segment_index.saturating_add(1)..second.segment_index {
        let Some(segment) = segments.get(position) else {
            break;
        };
        if !matches!(segment.kind, SegmentKind::Blank) {
            return Err(EditError::new(
                EditErrorKind::NotApplicable,
                "the two cues are separated by content that is not blank lines",
            ));
        }
    }

    let head = diff::normalize(document.slice(first.cue.text));
    let tail = diff::normalize(document.slice(second.cue.text));
    let joined = if head.is_empty() || tail.is_empty() {
        format!("{head}{tail}")
    } else {
        match format {
            SubtitleFormat::Ass => format!("{head}\\N{tail}"),
            SubtitleFormat::Srt | SubtitleFormat::Vtt => format!("{head}\n{tail}"),
        }
    };
    validate_text(format, &joined)?;

    let region = Span::new(first.segment.span.start, second.segment.span.end);
    let terminated = terminator_len(document.slice(second.segment.span)) > 0;
    let (start_ms, end_ms) = (first.cue.start.millis(), second.cue.end.millis());

    // The second cue's own shape -- its index line, identifier or non-timing fields -- goes with
    // it: two lines becoming one can only keep one shape, and undo restores the bytes exactly.
    let (inserted, text_raw) = match format {
        SubtitleFormat::Ass => (
            ass_line(
                document, &first, start_ms, end_ms, &joined, false, terminated,
            )?,
            joined.clone(),
        ),
        SubtitleFormat::Srt | SubtitleFormat::Vtt => {
            let block = block_of(document, &first)?;
            (
                block.render(format, start_ms, end_ms, &joined, terminated)?,
                render_text(&joined, block.newline),
            )
        }
    };

    Ok(Planned {
        splice: Splice::new(region.start, document.slice(region).to_owned(), inserted),
        label: EditLabel {
            kind: EditKind::Merge,
            cue: index,
        },
        expect: Expectation {
            from: index,
            removed: 2,
            cues: vec![ExpectedCue {
                text_raw,
                start_ms,
                end_ms,
            }],
            segments_from: first.segment_index,
            segments_removed: second
                .segment_index
                .saturating_sub(first.segment_index)
                .saturating_add(1),
            segments_inserted: 1,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::{
        default_shape, first_ass_event, is_blank_line, render_text, render_timecode, shape_of,
        validate_text, verify_field, TimeShape,
    };
    use crate::error::EditErrorKind;
    use sublore_formats::{
        timecode::parse_timecode, AssField, SubtitleDocument, SubtitleFormat, MAX_TIMECODE_MS,
    };

    /// A `Format:` line that puts a timing after the text describes a line this cannot write: the
    /// text takes everything after the last comma, so a field behind it would be eaten by it.
    #[test]
    fn a_first_line_is_refused_where_the_text_is_not_the_last_field() {
        let body = "[Events]\nFormat: Layer, Text, Start, End\n";
        let document = sublore_formats::parse(SubtitleFormat::Ass, body.as_bytes())
            .expect("a file with a format line and no events");
        let refused = first_ass_event(&document, 0, 1_000, "Anything").expect_err("a refusal");
        assert_eq!(refused.kind, EditErrorKind::NotApplicable);
    }

    /// And a file with no events section at all has nowhere to put a line.
    #[test]
    fn a_first_line_is_refused_where_there_is_no_events_section() {
        let body = "[Script Info]\nScriptType: v4.00+\n";
        let document = sublore_formats::parse(SubtitleFormat::Ass, body.as_bytes())
            .expect("a file with no events section");
        let refused = first_ass_event(&document, 0, 1_000, "Anything").expect_err("a refusal");
        assert_eq!(refused.kind, EditErrorKind::NotApplicable);
    }

    /// Every rendered timestamp is proved by the scanner that will read it back.
    fn round_trip(millis: u32, shape: TimeShape) -> String {
        let written = render_timecode(millis, shape).expect("the shape can hold the value");
        let (timecode, end) = parse_timecode(&written, 0).expect("the scanner reads it back");
        assert_eq!(end, written.len(), "{written:?} must be consumed whole");
        assert_eq!(timecode.millis(), millis, "{written:?} must mean {millis}");
        written
    }

    #[test]
    fn mirrors_the_spelling_it_was_given() {
        assert_eq!(shape_of("00:00:01,000").separator, ',');
        assert_eq!(shape_of("00:00:01.000").separator, '.');
        assert_eq!(shape_of("00:00:01,5").fraction, 1);
        assert_eq!(shape_of("0:00:01.50").fraction, 2);
        assert_eq!(shape_of("0:00:01.50").hours, Some(1));
        assert_eq!(shape_of("00:01.000").hours, None);
    }

    #[test]
    fn writes_back_what_each_format_writes() {
        assert_eq!(
            round_trip(3_723_004, default_shape(SubtitleFormat::Srt)),
            "01:02:03,004"
        );
        assert_eq!(
            round_trip(3_723_004, default_shape(SubtitleFormat::Vtt)),
            "01:02:03.004"
        );
        assert_eq!(
            round_trip(3_723_000, default_shape(SubtitleFormat::Ass)),
            "1:02:03.00"
        );
        assert_eq!(
            round_trip(0, default_shape(SubtitleFormat::Srt)),
            "00:00:00,000"
        );
    }

    #[test]
    fn refuses_a_value_the_precision_cannot_hold_rather_than_rounding_it() {
        let centiseconds = shape_of("0:00:01.50");
        let error = render_timecode(1_234, centiseconds).expect_err("1234 ms needs 3 digits");
        assert_eq!(error.kind, crate::error::EditErrorKind::UnwritableTimecode);
        assert_eq!(round_trip(1_230, centiseconds), "0:00:01.23");
    }

    #[test]
    fn refuses_a_value_past_the_ceiling() {
        let error = render_timecode(MAX_TIMECODE_MS + 1, default_shape(SubtitleFormat::Srt))
            .expect_err("past the ceiling");
        assert_eq!(error.kind, crate::error::EditErrorKind::UnwritableTimecode);
        assert_eq!(
            round_trip(MAX_TIMECODE_MS, default_shape(SubtitleFormat::Srt)),
            "999:59:59,999"
        );
    }

    #[test]
    fn widens_only_where_widening_loses_nothing() {
        // Hours grow past the width the file used; the vtt short form promotes past its last hour.
        assert_eq!(
            round_trip(3_600_000, shape_of("00:00:01.000")),
            "01:00:00.000"
        );
        assert_eq!(round_trip(3_599_999, shape_of("00:01.000")), "59:59.999");
        assert_eq!(round_trip(3_600_000, shape_of("00:01.000")), "01:00:00.000");
    }

    #[test]
    fn a_blank_line_inside_cue_text_is_unwritable() {
        for text in ["one\n\ntwo", "one\n \ntwo", "\nleading", "trailing\n", "\r"] {
            assert!(
                validate_text(SubtitleFormat::Srt, text).is_err(),
                "{text:?} must be refused"
            );
        }
        assert!(validate_text(SubtitleFormat::Srt, "one\ntwo").is_ok());
        assert!(validate_text(SubtitleFormat::Vtt, "").is_ok());
    }

    #[test]
    fn an_ass_event_holds_no_line_break() {
        assert!(validate_text(SubtitleFormat::Ass, "one\ntwo").is_err());
        assert!(validate_text(SubtitleFormat::Ass, "one\rtwo").is_err());
        assert!(validate_text(SubtitleFormat::Ass, "one\\Ntwo").is_ok());
    }

    #[test]
    fn renders_text_with_the_terminator_the_block_uses() {
        assert_eq!(render_text("a\nb", "\r\n"), "a\r\nb");
        assert_eq!(render_text("a\nb", "\n"), "a\nb");
        assert!(is_blank_line(" \t\r"));
        assert!(!is_blank_line(" x"));
    }

    /// One event under a fixed six-field `Format:` line.
    fn ass(event: &str) -> SubtitleDocument {
        let text =
            format!("[Events]\nFormat: Layer, Start, End, Style, Name, Text\nDialogue: {event}\n");
        sublore_formats::parse(SubtitleFormat::Ass, text.as_bytes()).expect("the sample parses")
    }

    fn kind_of(before: &SubtitleDocument, after: &SubtitleDocument, value: &str) -> EditErrorKind {
        verify_field(before, after, 0, AssField::Actor, value)
            .expect_err("this shape must be refused")
            .kind
    }

    /// `verify::verify` reads cue counts, times and text and no other field, so these three checks
    /// are the whole proof that a field write landed where it said it did. Held here rather than
    /// through a plan, because a plan that produced any of them would be the bug.
    /// See docs/ass-field-write-tasks.md W6.
    #[test]
    fn a_field_write_proves_itself_against_the_reparsed_document() {
        let before = ass("0,0:00:01.00,0:00:02.00,Default,Ingrid,Hello");

        let written = ass("0,0:00:01.00,0:00:02.00,Default,Marek,Hello");
        assert!(verify_field(&before, &written, 0, AssField::Actor, "Marek").is_ok());

        // A field the write did not name moved with it.
        let strayed = ass("0,0:00:01.00,0:00:02.00,Sign,Marek,Hello");
        assert_eq!(
            kind_of(&before, &strayed, "Marek"),
            EditErrorKind::Unverified
        );

        // It landed somewhere else, so the named field reads back the wrong bytes.
        let elsewhere = ass("0,0:00:01.00,0:00:02.00,Marek,Ingrid,Hello");
        assert_eq!(
            kind_of(&before, &elsewhere, "Marek"),
            EditErrorKind::Unverified
        );

        // The event lost a field: what a smuggled separator looks like whatever else went wrong.
        let shortened = sublore_formats::parse(
            SubtitleFormat::Ass,
            b"[Events]\nFormat: Layer, Start, End, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Hello\n",
        )
        .expect("the sample parses");
        assert_eq!(
            kind_of(&before, &shortened, "Marek"),
            EditErrorKind::Unverified
        );
    }
}
