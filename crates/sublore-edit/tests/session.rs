//! What one open document does under editing: the cue list the UI renders, the patch every change
//! produces, and the promise that a refused edit moves nothing. Written from the M2.3 acceptance
//! criteria in BACKLOG.md — edit a cue, save, reopen, the edit is there and the rest is
//! byte-identical; undo restores it — asserted here on bytes rather than through the app.
//!
//! The session is the only place the mutation API and the undo stack meet, so these tests drive it
//! the way the IPC layer does and compare every result against the fixture as it was read.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use sublore_edit::diff::CuePatch;
use sublore_edit::error::EditErrorKind;
use sublore_edit::history::Run;
use sublore_edit::plan::{AssStyleField, Edit};
use sublore_edit::session::EditSession;
use sublore_formats::override_tags::StyleFlag;
use sublore_formats::{AssField, CueDetail, SubtitleDocument, SubtitleFormat};

/// A typing pause, well inside `history::COALESCE_WINDOW`.
const KEYSTROKE: Duration = Duration::from_millis(50);
/// Wider than the window: two edits this far apart are two undo steps.
const APART: Duration = Duration::from_secs(2);

fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR is crates/sublore-edit; the fixtures live two levels up.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("the crate sits two levels under the repo root")
        .to_path_buf()
}

fn fixture_path(relative: &str) -> PathBuf {
    let path = repo_root().join("fixtures/subtitles").join(relative);
    assert!(path.is_file(), "missing fixture {}", path.display());
    path
}

fn fixture_bytes(relative: &str) -> Vec<u8> {
    let path = fixture_path(relative);
    std::fs::read(&path).unwrap_or_else(|error| panic!("{} is unreadable: {error}", path.display()))
}

fn format_of(relative: &str) -> SubtitleFormat {
    match Path::new(relative)
        .extension()
        .and_then(|value| value.to_str())
    {
        Some("srt") => SubtitleFormat::Srt,
        Some("vtt") => SubtitleFormat::Vtt,
        Some("ass") => SubtitleFormat::Ass,
        other => panic!("no parser for {other:?}"),
    }
}

fn document(relative: &str) -> SubtitleDocument {
    let bytes = fixture_bytes(relative);
    sublore_formats::parse(format_of(relative), &bytes)
        .unwrap_or_else(|error| panic!("{relative} is a clean fixture: {error}"))
}

/// A session over a fixture, opened from a path that is never written to by these tests.
fn session(relative: &str) -> EditSession {
    EditSession::open(fixture_path(relative), document(relative))
}

/// The M2.1 promise, asserted at the session level: outside the region the edit named, the file is
/// the same bytes it was. `start` is a file offset, so a BOM is already counted.
fn differs_only_in(before: &[u8], after: &[u8], start: usize, old_len: usize, new_len: usize) {
    assert_eq!(
        before.get(..start),
        after.get(..start),
        "the bytes before the edit moved"
    );
    assert_eq!(
        before.get(start + old_len..),
        after.get(start + new_len..),
        "the bytes after the edit moved"
    );
}

/// Where cue `index`'s text sits in the file: its body span shifted past a byte-order mark.
fn text_region(session: &EditSession, index: usize) -> (usize, usize) {
    let document = session.document();
    let cue = document.cues().nth(index).expect("the cue exists");
    let bom = if document.source().has_bom() { 3 } else { 0 };
    (bom + cue.text.start, cue.text.end - cue.text.start)
}

fn set_text(index: usize, text: &str) -> Edit {
    Edit::SetText {
        cue: index,
        text: text.to_owned(),
    }
}

fn texts(session: &EditSession) -> Vec<String> {
    session
        .views()
        .iter()
        .map(|view| view.text.clone())
        .collect()
}

#[test]
fn an_opened_session_lists_every_cue_and_has_nothing_to_undo() {
    let session = session("srt/clean/basic-lf.srt");

    assert_eq!(session.views().len(), 3, "three cues, three rows");
    assert_eq!(session.revision(), 0);
    assert!(!session.dirty(), "a file as it was read is not dirty");
    assert!(!session.can_undo());
    assert!(!session.can_redo());
    assert!(!session.truncated());
    assert_eq!(
        session.to_bytes(),
        fixture_bytes("srt/clean/basic-lf.srt"),
        "an unedited session serializes to the file it opened"
    );
    assert_eq!(
        session.path(),
        Some(fixture_path("srt/clean/basic-lf.srt").as_path()),
        "the session remembers where it came from"
    );

    let first = session.views().first().expect("a first row");
    assert_eq!(first.start_ms, 2_120);
    assert_eq!(first.end_ms, 4_880);
    assert_eq!(first.number, Some(1), "the file wrote an index line");
    assert!(!first.comment);
}

#[test]
fn editing_one_cue_leaves_every_other_byte_of_the_file_identical() {
    for relative in [
        "srt/clean/basic-lf.srt",
        "srt/clean/basic-crlf.srt",
        "srt/clean/bom-crlf.srt",
        "srt/clean/non-latin.srt",
        "vtt/clean/basic.vtt",
        "ass/clean/basic.ass",
    ] {
        let mut session = session(relative);
        let before = session.to_bytes();
        let (start, old_len) = text_region(&session, 1);

        let patch = session
            .apply(&set_text(1, "Rewritten line"), Run::New, Instant::now())
            .unwrap_or_else(|error| panic!("{relative}: editing cue 1 was refused: {error}"));

        assert_eq!(
            patch,
            CuePatch {
                from: 1,
                removed: 1,
                cues: vec![session.views()[1].clone()],
            },
            "{relative}: one row changed, so the patch is one row"
        );
        assert_eq!(session.views()[1].text, "Rewritten line", "{relative}");

        let after = session.to_bytes();
        differs_only_in(&before, &after, start, old_len, "Rewritten line".len());
        assert!(session.dirty(), "{relative}: an edited file is dirty");
        assert!(session.can_undo(), "{relative}");
        assert_eq!(session.revision(), 1, "{relative}");
    }
}

#[test]
fn undo_restores_the_exact_original_bytes_and_redo_the_edited_ones() {
    for relative in [
        "srt/clean/basic-lf.srt",
        "srt/clean/basic-crlf.srt",
        "srt/clean/bom-crlf.srt",
        "srt/clean/no-final-newline.srt",
        "srt/clean/numbering-gaps.srt",
        "vtt/clean/cue-settings.vtt",
        "ass/clean/basic.ass",
    ] {
        let mut session = session(relative);
        let original = session.to_bytes();

        session
            .apply(
                &set_text(0, "First line, rewritten"),
                Run::New,
                Instant::now(),
            )
            .unwrap_or_else(|error| panic!("{relative}: {error}"));
        let edited = session.to_bytes();
        assert_ne!(edited, original, "{relative}: the edit changed the file");

        let patch = session
            .undo()
            .unwrap_or_else(|error| panic!("{relative}: undo was refused: {error}"))
            .unwrap_or_else(|| panic!("{relative}: there was an edit to undo"));
        assert_eq!(patch.from, 0, "{relative}");
        assert_eq!(
            session.to_bytes(),
            original,
            "{relative}: undo restores the file byte for byte"
        );
        assert!(!session.dirty(), "{relative}: back at the opened bytes");
        assert!(session.can_redo(), "{relative}");

        session
            .redo()
            .unwrap_or_else(|error| panic!("{relative}: redo was refused: {error}"))
            .unwrap_or_else(|| panic!("{relative}: there was an edit to redo"));
        assert_eq!(
            session.to_bytes(),
            edited,
            "{relative}: redo restores the edited file byte for byte"
        );
        assert!(session.dirty(), "{relative}");
    }
}

#[test]
fn undo_at_the_bottom_and_redo_at_the_top_move_nothing() {
    let mut session = session("srt/clean/basic-lf.srt");
    let original = session.to_bytes();

    assert!(session.undo().expect("no step is not a failure").is_none());
    assert_eq!(session.revision(), 0, "nothing happened, nothing moved");
    assert_eq!(session.to_bytes(), original);

    session
        .apply(&set_text(0, "Changed"), Run::New, Instant::now())
        .expect("the edit lands");
    assert!(session.redo().expect("no step is not a failure").is_none());
    assert_eq!(session.revision(), 1, "the redo was a no-op");
}

#[test]
fn a_refused_edit_leaves_the_session_exactly_as_it_was() {
    let mut session = session("srt/clean/basic-lf.srt");
    let original = session.to_bytes();
    let rows = texts(&session);

    // A cue index past the end, and a text SRT cannot spell: both are refusals, never writes.
    for (edit, expected) in [
        (set_text(99, "nowhere"), EditErrorKind::NoSuchCue),
        (
            set_text(0, "first\n\nsecond"),
            EditErrorKind::UnwritableText,
        ),
        (Edit::Merge { cue: 2 }, EditErrorKind::NoSuchCue),
    ] {
        let error = session
            .apply(&edit, Run::New, Instant::now())
            .expect_err("this edit cannot be written");
        assert_eq!(error.kind, expected, "{edit:?}");
        assert_eq!(session.to_bytes(), original, "{edit:?}: the bytes moved");
        assert_eq!(texts(&session), rows, "{edit:?}: the rows moved");
        assert_eq!(session.revision(), 0, "{edit:?}: the revision moved");
        assert!(!session.dirty(), "{edit:?}: a refusal made the file dirty");
        assert!(!session.can_undo(), "{edit:?}: a refusal reached the stack");
    }
}

