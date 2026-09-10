import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { invoke } from "@tauri-apps/api/core";

import { en } from "../i18n/en";
import { commandToken, runCommand, type CommandId, type CommandRegistry } from "../types/chrome";
import { type AssFieldName, type CueRow } from "../types/subtitle";
import {
  colourAt as colourInMode,
  positionIn,
  SPECTRUM_MODES,
  type SpectrumMode,
  assFromRgb,
  hexFromRgb,
  hslFromRgb,
  hsvFromRgb,
  rgbFromHex,
  rgbFromHsv,
  roundedHsl,
  roundedHsv,
  type Hsv,
} from "../colour";
import {
  characterLimit,
  fieldValues,
  characterCount,
  lengthOf,
  MAX_TIME_MS,
  parseTimecode,
  readingRate,
  refusedFieldValue,
  timecode,
  trimmedFieldValue,
  type FieldRefusal,
} from "./cueView";

type CurrentLineProps = {
  /** Says something on the status bar's timed slot. See interface-spec 1.5. */
  onNotice: (text: string) => void;
  /** Which way the picker draws its square, remembered in the layout (N53). */
  spectrumMode: SpectrumMode;
  /** The reading rate a line is flagged above, from the preferences (N103). */
  cpsLimit: number;
  onSpectrumMode: (mode: SpectrumMode) => void;
  /** The row the cursor is on, or null while the document has none. */
  index: number | null;
  cue: CueRow | null;
  /** ASS writes line breaks as `\N` inside one field, so a real one cannot be committed there. */
  multiline: boolean;
  /**
   * Filled with a function that sends whatever the box holds. A save must write what the user
   * typed, whichever way the save was asked for. See BACKLOG.md M2.3.
   */
  flushRef: { current: () => Promise<void> };
  /**
   * Filled with a function that opens one colour's picker, so the four registry commands reach the
   * same popover the buttons do rather than opening a second one of their own (N112).
   */
  openColourRef: { current: (slot: ColourSlot) => void };
  /** Told whenever the box holds text the document does not: that is unsaved work too. */
  onDraftChange: (pending: boolean) => void;
  /**
   * Where the selection is in the text box, as UTF-8 byte offsets, which is what a split and a
   * style toggle both count in. Reported rather than read back later because the click that acts
   * on it blurs the box first.
   */
  onCaret: (from: number, to: number) => void;
  onCommit: (cue: number, text: string) => Promise<void>;
  onCommitTimes: (cue: number, startMs: number, endMs: number) => Promise<void>;
  /** Every row of the open document, for the speakers it already names. See D6. */
  cues: CueRow[];
  /** One line's field. A selection write is a loop over this one and waits on the owner (D5). */
  onCommitField: (cue: number, field: AssFieldName, value: string) => Promise<void>;
  /** The command registry, so the panel's own buttons grey and run by the same rule (decision 24). */
  commands: CommandRegistry;
  /** The names the document's styles section declares, in its own order. See edit-bar-tasks C5. */
  styles: string[];
  /** Open the editor over the style the line names. Greyed on a row that names none (B10). */
  onEditStyle: () => void;
  /** Whether the format has a descriptor at all: only ASS has one, so only ASS can be commented. */
  canComment: boolean;
  onCommitComment: (cue: number, comment: boolean) => Promise<void>;
  /** Whether there is a caret on this row to write at. Without one the colour buttons grey. */
  canWriteTag: boolean;
  /** Several override tags at one caret, as one step: a font is a family and a size. See B12. */
  onSetOverrideTags: (tags: [string, string][], at: number) => Promise<void>;
  /** Where the caret is, in the bytes of the line, or null while there is none on this row. */
  caretAt: number | null;
  /** The families installed on this machine, empty until the picker asks for them. */
  fonts: string[];
  fontsLoading: boolean;
  onLoadFonts: () => void;
};

/** The four colours a line can override, in the order row three of the reference draws them. */
export type ColourSlot = "primary" | "secondary" | "outline" | "shadow";

const COLOUR_SLOTS: { slot: ColourSlot; id: CommandId }[] = [
  { slot: "primary", id: "edit.colour-primary" },
  { slot: "secondary", id: "edit.colour-secondary" },
  { slot: "outline", id: "edit.colour-outline" },
  { slot: "shadow", id: "edit.colour-shadow" },
];

/** How many families the picker draws at once. A machine can have hundreds and a list that long
 * is not read, it is scrolled past: the field above it is what narrows it. */
const FAMILIES_SHOWN = 60;

/** The four style commands and the letter each is drawn as, in row three's order. */
const STYLE_GLYPHS: { id: CommandId; glyph: string }[] = [
  { id: "edit.style-bold", glyph: "B" },
  { id: "edit.style-italic", glyph: "I" },
  { id: "edit.style-underline", glyph: "U" },
  { id: "edit.style-strikeout", glyph: "S" },
];

/**
 * The tag each of them writes. The first is `\\c` and not `\\1c` because that is the spelling the
 * reference writes; a renderer reads the two as one colour.
 */
const COLOUR_TAGS: Record<ColourSlot, string> = {
  primary: "\\c",
  secondary: "\\2c",
  outline: "\\3c",
  shadow: "\\4c",
};

/**
 * The tag each one's transparency is written with. Numbered from one even where the colour is not:
 * the primary colour is `\\c` and its transparency is `\\1a`, which is the format's own spelling.
 */
const ALPHA_TAGS: Record<ColourSlot, string> = {
  primary: "\\1a",
  secondary: "\\2a",
  outline: "\\3a",
  shadow: "\\4a",
};

/**
 * ASS writes transparency and not opacity: `&H00&` is solid and `&HFF&` is invisible. Null when the
 * text is not a whole number in range, which is what keeps a half-typed one out of the line.
 */
function assAlpha(typed: string): string | null {
  const wanted = Number(typed.trim());
  if (!Number.isInteger(wanted) || wanted < 0 || wanted > 255) {
    return null;
  }
  return `&H${wanted.toString(16).toUpperCase().padStart(2, "0")}&`;
}

/** What the picker offers without typing: the sixteen a subtitle is actually coloured with. */
/** How many pixels each side of the painted square is. The reference paints 256; this is the same
 * square at the size the panel gives it, and the axes are fractions either way. */
const SQUARE_SIZE = 128;

const PALETTE = [
  "#FFFFFF",
  "#C0C0C0",
  "#808080",
  "#000000",
  "#FF0000",
  "#800000",
  "#FFFF00",
  "#808000",
  "#00FF00",
  "#008000",
  "#00FFFF",
  "#008080",
  "#0000FF",
  "#000080",
  "#FF00FF",
  "#800080",
];

/**
 * ASS writes a colour blue first, so `#RRGGBB` is written `&HBBGGRR&`. Null when the text is not
 * six hexadecimal digits, which is what keeps a half-typed value out of the line.
 */
function assColour(hex: string): string | null {
  const found = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (found === null) {
    return null;
  }
  const digits = found[1].toUpperCase();
  return `&H${digits.slice(4, 6)}${digits.slice(2, 4)}${digits.slice(0, 2)}&`;
}

