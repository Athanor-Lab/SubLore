//! The font families installed on this machine, read from the font files themselves.
//!
//! Nothing here asks a toolkit or a subprocess. The webview has no way to enumerate local fonts
//! that WebKitGTK implements, `fc-list` is a command that a minimal system need not have installed
//! even where the library is, and a crate for it would be a dependency for one table. So this walks
//! the directories a font is installed into and reads the `name` table out of each file, which is
//! about a hundred lines of bounds-checked parsing and works the same on both platforms.
//!
//! Everything here treats the file as hostile: a font is a binary somebody else wrote, the list is
//! built from whatever is on disk, and one malformed file must cost that file and nothing else.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::log;

/// How deep a font directory is walked. Distributions nest by foundry and by family, two or three
/// levels; ten is far past anything real and stops a symlink loop from walking forever.
const MAX_DEPTH: usize = 10;

/// How many files are opened at most. A machine with a thousand fonts is unusual and a directory
/// with fifty thousand files in it is not a font directory, so this bounds the worst case.
const MAX_FILES: usize = 4_000;

/// The most a font file may be to be read whole. The `name` table sits near the front, but the
/// offsets in the header may point anywhere, so the file is read whole and this is the ceiling.
const MAX_FONT_BYTES: u64 = 64 * 1024 * 1024;

/// The extensions a font is installed under. A file with any other name is not opened at all, which
/// is what keeps the walk off the licence texts and the READMEs that live beside them.
const FONT_EXTENSIONS: [&str; 5] = ["ttf", "otf", "ttc", "otc", "TTF"];

/// Every family name on this machine, sorted and without repeats.
///
/// A directory that cannot be read is skipped and said out loud once; a file that cannot be parsed
/// is skipped in silence, because a font directory reliably holds a few of those and a line each
/// would bury the log.
pub fn families() -> Vec<String> {
    let mut found: BTreeSet<String> = BTreeSet::new();
    let mut opened = 0usize;
    for root in roots() {
        walk(&root, 0, &mut opened, &mut found);
    }
    log::info!("fonts: {} families installed", found.len());
    found.into_iter().collect()
}

/// The list, read once. Walking the font directories costs a few hundred file reads, and what is
/// installed does not change while the app is open often enough to be worth re-reading.
static INSTALLED: OnceLock<Vec<String>> = OnceLock::new();

/// The families, for the interface. Blocking: the caller runs it off the async runtime's threads.
#[tauri::command]
pub async fn fonts_installed() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| INSTALLED.get_or_init(families).clone())
        .await
        .map_err(|error| format!("the font list could not be read: {error}"))
}

/// Where fonts are installed, in the order a system search would look. Missing ones are skipped.
fn roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        if let Some(windows) = std::env::var_os("SystemRoot") {
            roots.push(Path::new(&windows).join("Fonts"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            roots.push(Path::new(&local).join("Microsoft/Windows/Fonts"));
        }
    } else {
        roots.push(PathBuf::from("/usr/share/fonts"));
        roots.push(PathBuf::from("/usr/local/share/fonts"));
        if let Some(home) = std::env::var_os("HOME") {
            roots.push(Path::new(&home).join(".fonts"));
            roots.push(Path::new(&home).join(".local/share/fonts"));
        }
    }
    roots.retain(|root| root.is_dir());
    roots
}

fn walk(dir: &Path, depth: usize, opened: &mut usize, found: &mut BTreeSet<String>) {
    if depth > MAX_DEPTH || *opened >= MAX_FILES {
        return;
    }
    let listing = match fs::read_dir(dir) {
        Ok(listing) => listing,
        Err(error) => {
            log::warn!("fonts: {} could not be listed: {error}", dir.display());
            return;
        }
    };
    for entry in listing.flatten() {
        if *opened >= MAX_FILES {
            return;
        }
        let path = entry.path();
        // `file_type` and not `metadata`: a symlink is not followed here, so a loop through one
        // cannot be walked into at all and the depth cap is only the second line of defence.
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            walk(&path, depth + 1, opened, found);
            continue;
        }
        if !kind.is_file() || !is_font_name(&path) {
            continue;
        }
        *opened += 1;
        let Ok(size) = entry.metadata().map(|data| data.len()) else {
            continue;
        };
        if size > MAX_FONT_BYTES {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        for family in families_in(&bytes) {
            found.insert(family);
        }
    }
}

fn is_font_name(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            FONT_EXTENSIONS
                .iter()
                .any(|wanted| wanted.eq_ignore_ascii_case(value))
        })
}

/// Read `count` bytes at `at` as a big-endian number, or `None` past the end.
fn be(bytes: &[u8], at: usize, count: usize) -> Option<u32> {
    let slice = bytes.get(at..at.checked_add(count)?)?;
    Some(
        slice
            .iter()
            .fold(0u32, |value, byte| (value << 8) | u32::from(*byte)),
    )
}

