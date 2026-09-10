/**
 * mpv is stopped by the close path, before the window goes.
 *
 *   pnpm e2e:video-shutdown
 *
 * **What this guards, and what it does not.** Removing the `shutdown_video` call from the close gate
 * brings back N11, the SIGSEGV on the way out: measured with `pnpm e2e:n11-battery 25 5`, the clean
 * tree closed 0 of 25 runs on a signal and the tree without that line closed 2, with one more still
 * running at teardown. No automated check saw it. The four shutdown checks never open a video, and
 * the ones that do launch a single app on an idle machine, where N11 does not reproduce at all, and
 * where `Drop for Player` shuts mpv down anyway once the process exits.
 *
 * So this does not try to catch the crash, which lives in contention and would make a guard that
 * fires when it feels like it. It asserts the property instead: the close path stopped mpv. That the
 * order matters is already measured, by the battery; this is the guard against the line going away.
 *
 * The app says so itself, which is how `waveform-budget-check.js` and `mpv-context-check.js` read
 * what they read. Nothing is inferred from the outside.
 */
import { execFileSync, spawn } from "node:child_process";
import console from "node:console";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { appEnv } from "../lib/env.js";
import {
  closeWindowTool,
  requireAppBinary,
  requireCloseWindowTool,
  requireDisplay,
  requireVideoFixture,
  videoFixture,
} from "../lib/paths.js";
import { describeProcesses, killGroup, processGroupMembers, waitFor } from "../lib/proc.js";
import { allWindows, isAppWindowName, rootTree } from "../lib/x11.js";

/** The line the close path writes when it has stopped mpv and taken the surface back. */
const MARK = "video: mpv stopped and its surface taken";

/** The same limit `scaled-surface-check.js` gives the app's children to finish leaving (N16). */
const GROUP_EMPTY_TIMEOUT_MS = 60000;

/** Gutting an assertion has to be as red as failing one, so the checks count themselves. */
const EXPECTED_CHECKS = 4;
let checksRun = 0;

function check(label, ok, detail = "") {
  checksRun += 1;
  if (!ok) {
    throw new Error(`video shutdown check failed: ${label}${detail === "" ? "" : `\n${detail}`}`);
  }
  console.log(`  ok  ${label}`);
}

/** By its tail, because the window is named for the document it holds (N57). */
function appToplevel() {
  const named = allWindows().filter((window) => isAppWindowName(window.name) && window.width > 200);
  return named.length === 1 ? named[0] : null;
}

function logFileIn(dataHome) {
  return path.join(dataHome, "com.sublore.app", "logs", "sublore.log");
}

/** How many times the app has said it, or zero before it has written a log at all. */
function marks(dataHome) {
  try {
    return readFileSync(logFileIn(dataHome), "utf8").split(MARK).length - 1;
  } catch {
    return 0;
  }
}

/**
 * Launch, wait for the window, close it, and hand back what the log said and how it exited.
 * @param {string[]} args what the app is started with, a video or nothing
 */
async function launchAndClose(args, what) {
  const dataHome = path.join(mkdtempSync(path.join(os.tmpdir(), "sublore-shutdown-")), "data");
  const app = spawn(requireAppBinary(), args, {
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
    env: appEnv({ XDG_DATA_HOME: dataHome }),
  });
  const pgid = app.pid;
  let exit = null;
  app.on("exit", (code, signal) => {
    exit = { code, signal };
  });

  try {
    const toplevel = await waitFor(appToplevel, {
      timeout: 40000,
      message: `the app's window to appear for ${what}\n${rootTree()}`,
    });
    // The mark must not be there yet: a line written at startup would pass the assertion below
    // without the close path ever running.
    const before = marks(dataHome);

    execFileSync("python3", [closeWindowTool, String(toplevel.id)], {
      stdio: "ignore",
      timeout: 15000,
    });
    await waitFor(() => exit !== null, { timeout: 30000, message: `the app to exit for ${what}` });
    const survivors = await waitFor(() => (processGroupMembers(pgid).length === 0 ? [] : null), {
      timeout: GROUP_EMPTY_TIMEOUT_MS,
      message: `process group ${pgid} to be empty`,
    }).catch(() => processGroupMembers(pgid));

    return { before, after: marks(dataHome), exit, survivors, dataHome };
  } finally {
    try {
      if (processGroupMembers(pgid).length > 0) {
        killGroup(pgid);
      }
    } catch {
      // Teardown must not mask the failure that got us here.
    }
  }
}

async function main() {
  requireDisplay();
  requireAppBinary();
  requireCloseWindowTool();
  requireVideoFixture();

  const withVideo = await launchAndClose([videoFixture], "a video");
  console.log(
    `  with a video: said it ${withVideo.before} times before the close, ${withVideo.after} after`,
  );

  check(
    "the close path stopped mpv and said so",
    withVideo.after > withVideo.before,
    `the log at ${logFileIn(withVideo.dataHome)} carries ${JSON.stringify(MARK)} ` +
      `${withVideo.after} times, and ${withVideo.before} of those were there before the close. ` +
      `Removing the close gate's call to shut mpv down looks exactly like this, and it brings back ` +
      `the SIGSEGV on exit that no other check sees (N68).`,
  );
  check(
    "it said it once, because shutting down twice is not a thing that happened",
    withVideo.after === withVideo.before + 1,
    `it said it ${withVideo.after - withVideo.before} times for one close`,
  );
  check(
    "it closed with status 0 and left nothing running",
    withVideo.exit.code === 0 && withVideo.survivors.length === 0,
    `exit ${JSON.stringify(withVideo.exit)}\nsurvivors:\n${describeProcesses(withVideo.survivors)}`,
  );

  // The other half, and it was written the wrong way round first. The surface does not arrive with
  // a video, it arrives with the app: `setup` creates it during Tauri's own start, whatever is
  // opened afterwards. So the order matters with no file open too, and the line belongs there.
  const withoutVideo = await launchAndClose([], "no video");
  console.log(`  with no video: said it ${withoutVideo.after} times`);
  check(
    "it holds with no video open too, because the surface is the app's and not the file's",
    withoutVideo.after === 1,
    `the log carries ${JSON.stringify(MARK)} ${withoutVideo.after} times with no video opened, ` +
      `and it should carry it once: the surface exists from startup and has to be taken in the ` +
      `same order whether or not anything was played.`,
  );

  if (checksRun < EXPECTED_CHECKS) {
    throw new Error(
      `video shutdown guard: expected ${EXPECTED_CHECKS} checks, only ${checksRun} ran. ` +
        "Removing an assertion here is a CI failure. See e2e/README.md.",
    );
  }
  console.log(`video shutdown check passed (${checksRun}/${EXPECTED_CHECKS} checks)`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
