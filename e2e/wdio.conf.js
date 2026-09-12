import console from "node:console";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  asrDir,
  cacheHome,
  installModelForSpec,
  installStubSidecar,
  stubBinary,
} from "./lib/asr.js";
import { appEnv, silentMachine } from "./lib/env.js";
import { startDisplay, stopDisplay } from "./lib/display.js";
import { startUpdateStandIn } from "./lib/updates.js";
import { driverPort, startDriver, stopDriver } from "./lib/driver.js";
import {
  requireAppBinary,
  requireDisplay,
  requireTool,
  requireVideoFixture,
  windowHeight,
  windowWidth,
} from "./lib/paths.js";
import {
  failedTests,
  passedTests,
  recordFailedTest,
  recordPassedTest,
  resetTally,
} from "./lib/tally.js";

/**
 * Every spec that exists must run. WebdriverIO does not reliably fail a run that executed nothing,
 * so the count is asserted here. Bump it when you add a test; see e2e/README.md.
 */
const EXPECTED_TESTS = 514;

/** How long mocha lets one test live. Every wait inside a test must be shorter. See N165. */
const TEST_LIMIT_MS = 60000;

// Keeps a run out of the real data dir. Created once in the launcher; workers inherit the value.
const inherited = process.env.SUBLORE_E2E_DATA_HOME;
process.env.SUBLORE_E2E_DATA_HOME ??= mkdtempSync(path.join(os.tmpdir(), "sublore-e2e-"));
/**
 * The tree this run made, or null when the caller handed one in. Removed at the end, because a run
 * leaves about 77 MB behind and nothing was removing it: 318 of them filled a 31 GB /tmp and broke
 * the next build with a quota error. A tree the caller named is the caller's to keep.
 */
const ownDataHome = inherited === undefined ? process.env.SUBLORE_E2E_DATA_HOME : null;
/** The run's tree, kept because every spec's own directory is made under it. */
const runDataHome = process.env.SUBLORE_E2E_DATA_HOME;
// Read at module load, in the launcher and again in every worker, and before `beforeSession`
// points the data home at the spec's own. What is shared and read only lives here: the stub
// sidecar and the transcript it replays.
process.env.SUBLORE_E2E_RUN_HOME = runDataHome;

/** A spec file's name, as a directory name: what tells one spec's tree from another's. */
function specName(specs) {
  const first = Array.isArray(specs) ? specs[0] : specs;
  return path.basename(String(first ?? "unknown")).replace(/[^a-zA-Z0-9._-]/g, "_");
}
/**
 * Say which apps stalled, whether or not it cost a test.
 *
 * `stall.rs` beats on the main loop and `App.tsx` beats in the page, and each writes a line when
 * two of its own beats are more than three seconds apart. A stall that reddens nothing leaves no trace otherwise, because a green run throws its
 * tree away, and on 2026-09-12 two apps in one battery went silent for thirty and thirty-two
 * seconds while only one of them cost a spec. Printing it here makes every run a data point: this
 * is the instrument N101 was missing, and it accumulates only if somebody reads it. Never fails the
 * run. The stall is somebody else's entry to close.
 */
function reportStalls() {
  const root = path.join(runDataHome, "spec");
  if (!existsSync(root)) {
    return;
  }
  const seen = [];
  for (const spec of readdirSync(root)) {
    const log = path.join(root, spec, "com.sublore.app", "logs", "sublore.log");
    let text = "";
    try {
      text = readFileSync(log, "utf8");
    } catch {
      // A spec that never launched the app has no log, which is not an error here.
      continue;
    }
    for (const found of text.matchAll(/main loop: (\d+) ms between two beats/g)) {
      seen.push({ spec, where: "main loop", ms: Number(found[1]) });
    }
    // The page's own beat, which is the half that matters for a keystroke: the runner has shown the
    // app acting on one a minute late with the main loop beating throughout.
    for (const found of text.matchAll(/page: (\d+) ms between two ticks/g)) {
      seen.push({ spec, where: "page", ms: Number(found[1]) });
    }
  }
  if (seen.length === 0) {
    return;
  }
  seen.sort((one, two) => two.ms - one.ms);
  console.log(
    `E2E: the main loop stalled ${seen.length} time(s) in this run, worst first: ` +
      `${seen.map((one) => `${one.spec} ${one.where} ${one.ms} ms`).join("; ")}. ` +
      "See BACKLOG.md N101.",
  );
}

