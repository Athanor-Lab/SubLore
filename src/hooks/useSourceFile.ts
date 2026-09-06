import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import {
  isSubtitleError,
  type CueRow,
  type SubtitleError,
  type SubtitleOpened,
  type SubtitleSummary,
} from "../types/subtitle";

/**
 * The document being read from, beside the one being written.
 *
 * Much smaller than [`useSubtitleFile`] on purpose: there is no revision, no patch, no undo stack
 * and no dirty state, because nothing here ever writes. It opens, it is read, it closes. See
 * side-by-side-tasks.md S1.
 */
export type SourceFile = {
  summary: SubtitleSummary | null;
  /** Every cue, in the file's own order, so row `n` of the grid reads row `n` of this list. */
  cues: CueRow[];
  /** Why the last open was refused, or null. Cleared by the next open or close. */
  error: SubtitleError | null;
  open: (path: string) => Promise<void>;
  close: () => Promise<void>;
};

function refusal(failure: unknown): SubtitleError {
  return isSubtitleError(failure)
    ? failure
    : { code: "commandFailed", line: null, reason: null, detail: String(failure) };
}

export function useSourceFile(): SourceFile {
  const [summary, setSummary] = useState<SubtitleSummary | null>(null);
  const [cues, setCues] = useState<CueRow[]>([]);
  const [error, setError] = useState<SubtitleError | null>(null);

  const open = useCallback(async (path: string) => {
    setError(null);
    try {
      const opened = await invoke<SubtitleOpened>("subtitle_open_source", { path });
      setSummary(opened.summary);
      setCues(opened.cues);
    } catch (failure) {
      // A refused open leaves no half-read document behind: the column goes with it.
      setSummary(null);
      setCues([]);
      setError(refusal(failure));
    }
  }, []);

  const close = useCallback(async () => {
    setError(null);
    try {
      await invoke<void>("subtitle_close_source");
    } catch (failure) {
      setError(refusal(failure));
      return;
    }
    setSummary(null);
    setCues([]);
  }, []);

  return { summary, cues, error, open, close };
}
