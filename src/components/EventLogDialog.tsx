import { useLayoutEffect, useRef } from "react";

import { useEventLog } from "../hooks/useEventLog";
import { useLayer } from "../hooks/useLayers";
import { en } from "../i18n/en";

type EventLogDialogProps = {
  onClose: () => void;
};

/** How close to the bottom still counts as reading the end, in pixels. */
const AT_THE_END = 24;

/**
 * What Help > Event log opens: the lines the app has written this run (interface-spec 9.12).
 *
 * A panel rather than a window of its own, because every other dialog here is one and a second
 * toplevel would bring a second close gate and a second remembered size for something that is read
 * and shut (event-log-tasks.md).
 */
export default function EventLogDialog({ onClose }: EventLogDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLPreElement>(null);
  const wasAtTheEnd = useRef(true);
  const lines = useEventLog(true);
  // Mounted only while the panel is open, so the video surface hides for exactly that long (T8).
  useLayer(true);

  useLayoutEffect(() => {
    panelRef.current?.focus();
  }, []);

  // Follow the end while the reader is at the end, and stay put once they have scrolled back: a
  // window that yanks itself down while someone is reading an earlier line is unreadable.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null || !wasAtTheEnd.current) {
      return;
    }
    list.scrollTop = list.scrollHeight;
  }, [lines]);

  const words = en.eventLog;

  return (
    <div
      className="eventlog"
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
        className="eventlog__panel"
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <h2 className="eventlog__heading">{words.title}</h2>
        <pre
          className="eventlog__lines"
          ref={listRef}
          tabIndex={0}
          onScroll={(event) => {
            const box = event.currentTarget;
            wasAtTheEnd.current = box.scrollHeight - box.scrollTop - box.clientHeight <= AT_THE_END;
          }}
        >
          {lines.length === 0 ? words.empty : lines.join("\n")}
        </pre>
        <div className="eventlog__buttons">
          <button type="button" className="eventlog__close" onClick={onClose}>
            {words.close}
          </button>
        </div>
      </div>
    </div>
  );
}
