/**
 * Sublore writes in its own folder and nowhere else.
 *
 *   pnpm e2e:writes-nowhere-else
 *
 * CONTRIBUTING.md section 3 has five hard rules. The media being read only is guarded by
 * `asr.spec.js`, the backup before an overwrite by `close-gate-check.js`, the atomic write by
 * `crates/sublore-io/tests/crash_injection.rs`. This one, that no feature writes across the user's
 * folders, was written down and never observed.
 *
 * It is observed by giving the app a home nobody has used: `HOME` in one fresh directory and the
 * XDG directories in another. What appears in the empty home is what Sublore writes where nobody
 * asked it to, and there should be nothing.
 *
 * **The session has to be real.** An app that failed to open anything also writes nothing, so the
 * checks below start by reading the app's own log for the video, the subtitle and the peaks. Without
 * that, an empty home proves an app that did not start.
 */
import { execFileSync, spawn } from "node:child_process";
import console from "node:console";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  closeWindowTool,
  repoRoot,
  requireAppBinary,
  requireCloseWindowTool,
  requireDisplay,
  requireWaveformFixture,
} from "../lib/paths.js";
import { describeProcesses, killGroup, processGroupMembers, waitFor } from "../lib/proc.js";
import { allWindows, isAppWindowName, rootTree } from "../lib/x11.js";

/**
 * What may appear at the top of a fresh XDG directory, and whose it is. A name that is not here
 * fails the check rather than passing unseen: the list grows by a line that says who wrote it.
 */
const EXPECTED_XDG_ENTRIES = new Map([
  ["com.sublore.app", "Sublore's own store, which is the whole point"],
  ["mesa_shader_cache", "Mesa's compiled shaders, which XDG_CACHE_HOME is exactly for"],
  ["mesa_shader_cache_db", "the same, under Mesa's newer name"],
  [
    "mpv",
    "mpv's own shader cache, which XDG_CACHE_HOME is for: reproduced on 2026-09-10 by running " +
      "mpv with the gpu video output over a fresh cache home, which fills it with SHA-named " +
      "files. It appears on the CI runner and not on this repository's own machine (N81)",
  ],
  [
    "ibus",
    "the ibus input method, which GTK loads as an immodule at runtime: not linked into the " +
      "binary, and it makes its own bus directory wherever XDG_CONFIG_HOME points",
  ],
]);

/** Gutting an assertion has to be as red as failing one, so the checks count themselves. */
const EXPECTED_CHECKS = 4;
let checksRun = 0;

function check(label, ok, detail = "") {
  checksRun += 1;
  if (!ok) {
    throw new Error(`writes check failed: ${label}${detail === "" ? "" : `\n${detail}`}`);
  }
  console.log(`  ok  ${label}`);
}

/** By its tail, because the window is named for the document it holds (N57). */
function appToplevel() {
  const named = allWindows().filter((window) => isAppWindowName(window.name) && window.width > 200);
  return named.length === 1 ? named[0] : null;
}

/** Every path under `root`, relative to it, so a failure names files rather than counting them. */
function everythingUnder(root) {
  const found = [];
  const walk = (dir, prefix) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const shown = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      found.push(shown);
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), shown);
      }
    }
  };
  walk(root, "");
  return found.sort();
}

function logIn(dataHome) {
  try {
    return readFileSync(path.join(dataHome, "com.sublore.app", "logs", "sublore.log"), "utf8");
  } catch {
    return "";
  }
}