/** The ASS fields the panel holds as a number: the drawing order and the three margins. */
type NumberField = "layer" | "marginL" | "marginR" | "marginV";

/**
 * What each of them may hold. The reference clamps rather than refuses here, and its ranges are the
 * ones below: the layer spins between 0 and 999, and a margin takes five characters, which is
 * exactly -9999 at one end and 99999 at the other. A value outside them can only arrive by paste,
 * so the clamp guards what the keyboard cannot reach. See edit-bar-tasks.md 1.2 and C6.
 */
const NUMBER_BOUNDS: Record<NumberField, { min: number; max: number }> = {
  layer: { min: 0, max: 999 },
  marginL: { min: -9999, max: 99999 },
  marginR: { min: -9999, max: 99999 },
  marginV: { min: -9999, max: 99999 },
};

/** The order they are drawn in, which is the order the reference's row two puts them in. */
const MARGIN_FIELDS: NumberField[] = ["marginL", "marginR", "marginV"];

/** Which of the three time fields a gesture is in. CPS stays derived and read-only. */
type TimeField = "start" | "end" | "length";

/**
 * The class each time field carries. The length keeps the name it had as read-only text, because
 * that is the selector the harness's contract lists and the value in it did not change.
 */
const TIME_CLASS: Record<TimeField, string> = {
  start: "currentline__start",
  end: "currentline__end",
  length: "currentline__duration",
};

/** The field points at its list and at the name under the keyboard, so both are named once here. */
/** The two fields drawn as a combo: free text with the values the document already uses beside it. */
type ComboField = "actor" | "effect";

/** Row one draws them in this order, between the style controls and the count. */
const COMBO_FIELDS: ComboField[] = ["actor", "effect"];

const LIST_ID = "currentline-combo-list";
const OPTION_ID = "currentline-combo-value-";

/** The two combo fields as the document holds them. */
function cueCombos(cue: CueRow | null): Record<ComboField, string> {
  return { actor: cue?.actor ?? "", effect: cue?.effect ?? "" };
}

/** The four numeric fields as the document holds them, in the order they are drawn. */
function cueNumbers(cue: CueRow | null): Record<NumberField, string> {
  return {
    layer: cue?.layer ?? "",
    marginL: cue?.marginL ?? "",
    marginR: cue?.marginR ?? "",
    marginV: cue?.marginV ?? "",
  };
}

/**
 * What a typed number commits, or null when it commits nothing. An empty field is the format's own
 * "default from style", which is 0 and is a real edit; anything that is not a whole number is
 * refused where it stands, the way the time fields are; a number outside the field's range is
 * clamped rather than refused, which is the reference's answer. See C6.
 */
function committedNumber(field: NumberField, typed: string): string | null {
  const value = typed.trim();
  if (value === "") {
    return "0";
  }
  if (!/^-?\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return null;
  }
  const { min, max } = NUMBER_BOUNDS[field];
  return String(Math.min(Math.max(parsed, min), max));
}

const encoder = new TextEncoder();

/** A caret at `at` UTF-16 units into `text`, counted in the bytes the backend indexes text by. */
function byteOffset(text: string, at: number): number {
  return encoder.encode(text.slice(0, at)).length;
}

/**
 * The current line, in the tools column under where the waveform will be. It edits whichever row
 * carries the cursor, through the one command the grid's own editor commits with (T5).
 *
 * The waveform is not above it and no placeholder stands in for it: there is no audio provider
 * before M2.4, and a panel with no provider takes no space.
 */
