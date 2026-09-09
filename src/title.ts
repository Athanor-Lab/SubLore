import { invoke } from "@tauri-apps/api/core";

import { en } from "./i18n/en";
import { fill } from "./i18n/format";

/**
 * The window's own name: what is open, whether it is saved, and the app after it (N57).
 *
 * The file's name and not its path, because a title bar has room for one and a translator reads the
 * one. A document that has never had a file is named for that rather than left blank.
 */
export function windowTitle(path: string | null, dirty: boolean): string {
  return fill(en.subtitle.windowTitle, {
    mark: dirty ? en.subtitle.windowTitleDirty : "",
    document: path === null ? en.subtitle.windowTitleUntitled : baseName(path),
  });
}

/** The last segment of a path, on either separator, falling back to the path when it ends in one. */
function baseName(path: string): string {
  const segments = path.split(/[/\\]/).filter((segment) => segment.length > 0);
  return segments.length === 0 ? path : segments[segments.length - 1];
}

/**
 * Name the window. A backend that will not take the name leaves the window called what it was
 * called, which the backend logs: a title is chrome, and losing it is never worth a failure on
 * screen.
 */
export async function setWindowTitle(title: string): Promise<void> {
  try {
    await invoke("window_title_set", { title });
  } catch {
    // Deliberately silent here and said in the backend log: see title.rs.
  }
}