#[test]
fn typing_a_word_through_the_session_is_one_undo_step() {
    let mut session = session("srt/clean/basic-lf.srt");
    let original = session.to_bytes();
    let mut now = Instant::now();

    // Eight keystrokes on the same cue, each rewriting the whole text field, from a caller that
    // says so. The cue list is not such a caller: it sends one finished field per commit.
    for length in 1..=8 {
        let typed: String = "Kept safe".chars().take(length).collect();
        session
            .apply(&set_text(0, &typed), Run::Continues, now)
            .expect("each keystroke lands");
        now += KEYSTROKE;
    }
    assert_eq!(session.views()[0].text, "Kept saf");

    session
        .undo()
        .expect("one undo")
        .expect("there is a step to undo");
    assert_eq!(
        session.to_bytes(),
        original,
        "one undo takes the whole typed run back"
    );
    assert!(!session.can_undo(), "the run was one entry, not eight");
}

/// Regression: two finished edits of one cue used to merge whenever they landed inside the
/// coalescing window, so the first of them stopped being a place undo could go back to. M2.2.
#[test]
fn two_finished_edits_of_one_cue_are_two_undo_steps_however_fast_they_arrive() {
    let mut session = session("srt/clean/basic-lf.srt");
    let original = session.to_bytes();
    let now = Instant::now();

    session
        .apply(&set_text(0, "First draft."), Run::New, now)
        .expect("the first edit lands");
    let after_first = session.to_bytes();
    session
        .apply(
            &set_text(0, "Second, corrected draft."),
            Run::New,
            now + KEYSTROKE,
        )
        .expect("the second edit lands");

    session.undo().expect("undo").expect("a step");
    assert_eq!(session.views()[0].text, "First draft.");
    assert_eq!(
        session.to_bytes(),
        after_first,
        "the first draft is still a state the stack can go back to"
    );
    session.undo().expect("undo").expect("a second step");
    assert_eq!(session.to_bytes(), original, "and then the file as opened");
}

#[test]
fn edits_far_apart_are_separate_undo_steps() {
    let mut session = session("srt/clean/basic-lf.srt");
    let original = session.to_bytes();
    let mut now = Instant::now();

    session
        .apply(&set_text(0, "One"), Run::New, now)
        .expect("first edit");
    now += APART;
    let after_first = session.to_bytes();
    session
        .apply(&set_text(0, "Two"), Run::New, now)
        .expect("second edit");

    session.undo().expect("undo").expect("a step");
    assert_eq!(session.to_bytes(), after_first, "one step back, not two");
    session.undo().expect("undo").expect("a second step");
    assert_eq!(session.to_bytes(), original);
}

#[test]
fn saving_marks_the_session_clean_and_the_next_edit_dirty_again() {
    let mut session = session("srt/clean/basic-lf.srt");
    session
        .apply(&set_text(0, "Edited"), Run::New, Instant::now())
        .expect("the edit lands");
    assert!(session.dirty());

    session.mark_saved();
    assert!(
        !session.dirty(),
        "the bytes on disk are the bytes in memory"
    );

    session
        .apply(&set_text(1, "Edited too"), Run::New, Instant::now())
        .expect("the second edit lands");
    assert!(session.dirty(), "an edit after a save is unsaved work");

    session.undo().expect("undo").expect("a step");
    assert!(!session.dirty(), "undoing back to the save point is clean");
}

#[test]
fn an_edit_after_an_undo_drops_the_redo_tail() {
    let mut session = session("srt/clean/basic-lf.srt");
    let mut now = Instant::now();

    session
        .apply(&set_text(0, "One"), Run::New, now)
        .expect("first edit");
    now += APART;
    session.undo().expect("undo").expect("a step");
    assert!(session.can_redo());

    session
        .apply(&set_text(1, "Elsewhere"), Run::New, now)
        .expect("a new edit");
    assert!(
        !session.can_redo(),
        "the undone edit is unreachable once a new one is made"
    );
}

/// What a copy of the first two cues of `basic-lf.srt` puts on the clipboard.
const TWO_SRT_BLOCKS: &str = "1\n00:00:02,120 --> 00:00:04,880\nThe harbour was empty when we got there.\n\n2\n00:00:05,000 --> 00:00:08,340\nNobody had told the crew we were coming,\nso we sat on the dock until it got light.\n";

#[test]
fn a_join_puts_every_text_on_the_first_line_and_takes_the_latest_end() {
    let mut session = session("srt/clean/basic-lf.srt");
    let original = session.to_bytes();

    session
        .apply(
            &Edit::Join {
                cues: vec![0, 1],
                keep_first_text: false,
            },
            Run::New,
            Instant::now(),
        )
        .expect("the first two join");

    let rows = session.views();
    assert_eq!(rows.len(), 2, "two lines became one");
    assert_eq!(
        rows[0].text,
        "The harbour was empty when we got there. Nobody had told the crew we were coming,\nso we sat on the dock until it got light.",
        "one text after the other, with a space between them"
    );
    assert_eq!(
        rows[0].start_ms, 2_120,
        "the first line keeps its own start"
    );
    assert_eq!(
        rows[0].end_ms, 8_340,
        "and takes the end of the last of them"
    );

    session.undo().expect("undo").expect("a step");
    assert_eq!(session.to_bytes(), original, "one undo puts both back");
}

#[test]
fn a_join_that_keeps_the_first_text_drops_the_others_words_and_not_their_time() {
    let mut session = session("srt/clean/basic-lf.srt");

    session
        .apply(
            &Edit::Join {
                cues: vec![0, 1],
                keep_first_text: true,
            },
            Run::New,
            Instant::now(),
        )
        .expect("the first two join");

    let rows = session.views();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].text, "The harbour was empty when we got there.");
    assert_eq!(
        rows[0].end_ms, 8_340,
        "the time of the line that went is kept"
    );
}

#[test]
fn a_join_over_a_hole_leaves_the_line_it_did_not_name() {
    let mut session = session("srt/clean/basic-lf.srt");
    let middle = session.views()[1].text.clone();

    session
        .apply(
            &Edit::Join {
                cues: vec![0, 2],
                keep_first_text: false,
            },
            Run::New,
            Instant::now(),
        )
        .expect("the first and the last join");

    let rows = session.views();
    assert_eq!(rows.len(), 2, "the two named became one, the third stayed");
    assert_eq!(rows[0].end_ms, 11_760, "the latest end of the two named");
    assert_eq!(
        rows[1].text, middle,
        "and the line between them is untouched"
    );
}

#[test]
fn a_join_keeps_the_fields_the_first_line_declares() {
    let mut session = session("ass/clean/speakers.ass");
    let (style, actor) = {
        let rows = session.views();
        (rows[1].style.clone(), rows[1].actor.clone())
    };
    assert_ne!(actor, "", "the fixture's second event names a speaker");

    session
        .apply(
            &Edit::Join {
                cues: vec![1, 2],
                keep_first_text: false,
            },
            Run::New,
            Instant::now(),
        )
        .expect("the last two join");

    // Five events in the fixture, two of them joined into one.
    let rows = session.views();
    assert_eq!(rows.len(), 4);
    assert_eq!(rows[1].style, style, "the line that stays keeps its style");
    assert_eq!(rows[1].actor, actor, "and its speaker");
    assert_eq!(
        rows[1].end_ms, 9_440,
        "and takes the end of the one it took in"
    );
}

#[test]
fn a_join_refuses_one_cue_and_cues_out_of_their_order() {
    let mut session = session("srt/clean/basic-lf.srt");
    let original = session.to_bytes();

    for cues in [vec![0], Vec::new(), vec![2, 0], vec![1, 1]] {
        let refused = session
            .apply(
                &Edit::Join {
                    cues,
                    keep_first_text: false,
                },
                Run::New,
                Instant::now(),
            )
            .expect_err("a refusal");
        assert_eq!(refused.kind, EditErrorKind::NotApplicable);
    }
    assert_eq!(session.to_bytes(), original, "a refusal writes nothing");
}

#[test]
fn a_duplicate_writes_each_named_line_again_and_leaves_the_ones_between_them() {
    let mut session = session("srt/clean/basic-lf.srt");
    let original = session.to_bytes();

    session
        .apply(
            &Edit::Duplicate { cues: vec![0, 2] },
            Run::New,
            Instant::now(),
        )
        .expect("the first and the last are duplicated");

    let texts: Vec<String> = session.views().iter().map(|row| row.text.clone()).collect();
    assert_eq!(
        texts,
        vec![
            "The harbour was empty when we got there.".to_owned(),
            "The harbour was empty when we got there.".to_owned(),
            "Nobody had told the crew we were coming,\nso we sat on the dock until it got light."
                .to_owned(),
            "By then the fog had eaten the boats.".to_owned(),
            "By then the fog had eaten the boats.".to_owned(),
        ],
        "each copy sits after the line it copies, and the line between them is untouched"
    );

    session.undo().expect("undo").expect("a step");
    assert_eq!(
        session.to_bytes(),
        original,
        "one undo takes both copies back"
    );
}

#[test]
fn a_duplicated_run_lands_as_a_block_after_the_block_it_copies() {
    let mut session = session("srt/clean/basic-lf.srt");

    session
        .apply(
            &Edit::Duplicate { cues: vec![0, 1] },
            Run::New,
            Instant::now(),
        )
        .expect("the first two are duplicated");

    let texts: Vec<String> = session.views().iter().map(|row| row.text.clone()).collect();
    let first = "The harbour was empty when we got there.".to_owned();
    let second =
        "Nobody had told the crew we were coming,\nso we sat on the dock until it got light."
            .to_owned();
    assert_eq!(
        texts,
        vec![
            first.clone(),
            second.clone(),
            first,
            second,
            "By then the fog had eaten the boats.".to_owned(),
        ],
        "the two copies follow the two lines, in the order those two were written in"
    );
}