/** The update check's stand-in for this worker's session, held so `afterSession` can shut it. */
let standIn = null;
process.env.XDG_DATA_HOME = process.env.SUBLORE_E2E_DATA_HOME;
// Pinned before the line below points XDG_CACHE_HOME at this run's own tree: a real model lives in
// the developer's cache, and `sourceModel` falls back to whatever XDG_CACHE_HOME says.
process.env.SUBLORE_TEST_MODEL_DIR ??= path.join(cacheHome(), "sublore", "models");
// One rule, one place: `appEnv` owns it and this copies the result onto the environment the
// driver chain inherits.
Object.assign(process.env, appEnv());
delete process.env.WAYLAND_DISPLAY;

// The transcription spec always runs against the stand-in sidecar, never a real whisper build: it
// needs a run it can cancel mid-flight, and CI has no model. Set unconditionally, so an inherited
// SUBLORE_WHISPER_BIN cannot quietly change what asr.spec.js is asserting. See e2e/README.md.
process.env.SUBLORE_E2E_ASR_DIR = asrDir();
process.env.SUBLORE_WHISPER_BIN = stubBinary();
// For the app, not the harness: no spec measures pixels, asr.spec.js runs a real extraction. At
// load rather than in `onPrepare`, where a throw is logged and every spec runs regardless.
/**
 * Refuse to start if any spec waits as long as the test that contains it is allowed to live.
 *
 * `mochaOpts.timeout` kills a test at its limit, so a wait set to the same number is cut off at the
 * instant it would have reported: what the runner prints is a bare `Timeout` and the message the
 * wait composed is never seen. It happened on 2026-09-12, and four other waits carried the same
 * number, two of them with elaborate messages that could never have been printed.
 *
 * The rule is a relation rather than a number: whatever the limit is, a wait lives inside it with
 * room for the rest of the test. See BACKLOG.md N165.
 */
function refuseWaitsAtTheTestLimit() {
  const specsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "specs");
  const limit = TEST_LIMIT_MS;
  const offenders = [];
  for (const file of readdirSync(specsDir)) {
    if (!file.endsWith(".spec.js")) {
      continue;
    }
    const text = readFileSync(path.join(specsDir, file), "utf8");
    for (const found of text.matchAll(/timeout:\s*(\d+)/g)) {
      if (Number(found[1]) >= limit) {
        offenders.push(`${file} waits ${found[1]} ms`);
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `a wait may not reach mochaOpts.timeout (${limit} ms), or the test is killed before it can ` +
        `say what it was waiting for: ${offenders.join("; ")}. See e2e/README.md and BACKLOG.md N165.`,
    );
  }
}
requireTool("ffmpeg", "extract the audio the transcription spec transcribes");
// At load for the same reason: in `onPrepare` a throw is logged and every spec runs regardless,
// which is what the first version of this did, and the battery went green with the offender in it.
refuseWaitsAtTheTestLimit();

/**
 * The one spec that needs a module file beside the executable, and the fixture it needs there.
 *
 * Cargo writes `libsublore_module_wrong_major.so`; a module ships as `sublore_module_*.so`, which
 * is the shape the loader matches, so the copy is also a rename.
 */
const MODULE_SPEC = "modules.spec.js";
/** One that loads and contributes, one that is refused: the spec asserts both in one launch. */
const MODULE_FIXTURES = ["sublore_module_fixture", "sublore_module_wrong_major"];

function wantsModuleFixture(specs) {
  return Array.isArray(specs) && specs.some((spec) => spec.endsWith(MODULE_SPEC));
}

function moduleFixturePaths(name) {
  const beside = path.dirname(requireAppBinary());
  return {
    source: path.join(beside, "examples", `lib${name}.so`),
    target: path.join(beside, `${name}.so`),
  };
}

function installModuleFixture(specs) {
  if (!wantsModuleFixture(specs)) {
    return;
  }
  for (const name of MODULE_FIXTURES) {
    const { source, target } = moduleFixturePaths(name);
    if (!existsSync(source)) {
      throw new Error(
        `${source} does not exist. The module fixtures are example targets of ` +
          "crates/sublore-module-fixture; `cargo test --workspace` builds them, and so does " +
          "`cargo build -p sublore-module-fixture --examples`.",
      );
    }
    copyFileSync(source, target);
  }
}

