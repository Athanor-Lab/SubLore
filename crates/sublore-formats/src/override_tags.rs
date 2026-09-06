//! The override tags inside a cue's text, and the blocks they sit in.
//!
//! ASS puts styling inside the text field, in braces: `{\b1}bold{\b0}`. Everything that writes a
//! style from the editing panel writes through here, and it is in Rust with its own tests rather
//! than in the frontend because it is the one piece of the panel that can corrupt a line silently.
//!
//! The four kinds are the reference's own, and they are four rather than two because two of them
//! change what the text around them means: a drawing is coordinates rather than words, and a
//! braced run that holds no tag is a comment a writer left in the line.

use crate::span::Span;

/// What a run of a cue's text is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockKind {
    /// Words a reader sees.
    Plain,
    /// A braced run holding at least one tag.
    Override,
    /// A braced run holding no tag at all, which is a note rather than styling.
    Comment,
    /// Coordinates rather than words: what follows a `\p` with a non-zero scale, until `\p0`.
    Drawing,
}

/// One run of a cue's text, in the order it appears. Braces are inside the span of the block they
/// open and close.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Block {
    pub kind: BlockKind,
    pub span: Span,
}

/// Whether a braced run holds a tag. A tag is a backslash and a name, and a run with none is a
/// comment: `{note}` is a note and `{\b1}` is styling.
fn holds_a_tag(inside: &str) -> bool {
    let bytes = inside.as_bytes();
    bytes
        .iter()
        .enumerate()
        .any(|(at, byte)| *byte == b'\\' && names_a_tag(bytes, at))
}

/// Whether the backslash at `at` opens a name: one digit at most, then at least one letter. The
/// digit is there because the numbered colours and alphas are spelt `\2c` and `\1a`.
fn names_a_tag(bytes: &[u8], at: usize) -> bool {
    let letters = at + 1 + usize::from(bytes.get(at + 1).is_some_and(u8::is_ascii_digit));
    bytes.get(letters).is_some_and(u8::is_ascii_alphabetic)
}

/// The drawing scale a braced run leaves behind it: the last `\p<digits>` in it, or `None` when it
/// names none. Zero turns the drawing off, which is why the number and not the presence is read.
fn drawing_scale(inside: &str) -> Option<u32> {
    let bytes = inside.as_bytes();
    let mut scale = None;
    for at in 0..bytes.len() {
        if bytes[at] != b'\\' || bytes.get(at + 1) != Some(&b'p') {
            continue;
        }
        let digits: String = inside[at + 2..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        if !digits.is_empty() {
            scale = digits.parse().ok();
        }
    }
    scale
}

/// A cue's text split into its runs. An unclosed brace runs to the end of the text, which is what a
/// renderer does with it: the line is still drawn and the rest of it is inside the block.
pub fn blocks(text: &str) -> Vec<Block> {
    let bytes = text.as_bytes();
    let mut out: Vec<Block> = Vec::new();
    let mut at = 0;
    let mut drawing = false;
    while at < bytes.len() {
        if bytes[at] == b'{' {
            let close = text[at..].find('}').map(|found| at + found + 1);
            let end = close.unwrap_or(bytes.len());
            let inside = &text[at + 1..end.saturating_sub(usize::from(close.is_some()))];
            if let Some(scale) = drawing_scale(inside) {
                drawing = scale != 0;
            }
            out.push(Block {
                kind: if holds_a_tag(inside) {
                    BlockKind::Override
                } else {
                    BlockKind::Comment
                },
                span: Span::new(at, end),
            });
            at = end;
            continue;
        }
        let end = text[at..]
            .find('{')
            .map(|found| at + found)
            .unwrap_or(bytes.len());
        out.push(Block {
            kind: if drawing {
                BlockKind::Drawing
            } else {
                BlockKind::Plain
            },
            span: Span::new(at, end),
        });
        at = end;
    }
    out
}

/// One of the four flags a line can be styled with, inline. Closed on purpose: these four are the
/// ones the panel draws, and each is a boolean the style starts and an override tag may change.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StyleFlag {
    Bold,
    Italic,
    Underline,
    Strikeout,
}