#[test]
fn a_duplicated_block_is_a_block_and_not_two_lines_stuck_together() {
    let mut session = session("srt/clean/basic-lf.srt");

    session
        .apply(&Edit::Duplicate { cues: vec![2] }, Run::New, Instant::now())
        .expect("the last line is duplicated");

    let text = String::from_utf8(session.to_bytes()).expect("still UTF-8");
    assert_eq!(session.views().len(), 4);
    // The blank line between the block and its copy, at the end of a file that has no block after
    // it: without it the two read back as one cue with an index line in its text.
    assert!(
        text.ends_with(
            "boats.\n\n3\n00:00:09,100 --> 00:00:11,760\nBy then the fog had eaten the boats.\n"
        ),
        "the copy is its own block:\n{text}"
    );
}

#[test]
fn a_duplicated_ass_event_carries_the_fields_the_line_declares() {
    let mut session = session("ass/clean/speakers.ass");
    let (style, actor) = {
        let rows = session.views();
        (rows[1].style.clone(), rows[1].actor.clone())
    };
    assert_ne!(actor, "", "the fixture's second event names a speaker");

    session
        .apply(&Edit::Duplicate { cues: vec![1] }, Run::New, Instant::now())
        .expect("the event is duplicated");

    let rows = session.views();
    assert_eq!(rows[2].style, style, "the copy names the same style");
    assert_eq!(rows[2].actor, actor, "and the same speaker");
    assert_eq!(rows[1].text, rows[2].text);
}

#[test]
fn a_duplicate_refuses_cues_out_of_their_order_or_named_twice() {
    let mut session = session("srt/clean/basic-lf.srt");
    let original = session.to_bytes();

    for cues in [vec![2, 0], vec![1, 1], Vec::new()] {
        let refused = session
            .apply(&Edit::Duplicate { cues }, Run::New, Instant::now())
            .expect_err("a refusal");
        assert_eq!(refused.kind, EditErrorKind::NotApplicable);
    }
    assert_eq!(session.to_bytes(), original, "a refusal writes nothing");
}

#[test]
fn a_playhead_split_keeps_the_whole_text_in_both_halves_and_one_undo_restores_it() {
    let mut session = session("srt/clean/basic-lf.srt");
    let original = session.to_bytes();
    let (start, end, text) = {
        let row = &session.views()[0];
        (row.start_ms, row.end_ms, row.text.clone())
    };
    let third = (end - start) / 3;

    session
        .apply(
            &Edit::SplitInTwo {
                cue: 0,
                first_end_ms: start + third,
                second_start_ms: start + third,
            },
            Run::New,
            Instant::now(),
        )
        .expect("the cue splits in two");

    let rows = session.views();
    assert_eq!(rows.len(), 4, "one cue became two, the other two untouched");
    assert_eq!(rows[0].text, text);
    assert_eq!(rows[1].text, text);
    assert_eq!((rows[0].start_ms, rows[0].end_ms), (start, start + third));
    assert_eq!((rows[1].start_ms, rows[1].end_ms), (start + third, end));

    session.undo().expect("undo").expect("a step");
    assert_eq!(
        session.to_bytes(),
        original,
        "one undo puts the single cue back"
    );
}

#[test]
fn a_playhead_split_may_leave_a_frame_edge_gap_between_the_halves() {
    let mut session = session("srt/clean/basic-lf.srt");
    let (start, end) = {
        let row = &session.views()[0];
        (row.start_ms, row.end_ms)
    };
    let (first_end, second_start) = (start + (end - start) / 3, start + 2 * (end - start) / 3);

    session
        .apply(
            &Edit::SplitInTwo {
                cue: 0,
                first_end_ms: first_end,
                second_start_ms: second_start,
            },
            Run::New,
            Instant::now(),
        )
        .expect("the cue splits with a gap");

    let rows = session.views();
    assert_eq!((rows[0].start_ms, rows[0].end_ms), (start, first_end));
    assert_eq!(
        (rows[1].start_ms, rows[1].end_ms),
        (second_start, end),
        "the second half starts past the first's end, with the frame edge between them"
    );
}

#[test]
fn a_playhead_split_refuses_a_boundary_outside_the_cue_or_a_crossed_pair() {
    let mut session = session("srt/clean/basic-lf.srt");
    let original = session.to_bytes();
    let (start, end) = {
        let row = &session.views()[0];
        (row.start_ms, row.end_ms)
    };
    let mid = (start + end) / 2;

    for (first_end_ms, second_start_ms) in [(end + 1, end + 1), (start, end + 1), (mid + 5, mid)] {
        let refused = session
            .apply(
                &Edit::SplitInTwo {
                    cue: 0,
                    first_end_ms,
                    second_start_ms,
                },
                Run::New,
                Instant::now(),
            )
            .expect_err("a refusal");
        assert_eq!(refused.kind, EditErrorKind::NotApplicable);
    }
    assert_eq!(session.to_bytes(), original, "a refusal writes nothing");
}

#[test]
fn a_paste_puts_the_lines_in_before_the_row_it_names() {
    let mut session = session("srt/clean/basic-lf.srt");
    let original = session.to_bytes();

    session
        .apply(
            &Edit::Paste {
                before: 2,
                fragment: TWO_SRT_BLOCKS.to_owned(),
            },
            Run::New,
            Instant::now(),
        )
        .expect("two blocks land");

    let rows = session.views();
    assert_eq!(rows.len(), 5, "three cues and the two that were pasted");
    assert_eq!(rows[2].text, "The harbour was empty when we got there.");
    assert_eq!(rows[3].start_ms, 5_000, "and their times came with them");
    assert_eq!(
        rows[4].text, "By then the fog had eaten the boats.",
        "the row they went in before is still after them"
    );

    session.undo().expect("undo").expect("a step");
    assert_eq!(session.to_bytes(), original, "one undo takes both back");
}

#[test]
fn a_paste_at_the_end_appends_and_keeps_the_blank_line_between_blocks() {
    let mut session = session("srt/clean/basic-lf.srt");

    session
        .apply(
            &Edit::Paste {
                before: 3,
                fragment: TWO_SRT_BLOCKS.to_owned(),
            },
            Run::New,
            Instant::now(),
        )
        .expect("two blocks land at the end");

    let text = String::from_utf8(session.to_bytes()).expect("still UTF-8");
    assert_eq!(session.views().len(), 5);
    assert!(
        text.contains("boats.\n\n1\n00:00:02,120"),
        "a blank line separates the last block from the first pasted one:\n{text}"
    );
}

#[test]
fn a_paste_keeps_the_fields_an_ass_event_carries() {
    let mut session = session("ass/clean/speakers.ass");
    let carried = {
        let rows = session.views();
        (rows[1].style.clone(), rows[1].actor.clone())
    };
    assert_ne!(carried.1, "", "the fixture's second event names a speaker");
    let line = String::from_utf8(session.to_bytes())
        .expect("still UTF-8")
        .lines()
        .filter(|line| line.starts_with("Dialogue:"))
        .nth(1)
        .expect("a second event")
        .to_owned();

    session
        .apply(
            &Edit::Paste {
                before: 0,
                fragment: format!("{line}\n"),
            },
            Run::New,
            Instant::now(),
        )
        .expect("the event lands");

    let rows = session.views();
    assert_eq!(rows[0].style, carried.0, "the style came with the line");
    assert_eq!(rows[0].actor, carried.1, "and so did the speaker");
}

#[test]
fn a_paste_into_a_script_with_no_events_lands_under_its_format_line() {
    let mut session = session("ass/clean/no-events.ass");
    assert_eq!(session.views().len(), 0, "the fixture has no events");

    session
        .apply(
            &Edit::Paste {
                before: 0,
                fragment: "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Pasted.\n".to_owned(),
            },
            Run::New,
            Instant::now(),
        )
        .expect("the event lands");

    let text = String::from_utf8(session.to_bytes()).expect("still UTF-8");
    assert_eq!(session.views().len(), 1);
    assert_eq!(session.views()[0].text, "Pasted.");
    // Under the section's own format line, which is what says the event went into `[Events]` and
    // not onto the end of a file whose last section is something else.
    let format_at = text.find("Format: Layer").expect("the events format line");
    let event_at = text.find("Dialogue:").expect("the pasted event");
    assert!(format_at < event_at, "the event follows the format line");
}

#[test]
fn a_paste_into_an_empty_srt_writes_the_only_block_it_has() {
    let mut session = session("srt/clean/empty.srt");
    assert_eq!(session.views().len(), 0, "the fixture has no cues");

    session
        .apply(
            &Edit::Paste {
                before: 0,
                fragment: "1\n00:00:01,000 --> 00:00:02,000\nPasted.\n".to_owned(),
            },
            Run::New,
            Instant::now(),
        )
        .expect("the block lands");

    assert_eq!(session.views().len(), 1);
    assert_eq!(session.views()[0].text, "Pasted.");
}

#[test]
fn a_paste_refuses_what_this_document_cannot_read() {
    let mut session = session("srt/clean/basic-lf.srt");
    let original = session.to_bytes();

    for fragment in ["", "not a cue at all\n"] {
        let refused = session
            .apply(
                &Edit::Paste {
                    before: 0,
                    fragment: fragment.to_owned(),
                },
                Run::New,
                Instant::now(),
            )
            .expect_err("a refusal");
        assert_eq!(refused.kind, EditErrorKind::NotApplicable);
    }
    assert_eq!(session.to_bytes(), original, "a refusal writes nothing");
}

