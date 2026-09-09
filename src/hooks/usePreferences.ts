import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

/** Kept in step with `src-tauri/src/preferences.rs`; the file it comes from carries the same names. */
export type Preferences = {
  /** How far Add lead-in pulls a start back, in milliseconds. */
  leadInMs: number;
  /** How far Add lead-out pushes an end on, in milliseconds. */
  leadOutMs: number;
  /** How long a cue the user has just made lasts, in milliseconds. */
  newCueMs: number;
};

/**
 * The reference's own numbers, which is what the store answers with until it has been written and
 * what the app draws with while the read is in flight (interface-spec 9.6, question 42).
 */
export const DEFAULT_PREFERENCES: Preferences = {
  leadInMs: 100,
  leadOutMs: 350,
  newCueMs: 3000,
};

/**
 * The three numbers a translator may change. Read once when the shell mounts and written when the
 * dialog is confirmed: losing the file costs a preference, so nothing here fails loudly, and the
 * backend answers with the defaults and says so in its log.
 */
export function usePreferences(): {
  preferences: Preferences;
  store: (next: Preferences) => Promise<void>;
} {
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);

  useEffect(() => {
    void invoke<Preferences>("preferences_read")
      .then(setPreferences)
      .catch((failure: unknown) => {
        console.error("the stored preferences could not be read", failure);
      });
  }, []);

  const store = useCallback(async (next: Preferences) => {
    // Drawn from the moment they are confirmed, whatever the write does: a number the user typed
    // is the number the app should be using, and a failed write costs the next launch, not this one.
    setPreferences(next);
    try {
      await invoke("preferences_write", { preferences: next });
    } catch (failure) {
      console.error("the preferences could not be stored", failure);
    }
  }, []);

  return { preferences, store };
}
