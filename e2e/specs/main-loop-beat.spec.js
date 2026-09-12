/* global describe, it, before */
/**
 * The beat that says when the app's main loop stalled.
 *
 * Twice in one battery on 2026-09-12 the app processed nothing for thirty and thirty-two seconds,
 * in two different specs and at two different moments, and the runner has been red on the same
 * silence more than once. Nothing could say whether the main thread was blocked at all, so four
 * attempts at reproducing it were searching without an instrument. `stall.rs` beats once a second
 * and writes a line when a beat is late.
 *
 * This spec runs against a main thread that is frozen on purpose, four seconds, which
 * `wdio.conf.js` arranges by this file's name. What it proves is that the instrument reports a
 * stall of about the length it was given. Every other spec in the battery is the control: none of
 * them freezes anything, and a late beat appearing in one of them is a real stall worth reading.
 */
import { expect } from "@wdio/globals";

import { appLog, dataHome, waitForLog } from "../lib/applog.js";
import { waitFor } from "../lib/proc.js";
import { windowHeight, windowWidth } from "../lib/paths.js";
import { findToplevel } from "../lib/x11.js";

/** What the hook was told to hold the thread for, set in `wdio.conf.js` by this file's name. */
const HELD_MS = 4000;

/**
 * How far off the reported gap may be. A beat is due at some point inside the hold rather than at
 * its start, so the gap is between the hold and the hold plus one beat, and the beat is a second.
 */
const SLACK_MS = 1500;

/** Every gap between beats the app has reported so far, in milliseconds, oldest first. */
function lateBeats() {
  return [...appLog(dataHome()).matchAll(/main loop: (\d+) ms between two beats/g)].map((found) =>
    Number(found[1]),
  );
}

describe("the beat on the main loop", () => {
  before(async () => {
    await waitFor(findToplevel, {
      timeout: 30000,
      message: `the ${windowWidth}x${windowHeight} "Sublore" toplevel to appear`,
    });
  });

  it("holds the main thread and then says how long for", async () => {
    // The hook says it is about to hold the thread, so a late beat found below cannot be from
    // something else that happened to stall at the same moment.
    await waitForLog(dataHome(), /main loop: SUBLORE_STALL_MAIN_MS=4000/, {
      timeout: 30000,
      what: "the app to say it is holding the main thread",
    });

    await waitForLog(dataHome(), /main loop: \d+ ms between two beats/, {
      timeout: 30000,
      what: "the beat to report the stall the hook made",
    });

    // How long it says, not just that it says something: an instrument that reports every stall as
    // the same number would pass a bare "there is a line" and tell nobody anything.
    const late = lateBeats();
    expect(late.length).toBeGreaterThan(0);
    const worst = Math.max(...late);
    expect(worst).toBeGreaterThan(HELD_MS - SLACK_MS);
    expect(worst).toBeLessThan(HELD_MS + 1000 + SLACK_MS);
  });
});
