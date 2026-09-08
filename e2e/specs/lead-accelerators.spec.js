/* global describe, it, before, document, window */
/**
 * Lead-in and lead-out from the keyboard. The reference binds them to two bare letters, C and V
 * (interface-spec 3.4), and the whole change is those two accelerator strings: the field rule that
 * keeps a bare letter inside a text box and the gate that runs it outside one are already there.
 *
 * Proved by the times the grid draws: C pulls the cursor cue's start 100 ms back, V pushes its end
 * 350 ms on, and neither moves a time while a text box has the keyboard.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow, pressKey } from "../lib/input.js";
import { repoRoot, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

/** Three cues, so the middle one has a start to pull back and an end to push on. */
const FIXTURE = ["srt", "clean", "basic-lf.srt"];
const LEAD_IN_MS = 100;
const LEAD_OUT_MS = 350;

function dataHome() {
  const home = process.env.SUBLORE_E2E_DATA_HOME;
  if (typeof home !== "string" || home === "") {
    throw new Error("SUBLORE_E2E_DATA_HOME is not set; e2e/wdio.conf.js sets it for every run.");
  }
  return home;
}

function workingCopy() {
  const from = path.join(repoRoot, "fixtures", "subtitles", ...FIXTURE);
  if (!existsSync(from)) {
    throw new Error(`E2E prerequisite missing: ${from} does not exist. Restore it with git.`);
  }
  const directory = path.join(dataHome(), "lead-accelerators");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const copy = path.join(directory, "basic-lf.srt");
  copyFileSync(from, copy);
  return copy;
}

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

/** The centre of an element in physical pixels, or null when it is not drawn. */
function centreOf(selector) {
  return browser.execute((css) => {
    const rect = document.querySelector(css)?.getBoundingClientRect();
    if (rect === undefined) {
      return null;
    }
    const dpr = window.devicePixelRatio;
    return { x: (rect.x + rect.width / 2) * dpr, y: (rect.y + rect.height / 2) * dpr };
  }, selector);
}

async function clickElement(toplevel, selector) {
  const centre = await centreOf(selector);
  if (centre === null) {
    throw new Error(`${selector} is missing from the DOM`);
  }
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

/** A timecode the grid drew, as the milliseconds the product reasons in. The grid draws three
 *  fractional digits, so the fraction is milliseconds already (cueView.ts `pad(millis, 3)`). */
function asMillis(timecode) {
  const parts = /^(\d+):(\d+):(\d+)\.(\d+)$/.exec(timecode ?? "");
  if (parts === null) {
    throw new Error(`"${timecode}" is not a timecode the grid draws`);
  }
  const [, h, m, s, ms] = parts;
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms);
}

/** The start and end of the row at a 1-based position, in milliseconds. */
function rowTimes(position) {
  return browser.execute((wanted) => {
    const row = Array.from(document.querySelectorAll(".cuelist__row")).find(
      (candidate) => candidate.querySelector(".cuelist__pos")?.textContent === wanted,
    );
    return {
      start: row?.querySelector(".cuelist__start")?.textContent ?? null,
      end: row?.querySelector(".cuelist__end")?.textContent ?? null,
    };
  }, String(position));
}

/** Select the row at a 1-based position by clicking its number cell, which focuses the grid too. */
async function selectRow(toplevel, position) {
  const centre = await browser.execute((wanted) => {
    const row = Array.from(document.querySelectorAll(".cuelist__row")).find(
      (candidate) => candidate.querySelector(".cuelist__pos")?.textContent === wanted,
    );
    const rect = row?.querySelector(".cuelist__pos")?.getBoundingClientRect();
    if (rect === undefined) {
      return null;
    }
    const dpr = window.devicePixelRatio;
    return { x: (rect.x + rect.width / 2) * dpr, y: (rect.y + rect.height / 2) * dpr };
  }, String(position));
  if (centre === null) {
    throw new Error(`row ${position} is not rendered`);
  }
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

describe("lead-in and lead-out on the keyboard", () => {
  let toplevel = null;

  before(async () => {
    const copy = workingCopy();
    toplevel = await waitFor(findToplevel, {
      timeout: 30000,
      message: `the ${windowWidth}x${windowHeight} "Sublore" toplevel to appear`,
    });
    focusWindow(toplevel.id);
    await waitFor(() => present(".toolbar__file-open-subtitle"), {
      timeout: 30000,
      message: "the app UI to render",
    });
    await clickElement(toplevel, ".toolbar__file-open-subtitle");
    const chooser = await waitForChooser("Choose a subtitle");
    await answerChooser(chooser, copy, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(() => present(".cuelist__row"), {
      timeout: 20000,
      message: "the fixture to open",
    });
  });

  it("pulls the start back 100 ms on C and pushes the end on 350 ms on V", async () => {
    await selectRow(toplevel, 2);
    const before = await rowTimes(2);
    const startWas = asMillis(before.start);
    const endWas = asMillis(before.end);

    pressKey("c");
    await waitFor(
      async () => {
        const now = await rowTimes(2);
        return asMillis(now.start) !== startWas ? now : null;
      },
      { timeout: 15000, message: "C to pull the start back" },
    );
    let now = await rowTimes(2);
    expect(asMillis(now.start)).toBe(startWas - LEAD_IN_MS);
    expect(now.end).toBe(before.end);

    pressKey("v");
    await waitFor(
      async () => {
        const after = await rowTimes(2);
        return asMillis(after.end) !== endWas ? after : null;
      },
      { timeout: 15000, message: "V to push the end on" },
    );
    now = await rowTimes(2);
    expect(asMillis(now.end)).toBe(endWas + LEAD_OUT_MS);
    // The start is where C left it, not where it began: V moves the end alone.
    expect(asMillis(now.start)).toBe(startWas - LEAD_IN_MS);

    // Each lead is one undo; two undos put the cue back exactly.
    await clickElement(toplevel, ".toolbar__edit-undo");
    await clickElement(toplevel, ".toolbar__edit-undo");
    await waitFor(
      async () => {
        const back = await rowTimes(2);
        return asMillis(back.start) === startWas && asMillis(back.end) === endWas ? back : null;
      },
      { timeout: 15000, message: "two undos to restore the cue" },
    );
  });

  it("takes the letter as a character in a text box and moves no time", async () => {
    await selectRow(toplevel, 2);
    const before = await rowTimes(2);

    // Open the row's own editor, which is a text field: the field keeps C and V as characters.
    await clickElement(toplevel, ".cuelist__row--selected .cuelist__text");
    await waitFor(() => present(".cuelist__editor"), {
      timeout: 15000,
      message: "the inline editor to open",
    });
    pressKey("c");
    pressKey("v");
    // Give any misfired accelerator time to land before reading the times back.
    await browser.pause(300);
    const after = await rowTimes(2);
    expect(after.start).toBe(before.start);
    expect(after.end).toBe(before.end);

    // Leave the document as it was found: Escape drops the edit rather than committing it.
    pressKey("Escape");
    await waitFor(async () => ((await present(".cuelist__editor")) ? null : 1), {
      timeout: 15000,
      message: "the editor to close on Escape",
    });
  });
});
