/** The subtitle IPC contract. Mirrors src-tauri/src/subtitle; changing either side means changing both. */

export type SubtitleFormatName = "srt" | "vtt" | "ass";

export type SubtitleNewline = "lf" | "crlf" | "mixed" | "none";

/**
 * One declared style as an editor reads it: every value the file's own spelling, and the four flags
 * as booleans because that is what a line's own override tags start from.
 */
/**
 * Which column of a `Style:` line a write names. The name is not on it: renaming a style means
 * rewriting every event that names it, which is a different operation. See edit-bar-tasks.md B10.
 */
export type AssStyleField =
  | "fontname"
  | "fontsize"
  | "primary"
  | "secondary"
  | "outline"
  | "back"
  | "bold"
  | "italic"
  | "underline"
  | "strikeout"
  | "scaleX"
  | "scaleY"
  | "spacing"
  | "angle"
  | "borderStyle"
  | "outlineWidth"
  | "shadow"
  | "alignment"
  | "marginL"
  | "marginR"
  | "marginV"
  | "encoding";

export type AssStyle = {
  name: string;
  fontname: string;
  fontsize: string;
  primary: string;
  secondary: string;
  outline: string;
  back: string;
  /** The rest of what a style declares. `outlineWidth` and `shadow` are widths, not colours. */
  scaleX: string;
  scaleY: string;
  spacing: string;
  angle: string;
  borderStyle: string;
  outlineWidth: string;
  shadow: string;
  alignment: string;
  marginL: string;
  marginR: string;
  marginV: string;
  encoding: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikeout: boolean;
};

export type SubtitleSummary = {
  /** Where the document came from, or null while it has never had a file. */
  path: string | null;
  format: SubtitleFormatName;
  /** Cues a player would draw; ASS `Comment:` events are not among them. */
  cueCount: number;
  hasBom: boolean;
  newline: SubtitleNewline;
  byteLength: number;
  /** The styles the ASS section declares, in its own order. Empty for every other format. */
  styles: AssStyle[];
};

/** One row of the cue list. Its index is its position in the array, never a field of its own. */
export type CueRow = {
  startMs: number;
  endMs: number;
  /** Line breaks are always "\n" here, whatever the file uses. */
  text: string;
  /** An ASS `Comment:` event: listed and editable, but not a line a player draws. */
  comment: boolean;
  /** The cue's own number, when the file wrote one. Never renumbered. */
  number: number | null;
  /** The ASS style the event names. Empty string when there is none, never null. */
  style: string;
  /** The ASS `Name` (or `Actor`) field, under the same rule as `style`. */
  actor: string;
  /** The ASS `Effect` field, under the same rule as `style`. */
  effect: string;
  /**
   * The ASS `Layer` field as the file spells it, never as a number: "0000" stays "0000", and a
   * value that is no integer at all stays itself. Empty means nothing to show, which is the answer
   * both for a field the file does not declare and for one it declared and left blank;
   * `declaredFields` is what tells those two apart.
   */
  layer: string;
  /** The ASS `MarginL` field, under the same rule as `layer`. */
  marginL: string;
  /** The ASS `MarginR` field, under the same rule as `layer`. */
  marginR: string;
  /** The ASS `MarginV` field, under the same rule as `layer`. */
  marginV: string;
  /**
   * Which of the seven fields this row's own `Format:` line declares. A control for a field that
   * is not on this list is drawn greyed and never asks: the write would be refused. Empty for SRT
   * and for VTT, so a row of either draws none of the seven.
   */
  declaredFields: AssFieldName[];
};

/**
 * The ASS event field `subtitle_set_field` writes. The text field is deliberately not on this
 * list: it is written through `subtitle_set_text`, and nothing else may name it.
 * A field the row does not declare is refused, so its control greys itself off `declaredFields`
 * rather than asking and reading the refusal.
 */
/** The four inline style flags, spelled the way the backend's own enum takes them. */
export type StyleFlagName = "bold" | "italic" | "underline" | "strikeout";

export type AssFieldName =
  "style" | "actor" | "effect" | "layer" | "marginL" | "marginR" | "marginV";

export type SubtitleOpened = {
  summary: SubtitleSummary;
  revision: number;
  /** Every cue, ASS comments included, unlike `summary.cueCount`. */
  cues: CueRow[];
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  truncated: boolean;
};

/** One contiguous run of rows replaced by another, and the state that changed with it. */
export type CuePatch = {
  revision: number;
  from: number;
  removed: number;
  cues: CueRow[];
  /** For the status line: ASS `Comment:` events excluded. */
  cueCount: number;
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  truncated: boolean;
  /** The styles as they stand: a style write changes no cue, so nothing else here would say it. */
  styles: AssStyle[];
};

export type SubtitleSaved = {
  path: string;
  bytesWritten: number;
  /** Null when the destination did not exist before. */
  backupPath: string | null;
  /** Whether the document still holds edits that are not on disk. */
  dirty: boolean;
};

export type SubtitleErrorCode =
  | "invalidPath"
  | "notAFile"
  | "tooLarge"
  | "readFailed"
  | "unsupportedEncoding"
  | "unknownFormat"
  | "parseFailed"
  | "writeFailed"
  | "backupFailed"
  | "permissionDenied"
  | "noDocument"
  | "staleRevision"
  | "invalidCue"
  | "unwritableText"
  | "unencodableCharacter"
  | "editRefused"
  | "unsavedChanges"
  | "noPath"
  | "transcriptionGone"
  | "commandFailed";

/** Why a parse stopped. Sent only with `parseFailed`, always together with a line number. */
export type SubtitleReason =
  | "expectedTiming"
  | "badTimecode"
  | "timecodeOutOfRange"
  | "missingVttHeader"
  | "missingFormatLine"
  | "missingTimingFields"
  | "fieldCountMismatch"
  | "badSectionHeader"
  | "unexpectedEndOfFile";

export type SubtitleError = {
  code: SubtitleErrorCode;
  /** 1-based, null unless `reason` is set too. */
  line: number | null;
  reason: SubtitleReason | null;
  /** Technical, not user-facing, may be empty. */
  detail: string;
};

const ERROR_CODES: ReadonlySet<string> = new Set<SubtitleErrorCode>([
  "invalidPath",
  "notAFile",
  "tooLarge",
  "readFailed",
  "unsupportedEncoding",
  "unknownFormat",
  "parseFailed",
  "writeFailed",
  "backupFailed",
  "permissionDenied",
  "noDocument",
  "staleRevision",
  "invalidCue",
  "unwritableText",
  "unencodableCharacter",
  "editRefused",
  "unsavedChanges",
  "noPath",
  "transcriptionGone",
  "commandFailed",
]);

const REASONS: ReadonlySet<string> = new Set<SubtitleReason>([
  "expectedTiming",
  "badTimecode",
  "timecodeOutOfRange",
  "missingVttHeader",
  "missingFormatLine",
  "missingTimingFields",
  "fieldCountMismatch",
  "badSectionHeader",
  "unexpectedEndOfFile",
]);

/** Commands reject with a SubtitleError object, but a thrown value is never trusted on sight. */
export function isSubtitleError(value: unknown): value is SubtitleError {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { code?: unknown; line?: unknown; reason?: unknown };
  if (typeof candidate.code !== "string" || !ERROR_CODES.has(candidate.code)) {
    return false;
  }
  // The error line is rendered from these two, so a payload that disagrees is not one of ours.
  return (
    (candidate.line === null || typeof candidate.line === "number") &&
    (candidate.reason === null ||
      (typeof candidate.reason === "string" && REASONS.has(candidate.reason)))
  );
}