#[test]
fn a_cut_takes_the_cues_it_names_and_leaves_the_one_between_them() {
    let mut session = session("srt/clean/basic-lf.srt");
    let original = session.to_bytes();
    let middle = session.views()[1].text.clone();

    session
        .apply(
            &Edit::DeleteMany { cues: vec![0, 2] },
            Run::New,
            Instant::now(),
        )
        .expect("the first and the last go");

    let rows = session.views();
    assert_eq!(rows.len(), 1, "the cue that was not named stays");
    assert_eq!(
        rows[0].text, middle,
        "and it is the one that was between them"
    );

    session.undo().expect("undo").expect("a step");
    assert_eq!(
        session.to_bytes(),
        original,
        "one undo puts both of them back"
    );
}

#[test]
fn a_cut_over_a_run_writes_the_file_the_rest_of_it_makes() {
    let mut session = session("srt/clean/basic-lf.srt");

    session
        .apply(
            &Edit::DeleteMany { cues: vec![0, 1] },
            Run::New,
            Instant::now(),
        )
        .expect("the first two go");

    // The bytes, not the row count: a delete that left the blank line of the block it removed
    // would read back as the same one cue and say nothing.
    assert_eq!(
        String::from_utf8(session.to_bytes()).expect("still UTF-8"),
        "3\n00:00:09,100 --> 00:00:11,760\nBy then the fog had eaten the boats.\n",
        "what is left is the last block and nothing else"
    );
}

#[test]
fn a_cut_in_an_ass_leaves_the_header_it_did_not_name() {
    let mut session = session("ass/clean/basic.ass");
    let header = String::from_utf8(session.to_bytes())
        .expect("still UTF-8")
        .split("[Events]")
        .next()
        .expect("a header before the events")
        .to_owned();

    session
        .apply(
            &Edit::DeleteMany { cues: vec![0, 1] },
            Run::New,
            Instant::now(),
        )
        .expect("the first two events go");

    let after = String::from_utf8(session.to_bytes()).expect("still UTF-8");
    assert_eq!(session.views().len(), 1, "one event is left");
    assert!(
        after.starts_with(&header),
        "every byte before the events is where it was:\n{after}"
    );
    assert_eq!(
        after.matches("Dialogue:").count(),
        1,
        "and only the event that was not named is written"
    );
}

#[test]
fn a_cut_refuses_cues_out_of_their_order_or_named_twice() {
    let mut session = session("srt/clean/basic-lf.srt");
    let original = session.to_bytes();

    for cues in [vec![2, 0], vec![1, 1], Vec::new()] {
        let refused = session
            .apply(&Edit::DeleteMany { cues }, Run::New, Instant::now())
            .expect_err("a refusal");
        assert_eq!(refused.kind, EditErrorKind::NotApplicable);
    }
    assert_eq!(session.to_bytes(), original, "a refusal writes nothing");
}

#[test]
fn every_mutation_kind_reaches_the_document_and_undoes_back_to_the_file() {
    let cases = [
        (
            "srt/clean/basic-lf.srt",
            Edit::Insert {
                before: 1,
                start_ms: 4_900,
                end_ms: 4_950,
                text: "Inserted".to_owned(),
            },
            1isize,
        ),
        ("srt/clean/basic-lf.srt", Edit::Delete { cue: 1 }, -1),
        (
            "srt/clean/basic-lf.srt",
            Edit::Duplicate { cues: vec![0, 1] },
            2,
        ),
        (
            "srt/clean/basic-lf.srt",
            Edit::Paste {
                before: 1,
                fragment: "9\n00:00:20,000 --> 00:00:21,000\nPasted.\n".to_owned(),
            },
            1,
        ),
        (
            "srt/clean/basic-lf.srt",
            Edit::DeleteMany { cues: vec![0, 1] },
            -2,
        ),
        (
            "srt/clean/basic-lf.srt",
            Edit::Split {
                cue: 0,
                text_offset: 5,
                at_ms: 3_000,
            },
            1,
        ),
        ("srt/clean/basic-lf.srt", Edit::Merge { cue: 0 }, -1),
        (
            "srt/clean/basic-lf.srt",
            Edit::Join {
                cues: vec![0, 1],
                keep_first_text: false,
            },
            -1,
        ),
        (
            "srt/clean/basic-lf.srt",
            Edit::SetTimes {
                cue: 0,
                start_ms: 2_500,
                end_ms: 4_500,
            },
            0,
        ),
        (
            "ass/clean/basic.ass",
            Edit::SetTimes {
                cue: 0,
                start_ms: 1_500,
                end_ms: 2_500,
            },
            0,
        ),
        (
            "vtt/clean/basic.vtt",
            Edit::Insert {
                before: 0,
                start_ms: 100,
                end_ms: 400,
                text: "Inserted".to_owned(),
            },
            1,
        ),
    ];

    for (relative, edit, delta) in cases {
        let mut session = session(relative);
        let original = session.to_bytes();
        let rows_before = session.views().len();

        session
            .apply(&edit, Run::New, Instant::now())
            .unwrap_or_else(|error| panic!("{relative} {edit:?}: {error}"));

        let rows_after = session.views().len();
        assert_eq!(
            rows_after as isize - rows_before as isize,
            delta,
            "{relative} {edit:?}: the row count moved by the wrong amount"
        );
        assert_ne!(session.to_bytes(), original, "{relative} {edit:?}");

        session
            .undo()
            .unwrap_or_else(|error| panic!("{relative} {edit:?}: undo refused: {error}"))
            .unwrap_or_else(|| panic!("{relative} {edit:?}: nothing to undo"));
        assert_eq!(
            session.to_bytes(),
            original,
            "{relative} {edit:?}: undo did not restore the file"
        );
        assert_eq!(session.views().len(), rows_before, "{relative} {edit:?}");
    }
}

#[test]
fn a_crlf_file_keeps_its_line_endings_and_the_wire_form_stays_normalized() {
    let mut session = session("srt/clean/basic-crlf.srt");
    session
        .apply(&set_text(0, "First\nSecond"), Run::New, Instant::now())
        .expect("two lines land");

    assert_eq!(
        session.views()[0].text,
        "First\nSecond",
        "the row the UI renders uses \\n whatever the file uses"
    );
    let bytes = session.to_bytes();
    let text = String::from_utf8(bytes).expect("still UTF-8");
    assert!(
        text.contains("First\r\nSecond"),
        "the file kept its CRLF endings: {text:?}"
    );
    assert!(
        !text.contains("First\nSecond"),
        "no LF-only break was written into a CRLF file"
    );
}

#[test]
fn the_rows_carry_what_the_file_wrote_and_nothing_is_renumbered() {
    let mut session = session("srt/clean/numbering-gaps.srt");
    let numbers: Vec<Option<u32>> = session.views().iter().map(|view| view.number).collect();
    assert!(
        numbers.iter().any(Option::is_some),
        "the fixture writes index lines"
    );

    session
        .apply(
            &Edit::Insert {
                before: 1,
                start_ms: 9_000,
                end_ms: 9_500,
                text: "Inserted".to_owned(),
            },
            Run::New,
            Instant::now(),
        )
        .expect("the insert lands");

    let after: Vec<Option<u32>> = session.views().iter().map(|view| view.number).collect();
    assert_eq!(
        after.first(),
        numbers.first(),
        "the cue before the insert kept its number"
    );
    assert_eq!(
        after.get(2..),
        numbers.get(1..),
        "no cue after the insert was renumbered"
    );
}

#[test]
fn an_ass_comment_is_listed_and_flagged() {
    let session = session("ass/clean/comments-and-semicolons.ass");
    assert!(
        session.views().iter().any(|view| view.comment),
        "a Comment: event is a row the editor lists"
    );
    assert!(
        session.views().iter().any(|view| !view.comment),
        "and a Dialogue: event is not flagged as one"
    );
}

#[test]
fn the_two_thousand_cue_fixture_opens_whole_and_patches_one_row() {
    let mut session = session("srt/clean/large-2000.srt");
    assert_eq!(session.views().len(), 2_000);

    let before = session.to_bytes();
    let (start, old_len) = text_region(&session, 42);
    let patch = session
        .apply(
            &set_text(42, "Edited by the cue list."),
            Run::New,
            Instant::now(),
        )
        .expect("editing row 42 lands");

    assert_eq!(patch.from, 42);
    assert_eq!(patch.removed, 1);
    assert_eq!(patch.cues.len(), 1, "one row crosses the wire, not 2000");
    differs_only_in(
        &before,
        &session.to_bytes(),
        start,
        old_len,
        "Edited by the cue list.".len(),
    );
}

#[test]
fn committing_an_unchanged_field_is_not_an_edit() {
    let mut session = session("srt/clean/basic-lf.srt");
    let original = session.to_bytes();
    let unchanged = session.views().first().expect("a first row").text.clone();

    // The UI commits a field on Enter and on blur, whether or not anything was typed into it.
    let patch = session
        .apply(&set_text(0, &unchanged), Run::New, Instant::now())
        .expect("re-sending the same text is accepted");

    assert_eq!(patch.removed, 0, "nothing was replaced");
    assert!(patch.cues.is_empty(), "so nothing crosses the wire");
    assert_eq!(session.to_bytes(), original);
    assert_eq!(session.revision(), 0, "nothing moved, nothing to refetch");
    assert!(!session.dirty(), "closing a field is not unsaved work");
    assert!(!session.can_undo(), "and it is not an undo step either");
}

