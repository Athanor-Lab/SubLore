import { useLayoutEffect, useRef, useState } from "react";

import { useLayer } from "../hooks/useLayers";
import { en } from "../i18n/en";
import { parseTimecode, timecode } from "./cueView";

type JumpToTimeProps = {
  /** Where the picture is now, in seconds, which is what the field opens holding. */
  position: number;
  /** How long the media is, in seconds. A time past it is refused rather than clamped. */
  duration: number;
  onJump: (seconds: number) => void;
  onClose: () => void;
};

/**
 * What Ctrl+G opens: a field taking a time, and the picture goes there.
 *
 * The time is read by `parseTimecode`, the one the grid and the current line already use, so a
 * translator types the same thing here as everywhere else and there is no second parser to keep
 * agreeing with the first. See interface-spec 9.7.
 */
export default function JumpToTime({ position, duration, onJump, onClose }: JumpToTimeProps) {
  const fieldRef = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState(() => timecode(position * 1000));
  const [refused, setRefused] = useState(false);
  // Mounted only while the panel is open (decision 1, T8).
  useLayer(true);

  useLayoutEffect(() => {
    fieldRef.current?.focus();
    fieldRef.current?.select();
  }, []);

  function jump() {
    const millis = parseTimecode(typed);
    // Past the end is not a time this media has, so it is refused where it was typed rather than
    // quietly turned into the last frame.
    if (millis === null || millis / 1000 > duration) {
      setRefused(true);
      return;
    }
    onJump(millis / 1000);
  }

  return (
    <div
      className="jumpto"
      role="dialog"
      aria-modal="true"
      aria-label={en.video.jumpTo.title}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="jumpto__panel"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <label className="jumpto__field">
          <span className="jumpto__label">{en.video.jumpTo.label}</span>
          <input
            className="jumpto__value"
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
                jump();
              }
            }}
          />
        </label>
        {refused && (
          <p className="jumpto__refusal" role="alert">
            {en.video.jumpTo.refused}
          </p>
        )}
        <div className="jumpto__buttons">
          <button type="button" className="jumpto__go" onClick={jump}>
            {en.video.jumpTo.go}
          </button>
          <button type="button" className="jumpto__cancel" onClick={onClose}>
            {en.video.jumpTo.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}
