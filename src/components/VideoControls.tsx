import { useId, useState, type ChangeEvent } from "react";

import { en } from "../i18n/en";
import { type RowReading } from "../measure";

/** m:ss. The separator is punctuation, not translatable copy. */
function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

/**
 * Every reading the transport can show for this media, so the panel's floor is the widest of them
 * and not whichever one happened to be up when it was measured: the button says play or pause, and
 * the time is at its widest with the duration on both sides, its digits being tabular.
 */
export function transportReadings(duration: number): RowReading[] {
  const time = `${formatTime(duration)} / ${formatTime(duration)}`;
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
};

export default function VideoControls({
  enabled,
  paused,
  duration,
  position,
  cue,
  onToggle,
  onSeek,
}: VideoControlsProps) {
  const sliderId = useId();
  // While the user drags, the slider shows the dragged value instead of the event stream.
  const [dragged, setDragged] = useState<number | null>(null);
  const value = dragged ?? position;

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
        <span className="controls__time">
          {formatTime(value)} / {formatTime(duration)}
        </span>
        <span className="controls__offsets" aria-label={en.video.offsets}>
          {offsetsFrom(value, cue)}
        </span>
      </div>
    </div>
  );
}