#[test]
fn undo_and_redo_each_move_the_revision_and_a_no_step_call_does_not() {
    let mut session = session("srt/clean/basic-lf.srt");

    session
        .apply(&set_text(0, "Once"), Run::New, Instant::now())
        .expect("the edit lands");
    assert_eq!(session.revision(), 1);
    session.undo().expect("undo").expect("a step");
    assert_eq!(session.revision(), 2, "an undo changes the list too");
    session.redo().expect("redo").expect("a step");
    assert_eq!(session.revision(), 3);

    assert!(session.redo().expect("the top").is_none());
    assert_eq!(
        session.revision(),
        3,
        "a call that replayed nothing must not invalidate the caller's revision"
    );
}

#[test]
fn the_patch_of_an_undone_insert_removes_the_row_it_added() {
    let mut session = session("srt/clean/basic-lf.srt");

    let inserted = session
        .apply(
            &Edit::Insert {
                before: 1,
                start_ms: 4_900,
                end_ms: 4_950,
                text: "Wedged in".to_owned(),
            },
            Run::New,
            Instant::now(),
        )
        .expect("the insert lands");
    assert_eq!(inserted.from, 1);
    assert_eq!(inserted.removed, 0);
    assert_eq!(inserted.cues.len(), 1);

    // Undo carries no plan, so its patch is measured from the lists: same run, mirrored.
    let undone = session.undo().expect("undo").expect("a step");
    assert_eq!(undone.from, 1);
    assert_eq!(undone.removed, 1);
    assert!(undone.cues.is_empty());
    assert_eq!(session.views().len(), 3);
}

#[test]
fn a_non_latin_edit_survives_the_round_trip_byte_for_byte() {
    let mut session = session("srt/clean/non-latin.srt");
    let original = session.to_bytes();
    // Combining marks, RTL, CJK and an astral pair: the shapes a byte-offset bug mangles first.
    let planted = "Ολοκληρώθηκε · 完了 · مكتمل · éé\u{0301} · 🎬";

    session
        .apply(&set_text(1, planted), Run::New, Instant::now())
        .expect("the edit lands");
    assert_eq!(session.views()[1].text, planted);
    assert!(String::from_utf8(session.to_bytes())
        .expect("still UTF-8")
        .contains(planted));

    session.undo().expect("undo").expect("a step");
    assert_eq!(session.to_bytes(), original, "undo is exact through UTF-8");
}

#[test]
fn no_row_the_ui_renders_carries_a_line_terminator_the_textarea_would_eat() {
    // A textarea reads back "\n" whatever it was given, so a "\r\n" on the wire would come back
    // as "\n" and quietly convert that cue's endings. A lone "\r" is content to the parsers, so
    // it is not a terminator and must survive untouched. See BACKLOG.md M2.1.
    for relative in [
        "srt/clean/basic-crlf.srt",
        "srt/clean/bom-crlf.srt",
        "srt/clean/mixed-eol.srt",
        "vtt/clean/header-text-crlf.vtt",
    ] {
        let session = session(relative);
        assert!(
            session
                .views()
                .iter()
                .all(|view| !view.text.contains("\r\n")),
            "{relative}: a row reached the UI with a CRLF in it"
        );
    }

    let carried = session("srt/clean/mixed-eol.srt");
    assert!(
        carried.views().iter().any(|view| view.text.contains('\r')),
        "the lone carriage return this fixture plants is content, and stays content"
    );
}

#[test]
fn sixty_edits_across_the_large_fixture_undo_all_the_way_back() {
    let mut session = session("srt/clean/large-2000.srt");
    let original = session.to_bytes();
    let mut now = Instant::now();

    // Far apart in time and in cue, so nothing coalesces: sixty distinct entries.
    for step in 0..60usize {
        session
            .apply(&set_text(step * 7, &format!("Line {step}")), Run::New, now)
            .unwrap_or_else(|error| panic!("step {step}: {error}"));
        now += APART;
    }
    assert!(session.dirty());

    let mut undone = 0;
    while session.undo().expect("undo replays").is_some() {
        undone += 1;
    }
    assert_eq!(undone, 60, "one step per edit");
    assert_eq!(session.to_bytes(), original, "back to the file as opened");
    assert!(!session.dirty());
    assert!(!session.truncated(), "sixty is well inside the bound");
}

#[test]
fn a_document_with_no_file_is_unsaved_from_the_first_moment_and_edits_like_any_other() {
    let mut session = EditSession::untitled(document("srt/clean/basic-lf.srt"));

    assert_eq!(session.path(), None, "it has never had a file");
    assert!(
        session.dirty(),
        "every byte of it exists only here, so it is unsaved work"
    );
    assert!(!session.can_undo());
    assert!(!session.truncated());
    assert_eq!(session.views().len(), 3);

    let original = session.to_bytes();
    session
        .apply(&set_text(0, "Corrected"), Run::New, Instant::now())
        .expect("the same mutation API as a file-backed session");
    assert_eq!(texts(&session)[0], "Corrected");
    assert!(session.undo().expect("undo replays").is_some());
    assert_eq!(
        session.to_bytes(),
        original,
        "the same undo the editor uses"
    );

    // Still unsaved at the bottom of the stack: undoing back does not put bytes on a disk.
    assert!(session.dirty());
    session.mark_saved();
    assert!(!session.dirty(), "a write is what makes it saved");
}

#[test]
fn a_document_with_no_file_keeps_the_path_its_first_save_gave_it() {
    let mut session = EditSession::untitled(document("srt/clean/basic-lf.srt"));
    assert_eq!(session.path(), None);

    // What the first save adopts, so every save after it writes there (decision 24, B2).
    session.adopt_path(PathBuf::from("/tmp/episode-01.srt"));
    assert_eq!(session.path(), Some(Path::new("/tmp/episode-01.srt")));

    // Editing after the adoption does not take the file away again.
    session
        .apply(&set_text(0, "Corrected"), Run::New, Instant::now())
        .expect("the same mutation API");
    assert!(session.dirty());
    assert_eq!(session.path(), Some(Path::new("/tmp/episode-01.srt")));
}

// F1 at the session level: what a replace over many cues costs the undo stack. One step, whatever
// the count, because a replace the user has to press through cue by cue is not undone.

#[test]
fn one_undo_puts_back_every_cue_a_many_cue_edit_rewrote() {
    let original = fixture_bytes("srt/clean/basic-lf.srt");
    let mut session = session("srt/clean/basic-lf.srt");
    let now = Instant::now();

    session
        .apply(
            &Edit::SetTexts {
                edits: vec![
                    (0, "one".to_owned()),
                    (1, "two".to_owned()),
                    (2, "three".to_owned()),
                ],
            },
            Run::New,
            now,
        )
        .expect("three cues at once");
    assert!(session.dirty());
    assert!(session.can_undo());

    let patch = session
        .undo()
        .expect("the replay lands")
        .expect("there is a step to take");
    // The patch covers the whole run, so the grid redraws all three rather than one of them.
    assert_eq!(patch.from, 0);
    assert_eq!(patch.removed, 3);
    assert_eq!(session.to_bytes(), original);
    // One step, not three: a second undo has nothing left to take.
    assert!(!session.can_undo());
}

#[test]
fn a_many_cue_edit_that_writes_the_text_already_there_leaves_the_stack_alone() {
    let original = fixture_bytes("srt/clean/basic-lf.srt");
    let mut session = session("srt/clean/basic-lf.srt");
    let already: Vec<_> = session
        .views()
        .iter()
        .enumerate()
        .map(|(cue, view)| (cue, view.text.clone()))
        .collect();

    let patch = session
        .apply(&Edit::SetTexts { edits: already }, Run::New, Instant::now())
        .expect("writing what is already there is not a failure");

    // A replace whose matches all render back to the same bytes changed nothing, and a step the
    // user would press through for no reason is worse than no step.
    assert_eq!(patch.removed, 0);
    assert!(patch.cues.is_empty());
    assert!(!session.dirty());
    assert!(!session.can_undo());
    assert_eq!(session.to_bytes(), original);
}

#[test]
fn a_many_cue_edit_never_merges_into_the_keystroke_before_it() {
    let mut session = session("srt/clean/basic-lf.srt");
    let now = Instant::now();

    session
        .apply(
            &Edit::SetText {
                cue: 0,
                text: "typed".to_owned(),
            },
            Run::New,
            now,
        )
        .expect("a first edit");
    session
        .apply(
            &Edit::SetTexts {
                edits: vec![(0, "replaced".to_owned())],
            },
            // Inside the coalesce window and on the same cue: everything the history looks at to
            // merge, except the label, which is what keeps the two apart.
            Run::Continues,
            now + KEYSTROKE,
        )
        .expect("a replace over the same cue");

    session.undo().expect("the replay lands").expect("a step");
    let views = session.views();
    assert_eq!(
        views.first().map(|view| view.text.as_str()),
        Some("typed"),
        "one undo must take back the replace and leave the typing under it"
    );
}

// ---------------------------------------------------------------------------------------------
// Writing one ASS event field (docs/ass-field-write-tasks.md CF4)
// ---------------------------------------------------------------------------------------------

fn set_field(cue: usize, field: AssField, value: &str) -> Edit {
    Edit::SetField {
        cues: vec![cue],
        field,
        value: value.to_owned(),
    }
}

/// The style of one cue as the file spells it.
fn style_of(session: &EditSession, cue: usize) -> String {
    let document = session.document();
    let found = document.cues().nth(cue).expect("the cue is there");
    match &found.detail {
        CueDetail::Ass(event) => {
            let at = event
                .field_index(AssField::Style)
                .expect("the fixture declares Style");
            document.slice(event.fields[at]).trim().to_owned()
        }
        _ => panic!("the fixture is ASS"),
    }
}