async function main() {
  requireDisplay();
  requireAppBinary();
  requireCloseWindowTool();
  const media = requireWaveformFixture();

  // Two roots, both new: a file another run left behind would make a violation look like history.
  const scratch = mkdtempSync(path.join(os.tmpdir(), "sublore-writes-"));
  const home = path.join(scratch, "home");
  const dataHome = path.join(scratch, "xdg-data");
  const cacheHome = path.join(scratch, "xdg-cache");
  const configHome = path.join(scratch, "xdg-config");
  const stateHome = path.join(scratch, "xdg-state");
  for (const dir of [home, dataHome, cacheHome, configHome, stateHome]) {
    mkdirSync(dir, { recursive: true });
  }

  // A copy, because the document is the one thing the app may legitimately write to.
  const subtitle = path.join(scratch, "session.srt");
  copyFileSync(
    path.join(repoRoot, "fixtures", "subtitles", "srt", "clean", "basic-lf.srt"),
    subtitle,
  );
  const mediaBefore = statSync(media);

  const app = spawn(requireAppBinary(), [media, subtitle], {
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
    // Not `appEnv`: this check is about where the app writes, so it gives the app a whole home of
    // its own rather than borrowing the harness's, and it leaves the webview workarounds alone
    // because the configuration a user gets is the one worth watching.
    env: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: dataHome,
      XDG_CACHE_HOME: cacheHome,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: stateHome,
      GDK_BACKEND: "x11",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/sublore-writes-check-has-no-bus",
    },
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
    // The session has to be real before its silence means anything.
    const said = await waitFor(
      () => {
        const log = logIn(dataHome);
        return log.includes("the picture is drawn") &&
          log.includes("subtitle: opened") &&
          /waveform: job \d+ peaked/.test(log)
          ? log
          : null;
      },
      {
        timeout: 60000,
        message: "the app to open the video, open the subtitle and read the peaks",
      },
    );

    check(
      "the session really opened a video, a subtitle and a waveform",
      said.includes("the picture is drawn") && said.includes("subtitle: opened"),
      "an app that opened nothing writes nothing, so this comes first",
    );

    const toplevel = appToplevel();
    if (toplevel !== null) {
      execFileSync("python3", [closeWindowTool, String(toplevel.id)], {
        stdio: "ignore",
        timeout: 15000,
      });
      await waitFor(() => exit !== null, { timeout: 30000, message: "the app to exit" });
    }

    const inHome = everythingUnder(home);
    console.log(`  the home nobody used holds ${inHome.length} entries`);
    check(
      "it wrote nothing into the home it was given",
      inHome.length === 0,
      `it wrote:\n${inHome.map((entry) => `  ~/${entry}`).join("\n")}`,
    );

    const strangers = [];
    for (const [root, name] of [
      [dataHome, "XDG_DATA_HOME"],
      [cacheHome, "XDG_CACHE_HOME"],
      [configHome, "XDG_CONFIG_HOME"],
      [stateHome, "XDG_STATE_HOME"],
    ]) {
      for (const entry of readdirSync(root)) {
        if (!EXPECTED_XDG_ENTRIES.has(entry)) {
          // With what is inside it: a bare name is not enough to work out whose it is from a CI
          // artefact, which is how this check reported `mpv` for a day (N81).
          const inside = everythingUnder(path.join(root, entry)).slice(0, 10);
          strangers.push(
            `${name}/${entry}${inside.length === 0 ? " (empty)" : ` holding ${inside.join(", ")}`}`,
          );
        }
      }
    }
    check(
      "everything at the top of the XDG directories is something this check knows the owner of",
      strangers.length === 0,
      `these are new: ${strangers.join(", ")}\nAdd the name to EXPECTED_XDG_ENTRIES with whose it ` +
        `is, or find out why Sublore is writing it.`,
    );

    check(
      "the media it played is the file it was given, to the byte and the second",
      statSync(media).size === mediaBefore.size && statSync(media).mtimeMs === mediaBefore.mtimeMs,
      `${media} was ${mediaBefore.size} bytes at ${mediaBefore.mtimeMs} and is now ` +
        `${statSync(media).size} at ${statSync(media).mtimeMs}`,
    );
  } finally {
    try {
      if (processGroupMembers(pgid).length > 0) {
        console.log(`  note: ${describeProcesses(processGroupMembers(pgid))}`);
        killGroup(pgid);
      }
    } catch {
      // Teardown must not mask the failure that got us here.
    }
  }

  if (checksRun < EXPECTED_CHECKS) {
    throw new Error(
      `writes guard: expected ${EXPECTED_CHECKS} checks, only ${checksRun} ran. ` +
        "Removing an assertion here is a CI failure. See e2e/README.md.",
    );
  }
  console.log(`writes check passed (${checksRun}/${EXPECTED_CHECKS} checks)`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
