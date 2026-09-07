import { useLayoutEffect, useRef, useState } from "react";

import { useLayer } from "../hooks/useLayers";
import { en } from "../i18n/en";
import { parseTimecode } from "./cueView";

/** Which lines a shift moves. */
export type ShiftAffect = "all" | "selected" | "onward";
/** Which of a line's two times it moves. */
export type ShiftTimesKind = "both" | "start" | "end";

export type ShiftRequest = {
  /** Milliseconds, always positive; `backward` is what makes it a subtraction. */
  amountMs: number;
  backward: boolean;
  affect: ShiftAffect;
  times: ShiftTimesKind;
};

type ShiftTimesProps = {
  /** Whether anything is selected. Without a selection, two of the three scopes cannot be used. */
  hasSelection: boolean;
  onShift: (request: ShiftRequest) => void;
  onClose: () => void;
};

/**
 * What Ctrl+I opens: an amount, a direction, which lines and which of their times.
 *
 * The amount is read by `parseTimecode`, the parser the grid and the current line already use.
 * Backward is what the reference ships pre-selected and this keeps it, which is interface-spec
 * question 42 left where the reference put it rather than answered here.
 *
 * The history the reference keeps beside the form is `later`, and frames are out under decision 11.
 */
export default function ShiftTimes({ hasSelection, onShift, onClose }: ShiftTimesProps) {
  const fieldRef = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState("00:00:00.000");
  const [backward, setBackward] = useState(true);
  const [affect, setAffect] = useState<ShiftAffect>("all");
  const [times, setTimes] = useState<ShiftTimesKind>("both");
  const [refused, setRefused] = useState(false);
  // Mounted only while the panel is open (decision 1, T8).
  useLayer(true);

  useLayoutEffect(() => {
    fieldRef.current?.focus();
    fieldRef.current?.select();
  }, []);

  function shift() {
    const amountMs = parseTimecode(typed);
    if (amountMs === null || amountMs === 0) {
      setRefused(true);
      return;
    }
    // Without a selection the two scopes that need one are greyed, so this cannot be reached with
    // either of them; the fallback is the scope that always applies.
    onShift({
      amountMs,
      backward,
      affect: hasSelection ? affect : "all",
      times,
    });
  }

  const choice = (
    name: string,
    value: string,
    label: string,
    picked: boolean,
    pick: () => void,
    disabled = false,
  ) => (
    <label className={`shifttimes__choice shifttimes__${name}-${value}`} key={value}>
      <input
        type="radio"
        name={`shifttimes-${name}`}
        checked={picked}
        disabled={disabled}
        onChange={pick}
      />
      <span>{label}</span>
    </label>
  );

  return (
    <div
      className="shifttimes"
      role="dialog"
      aria-modal="true"
      aria-label={en.subtitle.shiftTimes.title}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="shifttimes__panel"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <h2 className="shifttimes__title">{en.subtitle.shiftTimes.title}</h2>
        <label className="shifttimes__field">
          <span className="shifttimes__label">{en.subtitle.shiftTimes.amount}</span>
          <input
            className="shifttimes__amount"
            ref={fieldRef}
            value={typed}
            spellCheck={false}
            aria-invalid={refused}
            onChange={(event) => {
              setTyped(event.target.value);
              setRefused(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                shift();
              }
            }}
          />
        </label>
        {refused && (
          <p className="shifttimes__refusal" role="alert">
            {en.subtitle.shiftTimes.refused}
          </p>
        )}

        <fieldset className="shifttimes__group">
          <legend className="shifttimes__legend">{en.subtitle.shiftTimes.direction}</legend>
          {choice("direction", "forward", en.subtitle.shiftTimes.forward, !backward, () =>
            setBackward(false),
          )}
          {choice("direction", "backward", en.subtitle.shiftTimes.backward, backward, () =>
            setBackward(true),
          )}
        </fieldset>

        <fieldset className="shifttimes__group">
          <legend className="shifttimes__legend">{en.subtitle.shiftTimes.affect}</legend>
          {choice("affect", "all", en.subtitle.shiftTimes.allLines, affect === "all", () =>
            setAffect("all"),
          )}
          {/* Both of these need lines to be selected, so with none they are greyed and "all" is
              what a shift would use anyway. */}
          {choice(
            "affect",
            "selected",
            en.subtitle.shiftTimes.selectedLines,
            hasSelection && affect === "selected",
            () => setAffect("selected"),
            !hasSelection,
          )}
          {choice(
            "affect",
            "onward",
            en.subtitle.shiftTimes.onwardLines,
            hasSelection && affect === "onward",
            () => setAffect("onward"),
            !hasSelection,
          )}
        </fieldset>

        <fieldset className="shifttimes__group">
          <legend className="shifttimes__legend">{en.subtitle.shiftTimes.which}</legend>
          {choice("times", "both", en.subtitle.shiftTimes.bothTimes, times === "both", () =>
            setTimes("both"),
          )}
          {choice("times", "start", en.subtitle.shiftTimes.startOnly, times === "start", () =>
            setTimes("start"),
          )}
          {choice("times", "end", en.subtitle.shiftTimes.endOnly, times === "end", () =>
            setTimes("end"),
          )}
        </fieldset>

        <div className="shifttimes__buttons">
          <button type="button" className="shifttimes__go" onClick={shift}>
            {en.subtitle.shiftTimes.go}
          </button>
          <button type="button" className="shifttimes__cancel" onClick={onClose}>
            {en.subtitle.shiftTimes.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}