#[test]
fn one_field_write_reaches_every_named_cue_and_undoes_in_one_step() {
    // N148: the owner's answer 46. Cues 0 and 2 are named and cue 1 is not, so the splice spans
    // all three and the one in the middle has to come back byte for byte.
    let mut session = session("ass/clean/speakers.ass");
    let original = fixture_bytes("ass/clean/speakers.ass");
    let untouched = style_of(&session, 1);

    session
        .apply(
            &Edit::SetField {
                cues: vec![0, 2],
                field: AssField::Style,
                value: "Sign".to_owned(),
            },
            Run::New,
            Instant::now(),
        )
        .expect("both cues declare Style");

    assert_eq!(
        style_of(&session, 0),
        "Sign",
        "the first named cue is written"
    );
    assert_eq!(
        style_of(&session, 2),
        "Sign",
        "the last named cue is written"
    );
    assert_eq!(
        style_of(&session, 1),
        untouched,
        "the cue between them was not named and must not move"
    );

    session
        .undo()
        .expect("the step replays")
        .expect("there is a step");
    assert_eq!(
        session.to_bytes(),
        original,
        "one gesture is one undo step however many cues it wrote"
    );
}

#[test]
fn a_field_write_naming_no_cue_is_refused() {
    let mut session = session("ass/clean/speakers.ass");
    let error = session
        .apply(
            &Edit::SetField {
                cues: Vec::new(),
                field: AssField::Style,
                value: "Sign".to_owned(),
            },
            Run::New,
            Instant::now(),
        )
        .expect_err("a write with no cue behind it has nothing to do");
    assert_eq!(error.kind, EditErrorKind::NotApplicable);
}

#[test]
fn a_field_write_out_of_order_is_refused_rather_than_sorted() {
    // A caller bug, not something to repair here: an unordered list would build the span out of
    // order and a repeated cue would put two writes over one range.
    let mut session = session("ass/clean/speakers.ass");
    for cues in [vec![2, 0], vec![1, 1]] {
        let error = session
            .apply(
                &Edit::SetField {
                    cues,
                    field: AssField::Style,
                    value: "Sign".to_owned(),
                },
                Run::New,
                Instant::now(),
            )
            .expect_err("the cues must be ascending and each named once");
        assert_eq!(error.kind, EditErrorKind::NotApplicable);
    }
}

#[test]
fn two_fields_of_one_cue_are_two_undo_steps() {
    // CF4.1 and CF4.2. The field is on the undo label, so an Actor write and an Effect write on
    // the same cue cannot merge even when they land inside the coalescing window.
    let mut session = session("ass/clean/basic.ass");
    let original = fixture_bytes("ass/clean/basic.ass");
    let now = Instant::now();

    session
        .apply(&set_field(0, AssField::Actor, "Ingrid"), Run::New, now)
        .expect("the Name field is declared");
    session
        .apply(
            &set_field(0, AssField::Effect, "fad"),
            Run::Continues,
            now + KEYSTROKE,
        )
        .expect("the Effect field is declared");
    session
        .apply(&set_text(0, "Rewritten."), Run::Continues, now + KEYSTROKE)
        .expect("the text is editable");

    for step in 0..3 {
        session
            .undo()
            .unwrap_or_else(|error| panic!("undo {step} must replay: {error}"))
            .unwrap_or_else(|| panic!("undo {step} must find a step"));
    }
    assert_eq!(
        session.to_bytes(),
        original,
        "three writes must take three undos to take back"
    );
    assert!(
        !session.can_undo(),
        "the stack must hold exactly three steps"
    );
    assert!(!session.dirty(), "undoing back to the open bytes is clean");
}

#[test]
fn committing_a_field_unchanged_never_grows_the_undo_stack() {
    // CF4.4: a translator tabbing through the panel without typing leaves the file as they found
    // it, because the trimmed core makes an unchanged commit byte-identical.
    let mut session = session("ass/clean/basic.ass");
    let original = fixture_bytes("ass/clean/basic.ass");
    let now = Instant::now();

    for field in AssField::ALL {
        let current = session
            .views()
            .first()
            .map(|view| match field {
                AssField::Style => view.style.clone(),
                AssField::Actor => view.actor.clone(),
                // B5 has not landed, so the panel cannot read these five back yet; the file's own
                // bytes stand in for what it would show.
                _ => raw_core(&session, 0, field),
            })
            .expect("a first row");
        let patch = session
            .apply(&set_field(0, field, &current), Run::New, now + APART)
            .unwrap_or_else(|error| panic!("{field:?} must be committable: {error}"));
        assert_eq!(patch.cues.len(), 0, "{field:?} changed a row");
    }

    assert!(!session.can_undo(), "no step was recorded");
    assert!(!session.dirty(), "the document was never dirtied");
    assert_eq!(session.revision(), 0, "the revision never moved");
    assert_eq!(session.to_bytes(), original);
}

#[test]
fn a_field_committed_as_whitespace_writes_nothing_however_often_it_is_committed() {
    // The panel reads a field through the trim `field_core` applies, so a value that is only
    // padding displays as empty. Written verbatim it landed outside the core and appended a byte
    // and an undo step on every commit, which a combo committing on blur would do every time.
    let mut session = session("ass/clean/basic.ass");
    let original = fixture_bytes("ass/clean/basic.ass");
    let now = Instant::now();

    // Spaces only: a tab inside a value is refused outright (CF3.6), padding or not.
    for (round, value) in [" ", "  ", "   ", "    "].into_iter().enumerate() {
        let patch = session
            .apply(
                &set_field(0, AssField::Actor, value),
                Run::New,
                now + APART * (round as u32 + 1),
            )
            .unwrap_or_else(|error| panic!("round {round} must be committable: {error}"));
        assert_eq!(patch.cues.len(), 0, "round {round} changed a row");
        assert_eq!(
            session.to_bytes(),
            original,
            "round {round} moved a byte of the file"
        );
    }

    assert!(!session.can_undo(), "no step was recorded");
    assert!(!session.dirty(), "the document was never dirtied");
    assert_eq!(session.revision(), 0, "the revision never moved");

    // The other half of the same rule: a value that has anything in it keeps its own padding,
    // because a style may genuinely be named with one (C5.2).
    session
        .apply(
            &set_field(0, AssField::Actor, "Bo "),
            Run::New,
            now + APART * 9,
        )
        .expect("a padded value is writable");
    // On the file's own bytes, not through `raw_core`, which trims the space back off: that the
    // panel cannot show the difference is W4's accepted consequence, but the file must hold it.
    let bytes = String::from_utf8(session.to_bytes()).expect("the fixture is UTF-8");
    assert!(
        bytes.contains("Default,Bo ,0,0,0,"),
        "the value's own trailing space was trimmed on the way out"
    );
}

/// One tag written at a caret, which is the list of one the pickers send when nothing else goes
/// with it: a colour with no transparency beside it, or a style flag's own value.
fn set_override_tag(cue: usize, tag: &str, value: &str, at: usize) -> Edit {
    Edit::SetOverrideTags {
        cue,
        tags: vec![(tag.to_owned(), value.to_owned())],
        at,
    }
}

#[test]
fn a_tag_with_a_chosen_value_is_written_where_the_caret_is() {
    // B12: a colour is picked rather than flipped, so the value comes from the caller.
    let mut session = session("ass/clean/basic.ass");
    let text = raw_text(&session, 0);
    session
        .apply(
            &set_override_tag(0, "\\c", "&H0000FF&", 0),
            Run::New,
            Instant::now(),
        )
        .expect("an ASS event takes an override tag");
    assert_eq!(raw_text(&session, 0), format!("{{\\c&H0000FF&}}{text}"));

    session.undo().expect("a step to undo").expect("a patch");
    assert_eq!(raw_text(&session, 0), text);
}

#[test]
fn clearing_a_line_empties_it_and_clearing_its_text_leaves_the_braced_runs_where_they_were() {
    // B13: the reference's two clears differ in exactly this, and nothing else.
    let mut session = session("ass/clean/basic.ass");
    session
        .apply(
            &Edit::SetText {
                cue: 0,
                text: "{\\b1}bold{\\b0} and {note} plain".to_owned(),
            },
            Run::New,
            Instant::now(),
        )
        .expect("a line to clear");

    session
        .apply(
            &Edit::ClearText {
                cue: 0,
                keep_tags: true,
            },
            Run::New,
            Instant::now(),
        )
        .expect("clear text is applied");
    assert_eq!(raw_text(&session, 0), "{\\b1}{\\b0}{note}");

    session
        .apply(
            &Edit::ClearText {
                cue: 0,
                keep_tags: false,
            },
            Run::New,
            Instant::now(),
        )
        .expect("clear is applied");
    assert_eq!(raw_text(&session, 0), "");

    // Two clears are two steps, so the words come back one undo at a time.
    session.undo().expect("a step").expect("a patch");
    assert_eq!(raw_text(&session, 0), "{\\b1}{\\b0}{note}");
}

#[test]
fn a_numbered_colour_replaces_the_one_already_in_the_block_rather_than_joining_it() {
    // B12: `\\2c` is one name, so a second pick of the same colour is not a second tag.
    let mut session = session("ass/clean/basic.ass");
    let text = raw_text(&session, 0);
    for value in ["&H0000FF&", "&H00FF00&"] {
        session
            .apply(
                &set_override_tag(0, "\\2c", value, 0),
                Run::New,
                Instant::now(),
            )
            .expect("an ASS event takes a numbered colour");
    }
    assert_eq!(raw_text(&session, 0), format!("{{\\2c&H00FF00&}}{text}"));
}

