/**
 * The idle memory CONTRIBUTING.md section 7 claims, measured rather than assumed.
 *
 * Three of that section's four numbers were already measured: the waveform's two by
 * `waveform-budget-check.js`, and the 2000 line open by `editor.spec.js`. This is the fourth, which
 * nothing measured until now, so a regression in it was invisible.
 *
 *   pnpm e2e:memory
 *
 * **PSS and not RSS.** The app is three processes, its own and WebKit's network and web content, and
 * they share a great deal. Summing RSS counts every shared page once per process: measured on
 * 2026-09-10 that came to 646 MB where the honest number was 385. PSS divides each shared page
 * between the processes using it, which is the only sum that means anything across a process tree.
 *
 * **What this does not certify.** Section 7's budget names a mid-range 2020 laptop. This runs
 * wherever it is run, and under Xvfb the GL stack is llvmpipe, which keeps its buffers in process
 * memory where a real GPU would not, so the number here is likely higher than on the machine the
 * budget describes. Read it as a regression guard, not as a verdict about that hardware.
 */
import { execFileSync, spawn } from "node:child_process";
import console from "node:console";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

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

/** What section 7 claims, in megabytes. */
const BUDGET_MB = 400;

/**
 * How long the app is left alone before it is measured. Long enough for the first paint, the
 * waveform job and mpv's own load to be over: measured at about eight seconds here, and this is
 * three times that, because a number taken while something is still allocating is not idle memory.
 */
const SETTLE_MS = 25000;

/** The same limit `scaled-surface-check.js` gives the app's children to finish leaving (N16). */
const GROUP_EMPTY_TIMEOUT_MS = 60000;

/** Gutting an assertion has to be as red as failing one, so the checks count themselves. */
const EXPECTED_CHECKS = 2;
let checksRun = 0;

function check(label, ok, detail = "") {
  checksRun += 1;
  if (!ok) {
    throw new Error(`memory budget check failed: ${label}${detail === "" ? "" : `\n${detail}`}`);
  }
  console.log(`  ok  ${label}`);
}

/** By its tail, because the window is named for the document it holds (N57). */
function appToplevel() {
  const named = allWindows().filter((window) => isAppWindowName(window.name) && window.width > 200);
  return named.length === 1 ? named[0] : null;
}

/** One process's proportional set size in kilobytes, or null when the kernel will not say. */
function pssOf(pid) {
  try {
    const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    const line = /^Pss:\s+(\d+) kB$/m.exec(rollup);
    return line === null ? null : Number(line[1]);
  } catch {
    // It exited between being listed and being read, which is not a failure to report a number.
    return null;
  }
}

/** What each process in the group is, so a new one tomorrow is seen rather than merely counted. */
function nameOf(pid) {
  try {
    return execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "gone";
  }
}

async function main() {
  requireDisplay();
  requireAppBinary();
  requireCloseWindowTool();
  requireVideoFixture();

  const home = mkdtempSync(path.join(os.tmpdir(), "sublore-memory-"));
  // `appEnv` disarms the webview workarounds, deliberately, because they key on the driver being
  // loaded and every spec would otherwise test a configuration no user gets. For a memory number
  // that reasoning inverts: the configuration a user gets is the only one worth measuring, and the
  // difference is not small. Measured on 2026-09-10, the same idle app read 385 MB armed and 520
  // disarmed, so a check that left this alone would be guarding the wrong number by a third.
  const env = appEnv({ XDG_DATA_HOME: path.join(home, "data") });
  delete env.SUBLORE_WEBKIT_WORKAROUNDS;
  const app = spawn(requireAppBinary(), [videoFixture], {
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
    await waitFor(() => appToplevel(), {
      timeout: 40000,
      message: () => `the app's window to appear\n${rootTree()}`,
    });
    await sleep(SETTLE_MS);

    const members = processGroupMembers(pgid);
    let total = 0;
    for (const pid of members) {
      const pss = pssOf(pid);
      if (pss === null) {
        continue;
      }
      total += pss;
      console.log(
        `  ${String(pid).padStart(8)} ${String(Math.round(pss / 1024)).padStart(5)} MB  ${nameOf(pid)}`,
      );
    }
    const megabytes = Math.round(total / 1024);
    // Always, not only when it fails: a budget that is only ever seen at the moment it breaks says
    // nothing about how close it was getting.
    console.log(`  idle memory: ${megabytes} MB across ${members.length} processes`);

    check(
      "the kernel reported memory for the processes the app is",
      members.length > 0 && total > 0,
      `the group held ${members.length} processes and they summed to ${total} kB`,
    );
    check(
      `idle memory is under the ${BUDGET_MB} MB of CONTRIBUTING.md section 7`,
      megabytes < BUDGET_MB,
      `it is ${megabytes} MB with a video open and paused. Read the header before moving the ` +
        `number: this machine is not the one the budget names.`,
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
      `memory budget guard: expected ${EXPECTED_CHECKS} checks, only ${checksRun} ran. ` +
        "Removing an assertion here is a CI failure. See e2e/README.md.",
    );
  }
  console.log(`memory budget check passed (${checksRun}/${EXPECTED_CHECKS} checks)`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
