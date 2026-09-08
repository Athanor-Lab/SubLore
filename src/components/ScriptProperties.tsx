import { useLayoutEffect, useRef } from "react";

import { useLayer } from "../hooks/useLayers";
import { en } from "../i18n/en";
import { type ScriptInfoView } from "../types/subtitle";

type ScriptPropertiesProps = {
  info: ScriptInfoView;
  onClose: () => void;
};

/**
 * What Project properties opens: the script-level metadata the open file carries, and nothing to
 * change (interface-spec 9.5). For a format with no such section every field is empty, which the
 * dialog says outright rather than showing rows that only ever read "not set".
 */
export default function ScriptProperties({ info, onClose }: ScriptPropertiesProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Mounted only while the panel is open, so the video surface hides for exactly that long (T8).
  useLayer(true);

  useLayoutEffect(() => {
    panelRef.current?.focus();
  }, []);

  const words = en.subtitle.properties;
  const resolution =
    info.playResX === null || info.playResY === null ? null : `${info.playResX} x ${info.playResY}`;
  const rows: { key: string; label: string; value: string | null }[] = [
    { key: "title", label: words.scriptTitle, value: info.title },
    { key: "resolution", label: words.resolution, value: resolution },
    { key: "wrap-style", label: words.wrapStyle, value: info.wrapStyle },
  ];
  const carriesNone = rows.every((row) => row.value === null);

  return (
    <div
      className="properties"
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
        className="properties__panel"
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <h2 className="properties__heading">{words.title}</h2>
        {carriesNone && <p className="properties__empty">{words.empty}</p>}
        <dl className="properties__rows">
          {rows.map((row) => (
            <div className="properties__row" key={row.key}>
              <dt className="properties__label">{row.label}</dt>
              <dd className={`properties__value properties__${row.key}`}>
                {row.value ?? words.unset}
              </dd>
            </div>
          ))}
        </dl>
        <button type="button" className="properties__close" onClick={onClose}>
          {words.close}
        </button>
      </div>
    </div>
  );
}
