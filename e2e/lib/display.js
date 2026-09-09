import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";

import { waitFor } from "./proc.js";

/**
 * An X display of this worker's own.
 *
 * `findToplevel` picks the app by its geometry, so two apps on one display are two windows that
 * match and the harness would drive whichever it found first. A display per worker is what makes
 * the battery safe to run in parallel at all. See BACKLOG.md N24.
 *
 * The whole run already sits inside one `xvfb-run`; these are nested inside it, one per worker,
 * and each is killed with its session.
 */
let server = null;

/** Derived from the worker's own number, so two workers never ask for one display. */
function displayNumber() {
  const slot = Number(/(\d+)$/.exec(process.env.WDIO_WORKER_ID ?? "")?.[1] ?? 0);
  // Well above the :99 `xvfb-run` picks for the run itself, and above any desktop's own.
  return 200 + slot;
}

export async function startDisplay(geometry = "1920x1080x24") {
  const number = displayNumber();
  server = spawn("Xvfb", [`:${number}`, "-screen", "0", geometry, "-nolisten", "tcp"], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  let died = null;
  server.on("error", (error) => {
    died = `Xvfb :${number} failed to start: ${error.message}`;
  });
  server.on("exit", (code) => {
    died = `Xvfb :${number} exited early with code ${code}`;
  });

  process.env.DISPLAY = `:${number}`;
  // Ready is a socket, not a pause: a driver started against a display that is not up yet fails in
  // a way that reads as the app's fault.
  await waitFor(
    () => {
      if (died !== null) {
        throw new Error(died);
      }
      return existsSync(`/tmp/.X11-unix/X${number}`) ? number : null;
    },
    { timeout: 20000, message: `Xvfb :${number} to accept connections` },
  );
  return number;
}

export function stopDisplay() {
  if (server === null) {
    return;
  }
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    // Already gone, which is the state this wanted.
  }
  server = null;
}
