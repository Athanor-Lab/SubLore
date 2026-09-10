import { execFileSync } from "node:child_process";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import { requireLinuxBackend } from "./platform.js";

/**
 * How much longer than asked every wait in the suite waits.
 *
 * The CI runner has two cores and runs the whole battery one spec at a time: a wait that is
 * generous on a workstation is tight there, and three pull requests in a row went red on timeouts
 * that a rerun did not reproduce. Waiting longer weakens nothing, because what is asserted does not
 * change and a check that fails still fails; it only takes longer to give up. See e2e/README.md.
 */
const PATIENCE = (() => {
  const asked = Number(process.env.E2E_PATIENCE ?? (process.env.CI === "true" ? "2" : "1"));
  return Number.isFinite(asked) && asked >= 1 ? asked : 1;
})();

/**
 * Poll until `probe` returns something truthy. Never a fixed sleep: every wait has a deadline and
 * a message saying what was expected (design section 10).
 *
 * `message` may be a function, and then it is called when the wait times out rather than before it
 * starts. A message holding `rootTree()` needs that: built eagerly it shows the display as it was
 * before the wait, which for "the window never appeared" is guaranteed not to hold it (N79).
 * @template T
 * @param {() => T | Promise<T>} probe
 * @param {{timeout?: number, interval?: number, message: string | (() => string)}} options
 * @returns {Promise<T>}
 */
export async function waitFor(probe, { timeout: asked = 30000, interval = 250, message }) {
  const timeout = Math.round(asked * PATIENCE);
  const deadline = Date.now() + timeout;
  let lastError = null;
  for (;;) {
    try {
      const value = await probe();
      if (value) {
        return value;
      }
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const cause = lastError === null ? "" : `\nlast error: ${lastError.message}`;
      const said = typeof message === "function" ? message() : message;
      throw new Error(`timed out after ${timeout}ms waiting for ${said}${cause}`);
    }
    await sleep(interval);
  }
}

/**
 * Process ids still alive in a process group. The group is the exact set a run created, which is
 * why the shutdown check uses it instead of a name scan: another agent may be running their own
 * copy of the app on this machine.
 * @param {number} pgid
 * @returns {number[]}
 */
export function processGroupMembers(pgid) {
  // A process group is POSIX; on Windows a job object is the equivalent unit. Seam for MW.1b.
  requireLinuxBackend(
    "proc.js processGroupMembers",
    "list the processes one run spawned, as the exact set it created rather than a name scan",
  );
  try {
    const out = execFileSync("pgrep", ["-g", String(pgid)], { encoding: "utf8", timeout: 10000 });
    return out
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch (error) {
    // pgrep exits 1 with no output when nothing matches; anything else is a real failure.
    if (error.status === 1 && String(error.stdout ?? "").trim() === "") {
      return [];
    }
    throw error;
  }
}

/**
 * What each of `pids` actually is, one `ps` line apiece, for a failure message that can be
 * diagnosed after the fact. A bare pid says nothing once the process is gone, which is how N16 sat
 * open for a week: the check reported a number and nobody could learn what had survived.
 * @param {number[]} pids
 * @returns {string}
 */
export function describeProcesses(pids) {
  requireLinuxBackend(
    "proc.js describeProcesses",
    "name the processes a run left behind, so a failure says what survived rather than which pid",
  );
  if (pids.length === 0) {
    return "none";
  }
  try {
    return execFileSync("ps", ["-o", "pid,ppid,etimes,stat,args", "-p", pids.join(",")], {
      encoding: "utf8",
      timeout: 10000,
    }).trim();
  } catch {
    // Every one of them exited between the check and this call, which is worth saying plainly.
    return `${JSON.stringify(pids)}, all gone by the time ps ran`;
  }
}

/**
 * Best-effort teardown of a whole process group. Never throws for a group that is already gone:
 * that is the outcome asked for, and this runs on failure paths. It does throw off Linux, where
 * the catch below would swallow the negative signal and leave the app running.
 */
export function killGroup(pgid, signal = "SIGKILL") {
  requireLinuxBackend(
    "proc.js killGroup",
    "tear down every process one run spawned, including the sidecar and the driver's children",
  );
  try {
    process.kill(-pgid, signal);
  } catch {
    // Already gone, which is the outcome we wanted anyway.
  }
}

/**
 * Live ffmpeg processes whose arguments name `needle`, and nothing else.
 *
 * Matched on the executable and then on the arguments, never on the whole command line at once:
 * `pgrep -f ffmpeg` also matches the shell that launched the test, whose own command line quotes
 * this function, and a check that counts its own caller answers whatever it likes.
 */
export function ffmpegProcessesFor(needle) {
  let pids = [];
  try {
    pids = execFileSync("pgrep", ["-x", "ffmpeg"], { encoding: "utf8", timeout: 10000 })
      .split("\n")
      .filter((line) => line.trim() !== "");
  } catch {
    // pgrep exits non-zero when nothing matches, which is the answer this wants most of the time.
    return [];
  }
  return pids
    .map((pid) => {
      try {
        return execFileSync("ps", ["-p", pid, "-o", "args="], {
          encoding: "utf8",
          timeout: 10000,
        }).trim();
      } catch {
        // It exited between the two calls, which is not a process left behind.
        return "";
      }
    })
    .filter((args) => args.includes(needle));
}
