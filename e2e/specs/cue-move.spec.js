/* global describe, it, before, document, window */
/**
 * Moving cues up and down (Alt+Up, Alt+Down): the selected cues trade places with the neighbour on
 * the side they move toward, the selection follows them, and a move at the edge does nothing and
 * sends no command. What is read is the grid's own order and which rows it marks selected, because
 * that is what a translator sees; the reorder edit's own correctness is proved in the crate's unit
 * tests. See docs/reorder-tasks.md.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow, pressKey } from "../lib/input.js";
import { takeCommands, watchCommands } from "../lib/ipc.js";
import { repoRoot, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

const FIXTURE = ["srt", "clean", "basic-lf.srt"];
const FIRST = "The harbour was empty when we got there.";
const SECOND =
  "Nobody had told the crew we were coming,\nso we sat on the dock until it got light.";
const THIRD = "By then the fog had eaten the boats.";

function dataHome() {
  const home = process.env.SUBLORE_E2E_DATA_HOME;
  if (typeof home !== "string" || home === "") {
    throw new Error("SUBLORE_E2E_DATA_HOME is not set; e2e/wdio.conf.js sets it for every run.");
  }
  return home;
}

/** Writes go to the harness temp dir. The committed fixture is copied, never opened directly. */
function workingCopy() {
  const from = path.join(repoRoot, "fixtures", "subtitles", ...FIXTURE);
  if (!existsSync(from)) {
    throw new Error(
      `E2E prerequisite missing: ${from} does not exist. It is committed; restore it with ` +
        "`git checkout fixtures/subtitles`.",
    );
  }
  const directory = path.join(dataHome(), "cue-move");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const copy = path.join(directory, "basic-lf.srt");
  copyFileSync(from, copy);
  return copy;
}

function centreOf(selector) {
  return browser.execute((css) => {
    const element = document.querySelector(css);
    if (element === null) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    return { x: (rect.x + rect.width / 2) * dpr, y: (rect.y + rect.height / 2) * dpr };
  }, selector);
}

async function clickElement(toplevel, selector) {
  const centre = await centreOf(selector);
  if (centre === null) {
    throw new Error(`${selector} is missing from the DOM, so there is nothing to click`);
  }
  // No window manager under Xvfb, so the toplevel origin is also the viewport origin.
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

/** The text of every rendered row, in list order. */
function rowTexts() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".cuelist__row")).map(
      (row) => row.querySelector(".cuelist__text")?.textContent ?? null,
    ),
  );
}

/** The 1-based positions the grid marks selected, as strings, in order. */
function selectedPositions() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".cuelist__row--selected")).map(
      (row) => row.querySelector(".cuelist__pos")?.textContent ?? null,
    ),
  );
}

/** Click the row at a 1-based list position, which also selects it. */
async function clickRow(toplevel, position) {
  const centre = await browser.execute((wanted) => {
    const row = Array.from(document.querySelectorAll(".cuelist__row")).find(
      (candidate) => candidate.querySelector(".cuelist__pos")?.textContent === wanted,
    );
    const cell = row?.querySelector(".cuelist__pos");
    if (!cell) {
      return null;
    }
    const rect = cell.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    return { x: (rect.x + rect.width / 2) * dpr, y: (rect.y + rect.height / 2) * dpr };
  }, String(position));
  if (centre === null) {
    throw new Error(`row ${position} is not rendered`);
  }
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

async function waitForOrder(order) {
  await waitFor(
    async () => {
      const texts = await rowTexts();
      return texts.length === order.length && texts.every((text, at) => text === order[at])
        ? 1
        : null;
    },
    { timeout: 15000, message: `the grid to read ${JSON.stringify(order)}` },
  );
}

async function waitForSelected(positions) {
  await waitFor(
    async () => ((await selectedPositions()).join(",") === positions.join(",") ? 1 : null),
    { timeout: 15000, message: `rows ${positions.join(",")} to be the selected ones` },
  );
}

describe("moving cues up and down", () => {
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
    await waitForOrder([FIRST, SECOND, THIRD]);
  });

  it("moves the selected cue up, and the selection follows it", async () => {
    await clickRow(toplevel, 3);
    await waitForSelected(["3"]);

    await watchCommands();
    pressKey("alt+Up");
    await waitForOrder([FIRST, THIRD, SECOND]);
    await waitForSelected(["2"]);
    expect(await takeCommands()).toEqual(["subtitle_reorder"]);
  });

  it("moves the selected cue back down, restoring the order", async () => {
    await watchCommands();
    pressKey("alt+Down");
    await waitForOrder([FIRST, SECOND, THIRD]);
    await waitForSelected(["3"]);
    expect(await takeCommands()).toEqual(["subtitle_reorder"]);
  });

  it("does nothing at the top edge, so a move up there sends no command", async () => {
    await clickRow(toplevel, 1);
    await waitForSelected(["1"]);

    await watchCommands();
    // Up at the top is a no-op; the down after it is a real move. Only the down crosses the
    // boundary, which is how this proves the no-op sent nothing without waiting on a negative.
    pressKey("alt+Up");
    pressKey("alt+Down");
    await waitForOrder([SECOND, FIRST, THIRD]);
    await waitForSelected(["2"]);
    expect(await takeCommands()).toEqual(["subtitle_reorder"]);

    // Put it back for the block test.
    pressKey("alt+Up");
    await waitForOrder([FIRST, SECOND, THIRD]);
    await waitForSelected(["1"]);
  });

  it("moves a contiguous block as one, keeping its inner order", async () => {
    await clickRow(toplevel, 1);
    pressKey("shift+Down");
    await waitForSelected(["1", "2"]);

    await watchCommands();
    pressKey("alt+Down");
    await waitForOrder([THIRD, FIRST, SECOND]);
    await waitForSelected(["2", "3"]);
    expect(await takeCommands()).toEqual(["subtitle_reorder"]);
  });
});
