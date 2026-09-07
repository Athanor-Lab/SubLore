//! The document model: one immutable body, plus segments that tile it exactly.
//!
//! Every byte of the file belongs to exactly one segment, in order, with no gaps and no overlaps.
//! That makes byte-identical serialization a structural property instead of a hope:
//! [`SubtitleDocument::to_bytes`] can only re-emit slices of the original, and
//! [`SubtitleDocument::check_coverage`] proves the slices add up to the whole file.
//! See BACKLOG.md M1.1.

use crate::cue::{AssEventKind, Cue, CueDetail};
use crate::span::Span;
use crate::text::{SourceText, UTF8_BOM};

/// Section names that identify an ASS/SSA file by content alone.
const ASS_SECTIONS: [&str; 6] = [
    "script info",
    "v4 styles",
    "v4+ styles",
    "events",
    "fonts",
    "graphics",
];

/// How far into a file [`SubtitleFormat::detect`] looks for an ASS section header.
const DETECT_LINE_BUDGET: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubtitleFormat {
    Srt,
    Vtt,
    Ass,
}

impl SubtitleFormat {
    /// Content decides, extension breaks ties. `None` means "not one of ours".
    pub fn detect(extension: Option<&str>, body: &str) -> Option<Self> {
        // A caller that has not decoded through SourceText still has its BOM in hand.
        let body = body.strip_prefix('\u{feff}').unwrap_or(body);
        if is_vtt_header(body) {
            return Some(Self::Vtt);
        }

        for line in body
            .split('\n')
            .filter(|line| !line.trim().is_empty())
            .take(DETECT_LINE_BUDGET)
        {
            let Some(name) = section_name(line.trim()) else {
                continue;
            };
            if ASS_SECTIONS.contains(&name.trim().to_ascii_lowercase().as_str()) {
                return Some(Self::Ass);
            }
        }

        match extension.map(str::to_ascii_lowercase).as_deref() {
            Some("srt") => Some(Self::Srt),
            Some("vtt") => Some(Self::Vtt),
            Some("ass" | "ssa") => Some(Self::Ass),
            _ => None,
        }
    }

    /// Stable: it is the IPC wire value.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Srt => "srt",
            Self::Vtt => "vtt",
            Self::Ass => "ass",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Segment {
    /// The bytes this segment owns, including its line terminator(s).
    pub span: Span,
    pub kind: SegmentKind,
}

#[derive(Clone, Debug)]
pub enum SegmentKind {
    /// Format header the file must start with (the VTT `WEBVTT` block; in ASS everything before the
    /// first event line, section by section). SRT never produces one.
    Header,
    /// A run of blank lines between blocks.
    Blank,
    /// Metadata kept verbatim: VTT `NOTE`/`STYLE`/`REGION`, ASS section headers, `Format:`,
    /// `Style:`, `;` comments, key/value lines, and any line inside a section we do not interpret.
    Meta,
    /// A cue or an ASS event.
    Cue(Cue),
}

/// What an `[Events]` section's `Format:` line declares, and where that line sits.
///
/// Kept so a file with no event yet can still be given its first one: without it the only way to
/// know a section's field list is to copy an event, and an empty section has none to copy.
/// See ass-first-event-tasks.md.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AssEventFormat {
    /// How many fields an event in this section carries.
    pub count: usize,
    pub start_index: Option<usize>,
    pub end_index: Option<usize>,
    pub style_index: Option<usize>,
    pub name_index: Option<usize>,
    pub effect_index: Option<usize>,
    pub layer_index: Option<usize>,
    pub margin_l_index: Option<usize>,
    pub margin_r_index: Option<usize>,
    pub margin_v_index: Option<usize>,
    /// Which segment the `Format:` line is, so a first event can be written after it rather than
    /// at the end of a file whose last section is not this one.
    pub format_segment: usize,
}

