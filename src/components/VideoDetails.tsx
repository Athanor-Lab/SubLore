import { useLayoutEffect, useRef } from "react";

import { useLayer } from "../hooks/useLayers";
import { en } from "../i18n/en";
import { type VideoDetails as Details } from "../types/video";

type VideoDetailsProps = {
  details: Details;
  onClose: () => void;
};

/** The largest number that divides both, for the aspect the resolution reduces to. */
function commonFactor(width: number, height: number): number {
  let large = Math.abs(width);
  let small = Math.abs(height);
  while (small > 0) {
    [large, small] = [small, large % small];
  }
  return large;
}

/** The resolution's aspect as a reduced fraction, or nothing when there is no picture to reduce. */
function aspectOf(width: number | null, height: number | null): string | null {
  if (width === null || height === null || width <= 0 || height <= 0) {
    return null;
  }
  const factor = commonFactor(width, height);
  return `${width / factor}:${height / factor}`;
}

/** Hours only when there are hours, and hundredths always: this is a reading, not a timecode. */
function lengthOf(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = (seconds - hours * 3600 - minutes * 60).toFixed(2).padStart(5, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/**
 * What Video details opens: everything the open media says about itself, and nothing to change.
 *
 * A field the container does not answer for says so rather than showing a zero, because a zero
 * frame rate reads as a fact. See interface-spec 9.9.
 */
export default function VideoDetails({ details, onClose }: VideoDetailsProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Mounted only while the panel is open (decision 1, T8).
  useLayer(true);

  useLayoutEffect(() => {
    panelRef.current?.focus();
  }, []);

  const words = en.video.details;
  const rows: { key: string; label: string; value: string | null }[] = [
    { key: "file", label: words.file, value: details.path === "" ? null : details.path },
    {
      key: "resolution",
      label: words.resolution,
      value:
        details.width === null || details.height === null
          ? null
          : `${details.width} x ${details.height}`,
    },
    { key: "aspect", label: words.aspect, value: aspectOf(details.width, details.height) },
    {
      key: "fps",
      label: words.fps,
      value: details.fps === null ? null : details.fps.toFixed(3),
    },
    {
      key: "frames",
      label: words.frames,
      value: details.frames === null ? null : String(details.frames),
    },
    { key: "duration", label: words.duration, value: lengthOf(details.duration) },
    { key: "codec", label: words.codec, value: details.codec },
  ];

  return (
    <div
      className="videodetails"
      role="dialog"
      aria-modal="true"
      aria-label={words.title}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="videodetails__panel"
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <h2 className="videodetails__title">{words.title}</h2>
        <dl className="videodetails__rows">
          {rows.map((row) => (
            <div className="videodetails__row" key={row.key}>
              <dt className="videodetails__label">{row.label}</dt>
              <dd className={`videodetails__value videodetails__${row.key}`}>
                {row.value ?? words.unknown}
              </dd>
            </div>
          ))}
        </dl>
        <button type="button" className="videodetails__close" onClick={onClose}>
          {words.close}
        </button>
      </div>
    </div>
  );
}
