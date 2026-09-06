import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Preview = {
  /** Whether View has the document on the video. On from the start (decision 7). */
  shown: boolean;
  /**
   * Whether the frame draws the document being read instead of the one being written. Off from the
   * start: a translator checks the translation against the picture. See side-by-side-tasks.md S3.
   */
  source: boolean;
  /** Set while the backend could not put the document on the frame. */
  failed: boolean;
  toggle: () => void;
  toggleSource: () => void;
};

/**
 * The open document on the video frame (decision 7).
 *
 * Nothing here holds the document or the shadow copy the backend writes for mpv: this is the View
 * toggle and the one line the status bar shows when the picture could not be drawn.
 */
export function usePreview(): Preview {
  const [shown, setShown] = useState(true);
  const [source, setSource] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const listeners = Promise.all([
      listen("preview://failed", () => setFailed(true)),
      listen("preview://drawn", () => setFailed(false)),
    ]);

    return () => {
      void listeners.then((unlisteners) => {
        for (const unlisten of unlisteners) {
          unlisten();
        }
      });
    };
  }, []);

  // Sent on mount too, so the backend's default and this one cannot drift apart: with nothing open
  // it costs a line in the log and no work.
  useEffect(() => {
    invoke("preview_set_shown", { shown }).catch(() => setFailed(true));
  }, [shown]);

  // Sent on mount for the same reason the one above is, and separately: the two toggles are two
  // answers and neither should have to be re-sent because the other moved.
  useEffect(() => {
    invoke("preview_set_source", { source }).catch(() => setFailed(true));
  }, [source]);

  const toggle = useCallback(() => setShown((was) => !was), []);
  const toggleSource = useCallback(() => setSource((was) => !was), []);

  return { shown, source, failed, toggle, toggleSource };
}