impl StyleFlag {
    /// The tag that carries it, backslash included.
    pub fn tag(self) -> &'static str {
        match self {
            StyleFlag::Bold => "\\b",
            StyleFlag::Italic => "\\i",
            StyleFlag::Underline => "\\u",
            StyleFlag::Strikeout => "\\s",
        }
    }

    /// Its name, for a refusal that has to say which flag it is about.
    pub fn as_str(self) -> &'static str {
        match self {
            StyleFlag::Bold => "bold",
            StyleFlag::Italic => "italic",
            StyleFlag::Underline => "underline",
            StyleFlag::Strikeout => "strikeout",
        }
    }

    /// What a style sets it to, which is where a line starts before any tag of its own.
    pub fn of(self, style: &crate::document::AssStyle) -> bool {
        match self {
            StyleFlag::Bold => style.bold,
            StyleFlag::Italic => style.italic,
            StyleFlag::Underline => style.underline,
            StyleFlag::Strikeout => style.strikeout,
        }
    }
}

/// Whether a tag's value reads as on. ASS writes `1` for on and `0` for off inside a line, unlike
/// the styles section, which writes `-1`; anything that is not a number leaves the state alone,
/// which is what falling back to `initial` means here.
pub fn flag_value(value: &str, initial: bool) -> bool {
    value
        .trim()
        .parse::<i64>()
        .map_or(initial, |number| number != 0)
}

/// One tag inside an override block: the name with its backslash, and the value that follows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tag {
    /// Where the whole tag sits in the cue's text, backslash included.
    pub span: Span,
    /// Where the name sits, so `\\b` and `\\be` are told apart by what they are and not by a prefix.
    pub name: Span,
    /// Where the value sits: everything from the end of the name to the next tag or the brace.
    pub value: Span,
}

/// The tags inside one override block, in the order they are written. A name is the backslash and
/// the letters after it, which is what keeps `\\b` from swallowing `\\be`, and a value is everything
/// up to the next backslash or the closing brace.
pub fn tags_in(text: &str, block: Block) -> Vec<Tag> {
    if block.kind != BlockKind::Override {
        return Vec::new();
    }
    let bytes = text.as_bytes();
    // The braces themselves are never inside a tag. An unclosed block has no brace to step over.
    let start = block.span.start + 1;
    let end = block.span.end - usize::from(bytes.get(block.span.end - 1) == Some(&b'}'));
    let mut out = Vec::new();
    let mut at = start;
    while at < end {
        if bytes[at] != b'\\' {
            at += 1;
            continue;
        }
        let letters = at + 1 + usize::from(bytes.get(at + 1).is_some_and(u8::is_ascii_digit));
        let mut after = letters;
        while after < end && bytes[after].is_ascii_alphabetic() {
            after += 1;
        }
        // A backslash with no letter after it is not a tag: `\\N` is a line break and its letter is
        // taken by the name, which is right, and a trailing backslash names nothing.
        if after == letters {
            at += 1;
            continue;
        }
        let mut value_end = after;
        while value_end < end && bytes[value_end] != b'\\' {
            value_end += 1;
        }
        out.push(Tag {
            span: Span::new(at, value_end),
            name: Span::new(at, after),
            value: Span::new(after, value_end),
        });
        at = value_end;
    }
    out
}

/// Which block a caret sits in, counting the caret in the bytes of the text a reader sees. A caret
/// at the very end of a run and immediately before a brace belongs to the block that brace opens,
/// which is what makes typing a tag at a boundary land where a hand expects it.
pub fn block_at(text: &str, visible: usize) -> Option<usize> {
    let parsed = blocks(text);
    let mut seen = 0;
    for (index, block) in parsed.iter().enumerate() {
        if matches!(block.kind, BlockKind::Override | BlockKind::Comment) {
            continue;
        }
        let length = block.span.end - block.span.start;
        if visible < seen + length {
            return Some(index);
        }
        if visible == seen + length {
            return Some(match parsed.get(index + 1) {
                Some(next) if matches!(next.kind, BlockKind::Override | BlockKind::Comment) => {
                    index + 1
                }
                _ => index,
            });
        }
        seen += length;
    }
    // Past the last visible byte, or a text made only of braces: the last block owns it.
    parsed.len().checked_sub(1)
}