/// Every family name a font file declares. A collection carries several fonts and each is read.
pub fn families_in(bytes: &[u8]) -> Vec<String> {
    let tag = bytes.get(..4).unwrap_or_default();
    if tag == b"ttcf" {
        let count = be(bytes, 8, 4).unwrap_or(0) as usize;
        // A count out of proportion to the file is a malformed header, not a font with a million
        // faces: each offset costs four bytes, so the file bounds it.
        let count = count.min(bytes.len() / 4);
        return (0..count)
            .filter_map(|at| be(bytes, 12 + at * 4, 4))
            .flat_map(|offset| family_at(bytes, offset as usize))
            .collect();
    }
    family_at(bytes, 0)
}

/// The family name of the font whose table directory starts at `start`.
fn family_at(bytes: &[u8], start: usize) -> Vec<String> {
    let tables = be(bytes, start.saturating_add(4), 2).unwrap_or(0) as usize;
    let mut name_table = None;
    for index in 0..tables {
        let Some(record) = start
            .checked_add(12)
            .and_then(|at| at.checked_add(index.checked_mul(16)?))
        else {
            break;
        };
        let Some(tag) = bytes.get(record..record + 4) else {
            break;
        };
        if tag == b"name" {
            name_table = be(bytes, record + 8, 4).map(|offset| offset as usize);
            break;
        }
    }
    let Some(table) = name_table else {
        return Vec::new();
    };
    read_names(bytes, table)
}

/// The family names inside one `name` table, best first.
///
/// Two name ids carry a family: 16 is the typographic family and 1 is the one every font has, and
/// where both are present 16 is the name a person recognises. Both are returned, because a family
/// a renderer will accept is worth offering even when it is the older spelling.
fn read_names(bytes: &[u8], table: usize) -> Vec<String> {
    let count = be(bytes, table.saturating_add(2), 2).unwrap_or(0) as usize;
    let Some(strings) = be(bytes, table.saturating_add(4), 2) else {
        return Vec::new();
    };
    let strings = table.saturating_add(strings as usize);
    let mut out = Vec::new();
    for index in 0..count {
        let Some(record) = table
            .checked_add(6)
            .and_then(|at| at.checked_add(index.checked_mul(12)?))
        else {
            break;
        };
        let (Some(platform), Some(encoding), Some(name_id), Some(length), Some(offset)) = (
            be(bytes, record, 2),
            be(bytes, record + 2, 2),
            be(bytes, record + 6, 2),
            be(bytes, record + 8, 2),
            be(bytes, record + 10, 2),
        ) else {
            break;
        };
        if name_id != 1 && name_id != 16 {
            continue;
        }
        let at = strings.saturating_add(offset as usize);
        let Some(raw) = bytes.get(at..at.saturating_add(length as usize)) else {
            continue;
        };
        // Platform 3 is Windows and platform 0 is Unicode, and both spell the string in UTF-16BE.
        // Platform 1 is Mac Roman, whose lower half is ASCII, which is what a family name is.
        let decoded = match (platform, encoding) {
            (3, _) | (0, _) => utf16_be(raw),
            (1, 0) => Some(raw.iter().map(|byte| *byte as char).collect()),
            _ => None,
        };
        if let Some(name) = decoded {
            let name = name.trim().to_owned();
            if !name.is_empty() && !out.contains(&name) {
                out.push(name);
            }
        }
    }
    out
}

/// Decode UTF-16BE, refusing anything that is not a whole valid string rather than guessing.
fn utf16_be(raw: &[u8]) -> Option<String> {
    if !raw.len().is_multiple_of(2) {
        return None;
    }
    let units: Vec<u16> = raw
        .chunks_exact(2)
        .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16(&units).ok()
}

#[cfg(test)]
mod tests {
    use super::{be, families_in, is_font_name, utf16_be};
    use std::path::Path;

