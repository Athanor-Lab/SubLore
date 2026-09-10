/**
 * The cold start CONTRIBUTING.md section 7 claims, measured rather than assumed.
 *
 *   pnpm e2e:cold-start
 *
 * **What counts as interactive, declared rather than implied.** A script needs a mark it can read.
 * The window being mapped is too early: it exists before the page does. The waveform arriving is too
 * late and depends on the media. The mark used here is that the page has run its mount effects, and
 * it is readable because `project_session` is a Tauri command: the line it writes can only be there
 * because the page asked for it (`src-tauri/src/project/mod.rs:152-160`), and `useProject` asks once
 * on mount. React runs effects after the commit, so this lands with the chrome drawn or just after
 * it, never before. It is a conservative mark, not a measurement of a pixel.
 *
 * **The clock is this script's, not the log's.** The log stamps to the second, which cannot answer a
 * two second budget. The elapsed time is measured from the spawn to the line appearing.
 *
 * **Cold, so a fresh data home every run.** A cache another run left behind is a gift the budget
 * does not describe.
 *
 * **What this does not certify**, the same as the memory budget beside it: section 7 names a
 * mid-range 2020 laptop, this runs where it is run, and under Xvfb the GL stack is llvmpipe. Read it
 * as a regression guard. If it goes over, say the number and say the machine; do not move the budget
 * quietly.
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
} from "../lib/paths.js";
import { describeProcesses, killGroup, processGroupMembers, waitFor } from "../lib/proc.js";
import { allWindows, isAppWindowName, rootTree } from "../lib/x11.js";

/** What section 7 claims, in milliseconds. */
const BUDGET_MS = 2000;

/** The line the page's first command writes, which is the mark this measures to. */
const MARK = "project session: read";

/** The same limit `scaled-surface-check.js` gives the app's children to finish leaving (N16). */
const GROUP_EMPTY_TIMEOUT_MS = 60000;

/** Gutting an assertion has to be as red as failing one, so the checks count themselves. */
const EXPECTED_CHECKS = 2;
let checksRun = 0;

function check(label, ok, detail = "") {
  checksRun += 1;
  if (!ok) {
    throw new Error(`cold start check failed: ${label}${detail === "" ? "" : `\n${detail}`}`);
  }
  console.log(`  ok  ${label}`);
}

/** By its tail, because the window is named for the document it holds (N57). */
function appToplevel() {
  const named = allWindows().filter((window) => isAppWindowName(window.name) && window.width > 200);
  return named.length === 1 ? named[0] : null;
}

/** Whether the app's own log carries the mark yet. Absent until it writes its first line. */
function marked(logFile) {
  try {
    return readFileSync(logFile, "utf8").includes(MARK);
  } catch {
    return false;
  }
}

async function main() {
  requireDisplay();
  requireAppBinary();
  requireCloseWindowTool();

  // A data home nobody has used: this is a cold start, and a peaks cache or a stored layout from a
  // previous run would be time the budget does not include.
  const home = mkdtempSync(path.join(os.tmpdir(), "sublore-cold-"));
  const dataHome = path.join(home, "data");
  const logFile = path.join(dataHome, "com.sublore.app", "logs", "sublore.log");
  // The workarounds stay armed, which `appEnv` turns off for every spec on purpose. A start time
  // about a configuration no user gets is not the budget. The memory check learned this the
  // expensive way, reading a third high before it was noticed.
  const env = appEnv({ XDG_DATA_HOME: dataHome });
  delete env.SUBLORE_WEBKIT_WORKAROUNDS;

  const from = Date.now();
  const app = spawn(requireAppBinary(), [], {
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
    env,
  });
  const pgid = app.pid;
  let exit = null;
  app.on("exit", (code, signal) => {
    exit = { code, signal };
  });

  try {
    const elapsed = await waitFor(
      () => {
        if (exit !== null) {
          throw new Error(`the app exited before it was interactive (code ${exit.code})`);
        }
        return marked(logFile) ? Date.now() - from : null;
      },
      {
        // Generous on purpose: this measures a number, and a timeout that is the budget would turn
        // every overrun into the same message. The budget is asserted below, where it can say what
        // it saw.
        timeout: 60000,
        // Finer than the default 250 ms, because the default is the resolution of the answer: at
        // 250 the same start read 505, 1009 and 506 ms, which is the poll interval showing through
        // the number rather than the app varying.
        interval: 20,
        message: () => `the page's first command to reach the log at ${logFile}\n${rootTree()}`,
      },
    );

    // Always, not only when it fails: how close it is getting is the useful half.
    console.log(`  cold start to interactive: ${elapsed} ms`);

    check(
      "the app reached the mark this measures to",
      elapsed > 0,
      `the mark is ${JSON.stringify(MARK)} in ${logFile}`,
    );
    check(
      `cold start is under the ${BUDGET_MS} ms of CONTRIBUTING.md section 7`,
      elapsed < BUDGET_MS,
      `it took ${elapsed} ms. Read the header before moving the number: this machine is not the ` +
        `one the budget names, and llvmpipe is not the GL stack it describes.`,
    );

    const toplevel = appToplevel();
    if (toplevel !== null) {
      execFileSync("python3", [closeWindowTool, String(toplevel.id)], {
        stdio: "ignore",
        timeout: 15000,
      });
      await waitFor(() => exit !== null, { timeout: 20000, message: "the app to exit" });
      const survivors = await waitFor(() => (processGroupMembers(pgid).length === 0 ? [] : null), {
        timeout: GROUP_EMPTY_TIMEOUT_MS,
        message: `process group ${pgid} to be empty`,
      }).catch(() => processGroupMembers(pgid));
      if (survivors.length > 0) {
        console.log(`  note: ${describeProcesses(survivors)}`);
      }
    }
  } finally {
    try {
      if (processGroupMembers(pgid).length > 0) {
        killGroup(pgid);
      }
    } catch {
      // Teardown must not mask the failure that got us here.
    }
  }

  if (checksRun < EXPECTED_CHECKS) {
    throw new Error(
      `cold start guard: expected ${EXPECTED_CHECKS} checks, only ${checksRun} ran. ` +
        "Removing an assertion here is a CI failure. See e2e/README.md.",
    );
  }
  console.log(`cold start check passed (${checksRun}/${EXPECTED_CHECKS} checks)`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