/// The value a tag has at a block, or `None` where nothing before it names one. The last tag of
/// that name at or before the block wins, which is the order a renderer reads them in.
pub fn value_at(text: &str, block: usize, name: &str) -> Option<String> {
    let parsed = blocks(text);
    for candidate in parsed.iter().take(block + 1).rev() {
        for tag in tags_in(text, *candidate).iter().rev() {
            if text.get(tag.name.range()) == Some(name) {
                return text.get(tag.value.range()).map(str::to_owned);
            }
        }
    }
    None
}

/// Write `name` with `value` so that it takes effect at `at`, a byte offset into the cue's own
/// text. Returns the new text and how many bytes longer it became, which is what a second write
/// further along the line has to be shifted by.
///
/// Where it lands follows the reference's own rule. The block the caret is in decides: an override
/// block already there takes the tag, replacing a tag of that name if it holds one and dropping any
/// later copy of it, and a run of words gets a new block spliced in front of the caret. A drawing
/// and a note are stepped over rather than written into, a note taking the caret back to where it
/// began, and a caret that finds neither writes at the start of the line.
pub fn set_tag(text: &str, at: usize, name: &str, value: &str) -> (String, isize) {
    let parsed = blocks(text);
    let mut index = block_at_raw(&parsed, at);
    let mut insert_at = at;
    while let Some(block) = index.and_then(|found| parsed.get(found)) {
        match block.kind {
            BlockKind::Plain | BlockKind::Override => break,
            BlockKind::Comment => {
                insert_at = block.span.start;
                index = index.and_then(|found| found.checked_sub(1));
            }
            BlockKind::Drawing => index = index.and_then(|found| found.checked_sub(1)),
        }
    }

    let written = format!("{name}{value}");
    let Some(block) = index.and_then(|found| parsed.get(found)) else {
        // Nothing on this line will take a tag, so the line takes one at its start.
        return (format!("{{{written}}}{text}"), written.len() as isize + 2);
    };
    if block.kind == BlockKind::Plain {
        let mut out = String::with_capacity(text.len() + written.len() + 2);
        out.push_str(&text[..insert_at]);
        out.push('{');
        out.push_str(&written);
        out.push('}');
        out.push_str(&text[insert_at..]);
        return (out, written.len() as isize + 2);
    }

    // An override block already there: the tag goes in it, in the place the one it replaces had.
    let held: Vec<Tag> = tags_in(text, *block)
        .into_iter()
        .filter(|tag| text.get(tag.name.range()) == Some(name))
        .collect();
    let Some(first) = held.first().copied() else {
        // Not there yet, so it joins the block just before the brace closes it.
        let closes = text.as_bytes().get(block.span.end - 1) == Some(&b'}');
        let put = block.span.end - usize::from(closes);
        let mut out = String::with_capacity(text.len() + written.len());
        out.push_str(&text[..put]);
        out.push_str(&written);
        out.push_str(&text[put..]);
        return (out, written.len() as isize);
    };

    let mut out = String::with_capacity(text.len() + written.len());
    out.push_str(&text[..first.span.start]);
    out.push_str(&written);
    let mut from = first.span.end;
    // Every later copy of the same tag goes: two of one name in a block is the last one winning,
    // so leaving one behind would undo the write that was just made.
    for extra in held.iter().skip(1) {
        out.push_str(&text[from..extra.span.start]);
        from = extra.span.end;
    }
    out.push_str(&text[from..]);
    let removed: usize = held.iter().map(|tag| tag.span.end - tag.span.start).sum();
    (out, written.len() as isize - removed as isize)
}