    /// A `name` table with one record, and a table directory in front of it that points at it.
    ///
    /// `base` is where this font starts in the file it will live in, because a table record's
    /// offset is counted from the start of the file and not from the start of the font. That is
    /// what a collection needs, and it is the one thing about the format worth writing down here.
    fn one_font_at(family: &str, name_id: u16, base: usize) -> Vec<u8> {
        let text: Vec<u8> = family
            .encode_utf16()
            .flat_map(|unit| unit.to_be_bytes())
            .collect();
        let mut name = Vec::new();
        name.extend_from_slice(&0u16.to_be_bytes()); // format
        name.extend_from_slice(&1u16.to_be_bytes()); // count
        name.extend_from_slice(&18u16.to_be_bytes()); // where the strings start, from the table
        name.extend_from_slice(&3u16.to_be_bytes()); // platform: Windows
        name.extend_from_slice(&1u16.to_be_bytes()); // encoding: UTF-16BE
        name.extend_from_slice(&0x0409u16.to_be_bytes()); // language
        name.extend_from_slice(&name_id.to_be_bytes());
        name.extend_from_slice(&(text.len() as u16).to_be_bytes());
        name.extend_from_slice(&0u16.to_be_bytes()); // offset into the strings
        name.extend_from_slice(&text);

        let mut font = Vec::new();
        font.extend_from_slice(&0x0001_0000u32.to_be_bytes()); // sfnt version
        font.extend_from_slice(&1u16.to_be_bytes()); // one table
        font.extend_from_slice(&[0; 6]); // searchRange, entrySelector, rangeShift
        font.extend_from_slice(b"name");
        font.extend_from_slice(&0u32.to_be_bytes()); // checksum
        font.extend_from_slice(&((base + 28) as u32).to_be_bytes()); // where the table is
        font.extend_from_slice(&(name.len() as u32).to_be_bytes());
        assert_eq!(
            font.len(),
            28,
            "the table has to start where the record says"
        );
        font.extend_from_slice(&name);
        font
    }

    /// The same font, standing alone at the start of its own file.
    fn one_font(family: &str, name_id: u16) -> Vec<u8> {
        one_font_at(family, name_id, 0)
    }

    #[test]
    fn a_font_gives_up_the_family_its_name_table_declares() {
        assert_eq!(families_in(&one_font("Gentium Book", 1)), ["Gentium Book"]);
        assert_eq!(
            families_in(&one_font("Source Han Sans", 16)),
            ["Source Han Sans"]
        );
    }

    #[test]
    fn a_name_that_is_not_a_family_is_not_offered_as_one() {
        // Name id 4 is the full name and 6 the PostScript name: neither is what a person picks.
        assert!(families_in(&one_font("Gentium Book Regular", 4)).is_empty());
        assert!(families_in(&one_font("GentiumBook-Regular", 6)).is_empty());
    }

    #[test]
    fn a_truncated_font_costs_that_file_and_nothing_else() {
        let whole = one_font("Gentium Book", 1);
        for cut in 0..whole.len() {
            // Every prefix of a real font: none of them may panic, and none may invent a name.
            let names = families_in(&whole[..cut]);
            assert!(
                names.is_empty() || names == ["Gentium Book"],
                "a font cut at {cut} produced {names:?}"
            );
        }
    }

    #[test]
    fn a_header_claiming_more_faces_than_the_file_can_hold_reads_none_of_them() {
        let mut collection = Vec::new();
        collection.extend_from_slice(b"ttcf");
        collection.extend_from_slice(&0x0001_0000u32.to_be_bytes());
        collection.extend_from_slice(&u32::MAX.to_be_bytes()); // every font there could be
        assert!(families_in(&collection).is_empty());
    }

    #[test]
    fn a_collection_gives_up_every_family_in_it() {
        let header = 12 + 2 * 4;
        let first = one_font_at("Gentium Book", 1, header);
        let second = one_font_at("Source Han Sans", 1, header + first.len());
        let mut collection = Vec::new();
        collection.extend_from_slice(b"ttcf");
        collection.extend_from_slice(&0x0002_0000u32.to_be_bytes());
        collection.extend_from_slice(&2u32.to_be_bytes());
        collection.extend_from_slice(&(header as u32).to_be_bytes());
        collection.extend_from_slice(&((header + first.len()) as u32).to_be_bytes());
        collection.extend_from_slice(&first);
        collection.extend_from_slice(&second);
        assert_eq!(
            families_in(&collection),
            ["Gentium Book", "Source Han Sans"]
        );
    }

    #[test]
    fn only_the_extensions_a_font_is_installed_under_are_opened() {
        assert!(is_font_name(Path::new("/usr/share/fonts/DejaVuSans.ttf")));
        assert!(is_font_name(Path::new("/usr/share/fonts/DejaVuSans.TTF")));
        assert!(is_font_name(Path::new("/usr/share/fonts/Noto.otc")));
        assert!(!is_font_name(Path::new("/usr/share/fonts/LICENSE")));
        assert!(!is_font_name(Path::new("/usr/share/fonts/README.txt")));
    }

    #[test]
    fn a_number_past_the_end_is_none_rather_than_a_panic() {
        assert_eq!(be(&[0x12, 0x34], 0, 2), Some(0x1234));
        assert_eq!(be(&[0x12, 0x34], 1, 2), None);
        assert_eq!(be(&[], 0, 1), None);
    }

    #[test]
    fn a_half_character_is_refused_rather_than_guessed_at() {
        assert_eq!(utf16_be(&[0x00, 0x41]).as_deref(), Some("A"));
        assert_eq!(utf16_be(&[0x00]), None);
        // A lone high surrogate is not a string, and half a character must not reach a menu.
        assert_eq!(utf16_be(&[0xD8, 0x00]), None);
    }
}
