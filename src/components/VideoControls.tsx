import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";

import { timecode } from "./cueView";
import { en } from "../i18n/en";
import { type RowReading } from "../measure";
import { notchesOf } from "../wheel";

/**
 * The playhead as a timecode, in the shape the grid and the line's own fields use.
 *
 * Whole seconds were not enough for a tool that times subtitles: a clock reading 0:03 is anywhere
 * in a second, and the row beside it says 00:00:09.100. The reference shows the timecode here too,
 * with one hour digit rather than two; this keeps Sublore's own shape, because inside the product
 * agreeing with the grid matters more than the digit count. See BACKLOG.md N125.
 */
function formatTime(seconds: number): string {
  return timecode(Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000));
}

/**
 * Every reading the transport can show for this media, so the panel's floor is the widest of them
 * and not whichever one happened to be up when it was measured: the button says play or pause, and
 * the time is at its widest with the duration on both sides, its digits being tabular.
 */
export function transportReadings(duration: number): RowReading[] {
  // A timecode is a fixed twelve characters up to a hundred hours, so this no longer grows with the
  // media: the panel's floor is a property of the interface and not of the file it has open (N125).
  void duration;
  const time = timecode(99 * 3_600_000 + 59 * 60_000 + 59_000 + 999);
  return [en.video.play, en.video.pause].map((label) => (row: HTMLElement) => {
    const button = row.querySelector(".controls__button");
    const span = row.querySelector(".controls__time");
    if (button !== null) {
      button.textContent = label;
    }
    if (span !== null) {
      span.textContent = time;
    }
  });
}

/**
 * How far the playhead is from the current line's two edges, in milliseconds and always signed.
 *
 * Blank with no line, which is what the reference does there: a zero or a dash would read as an
 * answer, and there is no line to answer about. See BACKLOG.md N123.
 */
function offsetsFrom(positionSeconds: number, cue: { startMs: number; endMs: number } | null) {
  if (cue === null) {
    return "";
  }
  const at = Math.round(positionSeconds * 1000);
  const signed = (ms: number) => `${ms >= 0 ? "+" : ""}${ms}ms`;
  return `${signed(at - cue.startMs)}; ${signed(at - cue.endMs)}`;
}

type VideoControlsProps = {
  enabled: boolean;
  paused: boolean;
  duration: number;
  position: number;
  /** The line the cursor is on, or null: the offsets are measured from its two edges. */
  cue: { startMs: number; endMs: number } | null;
  onToggle: () => void;
  onSeek: (position: number) => void;
  /** One frame either way, which is what the wheel over the slider asks for (interface-spec 6.1). */
  onStep: (frames: number) => void;
};

export default function VideoControls({
  enabled,
  paused,
  duration,
  position,
  cue,
  onToggle,
  onSeek,
  onStep,
}: VideoControlsProps) {
  const sliderId = useId();
  const sliderRef = useRef<HTMLInputElement>(null);
  /** The part of a frame a wheel gesture has not spent yet. Nothing renders from it, so it is a ref. */
  const wheelRest = useRef(0);
  // While the user drags, the slider shows the dragged value instead of the event stream.
  const [dragged, setDragged] = useState<number | null>(null);
  const value = dragged ?? position;

  // A native listener, not React's `onWheel`, which is attached passively at the root and cannot
  // take the gesture from the page. The waveform and the grid read their own the same way.
  useEffect(() => {
    const slider = sliderRef.current;
    if (slider === null) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!enabled) {
        return;
      }
      // Down is forward, which is the direction this window already moves under a wheel: the
      // waveform scrolls on and the grid goes down the file. The fraction is kept, so two half
      // notches step the frame one whole notch would. See interface-spec 6.1 and N133.
      const frames = notchesOf(event) + wheelRest.current;
      const whole = Math.trunc(frames);
      wheelRest.current = frames - whole;
      if (whole !== 0) {
        onStep(whole);
      }
    };
    slider.addEventListener("wheel", onWheel, { passive: false });
    return () => slider.removeEventListener("wheel", onWheel);
  }, [enabled, onStep]);

  function change(event: ChangeEvent<HTMLInputElement>) {
    const next = Number(event.target.value);
    if (dragged === null) {
      onSeek(next);
      return;
    }
    setDragged(next);
  }

  function commit() {
    if (dragged !== null) {
      onSeek(dragged);
      setDragged(null);
    }
  }

  // Two rows, the way the reference stacks the same controls: the seek bar takes a row of its own
  // at full width, and what reads or drives it sits on the band beneath. The panel's floor is the
  // wider of the two rows, so a control added to the band costs the panel far less width than it
  // would on one row, which is what a fourth thing on one row had cost (N124).
  return (
    <div className="controls">
      <div className="controls__seek">
        <label className="controls__label" htmlFor={sliderId}>
          {en.video.position}
        </label>
        <input
          id={sliderId}
          ref={sliderRef}
          className="controls__slider"
          type="range"
          min={0}
          max={duration}
          step={0.01}
          value={Math.min(value, duration)}
          disabled={!enabled}
          onPointerDown={() => setDragged(position)}
          onPointerUp={commit}
          onPointerCancel={commit}
          onChange={change}
        />
      </div>
      <div className="controls__band">
        <button className="controls__button" type="button" disabled={!enabled} onClick={onToggle}>
          {paused ? en.video.play : en.video.pause}
        </button>
        <span className="controls__time">{formatTime(value)}</span>
        <span className="controls__offsets" aria-label={en.video.offsets}>
          {offsetsFrom(value, cue)}
        </span>
      </div>
    </div>
  );
}