/// The block a byte offset into the raw text sits in, with a caret on a brace belonging to what
/// that brace opens. Raw rather than visible-only because the panel's box shows the line as the
/// file spells it, braces included, so the caret it reports is already an offset into this text.
fn block_at_raw(parsed: &[Block], at: usize) -> Option<usize> {
    let braced = |block: &Block| matches!(block.kind, BlockKind::Override | BlockKind::Comment);
    for (index, block) in parsed.iter().enumerate() {
        if at < block.span.end {
            return Some(index);
        }
        if at == block.span.end {
            // On a boundary, the braced side wins. Just past a closing brace the tags of the block
            // that closed are the ones in force; just before an opening one, the block it opens is
            // where a hand means the tag to go.
            if braced(block) {
                return Some(index);
            }
            return Some(match parsed.get(index + 1) {
                Some(next) if braced(next) => index + 1,
                _ => index,
            });
        }
    }
    parsed.len().checked_sub(1)
}

#[cfg(test)]
mod tests {
    use super::{block_at, blocks, set_tag, tags_in, value_at, Block, BlockKind};

    fn kinds(text: &str) -> Vec<(BlockKind, &str)> {
        blocks(text)
            .into_iter()
            .map(|Block { kind, span }| (kind, &text[span.range()]))
            .collect()
    }

    #[test]
    fn a_line_with_no_braces_is_one_run_of_words() {
        assert_eq!(
            kinds("plain words"),
            vec![(BlockKind::Plain, "plain words")]
        );
    }

    #[test]
    fn a_braced_run_with_a_tag_is_styling_and_one_without_is_a_note() {
        assert_eq!(
            kinds("{\\b1}bold{\\b0}"),
            vec![
                (BlockKind::Override, "{\\b1}"),
                (BlockKind::Plain, "bold"),
                (BlockKind::Override, "{\\b0}"),
            ]
        );
        assert_eq!(
            kinds("{a note}words"),
            vec![
                (BlockKind::Comment, "{a note}"),
                (BlockKind::Plain, "words")
            ]
        );
    }

    #[test]
    fn what_follows_a_drawing_scale_is_coordinates_until_it_is_turned_off() {
        assert_eq!(
            kinds("{\\p1}m 0 0 l 1 1{\\p0}words"),
            vec![
                (BlockKind::Override, "{\\p1}"),
                (BlockKind::Drawing, "m 0 0 l 1 1"),
                (BlockKind::Override, "{\\p0}"),
                (BlockKind::Plain, "words"),
            ]
        );
    }

    #[test]
    fn a_brace_nobody_closed_holds_the_rest_of_the_line() {
        assert_eq!(
            kinds("words{\\b1 and no close"),
            vec![
                (BlockKind::Plain, "words"),
                (BlockKind::Override, "{\\b1 and no close"),
            ]
        );
    }

