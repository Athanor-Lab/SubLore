import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

/** How often the open window asks for the lines again. A log a person reads does not need faster. */
const REREAD_MS = 1000;

/**
 * The app's own recent messages, while the window asking for them is open (interface-spec 9.12).
 *
 * Read on an interval rather than pushed line by line: an event per logged line would run the
 * logging through code that can log, and a loop inside the logger is the one fault that cannot be
 * diagnosed by reading the log. Nothing is asked for while the window is shut.
 */
export function useEventLog(open: boolean): string[] {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    if (!open) {
      return;
    }
    let showing = true;
    const read = () => {
      void invoke<string[]>("log_events_read").then(
        (found) => {
          if (showing) {
            setLines(found);
          }
        },
        (failure: unknown) => {
          console.error("the event log could not be read", failure);
        },
      );
    };
    read();
    const timer = setInterval(read, REREAD_MS);
    return () => {
      showing = false;
      clearInterval(timer);
    };
  }, [open]);

  return lines;
}
