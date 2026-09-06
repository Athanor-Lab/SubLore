import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { en } from "../i18n/en";
import { type AssFieldName, type CueRow } from "../types/subtitle";
import {
  CHARACTER_LIMIT,
  CPS_LIMIT,
  actorNames,
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
  /** Told whenever the box holds text the document does not: that is unsaved work too. */
  onDraftChange: (pending: boolean) => void;
  /**
   * Where the caret is in the text box, as a UTF-8 byte offset, which is what a split counts in.
   * Reported rather than read back later because the click that splits blurs the box first.
   */
  onCaret: (offset: number) => void;
  onCommit: (cue: number, text: string) => Promise<void>;
  onCommitTimes: (cue: number, startMs: number, endMs: number) => Promise<void>;
  /** Every row of the open document, for the speakers it already names. See D6. */
  cues: CueRow[];
  /** One line's field. A selection write is a loop over this one and waits on the owner (D5). */
  onCommitField: (cue: number, field: AssFieldName, value: string) => Promise<void>;
};

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
const ACTOR_LIST_ID = "currentline-actor-list";
const ACTOR_OPTION_ID = "currentline-actor-name-";

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
  index,
  cue,
  multiline,
  flushRef,
  onDraftChange,
  onCaret,
  onCommit,
  onCommitTimes,
  cues,
  onCommitField,
}: CurrentLineProps) {
  const text = cue?.text ?? "";
  const startMs = cue?.startMs ?? 0;
  const endMs = cue?.endMs ?? 0;
  const actor = cue?.actor ?? "";
  /** A row that does not declare the field cannot hold one, so its control is greyed (E3). */
  const canActor = cue !== null && cue.declaredFields.includes("actor");
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
  /** And for the speaker, which commits on blur and on Enter exactly as the times do (section 4). */
  const [actorDraft, setActorDraft] = useState(actor);
  const [shownActor, setShownActor] = useState({ index, actor });
  const pendingActor = useRef<{ index: number; actor: string } | null>(null);
  /** Why the value in the field cannot be written, said where the field stands. Null when it can. */
  const [refusal, setRefusal] = useState<FieldRefusal | null>(null);
  /** Where the list is drawn, and null while it is closed. Fixed, so the panel cannot clip it. */
  const [listAt, setListAt] = useState<{ left: number; top: number; width: number } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const comboRef = useRef<HTMLSpanElement>(null);
  const names = useMemo(() => actorNames(cues), [cues]);

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
  if (shownActor.index !== index || shownActor.actor !== actor) {
    setShownActor({ index, actor });
    setActorDraft(actor);
    setRefusal(null);
    setListAt(null);
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

  /** Send the speaker, if it belongs to a row and the value is one the file can hold. */
  const commitActor = useCallback(async () => {
    const held = pendingActor.current;
    pendingActor.current = null;
    if (held === null) {
      return;
    }
    await onCommitField(held.index, "actor", held.actor);
  }, [onCommitField]);

  // The window shortcuts and the toolbar flush every editor, so "save" means one thing wherever it
  // was asked for. Times as well as text: an uncommitted time is unsaved work the same way.
  useEffect(() => {
    flushRef.current = async () => {
      await commit();
      await commitTimes();
      await commitActor();
      for (const field of ["layer", ...MARGIN_FIELDS] as NumberField[]) {
        await commitNumber(field);
      }
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

  const timesEdited =
    times.start !== timecode(startMs) ||
    times.end !== timecode(endMs) ||
    times.length !== lengthOf(startMs, endMs);
  // The speaker counts the same way the times do, and by the same rule: text in a field the
  // document does not hold is unsaved work whether or not it can be written yet. See E4.8.
  const actorEdited = actorDraft !== actor;
  const numbersEdited = (["layer", ...MARGIN_FIELDS] as NumberField[]).some(
    (field) => numbers[field] !== held[field],
  );
  useEffect(() => {
    onDraftChange(draft !== text || timesEdited || actorEdited || numbersEdited);
  }, [draft, text, timesEdited, actorEdited, numbersEdited, onDraftChange]);

  /** A range reports where it starts, which is where the text would divide. */
  function reportCaret(box: HTMLTextAreaElement) {
    onCaret(byteOffset(box.value, box.selectionStart));
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
  function onTypeActor(value: string) {
    setActorDraft(value);
    // Typing is the other way into the field, so the list stops standing: with it open Enter picks
    // the highlighted name, and a translator typing a new one would commit a different one (E2.7).
    setListAt(null);
    const refused = refusedFieldValue(value);
    setRefusal(refused);
    // Trimmed the way the document's reader trims it, so typing a stray space around the name the
    // field already holds writes nothing rather than a byte the panel never shows (E4.7).
    const written = trimmedFieldValue(value);
    if (index === null || refused !== null || written === actor) {
      pendingActor.current = null;
      return;
    }
    pendingActor.current = { index, actor: written };
  }

  /** Put the list where the field is, in the viewport's own coordinates. */
  function openList() {
    const box = comboRef.current?.getBoundingClientRect();
    if (box === undefined || names.length === 0) {
      return;
    }
    setListAt({ left: box.left, top: box.bottom, width: box.width });
    setHighlight(Math.max(0, names.indexOf(actorDraft)));
  }

  /** Picking puts the name in the field and commits it in the one gesture (E2.6). */
  async function pickName(name: string) {
    setListAt(null);
    setActorDraft(name);
    // Tested like a typed one: the list comes from the document, and a hostile file's field can
    // hold a character no field may (E4.6).
    const refused = refusedFieldValue(name);
    setRefusal(refused);
    const written = trimmedFieldValue(name);
    if (index === null || refused !== null || written === actor) {
      pendingActor.current = null;
      return;
    }
    pendingActor.current = { index, actor: written };
    await commitActor();
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

  function onActorKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      // An open list is what Escape closes first; a second one puts the field back (E2.4).
      if (listAt !== null) {
        setListAt(null);
        return;
      }
      pendingActor.current = null;
      setActorDraft(actor);
      setRefusal(null);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (listAt === null) {
        openList();
        return;
      }
      // Guarded rather than assumed: the document can change under an open list, and a modulo by
      // an empty list is not a number.
      if (names.length === 0) {
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : names.length - 1;
      setHighlight((at) => (at + step) % names.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const picked = listAt === null ? undefined : names[highlight];
      if (picked !== undefined) {
        void pickName(picked);
        return;
      }
      void commitActor();
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
      void commit();
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

  if (cue === null) {
    return (
      <section className="currentline" aria-label={en.subtitle.currentLine.label}>
        <p className="currentline__empty">{en.subtitle.currentLine.none}</p>
      </section>
    );
  }

  const rate = readingRate(cue);
  const cpsClasses = ["currentline__cps"];
  if (rate !== null && rate > CPS_LIMIT) {
    cpsClasses.push("currentline__cps--over");
  }
  // Off the draft and not off the document: the number is a measure of the text, and the text a
  // translator is judging is the one under their hands. See edit-bar-first-tasks.md E1.3.
  const characters = characterCount(draft);
  const charClasses = ["currentline__chars"];
  if (characters > CHARACTER_LIMIT) {
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
   * The speaker: a text field with the names this document already uses beside it. Drawn and greyed
   * on a document whose lines cannot hold one, never absent (E3.1).
   */
  function actorField() {
    const label = en.subtitle.currentLine.actor;
    return (
      <span className="currentline__field">
        <span className="currentline__label">{label}</span>
        <span className="currentline__combo" ref={comboRef}>
          <input
            className="currentline__actor"
            role="combobox"
            aria-label={label}
            aria-invalid={refusal !== null}
            aria-expanded={listAt !== null}
            aria-controls={ACTOR_LIST_ID}
            aria-activedescendant={listAt === null ? undefined : `${ACTOR_OPTION_ID}${highlight}`}
            data-document-editor=""
            disabled={!canActor}
            value={actorDraft}
            spellCheck={false}
            onChange={(event) => onTypeActor(event.target.value)}
            onKeyDown={onActorKeyDown}
            onBlur={() => void commitActor()}
          />
          <button
            type="button"
            className="currentline__actor-open"
            aria-label={en.subtitle.currentLine.actorNames}
            aria-expanded={listAt !== null}
            // Nothing to pick is nothing to open, so the opener greys while the field stays usable.
            disabled={!canActor || names.length === 0}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => (listAt === null ? openList() : setListAt(null))}
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
        {actorField()}
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
          id={ACTOR_LIST_ID}
          role="listbox"
          aria-label={en.subtitle.currentLine.actorNames}
          style={{ left: listAt.left, top: listAt.top, minWidth: listAt.width }}
        >
          {names.map((name, at) => (
            <button
              key={name}
              id={`${ACTOR_OPTION_ID}${at}`}
              type="button"
              role="option"
              aria-selected={at === highlight}
              className={
                at === highlight
                  ? "currentline__actor-name currentline__actor-name--on"
                  : "currentline__actor-name"
              }
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void pickName(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