/// One style a `[V4 Styles]` or `[V4+ Styles]` section declares.
///
/// The name only. What an inline styling control would want beside it (the bold, italic and
/// underline flags) is not here: it would have to travel as the file's own bytes, and deciding what
/// those bytes mean belongs to the control that reads them, with its own tests.
/// See styles-and-fields-tasks.md S1.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AssStyle {
    /// The name as the section's own `Format:` line places it, padding trimmed by
    /// [`crate::ass::trim_field`], which is the same trim a grid column gives a cue's style. The
    /// two must match or a declared style reads as unknown.
    pub name: Span,
    /// The typeface the style names, and the size beside it. Spans rather than parsed values: a
    /// reader may not invent a number the file does not hold, and a size a hand wrote as `20.5`
    /// belongs to the file. Empty where the section's `Format:` line declares no such column.
    pub fontname: Span,
    pub fontsize: Span,
    /// The four colours as the file spells them, `&HAABBGGRR` and whatever else a hand left there.
    pub primary: Span,
    pub secondary: Span,
    pub outline: Span,
    pub back: Span,
    /// The four flags a line's own override tags start from. ASS writes `-1` for on and `0` for
    /// off, and a value that is neither is off, which is what a renderer makes of it.
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strikeout: bool,
    /// The rest of what a `Style:` line declares, as the file spells each of them. Spans for the
    /// same reason the colours are: a reader may not invent a number the file does not hold.
    /// `outline_width` and `shadow` are the border's width and the shadow's depth, which the
    /// format calls Outline and Shadow, and are not the two colour columns above them.
    pub scale_x: Span,
    pub scale_y: Span,
    pub spacing: Span,
    pub angle: Span,
    pub border_style: Span,
    pub outline_width: Span,
    pub shadow: Span,
    pub alignment: Span,
    pub margin_l: Span,
    pub margin_r: Span,
    pub margin_v: Span,
    pub encoding: Span,
    /// Where each of those four sits, so an editor can write one back. Read apart from the
    /// booleans above because a reader wants the meaning and a writer wants the bytes.
    pub bold_field: Span,
    pub italic_field: Span,
    pub underline_field: Span,
    pub strikeout_field: Span,
}

/// A parsed file: the bytes it came from, and the ordered segments that tile them.
#[derive(Clone, Debug)]
pub struct SubtitleDocument {
    format: SubtitleFormat,
    source: SourceText,
    segments: Vec<Segment>,
    ass_styles: Vec<AssStyle>,
    ass_event_format: Option<AssEventFormat>,
}

impl SubtitleDocument {
    /// Built by the format parsers. Coverage is checked by [`crate::parse`], not here, so a parser
    /// can assemble its segments in whatever order its grammar needs.
    pub fn new(format: SubtitleFormat, source: SourceText, segments: Vec<Segment>) -> Self {
        Self {
            format,
            source,
            segments,
            ass_styles: Vec::new(),
            ass_event_format: None,
        }
    }

    /// Attach the styles the ASS parser found. Every other format leaves the list empty, and the
    /// whole document is re-parsed after every splice, so the list cannot go stale.
    pub fn with_ass_styles(mut self, styles: Vec<AssStyle>) -> Self {
        self.ass_styles = styles;
        self
    }

    /// The styles this file declares, in the order it declares them. Empty for SRT, for VTT, and
    /// for an ASS file with no styles section. Duplicated names are listed as often as the file
    /// spells them. See styles-and-fields-tasks.md S3.
    pub fn ass_styles(&self) -> &[AssStyle] {
        &self.ass_styles
    }

    /// Attach what the `[Events]` section's `Format:` line declared. None for every other format,
    /// and for an ASS file that has no events section at all.
    pub fn with_ass_event_format(mut self, format: Option<AssEventFormat>) -> Self {
        self.ass_event_format = format;
        self
    }

    /// What an event in this file has to look like, or nothing when the file declares no events
    /// section. Re-read after every splice, like the styles above.
    pub fn ass_event_format(&self) -> Option<AssEventFormat> {
        self.ass_event_format
    }

    pub fn format(&self) -> SubtitleFormat {
        self.format
    }

    pub fn source(&self) -> &SourceText {
        &self.source
    }

    pub fn segments(&self) -> &[Segment] {
        &self.segments
    }