#[test]
fn two_tags_written_at_one_caret_land_beside_each_other_and_undo_together() {
    // A font picker names the family and the size, which is one thing a translator did.
    let mut session = session("ass/clean/basic.ass");
    let text = raw_text(&session, 0);
    session
        .apply(
            &Edit::SetOverrideTags {
                cue: 0,
                tags: vec![
                    ("\\fn".to_owned(), "Gentium Book".to_owned()),
                    ("\\fs".to_owned(), "48".to_owned()),
                ],
                at: 0,
            },
            Run::New,
            Instant::now(),
        )
        .expect("two tags at one caret");
    assert_eq!(
        raw_text(&session, 0),
        format!("{{\\fnGentium Book\\fs48}}{text}")
    );

    // One step, not two: the second undo has nothing to take back.
    session.undo().expect("a step to undo").expect("a patch");
    assert_eq!(raw_text(&session, 0), text);
    assert!(!session.can_undo(), "the pair was one step");
}

#[test]
fn two_tags_written_where_a_note_stands_stay_in_one_block() {
    // A tag written at a caret sitting on a note goes in front of the note, and the second one has
    // to join the first rather than opening a block of its own: one pick is one block, wherever the
    // caret was. B12.
    let mut session = session("ass/clean/basic.ass");
    session
        .apply(
            &Edit::SetText {
                cue: 0,
                text: "{note}word".to_owned(),
            },
            Run::New,
            Instant::now(),
        )
        .expect("a line whose braced run is a note");

    session
        .apply(
            &Edit::SetOverrideTags {
                cue: 0,
                tags: vec![
                    ("\\fn".to_owned(), "Gentium".to_owned()),
                    ("\\fs".to_owned(), "48".to_owned()),
                ],
                at: 6,
            },
            Run::New,
            Instant::now(),
        )
        .expect("two tags at a caret sitting on a note");
    assert_eq!(raw_text(&session, 0), "{\\fnGentium\\fs48}{note}word");
}

#[test]
fn a_style_field_is_written_where_the_parser_found_it_and_no_cue_moves() {
    let mut session = session("ass/clean/basic.ass");
    let before = session.to_bytes();
    let texts_before = texts(&session);

    session
        .apply(
            &Edit::SetStyleField {
                style: 0,
                field: AssStyleField::Fontname,
                value: "Gentium Book".to_owned(),
            },
            Run::New,
            Instant::now(),
        )
        .expect("a declared style takes a font");
    let after = session.to_bytes();
    assert_ne!(after, before, "the style line changed");
    assert!(
        String::from_utf8_lossy(&after).contains("Gentium Book"),
        "the font is in the file"
    );
    // Not one cue moved: that is what the plan asserts and it is what a style write must never do.
    assert_eq!(texts(&session), texts_before);

    session.undo().expect("a step to undo").expect("a patch");
    assert_eq!(session.to_bytes(), before, "undo restores the bytes");
}

#[test]
fn a_style_field_refuses_a_comma_a_break_and_a_flag_that_is_neither_on_nor_off() {
    let mut session = session("ass/clean/basic.ass");
    let before = session.to_bytes();
    for (field, value) in [
        (AssStyleField::Fontname, "Gentium, Book"),
        (AssStyleField::Fontname, "Gentium\nBook"),
        (AssStyleField::Fontname, " Gentium"),
        (AssStyleField::Bold, "1"),
        (AssStyleField::Bold, "yes"),
    ] {
        session
            .apply(
                &Edit::SetStyleField {
                    style: 0,
                    field,
                    value: value.to_owned(),
                },
                Run::New,
                Instant::now(),
            )
            .expect_err("the value cannot be written into a style line");
    }
    assert_eq!(session.to_bytes(), before, "a refusal writes nothing");
}

#[test]
fn a_style_the_document_does_not_declare_is_refused() {
    let mut session = session("ass/clean/basic.ass");
    session
        .apply(
            &Edit::SetStyleField {
                style: 99,
                field: AssStyleField::Fontname,
                value: "Gentium".to_owned(),
            },
            Run::New,
            Instant::now(),
        )
        .expect_err("there is no style 99");
}

#[test]
fn a_list_with_one_bad_tag_in_it_writes_none_of_them() {
    let mut session = session("ass/clean/basic.ass");
    let before = session.to_bytes();
    session
        .apply(
            &Edit::SetOverrideTags {
                cue: 0,
                tags: vec![
                    ("\\fn".to_owned(), "Gentium Book".to_owned()),
                    ("\\fs".to_owned(), "48}x{".to_owned()),
                ],
                at: 0,
            },
            Run::New,
            Instant::now(),
        )
        .expect_err("a value that could close the block refuses the whole list");
    assert_eq!(session.to_bytes(), before, "a refusal writes nothing");
}

#[test]
fn a_tag_name_that_is_not_a_name_and_a_value_that_could_close_a_block_are_both_refused() {
    let mut session = session("ass/clean/basic.ass");
    let before = session.to_bytes();
    for (tag, value) in [("c", "&H0&"), ("\\1c1", "&H0&"), ("\\c", "&H0&}x{\\b1")] {
        session
            .apply(
                &set_override_tag(0, tag, value, 0),
                Run::New,
                Instant::now(),
            )
            .expect_err("neither a bare name nor a value carrying a brace is written");
    }
    assert_eq!(session.to_bytes(), before, "a refusal writes nothing");
}

fn toggle_style(cue: usize, flag: StyleFlag, from: usize, to: usize) -> Edit {
    Edit::ToggleStyle {
        cue,
        flag,
        from,
        to,
    }
}

/// The text of one cue as the file spells it, braces included.
fn raw_text(session: &EditSession, cue: usize) -> String {
    let document = session.document();
    let found = document.cues().nth(cue).expect("the cue is there");
    document.slice(found.text).to_owned()
}

#[test]
fn a_style_toggle_over_a_selection_wraps_it_and_leaves_the_rest_alone() {
    // B11: the flag is off in the style, so the selection is turned on and turned back off at its
    // far end, which is what the writer's shift is for.
    let mut session = session("ass/clean/basic.ass");
    let text = raw_text(&session, 0);
    let at = text
        .find("harbour")
        .expect("the fixture's first line holds it");
    session
        .apply(
            &toggle_style(0, StyleFlag::Bold, at, at + 7),
            Run::New,
            Instant::now(),
        )
        .expect("an ASS event takes an override tag");
    assert_eq!(
        raw_text(&session, 0),
        format!("{}{{\\b1}}harbour{{\\b0}}{}", &text[..at], &text[at + 7..])
    );

    session.undo().expect("a step to undo").expect("a patch");
    assert_eq!(raw_text(&session, 0), text, "one undo puts the line back");
}

#[test]
fn a_style_toggle_at_a_caret_writes_one_tag_and_no_closing_one() {
    let mut session = session("ass/clean/basic.ass");
    let text = raw_text(&session, 0);
    session
        .apply(
            &toggle_style(0, StyleFlag::Italic, 0, 0),
            Run::New,
            Instant::now(),
        )
        .expect("an ASS event takes an override tag");
    assert_eq!(raw_text(&session, 0), format!("{{\\i1}}{text}"));
}

#[test]
fn a_second_toggle_of_the_same_flag_turns_it_off_again() {
    let mut session = session("ass/clean/basic.ass");
    let text = raw_text(&session, 0);
    let now = Instant::now();
    session
        .apply(&toggle_style(0, StyleFlag::Bold, 0, 0), Run::New, now)
        .expect("the first toggle turns it on");
    assert_eq!(raw_text(&session, 0), format!("{{\\b1}}{text}"));
    session
        .apply(
            &toggle_style(0, StyleFlag::Bold, 5, 5),
            Run::New,
            now + APART,
        )
        .expect("the second reads the tag already there");
    // The caret is inside the block the first write made, so the tag is replaced where it stood
    // rather than a second one being added.
    assert_eq!(raw_text(&session, 0), format!("{{\\b0}}{text}"));
}

#[test]
fn a_style_toggle_is_refused_outside_the_cue_and_writes_nothing() {
    let mut session = session("ass/clean/basic.ass");
    let before = session.to_bytes();
    session
        .apply(
            &toggle_style(0, StyleFlag::Bold, 0, 9999),
            Run::New,
            Instant::now(),
        )
        .expect_err("a range past the end of the text is refused");
    assert_eq!(session.to_bytes(), before, "a refusal writes nothing");
}

fn set_comment(cue: usize, comment: bool) -> Edit {
    Edit::SetComment {
        cues: vec![cue],
        comment,
    }
}

#[test]
fn turning_a_line_into_a_comment_rewrites_its_descriptor_and_nothing_else() {
    // B8: the word before the colon is the whole edit, and a player draws one line fewer for it.
    let mut session = session("ass/clean/basic.ass");
    let before = session.to_bytes();
    let drawn = session.document().displayed_cue_count();

    session
        .apply(&set_comment(0, true), Run::New, Instant::now())
        .expect("an ASS event can be commented");
    let after = String::from_utf8(session.to_bytes()).expect("the fixture is UTF-8");
    assert!(
        after.contains("Comment: ") && !after.starts_with("Comment:"),
        "the first event line now says Comment"
    );
    assert_eq!(
        session.document().displayed_cue_count(),
        drawn - 1,
        "a commented line is not one a player draws"
    );
    // Only the descriptor moved: Dialogue is eight bytes and Comment is seven, so the file is one
    // byte shorter and identical on both sides of that word.
    let at = String::from_utf8(before.clone())
        .expect("the fixture is UTF-8")
        .find("Dialogue:")
        .expect("the fixture has an event line");
    differs_only_in(&before, session.to_bytes().as_slice(), at, 8, 7);

    session.undo().expect("a step to undo").expect("a patch");
    assert_eq!(
        session.to_bytes(),
        before,
        "one undo puts the descriptor back"
    );
}