function removeModuleFixture(specs) {
  if (!wantsModuleFixture(specs)) {
    return;
  }
  for (const name of MODULE_FIXTURES) {
    rmSync(moduleFixturePaths(name).target, { force: true });
  }
}

export const config = {
  runner: "local",
  hostname: "127.0.0.1",
  port: driverPort,
  specs: ["./specs/*.spec.js"],
  // Four. The state that made parallel unsafe is gone (N19) and every spec passes alone, so the
  // number went two then four, measured at 5:22 here against 19:00 in series. What it costs on a
  // machine smaller than this one is not known, which is why `onPrepare` now prints the machine
  // and the worker count into every run's log. See N24 and N84.
  maxInstances: 4,
  /**
   * One retry of a whole spec file, on the shared runner only. Five CI runs on 2026-09-06 each
   * failed exactly one check and a different one every time, all of them timing, none of them
   * reproducible here across many full runs: `video-aspect`, `editor`, `waveform-follow`,
   * `current-line-bands` and `chrome`. That is the runner stalling, not five defects.
   *
   * It is a re-run of the file and not a softened assertion: a defect that fails deterministically
   * fails twice and stays red, and the count guard below still demands every test. What it can
   * hide is a defect that is genuinely intermittent in the product, so wdio's own line naming the
   * retried file is the thing to read when this is on. Zero here on purpose: a flake on this
   * machine is a flake worth seeing. See BACKLOG N40.
   */
  specFileRetries: process.env.CI === "true" ? 1 : 0,
  capabilities: [{ "tauri:options": { application: requireAppBinary() } }],
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: TEST_LIMIT_MS },
  // The spec reporter prints a file's whole tick list only when that file ends, so a long spec is
  // minutes of silence. Realtime sends one line per test to the launcher as each test finishes.
  reporters: [["spec", { realtimeReporting: true }]],
  logLevel: "warn",
  waitforTimeout: 20000,

  onPrepare: () => {
    // First, before anything that can throw. A throw in here is logged and every spec runs anyway,
    // so a tally left from the last run then accumulates and the count guard below can be satisfied
    // by running subsets until the file is long enough. Measured 2026-09-03: four tests reported as
    // 4, 6, 9, 13 then 17 over five consecutive runs, because the model copy above was failing on a
    // full disk and, when it ran first, taking `resetTally` down with it.
    resetTally();
    // What machine this ran on, once, before anything else. Every question about a red battery
    // starts with whether the host could carry the workers, and it was never in the log: a CI run
    // taking 8:12 where this machine takes 4:53 could not be told from a defect (N84).
    console.log(
      `E2E host: ${os.cpus().length} cpus, ${Math.round(os.totalmem() / 1024 ** 3)} GB, load ` +
        `${os
          .loadavg()
          .map((n) => n.toFixed(2))
          .join(
            " ",
          )}, ${config.maxInstances} workers, patience ${process.env.E2E_PATIENCE ?? (process.env.CI === "true" ? "2 (CI default)" : "1")}`,
    );
    // Fail before the first session rather than mid-assertion with a confusing message.
    requireDisplay();
    requireTool("xdotool", "click and type into the app");
    requireTool("xwininfo", "read the window tree");
    requireAppBinary();
    requireVideoFixture();
    // Stays here, not at module load: this file is read by the launcher and again by every worker,
    // and this copies a 75 MB model. At load it ran once per spec and they fought over the file.
    installStubSidecar();
  },

  afterTest: (test, context, result) => {
    if (result.passed) {
      recordPassedTest(`${test.parent} ${test.title}`);
    } else {
      recordFailedTest(`${test.parent} ${test.title}`);
    }
  },

  /**
   * The app is launched by the session, so anything that has to be on disk before it starts has to
   * be put there here. `modules.spec.js` needs a module file beside the executable, and no `before`
   * hook inside a spec runs early enough for the app to see one.
   */
  beforeSession: async (config_, capabilities, specs) => {
    installModuleFixture(specs);
    // A directory of this spec's own, under the run's. One data home for the whole battery is what
    // made every spec inherit its predecessors' state: a project it had open, a preference it had
    // written. Twice on 2026-09-09 that reached across specs and reddened one that had done nothing
    // wrong. Per spec rather than per launch, so the five specs that relaunch the app still find
    // what the launch before them left. See BACKLOG.md N19.
    // A display of this worker's own, before anything looks for a window on one. Serial or not,
    // this is what lets two workers run without finding each other's app. See BACKLOG.md N24.
    await startDisplay(`${windowWidth}x${windowHeight}x24`);
    const own = path.join(runDataHome, "spec", specName(specs));
    mkdirSync(own, { recursive: true });
    Object.assign(process.env, appEnv({ XDG_DATA_HOME: own }));
    process.env.SUBLORE_E2E_DATA_HOME = own;
    // One spec runs against a machine with no audio device, which is what a server or a plain
    // virtual machine is. Only that one: every other spec wants whatever this machine has, and a
    // battery-wide silence would change what the waveform specs are asserting. See BACKLOG.md N13.
    if (specName(specs).startsWith("silent-machine")) {
      Object.assign(process.env, silentMachine(own));
    }
    // One spec runs against a clipboard that will not take the text, which is what the Windows stub
    // is by construction and what GTK can be on a bad day. Only that one: every other spec wants the
    // real clipboard, and two of them round trip through it. See BACKLOG.md N169.
    if (specName(specs).startsWith("clipboard-refuses")) {
      process.env.SUBLORE_CLIPBOARD_REFUSES = "1";
    } else {
      delete process.env.SUBLORE_CLIPBOARD_REFUSES;
    }
    // One spec freezes the app's main thread on purpose, to prove the beat that watches it can see
    // a stall. Four seconds: long enough to be unmistakable, short enough that the spec costs less
    // than the checks around it. See BACKLOG.md N101.
    if (specName(specs).startsWith("main-loop-beat")) {
      process.env.SUBLORE_STALL_MAIN_MS = "4000";
    } else {
      delete process.env.SUBLORE_STALL_MAIN_MS;
    }
    // The stub sidecar is shared and read only; the model sits in the app's own data dir and so
    // follows the spec. Only the specs that transcribe get it: it is 75 MB a copy.
    if (specName(specs).startsWith("asr")) {
      installModelForSpec();
    }
    // Before the app exists, and in the process that launches it: an endpoint set in `onPrepare`
    // lives in the launcher, and whether a worker inherits it is not something to bet a run on.
    // With this set, no app in the battery can reach the real network to ask about updates.
    standIn = await startUpdateStandIn(process.env.SUBLORE_E2E_DATA_HOME);
    process.env.SUBLORE_UPDATE_ENDPOINT = standIn.url;
    await startDriver();
  },

  afterSession: async (config_, capabilities, specs) => {
    stopDriver();
    stopDisplay();
    await standIn?.close();
    standIn = null;
    // Unconditional: a module file left beside the executable would change what every later spec
    // starts with, and a failed run is exactly when it would be left behind.
    removeModuleFixture(specs);
  },

  onComplete: (exitCode, capabilities, config_, results) => {
    reportStalls();
    // A failed run keeps its tree: what the app wrote is the evidence for why it failed. `failed`
    // is spec files that ended red, so it is zero when a retry saved the run, and the tree was
    // thrown away in exactly the run whose logs are wanted. The tally knows every test that did
    // not pass at least once (N86).
    const stumbled = failedTests();
    if (results.failed > 0 || stumbled.length > 0) {
      if (results.failed === 0) {
        console.log(
          `E2E: the run is green but ${stumbled.length} test(s) needed a retry, so its tree is ` +
            `kept at ${runDataHome}: ${stumbled.join("; ")}`,
        );
      }
      return;
    }
    if (ownDataHome !== null) {
      rmSync(ownDataHome, { recursive: true, force: true });
    }
    const passed = passedTests();
    if (passed.length < EXPECTED_TESTS) {
      throw new Error(
        `E2E guard: expected at least ${EXPECTED_TESTS} passing tests, got ${passed.length}` +
          `${passed.length === 0 ? "" : ` (${passed.join("; ")})`}. ` +
          "Deleting, skipping or filtering out a spec is a CI failure, not a green run. " +
          "See e2e/README.md.",
      );
    }
  },
};
