/**
 * What the two views of a cue share: how its numbers are drawn, and the mark that says a field
 * edits the open document rather than owning its own keyboard.
 *
 * The grid row and the current-line box are two views of one row, not two states (decision 5), so
 * neither restates any of this and the two cannot drift apart. See T5.
 */
import { type CueRow } from "../types/subtitle";

/** Reading rate a line is flagged above, fixed and not configurable in v1. Decision 24 A8. */
export const CPS_LIMIT = 21;
/**
 * Characters a line is flagged above, fixed and not configurable either. It is the rate above held
 * for the two seconds a line is on screen, so the two numbers in the band say the same thing in two
 * units. See edit-bar-first-tasks.md D2.
 */
export const CHARACTER_LIMIT = 42;
/** The markup A8 does not count: ASS override blocks and HTML-style tags. */
const MARKUP = /\{[^}]*\}|<[^>]*>/g;
/** Line breaks in both spellings a cue holds: a real one, and the `\N` of an ASS field. */
const LINE_BREAKS = /\r\n|[\r\n]|\\[Nn]/g;
/** A drawing's scale inside an override block. Non-zero makes what follows coordinates, `\p0` text. */
const DRAWING_SCALE = /\\p(\d+)/g;

type Graphemes = { segment: (input: string) => Iterable<{ segment: string }> };
type SegmenterCtor = new (locale: undefined, options: { granularity: "grapheme" }) => Graphemes;

/**
 * Graphemes and not code units: the count is of what a reader sees, so an astronaut built from two
 * joined code points counts one. See edit-bar-first-tasks.md D1.
 *
 * `Intl.Segmenter` is ES2022 and this project compiles against the ES2020 library. Its shape is
 * named here rather than by widening `lib`, which every other file would inherit; the cast reaches
 * the one constructor used below and nothing wider.
 */
const GRAPHEMES = new (Intl as unknown as { Segmenter: SegmenterCtor }).Segmenter(undefined, {
  granularity: "grapheme",
});

/**
 * Whether a field edits the open document. Both editors carry `data-document-editor`, so Ctrl+Z
 * inside either is the document's undo and never the webview's own text undo, which would fork the
 * two histories. See BACKLOG.md M2.3 and T5.
 */
export function isDocumentEditor(element: HTMLElement): boolean {
  return element.dataset.documentEditor !== undefined;
}

/**
 * Characters per second: spaces counted, line breaks not, over text with its markup stripped.
 * Null when the cue has no duration to divide by. Decision 24 A8.
 *
 * CodeQL reads the strip below as an incomplete HTML sanitizer and is wrong about what it is: the
 * stripped string is never bound, `.length` consumes it here, and nothing renders it. Dismissed
 * twice, once per address it has lived at; the measurements are in #49.
 */
export function readingRate(cue: CueRow): number | null {
  const seconds = (cue.endMs - cue.startMs) / 1000;
  if (!(seconds > 0)) {
    return null;
  }
  return cue.text.replace(MARKUP, "").replace(LINE_BREAKS, "").length / seconds;
}

/**
 * The lines a reader sees, with the markup gone. Both spellings of a break divide them, `\h` is the
 * one character it draws as, and a drawing's coordinates are not text. A `{` with no `}` after it
 * opens no block: it and the rest of the line are counted, brace included.
 *
 * Walked rather than stripped by pattern, because `\p` carries state across the block that holds it
 * and a regex cannot say where the drawing stops. See edit-bar-first-tasks.md D1.
 */
function visibleLines(text: string): string[] {
  const lines: string[] = [];
  let line = "";
  let drawing = false;
  let at = 0;
  while (at < text.length) {
    const here = text[at];
    // Structural whatever is being drawn: a break ends the line it is on, coordinates or not.
    if (here === "\r" || here === "\n") {
      at += here === "\r" && text[at + 1] === "\n" ? 2 : 1;
      lines.push(line);
      line = "";
      continue;
    }
    if (here === "\\" && (text[at + 1] === "N" || text[at + 1] === "n")) {
      at += 2;
      lines.push(line);
      line = "";
      continue;
    }
    if (here === "{") {
      const close = text.indexOf("}", at + 1);
      // No closing brace, so this opened nothing: the brace is one character of text and the walk
      // carries on, so a later break still divides the lines it was hiding.
      if (close === -1) {
        at += 1;
        if (!drawing) {
          line += here;
        }
        continue;
      }
      const scales = text.slice(at + 1, close).match(DRAWING_SCALE);
      if (scales !== null) {
        drawing = Number(scales[scales.length - 1].slice(2)) !== 0;
      }
      at = close + 1;
      continue;
    }
    if (here === "<") {
      const close = text.indexOf(">", at + 1);
      // An unclosed angle bracket is no tag, so it falls through and counts as the text it is.
      if (close !== -1) {
        at = close + 1;
        continue;
      }
    }
    if (here === "\\" && text[at + 1] === "h") {
      at += 2;
      if (!drawing) {
        line += " ";
      }
      continue;
    }
    at += 1;
    if (!drawing) {
      line += here;
    }
  }
  lines.push(line);
  return lines;
}

/**
 * How long the cue's longest line is, in the characters a reader sees. The longest and not the sum:
 * a limit is about what fits across one row, and a total cannot tell two lines of thirty from one
 * of sixty-one. See edit-bar-first-tasks.md D3.
 */
export function characterCount(text: string): number {
  return visibleLines(text).reduce(
    (longest, line) => Math.max(longest, Array.from(GRAPHEMES.segment(line)).length),
    0,
  );
}