#[test]
fn a_comment_edit_is_refused_on_a_format_that_has_no_descriptor() {
    let mut session = session("srt/clean/basic-lf.srt");
    let before = session.to_bytes();
    session
        .apply(&set_comment(0, true), Run::New, Instant::now())
        .expect_err("an SRT cue has no descriptor to rewrite");
    assert_eq!(session.to_bytes(), before, "a refusal writes nothing");
}

#[test]
fn a_field_write_after_a_save_leaves_the_document_clean_when_undone() {
    // CF4.3.
    let mut session = session("ass/clean/basic.ass");
    session.mark_saved();
    session
        .apply(
            &set_field(0, AssField::Actor, "Ingrid"),
            Run::New,
            Instant::now(),
        )
        .expect("the Name field is declared");
    assert!(session.dirty());
    session.undo().expect("a step to undo").expect("a patch");
    assert!(!session.dirty(), "undoing back to the save point is clean");
}

/// One field of one cue as the file spells it, trimmed the way a column renders it.
fn raw_core(session: &EditSession, cue: usize, field: AssField) -> String {
    let document = session.document();
    let Some(sublore_formats::CueDetail::Ass(event)) =
        document.cues().nth(cue).map(|cue| &cue.detail)
    else {
        panic!("cue {cue} is not an ASS event");
    };
    let Some(span) = event
        .field_index(field)
        .and_then(|at| event.fields.get(at).copied())
    else {
        panic!("cue {cue} declares no {field:?}");
    };
    document
        .slice(span)
        .trim_start_matches([' ', '\t'])
        .trim_end_matches([' ', '\t', '\r'])
        .to_owned()
}

/// A file with a `Format:` line and no event under it takes its first one.
///
/// Until this was written the planner refused: it built every new ASS line by copying a neighbour,
/// and an empty section has no neighbour to copy. What the line has to look like is on the section's
/// own `Format:` line, so that is what it is written from.
#[test]
fn an_empty_events_section_takes_its_first_line() {
    let mut session = session("ass/clean/no-events.ass");
    let before = session.to_bytes();
    session
        .apply(
            &Edit::Insert {
                before: 0,
                start_ms: 1_340,
                end_ms: 3_980,
                text: "The first line of the file".to_owned(),
            },
            Run::New,
            Instant::now(),
        )
        .expect("the first line of an empty section");

    let written = String::from_utf8(session.to_bytes()).expect("the file stays UTF-8");
    let line = written
        .lines()
        .find(|line| line.starts_with("Dialogue:"))
        .expect("a dialogue line");
    // Every column the `Format:` line declares, in its order: the timings where they were declared,
    // the declared style named, zeros where a number is owed and the text last.
    assert_eq!(
        line,
        "Dialogue: 0,0:00:01.34,0:00:03.98,Default,,0,0,0,,The first line of the file",
    );
    assert_eq!(session.views().len(), 1);

    session.undo().expect("one undo");
    assert_eq!(session.to_bytes(), before, "the undo puts the file back");
}

/// The line goes under the `Format:` line it was written from, not at the end of the file: an
/// `[Events]` section is not always the last one, and a line after another section's header is in
/// that section.
#[test]
fn the_first_line_goes_inside_its_own_section() {
    let mut session = session("ass/clean/events-then-fonts.ass");
    session
        .apply(
            &Edit::Insert {
                before: 0,
                start_ms: 0,
                end_ms: 5_000,
                text: "Inside the events".to_owned(),
            },
            Run::New,
            Instant::now(),
        )
        .expect("the first line");
    let written = String::from_utf8(session.to_bytes()).expect("the file stays UTF-8");
    let lines: Vec<&str> = written.lines().collect();
    let event = lines
        .iter()
        .position(|line| line.starts_with("Dialogue:"))
        .expect("a dialogue line");
    let fonts = lines
        .iter()
        .position(|line| *line == "[Fonts]")
        .expect("the fonts section");
    assert!(
        event < fonts,
        "the line landed outside its own section:\n{written}"
    );
    // And the file still parses as one event, which is the whole of what "inside" means here.
    assert_eq!(session.views().len(), 1);
}

/// Several cues retimed in one step, and one undo takes all of them back.
///
/// The check that matters is the one in the middle: the cue between the two that moved is named in
/// the expectation and has to come back unchanged, because the splice replaced the bytes it sits in.
#[test]
fn many_cues_are_retimed_as_one_undo_step() {
    let mut session = session("srt/clean/basic-lf.srt");
    let before = session.to_bytes();
    let untouched = session.views()[1].clone();

    session
        .apply(
            &Edit::SetManyTimes {
                edits: vec![(0, 1_000, 2_000), (2, 30_000, 31_500)],
            },
            Run::New,
            Instant::now(),
        )
        .expect("two cues retimed");

    let views = session.views();
    assert_eq!((views[0].start_ms, views[0].end_ms), (1_000, 2_000));
    assert_eq!((views[2].start_ms, views[2].end_ms), (30_000, 31_500));
    assert_eq!(views[1], untouched, "the cue between them moved");

    session.undo().expect("one undo");
    assert_eq!(session.to_bytes(), before, "one step, not two");
}

/// The three refusals: cues out of order, a cue named twice, and a start after its end.
#[test]
fn a_timing_edit_refuses_what_it_cannot_write() {
    let mut session = session("srt/clean/basic-lf.srt");
    for edits in [
        vec![(2, 1_000, 2_000), (0, 3_000, 4_000)],
        vec![(1, 1_000, 2_000), (1, 3_000, 4_000)],
        vec![(0, 5_000, 1_000)],
    ] {
        let refused = session
            .apply(&Edit::SetManyTimes { edits }, Run::New, Instant::now())
            .expect_err("a refusal");
        assert_eq!(refused.kind, EditErrorKind::NotApplicable);
    }
}
#[test]
fn a_reorder_writes_the_run_in_the_order_given_and_the_times_travel() {
    let mut session = session("srt/clean/basic-lf.srt");
    let original = session.to_bytes();
    let before: Vec<(String, u32, u32)> = session
        .views()
        .iter()
        .map(|row| (row.text.clone(), row.start_ms, row.end_ms))
        .collect();

    // Swap the last two cues: the run 1..=2 comes back as [2, 1].
    session
        .apply(
            &Edit::Reorder {
                from: 1,
                order: vec![2, 1],
            },
            Run::New,
            Instant::now(),
        )
        .expect("the last two swap");

    let after: Vec<(String, u32, u32)> = session
        .views()
        .iter()
        .map(|row| (row.text.clone(), row.start_ms, row.end_ms))
        .collect();
    assert_eq!(
        after,
        vec![before[0].clone(), before[2].clone(), before[1].clone()],
        "the first stays; the last two trade places, each with its own times"
    );

    session.undo().expect("undo").expect("a step");
    assert_eq!(session.to_bytes(), original, "one undo puts the order back");
}

#[test]
fn a_reorder_that_leaves_the_order_unchanged_is_refused_and_adds_no_step() {
    let mut session = session("srt/clean/basic-lf.srt");
    let original = session.to_bytes();

    let refused = session
        .apply(
            &Edit::Reorder {
                from: 0,
                order: vec![0, 1, 2],
            },
            Run::New,
            Instant::now(),
        )
        .expect_err("a reorder that changes nothing is refused");
    assert_eq!(refused.kind, EditErrorKind::NotApplicable);
    assert!(
        session.undo().expect("undo").is_none(),
        "no undo step was added"
    );
    assert_eq!(session.to_bytes(), original, "and nothing was written");
}

#[test]
fn a_reorder_refuses_an_order_that_is_not_a_permutation_of_one_run() {
    // Not a run of from..from+len (0,2), a repeat (0,0), out of the document (1,2,3), and empty.
    for order in [vec![0usize, 2], vec![0, 0], vec![1, 2, 3], Vec::new()] {
        let mut session = session("srt/clean/basic-lf.srt");
        let refused = session
            .apply(&Edit::Reorder { from: 0, order }, Run::New, Instant::now())
            .expect_err("a refusal");
        assert_eq!(refused.kind, EditErrorKind::NotApplicable);
    }
}

#[test]
fn a_reordered_ass_event_carries_the_fields_the_line_declares() {
    let mut session = session("ass/clean/speakers.ass");
    let before: Vec<(String, String, String)> = session
        .views()
        .iter()
        .map(|row| (row.text.clone(), row.style.clone(), row.actor.clone()))
        .collect();

    // Reverse the first two events: the run 0..=1 comes back as [1, 0].
    session
        .apply(
            &Edit::Reorder {
                from: 0,
                order: vec![1, 0],
            },
            Run::New,
            Instant::now(),
        )
        .expect("the first two swap");

    let after: Vec<(String, String, String)> = session
        .views()
        .iter()
        .map(|row| (row.text.clone(), row.style.clone(), row.actor.clone()))
        .collect();
    assert_eq!(
        after[0], before[1],
        "the second event is now first, with its own style and speaker"
    );
    assert_eq!(after[1], before[0], "and the first is now second");
}
