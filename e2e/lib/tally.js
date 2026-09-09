import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import process from "node:process";
import path from "node:path";

import { repoRoot } from "./paths.js";

/**
 * WebdriverIO's `results.passed` in `onComplete` counts spec *files*, not tests, so it cannot see
 * an `it.skip` inside a file that otherwise passes. The launcher and the workers are separate
 * processes, so passed tests are tallied through a file both derive the same way.
 *
 * Keyed on the run and not on the driver's port. The port used to be one number for the whole
 * battery; with a worker per port it is not, and a tally keyed on it would split as many ways as
 * there are workers, leaving the guard reading a fraction of the run and calling it the whole.
 * Several workers append to this file at once, which is safe: each write is one short line opened
 * `O_APPEND`, and the reader takes the unique set anyway. See BACKLOG.md N24.
 */
function tallyFile() {
  // Read when it is used, never at import. A module body runs before the importing file's own, so
  // the launcher computed this before it had set the variable while every worker inherited it
  // already set: the two named different files and the guard read an empty one. Measured, on the
  // first parallel run: four spec files passed and the tally reported zero tests.
  const runKey = process.env.SUBLORE_E2E_RUN_HOME ?? repoRoot;
  return path.join(
    os.tmpdir(),
    `sublore-e2e-tally-${createHash("sha1").update(runKey).digest("hex").slice(0, 12)}`,
  );
}

export function resetTally() {
  writeFileSync(tallyFile(), "");
}

export function recordPassedTest(title) {
  appendFileSync(tallyFile(), `${title.replace(/\n/g, " ")}\n`);
}

export function passedTests() {
  try {
    // Unique, because a retried spec file appends its passing tests a second time and a count that
    // grew with a retry would let a deleted spec hide behind one. A title names one test.
    return [
      ...new Set(
        readFileSync(tallyFile(), "utf8")
          .split("\n")
          .filter((line) => line !== ""),
      ),
    ];
  } catch {
    return [];
  }
}