    /// Every cue in file order, ASS `Comment:` events included.
    pub fn cues(&self) -> impl Iterator<Item = &Cue> + '_ {
        self.segments
            .iter()
            .filter_map(|segment| match &segment.kind {
                SegmentKind::Cue(cue) => Some(cue),
                SegmentKind::Header | SegmentKind::Blank | SegmentKind::Meta => None,
            })
    }

    /// One declared style's spans resolved against the source, in the order the section declares
    /// them. Every value is the file's own spelling, trimmed the way a cue's own style field is so
    /// the two can be compared. Empty for every other format and for an ASS with no styles section.
    pub fn ass_style_text(&self, style: &AssStyle) -> [&str; 19] {
        let body = self.source.body();
        let read = |span: Span| body.get(span.range()).unwrap_or("");
        [
            read(style.name),
            read(style.fontname),
            read(style.fontsize),
            read(style.primary),
            read(style.secondary),
            read(style.outline),
            read(style.back),
            read(style.scale_x),
            read(style.scale_y),
            read(style.spacing),
            read(style.angle),
            read(style.border_style),
            read(style.outline_width),
            read(style.shadow),
            read(style.alignment),
            read(style.margin_l),
            read(style.margin_r),
            read(style.margin_v),
            read(style.encoding),
        ]
    }

    /// Every cue a player would draw: ASS `Comment:` events excluded. This is the number the UI
    /// shows.
    pub fn displayed_cue_count(&self) -> usize {
        self.cues()
            .filter(|cue| {
                !matches!(&cue.detail, CueDetail::Ass(event) if event.kind == AssEventKind::Comment)
            })
            .count()
    }

    /// The text a span spells. Spans must come from this document; a foreign span yields "".
    pub fn slice(&self, span: Span) -> &str {
        let text = self.source.body().get(span.range());
        debug_assert!(text.is_some(), "{span:?} does not belong to this document");
        text.unwrap_or("")
    }

    /// Rebuild the file from the segments. Byte-identical to the input for an unedited document.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(self.source.byte_len());
        if self.source.has_bom() {
            bytes.extend_from_slice(&UTF8_BOM);
        }
        for segment in &self.segments {
            bytes.extend_from_slice(self.slice(segment.span).as_bytes());
        }
        bytes
    }

    /// Segments are non-empty, ascending, contiguous, cut on character boundaries, and cover the
    /// whole body. The first violation wins; an uncovered tail is reported as a violation one past
    /// the last segment.
    ///
    /// The boundary rule is part of the guarantee: a segment cut inside a multi-byte character
    /// cannot be sliced, and [`Self::to_bytes`] would drop it silently. See CONTRIBUTING.md §3.
    pub fn check_coverage(&self) -> Result<(), CoverageViolation> {
        let body = self.source.body();
        let total = body.len();
        let mut expected = 0usize;
        for (index, segment) in self.segments.iter().enumerate() {
            if segment.span.start != expected
                || segment.span.is_empty()
                || segment.span.end > total
                || !body.is_char_boundary(segment.span.start)
            {
                return Err(CoverageViolation {
                    segment: index,
                    expected_start: expected,
                    found: segment.span,
                });
            }
            expected = segment.span.end;
        }
        if expected != total {
            return Err(CoverageViolation {
                segment: self.segments.len(),
                expected_start: expected,
                found: Span::new(expected, total),
            });
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CoverageViolation {
    pub segment: usize,
    pub expected_start: usize,
    pub found: Span,
}

fn is_vtt_header(body: &str) -> bool {
    match body.strip_prefix("WEBVTT") {
        Some(rest) => rest.is_empty() || rest.starts_with([' ', '\t', '\n', '\r']),
        None => false,
    }
}

/// The name inside a `[Section]` header, or `None` for any other line.
fn section_name(line: &str) -> Option<&str> {
    let rest = line.strip_prefix('[')?;
    let end = rest.find(']')?;
    rest.get(..end)
}

#[cfg(test)]
mod tests {
    use super::{Segment, SegmentKind, SubtitleDocument, SubtitleFormat};
    use crate::cue::{AssEvent, AssEventKind, AssField, Cue, CueDetail, SrtCue};
    use crate::span::Span;
    use crate::text::SourceText;
    use crate::timecode::Timecode;

    fn document(text: &str, spans: &[(usize, usize)]) -> SubtitleDocument {
        let source = SourceText::from_bytes(text.as_bytes()).expect("valid utf-8 fixture");
        let segments = spans
            .iter()
            .map(|&(start, end)| Segment {
                span: Span::new(start, end),
                kind: SegmentKind::Meta,
            })
            .collect();
        SubtitleDocument::new(SubtitleFormat::Srt, source, segments)
    }

    fn srt_cue(start: usize, end: usize) -> Cue {
        Cue {
            start: Timecode::new(0, Span::new(start, start)),
            end: Timecode::new(1_000, Span::new(end, end)),
            text: Span::new(start, end),
            detail: CueDetail::Srt(SrtCue {
                number: None,
                number_span: None,
                timing_trailer: None,
            }),
        }
    }

    fn ass_cue(kind: AssEventKind) -> Cue {
        Cue {
            start: Timecode::new(0, Span::new(0, 0)),
            end: Timecode::new(1_000, Span::new(0, 0)),
            text: Span::new(0, 0),
            detail: CueDetail::Ass(AssEvent {
                kind,
                descriptor: Span::new(0, 0),
                fields: Vec::new(),
                text_field: 0,
                named: [None; AssField::COUNT],
            }),
        }
    }

    #[test]
    fn rebuilds_the_file_from_its_segments() {
        let document = document("one\ntwo\n", &[(0, 4), (4, 8)]);
        assert_eq!(document.to_bytes(), b"one\ntwo\n");
        assert!(document.check_coverage().is_ok());
    }

    #[test]
    fn rebuilds_a_bom_prefixed_file() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"one\n");
        let source = SourceText::from_bytes(&bytes).expect("valid utf-8");
        let segments = vec![Segment {
            span: Span::new(0, 4),
            kind: SegmentKind::Meta,
        }];
        let document = SubtitleDocument::new(SubtitleFormat::Srt, source, segments);
        assert_eq!(document.to_bytes(), bytes);
    }

    #[test]
    fn a_messy_file_tiled_line_by_line_comes_back_byte_for_byte() {
        // The invariant every parser inherits: spans that tile the body reproduce the file exactly.
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(
            "1\r\n00:00:01,000 --> 00:00:02,000\r\n\u{3053}\u{3093}\u{306b}\u{3061}\u{306f}\r\n\r\n2\n00:00:03,000 --> 00:00:04,000\nbare\rreturn\ttab \nno final newline"
                .as_bytes(),
        );
        let source = SourceText::from_bytes(&bytes).expect("valid utf-8");

        let segments = (1..=source.line_count())
            .map(|line| Segment {
                span: source.line_span(line),
                kind: SegmentKind::Meta,
            })
            .collect();
        let document = SubtitleDocument::new(SubtitleFormat::Srt, source, segments);

        assert_eq!(document.check_coverage(), Ok(()));
        assert_eq!(document.to_bytes(), bytes);
        assert_eq!(document.segments().len(), 8);
    }

    #[test]
    fn an_empty_body_is_covered_by_no_segments() {
        let document = document("", &[]);
        assert!(document.check_coverage().is_ok());
        assert!(document.to_bytes().is_empty());
    }

    #[test]
    fn a_gap_is_a_coverage_violation() {
        let document = document("one\ntwo\n", &[(0, 4), (5, 8)]);
        let violation = document
            .check_coverage()
            .expect_err("the gap must be caught");
        assert_eq!(violation.segment, 1);
        assert_eq!(violation.expected_start, 4);
    }

    #[test]
    fn an_overlap_is_a_coverage_violation() {
        let document = document("one\ntwo\n", &[(0, 4), (3, 8)]);
        let violation = document
            .check_coverage()
            .expect_err("the overlap must be caught");
        assert_eq!(violation.segment, 1);
    }

    #[test]
    fn a_segment_cut_inside_a_character_is_a_coverage_violation() {
        // "é" is two bytes: tiling by bytes alone would slice to nothing and lose the character.
        let document = document("é\n", &[(0, 1), (1, 3)]);
        let violation = document
            .check_coverage()
            .expect_err("the split character must be caught");
        assert_eq!(violation.segment, 1);
        assert_eq!(violation.expected_start, 1);
    }

    #[test]
    fn an_empty_segment_is_a_coverage_violation() {
        let document = document("one\ntwo\n", &[(0, 4), (4, 4), (4, 8)]);
        let violation = document
            .check_coverage()
            .expect_err("the empty segment must be caught");
        assert_eq!(violation.segment, 1);
    }

    #[test]
    fn an_uncovered_tail_is_a_coverage_violation() {
        let document = document("one\ntwo\n", &[(0, 4)]);
        let violation = document
            .check_coverage()
            .expect_err("the tail must be caught");
        assert_eq!(violation.segment, 1);
        assert_eq!(violation.expected_start, 4);
        assert_eq!(violation.found.range(), 4..8);
    }

    #[test]
    fn counts_cues_and_leaves_ass_comments_out_of_the_displayed_count() {
        let source = SourceText::from_bytes(b"ignored").expect("valid utf-8");
        let segments = vec![
            Segment {
                span: Span::new(0, 3),
                kind: SegmentKind::Cue(ass_cue(AssEventKind::Dialogue)),
            },
            Segment {
                span: Span::new(3, 5),
                kind: SegmentKind::Cue(ass_cue(AssEventKind::Comment)),
            },
            Segment {
                span: Span::new(5, 7),
                kind: SegmentKind::Blank,
            },
        ];
        let document = SubtitleDocument::new(SubtitleFormat::Ass, source, segments);
        assert_eq!(document.cues().count(), 2);
        assert_eq!(document.displayed_cue_count(), 1);
    }

    #[test]
    fn every_srt_cue_counts_as_displayed() {
        let source = SourceText::from_bytes(b"one\ntwo\n").expect("valid utf-8");
        let segments = vec![
            Segment {
                span: Span::new(0, 4),
                kind: SegmentKind::Cue(srt_cue(0, 3)),
            },
            Segment {
                span: Span::new(4, 8),
                kind: SegmentKind::Cue(srt_cue(4, 7)),
            },
        ];
        let document = SubtitleDocument::new(SubtitleFormat::Srt, source, segments);
        assert_eq!(document.displayed_cue_count(), 2);
        assert_eq!(document.slice(Span::new(4, 7)), "two");
    }

    #[test]
    fn detects_vtt_from_its_header_whatever_the_extension_says() {
        assert_eq!(
            SubtitleFormat::detect(Some("srt"), "WEBVTT\n\n"),
            Some(SubtitleFormat::Vtt)
        );
        assert_eq!(
            SubtitleFormat::detect(None, "WEBVTT - Episode 1\r\n"),
            Some(SubtitleFormat::Vtt)
        );
        assert_eq!(
            SubtitleFormat::detect(Some("srt"), "\u{feff}WEBVTT\n"),
            Some(SubtitleFormat::Vtt)
        );
        assert_eq!(
            SubtitleFormat::detect(Some("srt"), "WEBVTTX\n"),
            Some(SubtitleFormat::Srt)
        );
    }

    #[test]
    fn detects_ass_from_a_section_header() {
        assert_eq!(
            SubtitleFormat::detect(Some("txt"), "\n; a comment\n[Script Info]\nTitle: x\n"),
            Some(SubtitleFormat::Ass)
        );
        assert_eq!(
            SubtitleFormat::detect(None, "[V4+ Styles]\n"),
            Some(SubtitleFormat::Ass)
        );
        assert_eq!(
            SubtitleFormat::detect(None, "[Whatever]\n"),
            None,
            "an unknown section is not enough to claim the file"
        );
    }

    #[test]
    fn falls_back_to_the_extension_then_gives_up() {
        assert_eq!(
            SubtitleFormat::detect(Some("SRT"), "1\n00:00:01,000 --> 00:00:02,000\nhi\n"),
            Some(SubtitleFormat::Srt)
        );
        assert_eq!(
            SubtitleFormat::detect(Some("ssa"), "Dialogue: 0,0:00:01.00\n"),
            Some(SubtitleFormat::Ass)
        );
        assert_eq!(SubtitleFormat::detect(Some("mkv"), "binary junk"), None);
        assert_eq!(SubtitleFormat::detect(None, ""), None);
    }

    #[test]
    fn wire_values_are_stable() {
        assert_eq!(SubtitleFormat::Srt.as_str(), "srt");
        assert_eq!(SubtitleFormat::Vtt.as_str(), "vtt");
        assert_eq!(SubtitleFormat::Ass.as_str(), "ass");
    }
}