export default function CurrentLine({
  onNotice,
  spectrumMode,
  cpsLimit,
  onSpectrumMode,
  index,
  cue,
  multiline,
  flushRef,
  openColourRef,
  onDraftChange,
  onCaret,
  onCommit,
  onCommitTimes,
  cues,
  onCommitField,
  commands,
  canWriteTag,
  onSetOverrideTags,
  caretAt,
  fonts,
  fontsLoading,
  onLoadFonts,
  styles,
  onEditStyle,
  canComment,
  onCommitComment,
}: CurrentLineProps) {
  const text = cue?.text ?? "";
  const startMs = cue?.startMs ?? 0;
  const endMs = cue?.endMs ?? 0;
  const [draft, setDraft] = useState(text);
  const [times, setTimes] = useState({
    start: timecode(startMs),
    end: timecode(endMs),
    length: lengthOf(startMs, endMs),
  });
  /** What the box last drew, so a cursor move or a change from elsewhere re-seeds it. */
  const [shown, setShown] = useState({ index, text });
  /** The same for the two time fields, tracked apart so committing one never re-seeds the other. */
  const [shownTimes, setShownTimes] = useState({ index, startMs, endMs });
  /**
   * What the box holds and the row it belongs to. A ref, because the blur that commits it arrives
   * after the click that caused it has already moved the cursor.
   */
  const pending = useRef<{ index: number; was: string; text: string } | null>(null);
  /** The same, for the pair of times: they travel together, in the one command that takes both. */
  const pendingTimes = useRef<{ index: number; startMs: number; endMs: number } | null>(null);
  /**
   * The four numeric fields, held together and committed one at a time: they share a shape and a
   * refusal, and each is its own undo step. Tracked apart from the times for the same reason the
   * times are tracked apart from the text.
   */
  const [numbers, setNumbers] = useState(() => cueNumbers(cue));
  const [shownNumbers, setShownNumbers] = useState({ index, values: cueNumbers(cue) });
  const pendingNumbers = useRef<Partial<Record<NumberField, { index: number; value: string }>>>({});
  /** And for the combos, which commit on blur and on Enter exactly as the times do (section 4). */
  const [combos, setCombos] = useState(() => cueCombos(cue));
  const [shownCombos, setShownCombos] = useState({ index, values: cueCombos(cue) });
  const pendingCombos = useRef<Partial<Record<ComboField, { index: number; value: string }>>>({});
  /** Why the value in the field cannot be written, said where the field stands. Null when it can. */
  const [refusal, setRefusal] = useState<FieldRefusal | null>(null);
  /** Where the list is drawn, and null while it is closed. Fixed, so the panel cannot clip it. */
  const [listAt, setListAt] = useState<{
    field: ComboField;
    left: number;
    top: number;
    width: number;
  } | null>(null);
  const [highlight, setHighlight] = useState(0);
  /** Which colour the picker is open on and where it is drawn. Null while it is closed. */
  const [colourAt, setColourAt] = useState<{
    slot: ColourSlot;
    left: number;
    top: number;
  } | null>(null);
  /** What the picker's own field holds, kept between openings so a colour is typed once. */
  const [hex, setHex] = useState(PALETTE[0]);
  /**
   * The picker's own position, in HSV. Held rather than derived from `hex` on every render, because
   * a grey has no hue: derived, the slider would swing to red the moment white was picked (C5).
   */
  const [hsv, setHsv] = useState<Hsv>(() =>
    hsvFromRgb(rgbFromHex(PALETTE[0]) ?? { r: 0, g: 0, b: 0 }),
  );
  /** True while the square or the hue slider is being dragged, so a release can apply once. */
  const dragging = useRef<"square" | "hue" | null>(null);
  /**
   * The colour the picker has moved to, read by the release that writes it.
   *
   * A ref rather than the `hex` state: a pointer released before React has committed the move would
   * hand the writer the colour from the render before it, so the square would draw one colour and
   * the line would take another. Found by the check, not by review.
   */
  const moved = useRef(PALETTE[0]);
  const squareRef = useRef<HTMLCanvasElement>(null);
  const sliderRef = useRef<HTMLCanvasElement>(null);
  /** The transparency beside it. Empty on purpose: an empty field writes no transparency at all. */
  const [alpha, setAlpha] = useState("");
  const pickerRef = useRef<HTMLDivElement | null>(null);
  /** Where the font picker is drawn, and null while it is closed. */
  const [fontAt, setFontAt] = useState<{ left: number; top: number } | null>(null);
  /** What the picker's two fields hold. An empty size writes no size at all. */
  const [family, setFamily] = useState("");
  const [size, setSize] = useState("");
  const fontRef = useRef<HTMLDivElement | null>(null);
  const comboRefs = useRef<Partial<Record<ComboField, HTMLSpanElement | null>>>({});
  const values = useMemo(
    () => ({ actor: fieldValues(cues, "actor"), effect: fieldValues(cues, "effect") }),
    [cues],
  );

  // The box and the grid's inline editor are two views of the active row, not two states: the one
  // without the keyboard shows what the document holds (decision 5).
  if (shown.index !== index || shown.text !== text) {
    setShown({ index, text });
    setDraft(text);
  }
  if (shownTimes.index !== index || shownTimes.startMs !== startMs || shownTimes.endMs !== endMs) {
    setShownTimes({ index, startMs, endMs });
    setTimes({
      start: timecode(startMs),
      end: timecode(endMs),
      length: lengthOf(startMs, endMs),
    });
  }
  // Tracked apart from the times for the same reason they are tracked apart from the text: an undo
  // elsewhere, or the cursor moving, re-seeds this field without disturbing the others.
  const held = cueNumbers(cue);
  if (
    shownNumbers.index !== index ||
    MARGIN_FIELDS.concat("layer").some((field) => shownNumbers.values[field] !== held[field])
  ) {
    setShownNumbers({ index, values: held });
    setNumbers(held);
    pendingNumbers.current = {};
  }
  const heldCombos = cueCombos(cue);
  if (
    shownCombos.index !== index ||
    COMBO_FIELDS.some((field) => shownCombos.values[field] !== heldCombos[field])
  ) {
    setShownCombos({ index, values: heldCombos });
    setCombos(heldCombos);
    setRefusal(null);
    setListAt(null);
    pendingCombos.current = {};
  }

  /** Send what the box holds, if it belongs to a row and actually differs from it. */
  const commit = useCallback(async () => {
    const held = pending.current;
    pending.current = null;
    if (held === null || held.text === held.was) {
      return;
    }
    await onCommit(held.index, held.text);
  }, [onCommit]);

  /** Send the pair, if both fields are times and at least one of them moved. */
  const commitTimes = useCallback(async () => {
    const held = pendingTimes.current;
    pendingTimes.current = null;
    if (held === null) {
      return;
    }
    await onCommitTimes(held.index, held.startMs, held.endMs);
  }, [onCommitTimes]);

  /**
   * Send one numeric field, if it belongs to a row and holds something the file can take. Each is
   * its own call and therefore its own undo step, which is what C8.3 asks of these fields.
   */
  const commitNumber = useCallback(
    async (field: NumberField, restoreTo?: string) => {
      const waiting = pendingNumbers.current[field];
      pendingNumbers.current = { ...pendingNumbers.current, [field]: undefined };
      if (waiting === undefined) {
        // Nothing to send. On the way out of the field it goes back to what the document holds, so
        // a box emptied over a zero does not sit there showing nothing the file has. See C6.4.
        if (restoreTo !== undefined) {
          setNumbers((current) => ({ ...current, [field]: restoreTo }));
        }
        return;
      }
      await onCommitField(waiting.index, field, waiting.value);
    },
    [onCommitField],
  );

  /** Send one combo field, if it belongs to a row and the value is one the file can hold. */
  const commitCombo = useCallback(
    async (field: ComboField) => {
      const waiting = pendingCombos.current[field];
      pendingCombos.current = { ...pendingCombos.current, [field]: undefined };
      if (waiting === undefined) {
        return;
      }
      await onCommitField(waiting.index, field, waiting.value);
    },
    [onCommitField],
  );

  // The window shortcuts and the toolbar flush every editor, so "save" means one thing wherever it
  // was asked for. Times as well as text: an uncommitted time is unsaved work the same way.
  useEffect(() => {
    flushRef.current = async () => {
      await commit();
      await commitTimes();
      for (const field of COMBO_FIELDS) {
        await commitCombo(field);
      }
      for (const field of ["layer", ...MARGIN_FIELDS] as NumberField[]) {
        await commitNumber(field);
      }
    };
  });

  // The picker takes the focus when it opens, so Escape closes it however it was opened: its own
  // handler is on the picker, and a command run from the keyboard leaves the caret in the text box,
  // which is outside it (N112).
  useEffect(() => {
    if (colourAt === null) {
      return;
    }
    pickerRef.current?.focus();
  }, [colourAt]);

  // The four colour commands open the picker over the button that colour already has, which is on
  // screen whenever they are enabled: the same `canWriteTag` gates both, so there is no second
  // placement rule to keep in step (N112).
  useEffect(() => {
    openColourRef.current = (slot) => {
      const button = document.querySelector(`.currentline__colour-${slot}`);
      if (button === null) {
        return;
      }
      const box = button.getBoundingClientRect();
      setColourAt({ slot, left: box.left, top: box.bottom });
    };
  });

  // A list drawn at coordinates taken when it opened cannot follow the panel underneath it, so it
  // closes rather than hanging over a row it no longer belongs to.
  useEffect(() => {
    if (listAt === null) {
      return;
    }
    const close = () => setListAt(null);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [listAt]);

  // The pickers are anchored to a button on one row, so the cursor leaving that row closes them.
  useEffect(() => {
    setColourAt(null);
    setFontAt(null);
  }, [index]);

  // The same rule the colour picker follows, over the button that opens this one.
  useEffect(() => {
    if (fontAt === null) {
      return;
    }
    const close = () => setFontAt(null);
    const away = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        close();
        return;
      }
      const onOpener = target instanceof Element && target.closest(".currentline__font") !== null;
      if (fontRef.current?.contains(target) !== true && !onOpener) {
        close();
      }
    };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("pointerdown", away, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("pointerdown", away, true);
    };
  }, [fontAt]);

  // Drawn at coordinates taken when it opened, so it closes rather than hanging over the panel it
  // no longer belongs to. A press anywhere but inside it, or on the button that opened it, closes
  // it too: the button's own click is what reopens it.
  useEffect(() => {
    if (colourAt === null) {
      return;
    }
    const close = () => setColourAt(null);
    const away = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        close();
        return;
      }
      const onOpener = target instanceof Element && target.closest(".currentline__colour") !== null;
      if (pickerRef.current?.contains(target) !== true && !onOpener) {
        close();
      }
    };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("pointerdown", away, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("pointerdown", away, true);
    };
  }, [colourAt]);

  const timesEdited =
    times.start !== timecode(startMs) ||
    times.end !== timecode(endMs) ||
    times.length !== lengthOf(startMs, endMs);
  // The speaker counts the same way the times do, and by the same rule: text in a field the
  // document does not hold is unsaved work whether or not it can be written yet. See E4.8.
  const combosEdited = COMBO_FIELDS.some((field) => combos[field] !== heldCombos[field]);
  const numbersEdited = (["layer", ...MARGIN_FIELDS] as NumberField[]).some(
    (field) => numbers[field] !== held[field],
  );
  useEffect(() => {
    onDraftChange(draft !== text || timesEdited || combosEdited || numbersEdited);
  }, [draft, text, timesEdited, combosEdited, numbersEdited, onDraftChange]);

  /** A range reports where it starts, which is where the text would divide. */
  function reportCaret(box: HTMLTextAreaElement) {
    // Both ends, because a style toggle wraps a selection and a split needs only the near one.
    onCaret(byteOffset(box.value, box.selectionStart), byteOffset(box.value, box.selectionEnd));
  }

  function onType(value: string) {
    setDraft(value);
    // Guarded rather than assumed: the box is only enabled over a row, and the ref outlives the
    // render that produced it.
    if (index !== null) {
      pending.current = { index, was: text, text: value };
    }
  }

  function onTypeTime(field: TimeField, value: string) {
    const next = { ...times, [field]: value };
    const typedStart = parseTimecode(next.start);
    // The command takes the pair, so the third field is carried onto one of the two rather than
    // sent on its own: a typed length moves the end and leaves the start where it is (C2.1), and a
    // typed start or end moves the length the same way round.
    if (field === "length") {
      const span = parseTimecode(next.length);
      if (typedStart !== null && span !== null && typedStart + span <= MAX_TIME_MS) {
        next.end = timecode(typedStart + span);
      }
    } else {
      const typedEnd = parseTimecode(next.end);
      if (typedStart !== null && typedEnd !== null && typedEnd >= typedStart) {
        next.length = lengthOf(typedStart, typedEnd);
      }
    }
    setTimes(next);
    const start = parseTimecode(next.start);
    const end = parseTimecode(next.end);
    // A field that is not a time is never sent: it leaves the document alone and shows itself.
    if (index === null || start === null || end === null || (start === startMs && end === endMs)) {
      pendingTimes.current = null;
      return;
    }
    pendingTimes.current = { index, startMs: start, endMs: end };
  }

  /**
   * The value is tested here rather than sent and refused, so the sentence names the comma where
   * the field stands and the document is provably never asked. A refused value stays in the field
   * so it can be corrected (E4.1 and E4.6).
   */
  function onTypeCombo(field: ComboField, value: string) {
    setCombos((current) => ({ ...current, [field]: value }));
    // Typing is the other way into the field, so the list stops standing: with it open Enter picks
    // the highlighted value, and a translator typing a new one would commit a different one (E2.7).
    setListAt(null);
    setRefusal(holdCombo(field, value));
  }

  /** What a value does to the pending write, and the refusal it carries. Shared by typing and
   * picking, because a picked value is tested exactly as a typed one is (E4.6). */
  function holdCombo(field: ComboField, value: string): FieldRefusal | null {
    const refused = refusedFieldValue(value);
    // Trimmed the way the document's reader trims it, so typing a stray space around the value the
    // field already holds writes nothing rather than a byte the panel never shows (E4.7).
    const written = trimmedFieldValue(value);
    if (index === null || refused !== null || written === heldCombos[field]) {
      pendingCombos.current = { ...pendingCombos.current, [field]: undefined };
      return refused;
    }
    pendingCombos.current = { ...pendingCombos.current, [field]: { index, value: written } };
    return refused;
  }

  /** Put the list where the field is, in the viewport's own coordinates. */
  function openList(field: ComboField) {
    const box = comboRefs.current[field]?.getBoundingClientRect();
    if (box === undefined || values[field].length === 0) {
      return;
    }
    setListAt({ field, left: box.left, top: box.bottom, width: box.width });
    setHighlight(Math.max(0, values[field].indexOf(combos[field])));
  }

  /** Picking puts the value in the field and commits it in the one gesture (E2.6). */
  async function pickValue(field: ComboField, value: string) {
    setListAt(null);
    setCombos((current) => ({ ...current, [field]: value }));
    setRefusal(holdCombo(field, value));
    await commitCombo(field);
  }

  function onTypeNumber(field: NumberField, value: string) {
    setNumbers((current) => ({ ...current, [field]: value }));
    const written = committedNumber(field, value);
    // A value the field cannot send is never sent: it stays in the box and the box says so.
    if (index === null || written === null || written === held[field]) {
      pendingNumbers.current = { ...pendingNumbers.current, [field]: undefined };
      return;
    }
    pendingNumbers.current = { ...pendingNumbers.current, [field]: { index, value: written } };
  }

  function onNumberKeyDown(field: NumberField, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      pendingNumbers.current = { ...pendingNumbers.current, [field]: undefined };
      setNumbers((current) => ({ ...current, [field]: held[field] }));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void commitNumber(field);
    }
  }

  function onComboKeyDown(field: ComboField, event: KeyboardEvent<HTMLInputElement>) {
    const list = values[field];
    if (event.key === "Escape") {
      event.preventDefault();
      // An open list is what Escape closes first; a second one puts the field back (E2.4).
      if (listAt !== null) {
        setListAt(null);
        return;
      }
      pendingCombos.current = { ...pendingCombos.current, [field]: undefined };
      setCombos((current) => ({ ...current, [field]: heldCombos[field] }));
      setRefusal(null);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (listAt === null) {
        openList(field);
        return;
      }
      // Guarded rather than assumed: the document can change under an open list, and a modulo by
      // an empty list is not a number.
      if (list.length === 0) {
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : list.length - 1;
      setHighlight((at) => (at + step) % list.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const picked = listAt === null ? undefined : list[highlight];
      if (picked !== undefined) {
        void pickValue(field, picked);
        return;
      }
      void commitCombo(field);
    }
  }

  function onEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      pending.current = null;
      setDraft(text);
      return;
    }
    if (event.key === "Enter") {
      if (event.shiftKey && multiline) {
        return;
      }
      event.preventDefault();
      // Commit and go on, which is what the reference binds Return to in its own box: the command
      // flushes the editors before it moves, so nothing typed is lost, and on the last line it
      // makes the next one. Shift keeps the real line break where the format holds one (N113).
      runCommand(commands, "subtitle.next-line");
    }
  }

  function onTimeKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      pendingTimes.current = null;
      setTimes({
        start: timecode(startMs),
        end: timecode(endMs),
        length: lengthOf(startMs, endMs),
      });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void commitTimes();
    }
  }

  // Above the early return below, and it has to be: a hook underneath it stops existing the
  // moment the panel has no line, and the render after one appears then has more hooks than the
  // one before it. That is React error #310, and it is what this was.
  /** Where the picker's colour sits in the mode being drawn. */
  const place = positionIn(spectrumMode, hsv);
  const { x: squareX, y: squareY, slider: sliderAt } = place;

  // Painted rather than stacked out of gradients: three of the five modes are a sum of two channels
  // over a third, which gradients cannot express, and the reference fills a bitmap for the same
  // reason. Redrawn when the mode changes and when the slider moves, because the slider is what the
  // square is drawn against.
  useEffect(() => {
    const square = squareRef.current?.getContext("2d");
    if (square != null) {
      const image = square.createImageData(SQUARE_SIZE, SQUARE_SIZE);
      for (let y = 0; y < SQUARE_SIZE; y += 1) {
        for (let x = 0; x < SQUARE_SIZE; x += 1) {
          const shade = colourInMode(spectrumMode, {
            x: x / (SQUARE_SIZE - 1),
            y: y / (SQUARE_SIZE - 1),
            slider: sliderAt,
          });
          const at = (y * SQUARE_SIZE + x) * 4;
          image.data[at] = shade.r;
          image.data[at + 1] = shade.g;
          image.data[at + 2] = shade.b;
          image.data[at + 3] = 255;
        }
      }
      square.putImageData(image, 0, 0);
    }
    const bar = sliderRef.current?.getContext("2d");
    if (bar != null) {
      const image = bar.createImageData(1, SQUARE_SIZE);
      for (let y = 0; y < SQUARE_SIZE; y += 1) {
        const shade = colourInMode(spectrumMode, {
          x: squareX,
          y: squareY,
          slider: y / (SQUARE_SIZE - 1),
        });
        image.data[y * 4] = shade.r;
        image.data[y * 4 + 1] = shade.g;
        image.data[y * 4 + 2] = shade.b;
        image.data[y * 4 + 3] = 255;
      }
      bar.putImageData(image, 0, 0);
    }
  }, [spectrumMode, sliderAt, squareX, squareY]);

  if (cue === null) {
    return (
      <section className="currentline" aria-label={en.subtitle.currentLine.label}>
        <p className="currentline__empty">{en.subtitle.currentLine.none}</p>
      </section>
    );
  }

  const rate = readingRate(cue);
  const cpsClasses = ["currentline__cps"];
  if (rate !== null && rate > cpsLimit) {
    cpsClasses.push("currentline__cps--over");
  }
  // Off the draft and not off the document: the number is a measure of the text, and the text a
  // translator is judging is the one under their hands. See edit-bar-first-tasks.md E1.3.
  const characters = characterCount(draft);
  const charClasses = ["currentline__chars"];
  if (characters > characterLimit(cpsLimit)) {
    charClasses.push("currentline__chars--over");
  }

  /**
   * Whether the field holds something that cannot be sent. Not a time, or, for the length, a length
   * that carries the end past what the command's parameter can hold (C2.7).
   */
  function timeRefused(field: TimeField, value: string): boolean {
    const parsed = parseTimecode(value);
    if (parsed === null) {
      return true;
    }
    if (field !== "length") {
      return false;
    }
    const from = parseTimecode(times.start);
    return from === null || from + parsed > MAX_TIME_MS;
  }

  /** A field that is not a time says so where it is, rather than in the line across the bottom. */
  function timeField(field: TimeField, label: string) {
    const value = times[field];
    const bad = timeRefused(field, value);
    const classes = ["currentline__time", TIME_CLASS[field]];
    if (bad) {
      classes.push("currentline__time--invalid");
    }
    return (
      <span className="currentline__field">
        <span className="currentline__label">{label}</span>
        <input
          className={classes.join(" ")}
          aria-label={label}
          aria-invalid={bad}
          data-document-editor=""
          value={value}
          spellCheck={false}
          onChange={(event) => onTypeTime(field, event.target.value)}
          onKeyDown={onTimeKeyDown}
          onBlur={() => void commitTimes()}
        />
      </span>
    );
  }

  /**
   * One of the four numeric fields. Drawn and greyed on a row whose `Format:` line does not declare
   * it, never absent (E3.1), and it says so where it stands when it holds something unsendable.
   */
  function numberField(field: NumberField, label: string, spoken = label) {
    const value = numbers[field];
    const can = cue !== null && cue.declaredFields.includes(field);
    const bad = can && committedNumber(field, value) === null;
    const classes = ["currentline__number", `currentline__${field.toLowerCase()}`];
    if (bad) {
      classes.push("currentline__time--invalid");
    }
    return (
      <span className="currentline__field">
        <span className="currentline__label">{label}</span>
        <input
          className={classes.join(" ")}
          aria-label={spoken}
          aria-invalid={bad}
          data-document-editor=""
          disabled={!can}
          // Five characters is exactly `-9999` and exactly `99999`, so the keyboard reaches both
          // ends of the range and can never cross one. See edit-bar-tasks.md 1.2.
          maxLength={5}
          value={value}
          spellCheck={false}
          onChange={(event) => onTypeNumber(field, event.target.value)}
          onKeyDown={(event) => onNumberKeyDown(field, event)}
          onBlur={() => void commitNumber(field, held[field])}
        />
      </span>
    );
  }

  /**
   * Whether the line is one a player draws. First in row one, and a checkbox rather than a field
   * because it is a flag: it commits the moment it is toggled and is its own undo step. Drawn and
   * greyed on a format that has no such distinction, never absent (E3.1).
   */
  function commentField() {
    const label = en.subtitle.currentLine.comment;
    return (
      <span className="currentline__field">
        <input
          type="checkbox"
          className="currentline__comment"
          aria-label={label}
          data-document-editor=""
          disabled={!canComment || cue === null}
          checked={cue?.comment ?? false}
          onChange={(event) => {
            if (index !== null) {
              void onCommitComment(index, event.target.checked);
            }
          }}
        />
        <span className="currentline__label">{label}</span>
      </span>
    );
  }

  /**
   * The style the line names, picked from the ones the document declares. A closed list: a name the
   * file does not define is still shown, because the file holds it, and cannot be chosen. Drawn and
   * greyed on a row whose `Format:` line cannot hold one, never absent (E3.1).
   */
  function styleField() {
    const label = en.subtitle.currentLine.style;
    const can = cue !== null && cue.declaredFields.includes("style");
    const held = cue?.style ?? "";
    // The held name first when the file does not declare it: the control may never show a value the
    // document does not have, and never invent one it does not. See C6.1.
    const options = held === "" || styles.includes(held) ? styles : [held, ...styles];
    return (
      <span className="currentline__field">
        <span className="currentline__label">{label}</span>
        <select
          className="currentline__style"
          aria-label={label}
          data-document-editor=""
          disabled={!can || options.length === 0}
          value={held}
          onChange={(event) => {
            if (index !== null) {
              void onCommitField(index, "style", event.target.value);
            }
          }}
        >
          {options.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </span>
    );
  }

  /**
   * Write one colour where the caret is, with its transparency when one was typed, and close.
   *
   * A colour short of six digits writes nothing, and so does a transparency that is not a whole
   * number between 0 and 255: a half-typed field must not reach the line. The two go together as
   * one step, because choosing a colour is one thing a translator did. See B12.
   */
  /** Move the picker to a colour without writing it: the fields and the preview follow, the line
   * does not. Writing happens when a gesture ends or a field is confirmed. */
  function moveTo(next: Hsv) {
    setHsv(next);
    const written = hexFromRgb(rgbFromHsv(next));
    moved.current = written;
    setHex(written);
  }

  /**
   * The colour under a pixel of the screen, asked of the desktop portal. Where there is no portal
   * the panel says so rather than reading the screen itself: under XWayland an X11 grab sees X
   * windows and not Wayland ones, so it would answer with the wrong colour and no warning.
   * See BACKLOG.md N54.
   */
  async function pickFromScreen() {
    const picked = await invoke<
      { kind: "colour"; hex: string } | { kind: "cancelled" } | { kind: "unavailable" }
    >("eyedropper_pick").catch(() => ({ kind: "unavailable" }) as const);
    if (picked.kind === "colour") {
      typedColour(picked.hex);
      return;
    }
    if (picked.kind === "unavailable") {
      onNotice(en.subtitle.currentLine.eyedropperUnavailable);
    }
  }

  /** A point in the square, read as the colour that mode puts there. */
  function fromSquare(at: { x: number; y: number }) {
    moveTo(
      hsvFromRgb(colourInMode(spectrumMode, { x: at.x, y: at.y, slider: place.slider }), hsv.h),
    );
  }

  /** A point on the slider, read the same way. */
  function fromSlider(slider: number) {
    moveTo(hsvFromRgb(colourInMode(spectrumMode, { x: place.x, y: place.y, slider }), hsv.h));
  }

  /** Where a pointer landed inside a box, as a fraction of it in each direction. */
  function fractionIn(event: ReactPointerEvent<HTMLElement>): { x: number; y: number } {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: box.width === 0 ? 0 : Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      y: box.height === 0 ? 0 : Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
    };
  }

  /** A typed notation, whatever it was typed in, moved onto the picker. Keeps the hue a grey has
   * none of, which is the whole reason the position is held rather than derived. */
  function typedColour(value: string) {
    const rgb = rgbFromHex(value);
    if (rgb === null) {
      return;
    }
    setHsv(hsvFromRgb(rgb, hsv.h));
    setHex(
      value.trim().toUpperCase().startsWith("#")
        ? value.trim().toUpperCase()
        : `#${value.trim().toUpperCase()}`,
    );
  }

  /** `keepOpen` is what a drag inside the picker wants: the colour reaches the line and the picker
   * stays up, so the next adjustment is one gesture rather than a reopen. */
  async function pickColour(slot: ColourSlot, value: string, keepOpen = false) {
    const written = assColour(value);
    if (written === null) {
      return;
    }
    const typed = alpha.trim();
    const transparency = typed === "" ? null : assAlpha(typed);
    if (typed !== "" && transparency === null) {
      return;
    }
    const trimmed = value.trim().toUpperCase();
    setHex(trimmed.startsWith("#") ? trimmed : `#${trimmed}`);
    if (!keepOpen) {
      setColourAt(null);
    }
    const tags: [string, string][] = [[COLOUR_TAGS[slot], written]];
    if (transparency !== null) {
      tags.push([ALPHA_TAGS[slot], transparency]);
    }
    if (caretAt === null) {
      return;
    }
    await onSetOverrideTags(tags, caretAt);
  }

  /**
   * Write the family and, when one was typed, the size. One step, because choosing a font is one
   * thing a translator did and undoing it should not take two. See edit-bar-tasks.md B12.
   */
  async function pickFont() {
    const chosen = family.trim();
    if (chosen === "" || caretAt === null) {
      return;
    }
    const tags: [string, string][] = [["\\fn", chosen]];
    const typed = size.trim();
    if (typed !== "") {
      const number = Number(typed);
      if (!Number.isInteger(number) || number < 1 || number > 9999) {
        return;
      }
      tags.push(["\\fs", String(number)]);
    }
    setFontAt(null);
    await onSetOverrideTags(tags, caretAt);
  }

  /**
   * One colour, drawn as the button that opens the picker over it. The button greys and runs by the
   * registry's rule like every other command's button: pressing it a second time closes what it
   * opened, which is the button's own state and not a second way to run the command (N112).
   */
  function colourButton(slot: ColourSlot, id: CommandId) {
    const command = commands[id];
    if (command === undefined) {
      return null;
    }
    const open = colourAt !== null && colourAt.slot === slot;
    return (
      <button
        key={slot}
        type="button"
        className={`currentline__colour currentline__colour-${slot}`}
        // The colour's own name and not the command's: the menu item ends in an ellipsis because it
        // opens a picker, and the button that picker is drawn over does not, which is the same
        // distinction the reference draws between an item's label and a button's tooltip.
        aria-label={en.subtitle.currentLine.colours[slot]}
        aria-expanded={open}
        disabled={!command.enabled}
        onClick={() => {
          if (open) {
            setColourAt(null);
            return;
          }
          runCommand(commands, id);
        }}
      >
        <span aria-hidden="true">A</span>
      </button>
    );
  }

  /**
   * One of the four style commands, drawn the way row three of the reference draws it: a letter in
   * the style it writes, not the word. The command's own label stays as the button's spoken name.
   */
  function styleButton(id: CommandId, glyph: string) {
    const command = commands[id];
    if (command === undefined) {
      return null;
    }
    return (
      <button
        key={id}
        type="button"
        className={`currentline__command currentline__glyph currentline__${commandToken(id)}`}
        aria-label={command.label}
        disabled={!command.enabled}
        onClick={() => runCommand(commands, id)}
      >
        <span aria-hidden="true">{glyph}</span>
      </button>
    );
  }

  /** One command from the registry, drawn as a button that greys and runs by the registry's rule. */
  function commandButton(id: CommandId) {
    const command = commands[id];
    if (command === undefined) {
      return null;
    }
    return (
      <button
        type="button"
        className={`currentline__command currentline__${commandToken(id)}`}
        disabled={!command.enabled}
        onClick={() => runCommand(commands, id)}
      >
        {command.label}
      </button>
    );
  }

  /**
   * One combo: a text field with the values this document already uses beside it. Drawn and greyed
   * on a row whose `Format:` line cannot hold the field, never absent (E3.1).
   */
  function comboField(field: ComboField, label: string, opener: string) {
    const can = cue !== null && cue.declaredFields.includes(field);
    const list = values[field];
    const open = listAt !== null && listAt.field === field;
    return (
      <span className="currentline__field">
        <span className="currentline__label">{label}</span>
        <span
          className="currentline__combo"
          ref={(node) => {
            comboRefs.current[field] = node;
          }}
        >
          <input
            className={`currentline__${field}`}
            role="combobox"
            aria-label={label}
            aria-invalid={refusal !== null}
            aria-expanded={open}
            aria-controls={LIST_ID}
            aria-activedescendant={open ? `${OPTION_ID}${highlight}` : undefined}
            data-document-editor=""
            disabled={!can}
            value={combos[field]}
            spellCheck={false}
            onChange={(event) => onTypeCombo(field, event.target.value)}
            onKeyDown={(event) => onComboKeyDown(field, event)}
            onBlur={() => void commitCombo(field)}
          />
          <button
            type="button"
            className={`currentline__${field}-open`}
            aria-label={opener}
            aria-expanded={open}
            // Nothing to pick is nothing to open, so the opener greys while the field stays usable.
            disabled={!can || list.length === 0}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => (open ? setListAt(null) : openList(field))}
          />
        </span>
      </span>
    );
  }

  return (
    <section className="currentline" aria-label={en.subtitle.currentLine.label}>
      {/* Band 1, identity. The two measures of the text sit at its right end, where a translator
        glances rather than reaches. See edit-bar-first-tasks.md section 2. */}
      <div className="currentline__band currentline__identity">
        {commentField()}
        {styleField()}
        {/* Row one of the reference puts Edit right after the dropdown, not at the end (B10). */}
        <button
          type="button"
          className="currentline__command currentline__style-edit"
          disabled={cue === null || !styles.includes(cue.style)}
          onClick={onEditStyle}
        >
          {en.subtitle.styleEditor.edit}
        </button>
        {comboField("actor", en.subtitle.currentLine.actor, en.subtitle.currentLine.actorNames)}
        {comboField("effect", en.subtitle.currentLine.effect, en.subtitle.currentLine.effectValues)}
        <span className="currentline__field">
          <span className="currentline__label">{en.subtitle.currentLine.characters}</span>
          <span className={charClasses.join(" ")}>{characters}</span>
        </span>
        <span className="currentline__field">
          <span className="currentline__label">{en.subtitle.currentLine.cps}</span>
          <span className={cpsClasses.join(" ")}>{rate === null ? "" : Math.round(rate)}</span>
        </span>
      </div>
      {/* Under the band the field sits on, so the sentence is beside the value it is about. */}
      {refusal !== null && (
        <p className="currentline__refusal" role="alert">
          {en.subtitle.currentLine.refusals[refusal]}
        </p>
      )}
      {/* Band 2, numbers. The order is the reference's row two: the drawing order first, then the
        three times, then the three margins. See edit-bar-tasks.md 1.2. */}
      <div className="currentline__band currentline__times">
        {numberField("layer", en.subtitle.currentLine.layer)}
        {timeField("start", en.subtitle.currentLine.start)}
        {timeField("end", en.subtitle.currentLine.end)}
        {timeField("length", en.subtitle.currentLine.duration)}
        {numberField(
          "marginL",
          en.subtitle.currentLine.marginL,
          en.subtitle.currentLine.marginLName,
        )}
        {numberField(
          "marginR",
          en.subtitle.currentLine.marginR,
          en.subtitle.currentLine.marginRName,
        )}
        {numberField(
          "marginV",
          en.subtitle.currentLine.marginV,
          en.subtitle.currentLine.marginVName,
        )}
      </div>
      {/* Band 3, the commands the panel carries. Row three of the reference puts the style buttons
        first and Next line last, so it goes at the end and the others arrive before it. */}
      <div className="currentline__band currentline__actions">
        {/* Two groups of four, the way the reference draws them: buttons touching inside a group,
          with the band's own gap between the groups rather than between the buttons. */}
        <span className="currentline__group">
          {STYLE_GLYPHS.map(({ id, glyph }) => styleButton(id, glyph))}
          {/* Row three of the reference puts the font with the four flags and not with the
            colours, so it is the fifth button of this group and not the first of the next. */}
          <button
            type="button"
            className="currentline__command currentline__glyph currentline__font"
            aria-label={en.subtitle.currentLine.font}
            aria-expanded={fontAt !== null}
            disabled={!canWriteTag}
            onClick={(event) => {
              if (fontAt !== null) {
                setFontAt(null);
                return;
              }
              onLoadFonts();
              const box = event.currentTarget.getBoundingClientRect();
              setFontAt({ left: box.left, top: box.bottom });
            }}
          >
            <span aria-hidden="true">F</span>
          </button>
        </span>
        <span className="currentline__group">
          {COLOUR_SLOTS.map(({ slot, id }) => colourButton(slot, id))}
        </span>
        {commandButton("subtitle.next-line")}
      </div>
      <textarea
        className="currentline__text"
        aria-label={en.subtitle.currentLine.text}
        data-document-editor=""
        value={draft}
        spellCheck={false}
        onChange={(event) => {
          onType(event.target.value);
          reportCaret(event.target);
        }}
        onSelect={(event) => reportCaret(event.currentTarget)}
        onKeyDown={onEditorKeyDown}
        onBlur={() => void commit()}
      />
      {/* Outside the panel's flow, so the panel's own scroll can never clip it. `onMouseDown` is
        prevented so the field keeps the keyboard and the pick is one gesture, not a blur then a
        click. */}
      {listAt !== null && (
        <div
          className="currentline__actor-list"
          id={LIST_ID}
          role="listbox"
          aria-label={
            listAt.field === "actor"
              ? en.subtitle.currentLine.actorNames
              : en.subtitle.currentLine.effectValues
          }
          style={{ left: listAt.left, top: listAt.top, minWidth: listAt.width }}
        >
          {values[listAt.field].map((value, at) => (
            <button
              key={value}
              id={`${OPTION_ID}${at}`}
              type="button"
              role="option"
              aria-selected={at === highlight}
              className={
                at === highlight
                  ? "currentline__actor-name currentline__actor-name--on"
                  : "currentline__actor-name"
              }
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void pickValue(listAt.field, value)}
            >
              {value}
            </button>
          ))}
        </div>
      )}
      {/* Under the box, which is where the reference's own row of four sits: what the line was,
        two ways of emptying it, and the source's line put where the caret is. See B13. */}
      <div className="currentline__band currentline__bottom">
        {commandButton("edit.revert")}
        {commandButton("edit.clear")}
        {commandButton("edit.clear-text")}
        {commandButton("edit.insert-original")}
      </div>
      {fontAt !== null && (
        <div
          className="currentline__fonts"
          ref={fontRef}
          role="group"
          aria-label={en.subtitle.currentLine.font}
          style={{ left: fontAt.left, top: fontAt.top }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setFontAt(null);
            }
          }}
        >
          <input
            className="currentline__family"
            aria-label={en.subtitle.currentLine.fontFamily}
            data-document-editor=""
            value={family}
            spellCheck={false}
            onChange={(event) => setFamily(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void pickFont();
              }
            }}
          />
          {/* Every family the machine has, filtered by what is typed. A machine whose font
            directories could not be read shows none and the family is typed instead. */}
          <ul className="currentline__families" aria-label={en.subtitle.currentLine.fontFamilies}>
            {fontsLoading && <li className="currentline__families-note">{en.subtitle.reading}</li>}
            {fonts
              .filter((name) => name.toLowerCase().includes(family.trim().toLowerCase()))
              .slice(0, FAMILIES_SHOWN)
              .map((name) => (
                <li key={name}>
                  <button
                    type="button"
                    className="currentline__family-name"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setFamily(name)}
                  >
                    {name}
                  </button>
                </li>
              ))}
          </ul>
          <span className="currentline__field">
            <span className="currentline__label">{en.subtitle.currentLine.fontSize}</span>
            <input
              className="currentline__number currentline__fontsize"
              aria-label={en.subtitle.currentLine.fontSize}
              data-document-editor=""
              value={size}
              spellCheck={false}
              onChange={(event) => setSize(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void pickFont();
                }
              }}
            />
          </span>
          <button
            type="button"
            className="currentline__command currentline__font-apply"
            disabled={family.trim() === ""}
            onClick={() => void pickFont()}
          >
            {en.subtitle.currentLine.fontApply}
          </button>
        </div>
      )}
      {/* The same, over the panel: opened under the button it belongs to, closed by Escape, by a
        press outside it and by the cursor leaving the row it was opened on. */}
      {colourAt !== null && (
        <div
          className="currentline__picker"
          ref={pickerRef}
          role="group"
          // Focusable so a gesture inside it can put the focus here: after a drag on the square
          // nothing focusable has been touched, and Escape sent to the body closes nothing.
          tabIndex={-1}
          aria-label={en.subtitle.currentLine.colours[colourAt.slot]}
          style={{ left: colourAt.left, top: colourAt.top }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setColourAt(null);
            }
          }}
        >
          <label className="currentline__mode">
            <span>{en.subtitle.currentLine.spectrumMode}</span>
            <select
              className="currentline__mode-choice"
              value={spectrumMode}
              onChange={(event) => onSpectrumMode(event.target.value as SpectrumMode)}
            >
              {SPECTRUM_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {en.subtitle.currentLine.spectrumModes[mode]}
                </option>
              ))}
            </select>
          </label>
          <div className="currentline__spectrum">
            {/* Saturation across, value down, over the hue the slider holds. One gesture writes
              once: the drag moves the picker and the release puts it on the line. */}
            <div className="currentline__square-box">
              <canvas
                className="currentline__square"
                ref={squareRef}
                width={SQUARE_SIZE}
                height={SQUARE_SIZE}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  pickerRef.current?.focus();
                  dragging.current = "square";
                  fromSquare(fractionIn(event));
                }}
                onPointerMove={(event) => {
                  if (dragging.current === "square") {
                    fromSquare(fractionIn(event));
                  }
                }}
                onPointerUp={() => {
                  if (dragging.current !== "square") {
                    return;
                  }
                  dragging.current = null;
                  void pickColour(colourAt.slot, moved.current, true);
                }}
              />
              <span
                className="currentline__thumb currentline__square-thumb"
                style={{ left: `${place.x * 100}%`, top: `${place.y * 100}%` }}
              />
            </div>
            <div className="currentline__hue-box">
              <canvas
                className="currentline__hue"
                ref={sliderRef}
                width={1}
                height={SQUARE_SIZE}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  pickerRef.current?.focus();
                  dragging.current = "hue";
                  fromSlider(fractionIn(event).y);
                }}
                onPointerMove={(event) => {
                  if (dragging.current === "hue") {
                    fromSlider(fractionIn(event).y);
                  }
                }}
                onPointerUp={() => {
                  if (dragging.current !== "hue") {
                    return;
                  }
                  dragging.current = null;
                  void pickColour(colourAt.slot, moved.current, true);
                }}
              />
              <span
                className="currentline__thumb currentline__hue-thumb"
                style={{ top: `${place.slider * 100}%` }}
              />
            </div>
            <button
              type="button"
              className="currentline__dropper"
              title={en.subtitle.currentLine.eyedropper}
              aria-label={en.subtitle.currentLine.eyedropper}
              onClick={() => void pickFromScreen()}
            >
              {en.subtitle.currentLine.eyedropperMark}
            </button>
            <span
              className="currentline__preview"
              aria-label={en.subtitle.currentLine.colourPreview}
              style={{ background: hexFromRgb(rgbFromHsv(hsv)) }}
            />
          </div>
          <dl className="currentline__notations">
            <div className="currentline__notation currentline__ass">
              <dt>{en.subtitle.currentLine.assNotation}</dt>
              <dd>{assFromRgb(rgbFromHsv(hsv))}</dd>
            </div>
            <div className="currentline__notation currentline__rgb">
              <dt>{en.subtitle.currentLine.rgbNotation}</dt>
              <dd>{(({ r, g, b }) => `${r}, ${g}, ${b}`)(rgbFromHsv(hsv))}</dd>
            </div>
            <div className="currentline__notation currentline__hsv">
              <dt>{en.subtitle.currentLine.hsvNotation}</dt>
              <dd>{(({ h, s, v }) => `${h}, ${s}, ${v}`)(roundedHsv(hsv))}</dd>
            </div>
            <div className="currentline__notation currentline__hsl">
              <dt>{en.subtitle.currentLine.hslNotation}</dt>
              <dd>
                {(({ h, s, l }) => `${h}, ${s}, ${l}`)(
                  roundedHsl(hslFromRgb(rgbFromHsv(hsv), hsv.h)),
                )}
              </dd>
            </div>
          </dl>
          <div className="currentline__palette">
            {PALETTE.map((value) => (
              <button
                key={value}
                type="button"
                className="currentline__swatch"
                style={{ background: value }}
                aria-label={value}
                onClick={() => {
                  typedColour(value);
                  void pickColour(colourAt.slot, value);
                }}
              />
            ))}
          </div>
          <input
            className="currentline__hex"
            aria-label={en.subtitle.currentLine.colourValue}
            aria-invalid={assColour(hex) === null}
            data-document-editor=""
            value={hex}
            spellCheck={false}
            onChange={(event) => {
              setHex(event.target.value);
              typedColour(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void pickColour(colourAt.slot, hex);
              }
            }}
          />
          <span className="currentline__field">
            <span className="currentline__label">{en.subtitle.currentLine.transparency}</span>
            <input
              className="currentline__number currentline__alpha"
              aria-label={en.subtitle.currentLine.transparencyName}
              aria-invalid={alpha.trim() !== "" && assAlpha(alpha) === null}
              data-document-editor=""
              value={alpha}
              spellCheck={false}
              onChange={(event) => setAlpha(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void pickColour(colourAt.slot, hex);
                }
              }}
            />
          </span>
        </div>
      )}
    </section>
  );
}
