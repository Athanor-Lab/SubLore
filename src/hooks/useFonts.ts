import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * The font families installed on this machine.
 *
 * Read once and only when something asks: walking the font directories costs a few hundred file
 * reads, and a translator who never opens the font picker should never pay for it. See B12.
 */
export type Fonts = {
  families: string[];
  /** Whether the list has been asked for and has not come back yet. */
  loading: boolean;
  /** Ask for the list. Asking again while it is on its way, or after it arrived, costs nothing. */
  load: () => void;
};

export function useFonts(): Fonts {
  const [families, setFamilies] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const asked = useRef(false);

  const load = useCallback(() => {
    if (asked.current) {
      return;
    }
    asked.current = true;
    setLoading(true);
    invoke<string[]>("fonts_installed")
      .then((found) => setFamilies(found))
      .catch(() => {
        // A machine whose font directories cannot be read still has a working picker: the list is
        // empty and the family is typed. Nothing here is worth a sentence on the status bar.
        asked.current = false;
      })
      .finally(() => setLoading(false));
  }, []);

  return { families, loading, load };
}
