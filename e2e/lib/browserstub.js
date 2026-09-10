import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A desktop launcher that goes nowhere, put in front of the real ones for every app a harness
 * starts.
 *
 * The Help commands and the update check hand a URL to `tauri-plugin-opener`, which is the `open`
 * crate, which runs `xdg-open` and then `gio open`, `gnome-open` and `kde-open` if that fails,
 * each resolved from `PATH`. It reads no `BROWSER` variable, so there is nothing to politely ask.
 *
 * The specs said a browser cannot open under Xvfb and that was simply wrong: `xdg-open` runs
 * `firefox`, and a second Firefox hands its URL to the instance already running through the
 * profile lock, which has nothing to do with `DISPLAY`. So every battery opened tabs in the
 * developer's own browser, on their real desktop, and the count went from two a run to six as
 * more Help commands were built. Found the only way it could be: the owner watched it happen.
 *
 * What each stub does instead is append the URL to a file, so what the desktop was handed stays
 * observable and a check can read it back.
 */
const LAUNCHERS = ["xdg-open", "gio", "gnome-open", "kde-open"];

/**
 * The directory the stubs live in, named here so a harness inspecting the same tree can tell what
 * it put there itself from what the app wrote. Spelled once, never twice (N81).
 */
export const STUB_DIR_NAME = "no-browser";

/** Where the URLs land, for a harness that wants to assert on them. */
export function openedPath(dataHome) {
  return path.join(dataHome, "opened-urls.txt");
}

/**
 * Write the stubs and give back the directory to put first on `PATH`.
 *
 * Rewritten on every call rather than created once: a run whose tree was removed underneath it
 * would otherwise inherit a directory that is not there any more, and a launcher missing from
 * `PATH` fails open, straight to the real one.
 */
export function browserStubDir(dataHome) {
  const home = typeof dataHome === "string" && dataHome !== "" ? dataHome : os.tmpdir();
  const directory = path.join(home, STUB_DIR_NAME);
  mkdirSync(directory, { recursive: true });
  const script = [
    "#!/bin/sh",
    "# A battery must not reach the developer's own desktop. See e2e/lib/browserstub.js.",
    'printf \'%s\\n\' "$*" >> "${SUBLORE_E2E_OPENED:-/dev/null}"',
    "exit 0",
    "",
  ].join("\n");
  for (const launcher of LAUNCHERS) {
    const file = path.join(directory, launcher);
    writeFileSync(file, script);
    chmodSync(file, 0o755);
  }
  return directory;
}