    #[test]
    fn a_name_is_the_letters_after_the_backslash_so_two_tags_are_not_one() {
        let text = "{\\be1\\b1}words";
        let block = blocks(text)[0];
        let read = tags_in(text, block)
            .into_iter()
            .map(|tag| {
                (
                    text[tag.name.range()].to_owned(),
                    text[tag.value.range()].to_owned(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            read,
            vec![
                ("\\be".to_owned(), "1".to_owned()),
                ("\\b".to_owned(), "1".to_owned()),
            ],
            "blur edges and bold are two tags, not one read twice"
        );
    }

    #[test]
    fn a_line_break_is_not_a_tag_and_neither_is_a_lone_backslash() {
        let text = "{\\N\\}words";
        let block = blocks(text)[0];
        let names = tags_in(text, block)
            .into_iter()
            .map(|tag| text[tag.name.range()].to_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec!["\\N".to_owned()],
            "a backslash with no letter names nothing"
        );
    }

    #[test]
    fn the_value_in_force_is_the_last_one_written_before_the_block() {
        let text = "{\\b1}bold{\\b0}plain";
        // Inside the first override block, and in the words after it, bold is on.
        assert_eq!(value_at(text, 0, "\\b"), Some("1".to_owned()));
        assert_eq!(value_at(text, 1, "\\b"), Some("1".to_owned()));
        // From the second block on it is off.
        assert_eq!(value_at(text, 2, "\\b"), Some("0".to_owned()));
        assert_eq!(value_at(text, 3, "\\b"), Some("0".to_owned()));
        // A tag nobody wrote has no value, and the caller falls back to the style's own.
        assert_eq!(value_at(text, 3, "\\i"), None);
    }

    #[test]
    fn two_of_one_tag_in_a_block_are_read_as_the_last_of_them() {
        let text = "{\\b1\\b0}words";
        assert_eq!(value_at(text, 0, "\\b"), Some("0".to_owned()));
    }

    #[test]
    fn a_caret_lands_in_the_run_it_is_inside_and_on_a_brace_it_is_before() {
        let text = "ab{\\b1}cd";
        // Inside the first run.
        assert_eq!(block_at(text, 0), Some(0));
        assert_eq!(block_at(text, 1), Some(0));
        // At its end, and a brace opens next: the caret belongs to what the brace opens.
        assert_eq!(block_at(text, 2), Some(1));
        // Inside the run after it, and past its end.
        assert_eq!(block_at(text, 3), Some(2));
        assert_eq!(block_at(text, 4), Some(2));
    }

    #[test]
    fn a_tag_written_into_words_gets_a_block_of_its_own_in_front_of_the_caret() {
        assert_eq!(
            set_tag("hello world", 6, "\\b", "1"),
            ("hello {\\b1}world".to_owned(), 5),
            "the braces are part of what a second write has to be shifted by"
        );
    }

    #[test]
    fn a_tag_written_where_a_block_already_is_joins_that_block() {
        assert_eq!(
            set_tag("{\\i1}words", 0, "\\b", "1"),
            ("{\\i1\\b1}words".to_owned(), 3)
        );
    }

    #[test]
    fn a_tag_already_in_the_block_is_replaced_where_it_stood() {
        assert_eq!(
            set_tag("{\\b0\\i1}words", 0, "\\b", "1"),
            ("{\\b1\\i1}words".to_owned(), 0),
            "the same length in the same place, so nothing after it moves"
        );
    }

    #[test]
    fn a_second_copy_of_the_tag_goes_rather_than_undoing_the_write() {
        assert_eq!(
            set_tag("{\\b0\\i1\\b0}words", 0, "\\b", "1"),
            ("{\\b1\\i1}words".to_owned(), -3),
            "the later copy would have won, so it cannot be left behind"
        );
    }

    #[test]
    fn a_drawing_is_stepped_over_rather_than_written_into() {
        // The caret is inside the coordinates, which are not words: the tag joins the block that
        // turned the drawing on rather than splitting the shape in half.
        assert_eq!(
            set_tag("{\\p1}m 0 0 l 1 1", 8, "\\b", "1"),
            ("{\\p1\\b1}m 0 0 l 1 1".to_owned(), 3)
        );
    }

    #[test]
    fn a_note_takes_the_caret_back_to_where_it_began() {
        assert_eq!(
            set_tag("words{a note}more", 8, "\\b", "1"),
            ("words{\\b1}{a note}more".to_owned(), 5),
            "the tag goes in front of the note, not inside it"
        );
    }

    #[test]
    fn a_line_that_will_take_no_tag_takes_one_at_its_start() {
        assert_eq!(
            set_tag("{a note}", 4, "\\b", "1"),
            ("{\\b1}{a note}".to_owned(), 5)
        );
    }

    #[test]
    fn a_scale_named_twice_in_one_block_is_the_last_one() {
        assert_eq!(
            kinds("{\\p1\\p0}words"),
            vec![
                (BlockKind::Override, "{\\p1\\p0}"),
                (BlockKind::Plain, "words")
            ]
        );
    }

    #[test]
    fn a_numbered_colour_is_one_name_and_not_a_digit_before_a_value() {
        let text = "{\\2c&H0000FF&}word";
        let parsed = blocks(text);
        assert_eq!(parsed[0].kind, BlockKind::Override);
        let found = tags_in(text, parsed[0]);
        assert_eq!(found.len(), 1);
        assert_eq!(&text[found[0].name.range()], "\\2c");
        assert_eq!(&text[found[0].value.range()], "&H0000FF&");
    }

    #[test]
    fn a_backslash_and_a_digit_with_no_letter_after_it_names_nothing() {
        let text = "{\\3}word";
        let parsed = blocks(text);
        assert_eq!(parsed[0].kind, BlockKind::Comment);
        assert!(tags_in(text, parsed[0]).is_empty());
    }
}