/**
 * The values the open document already uses in one of its combo fields, in the order its rows first
 * use them.
 *
 * First appearance and not sorted: the list is a record of what has been used so far, and the value
 * wanted next is usually the one used last. See edit-bar-first-tasks.md D6.
 */
export function fieldValues(cues: CueRow[], field: "actor" | "effect"): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const cue of cues) {
    const value = cue[field];
    if (value !== "" && !seen.has(value)) {
      seen.add(value);
      values.push(value);
    }
  }
  return values;
}

/**
 * A field value as the panel both shows it and writes it: the padding the document's reader drops
 * on the way in, dropped here on the way out. A control that displayed a value trimmed one way and
 * committed it another would write bytes the panel never drew. Mirrors `ass::trim_field`.
 * See edit-bar-first-tasks.md E4.7.
 */
export function trimmedFieldValue(value: string): string {
  return value.replace(/^[ \t]+/, "").replace(/[ \t\r]+$/, "");
}

/** Why a single-line ASS field cannot hold a value. One key per sentence the field says. */
export type FieldRefusal = "comma" | "lineBreak" | "control";

/**
 * Whether an ASS event field can hold this value, tested here so the refusal names what is wrong
 * where the field stands and so nothing is sent. The same three the plan refuses, in the same
 * order, because a line break is also a control character and its failure is the structural one.
 * See edit-bar-first-tasks.md E4 and ass-field-write-tasks.md 5.8.
 */
export function refusedFieldValue(value: string): FieldRefusal | null {
  if (value.includes(",")) {
    return "comma";
  }
  if (value.includes("\n") || value.includes("\r")) {
    return "lineBreak";
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      return "control";
    }
  }
  return null;
}

/** hh:mm:ss.mmm. Separators are punctuation, not translatable copy. */
export function timecode(milliseconds: number): string {
  const safe = Number.isFinite(milliseconds) && milliseconds > 0 ? Math.floor(milliseconds) : 0;
  const millis = safe % 1000;
  const seconds = Math.floor(safe / 1000) % 60;
  const minutes = Math.floor(safe / 60_000) % 60;
  const hours = Math.floor(safe / 3_600_000);
  const pad = (value: number, width: number) => value.toString().padStart(width, "0");
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}`;
}

/**
 * A time a person typed, back into milliseconds. Hours and minutes are optional and either
 * separator introduces the milliseconds, because a translator types `9.1` and pastes `00:00:09,100`
 * for the same instant. Null when the string is not a time, and a null is never committed.
 *
 * The digit counts are the bound on the result: three digits of the leading unit is at most
 * 999:59:59.999, which is inside the `u32` the command takes. See M2.7 E1.
 */
const TYPED_TIME = /^(\d{1,3}(?::\d{1,2}){0,2})[.,](\d{1,3})$/;

export function parseTimecode(value: string): number | null {
  const match = TYPED_TIME.exec(value.trim());
  if (match === null) {
    return null;
  }
  const units = match[1].split(":").map(Number);
  // Everything but the leading unit is a sexagesimal digit: `1:75.000` is not a time.
  if (units.slice(1).some((unit) => unit > 59)) {
    return null;
  }
  const millis = Number(match[2].padEnd(3, "0"));
  // Read from the right, so that seconds, minutes and hours all land in the right place.
  const seconds = units.pop() ?? 0;
  const minutes = units.pop() ?? 0;
  const hours = units.pop() ?? 0;
  return hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + millis;
}

/**
 * The largest instant `TYPED_TIME` admits, which is what a pair of typed times has to stay inside:
 * a start and a length are added before the command sees them, and the sum of two times the pattern
 * accepts does not fit the `u32` the command's parameter is. See M2.7 E1 and C2.7.
 */
export const MAX_TIME_MS = 999 * 3_600_000 + 59 * 60_000 + 59 * 1000 + 999;

/**
 * A span in seconds, to the millisecond the product reasons in (decision 11). Shown as seconds
 * rather than as a timecode: a length is judged against the second, not against the hour.
 */
export function lengthOf(startMs: number, endMs: number): string {
  const milliseconds = endMs - startMs;
  return (Number.isFinite(milliseconds) ? milliseconds / 1000 : 0).toFixed(3);
}

/** A cue's own length, by the same rule. */
export function lengthLabel(cue: CueRow): string {
  return lengthOf(cue.startMs, cue.endMs);
}

/**
 * How the grid draws a line's override tags: as they are, as a placeholder, or not at all.
 *
 * The text box is never any of these. It edits the file's own text and a mode that hid part of it
 * there would let a translator overwrite what they cannot see.
 */
export type TagMode = "show" | "simplify" | "hide";

/** What the placeholder is where a braced run stood. The reference's own default character. */
const TAG_MARK = "\u2600";

/** The longest a cell is laid out. Past it the rest is an ellipsis, as the reference does. */
const CELL_LIMIT = 512;

/**
 * One line as the grid draws it under `mode`.
 *
 * A brace with no closing one takes the rest of the line with it, which is what a renderer does
 * with it too: everything from that brace onwards is inside the run.
 */
export function drawnText(text: string, mode: TagMode): string {
  let drawn = text;
  if (mode !== "show") {
    let out = "";
    let start = 0;
    for (;;) {
      const open = text.indexOf("{", start);
      if (open === -1) {
        out += text.slice(start);
        break;
      }
      out += text.slice(start, open);
      if (mode === "simplify") {
        out += TAG_MARK;
      }
      const close = text.indexOf("}", open);
      if (close === -1) {
        start = -1;
        break;
      }
      start = close + 1;
    }
    drawn = out;
  }
  return drawn.length > CELL_LIMIT ? `${drawn.slice(0, CELL_LIMIT)}...` : drawn;
}
