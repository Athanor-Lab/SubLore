/* global describe, it, before, document, window */
/**
 * Sorting cues by start or end time: the whole document, or the selected cues among the positions
 * they occupy. The fixture is deliberately out of order, and its start order and end order differ,
 * so a sort by the wrong key would land the wrong sequence and the check would see it. What is read
 * is the grid's order and which rows it marks selected. The reorder edit's own correctness is proved
 * in the crate's unit tests. See docs/reorder-tasks.md.
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

const FIXTURE = ["srt", "clean", "out-of-order-lf.srt"];
// File order, and the two orders a sort should give.
const FILE_ORDER = ["start 5, end 20", "start 1, end 30", "start 3, end 10"];
const BY_START = ["start 1, end 30", "start 3, end 10", "start 5, end 20"];
const BY_END = ["start 3, end 10", "start 5, end 20", "start 1, end 30"];

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
    throw new Error(
      `E2E prerequisite missing: ${from} does not exist. It is committed; restore it with ` +
        "`git checkout fixtures/subtitles`.",
    );
  }
  const directory = path.join(dataHome(), "cue-sort");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const copy = path.join(directory, "out-of-order-lf.srt");
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
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

function rowTexts() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".cuelist__row")).map(
      (row) => row.querySelector(".cuelist__text")?.textContent ?? null,
    ),
  );
}

function selectedPositions() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".cuelist__row--selected")).map(
      (row) => row.querySelector(".cuelist__pos")?.textContent ?? null,
    ),
  );
}

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

async function closeMenu() {
  await waitFor(
    async () => {
      if (!(await present(".menubar__menu"))) {
        return 1;
      }
      pressKey("Escape");
      return null;
    },
    { timeout: 15000, message: "the menu to close" },
  );
}

/**
 * Open a sort submenu and report which of its two keys are greyed. A submenu is openable while it
 * has items (that is `usable` in MenuBar), so what greys with the selection is the keys inside it,
 * not the row that opens them, exactly as the Join submenu behaves.
 */
async function sortKeysDisabled(toplevel, submenu, items) {
  await clickElement(toplevel, ".menubar__title--subtitle");
  await waitFor(() => present(`.menubar__submenu--${submenu}`), {
    timeout: 15000,
    message: `the Subtitle menu to open on ${submenu}`,
  });
  await clickElement(toplevel, `.menubar__submenu--${submenu}`);
  await waitFor(() => present(`.menubar__item--${items[0]}`), {
    timeout: 15000,
    message: `the ${submenu} list to open`,
  });
  const disabled = await browser.execute(
    (tokens) =>
      tokens.map((token) => document.querySelector(`.menubar__item--${token}`)?.disabled === true),
    items,
  );
  await closeMenu();
  return disabled;
}

/** Open the Subtitle menu, open a sort submenu, and click one of its two keys. */
async function pickSort(toplevel, submenu, item) {
  await clickElement(toplevel, ".menubar__title--subtitle");
  await waitFor(() => present(`.menubar__submenu--${submenu}`), {
    timeout: 15000,
    message: `the Subtitle menu to open on ${submenu}`,
  });
  await clickElement(toplevel, `.menubar__submenu--${submenu}`);
  await waitFor(() => present(`.menubar__item--${item}`), {
    timeout: 15000,
    message: `the ${submenu} list to open on ${item}`,
  });
  await clickElement(toplevel, `.menubar__item--${item}`);
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

describe("sorting cues by time", () => {
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
    await waitForOrder(FILE_ORDER);
  });

  it("sorts the whole document by start time", async () => {
    await watchCommands();
    await pickSort(toplevel, "subtitle-sort-all", "subtitle-sort-all-start");
    await waitForOrder(BY_START);
    expect(await takeCommands()).toEqual(["subtitle_reorder"]);
  });

  it("sorts the whole document by end time, a different order from start", async () => {
    await watchCommands();
    await pickSort(toplevel, "subtitle-sort-all", "subtitle-sort-all-end");
    await waitForOrder(BY_END);
    expect(await takeCommands()).toEqual(["subtitle_reorder"]);
  });

  it("does nothing when the document is already in that order", async () => {
    // It is by-end now; sorting by end again is a no-op that sends no command.
    await watchCommands();
    await pickSort(toplevel, "subtitle-sort-all", "subtitle-sort-all-end");
    await waitForOrder(BY_END);
    expect(await takeCommands()).toEqual([]);
  });

  it("sorts only the selected cues, leaving the rest where they are", async () => {
    // From by-start order [start 1, start 3, start 5], select the first two and sort them by end:
    // their ends are 30 and 10, so they swap, while the third (start 5, end 20) stays last and
    // untouched. That last row staying is the whole point of a selected sort.
    await pickSort(toplevel, "subtitle-sort-all", "subtitle-sort-all-start");
    await waitForOrder(BY_START);

    await clickRow(toplevel, 1);
    pressKey("shift+Down");
    await waitFor(async () => ((await selectedPositions()).join(",") === "1,2" ? 1 : null), {
      timeout: 15000,
      message: "the first two rows selected",
    });

    await watchCommands();
    await pickSort(toplevel, "subtitle-sort-selected", "subtitle-sort-selected-end");
    await waitForOrder(["start 3, end 10", "start 1, end 30", "start 5, end 20"]);
    expect(await takeCommands()).toEqual(["subtitle_reorder"]);
  });

  it("greys the selected sort's keys until two or more cues are selected", async () => {
    const allKeys = ["subtitle-sort-all-start", "subtitle-sort-all-end"];
    const selKeys = ["subtitle-sort-selected-start", "subtitle-sort-selected-end"];

    await clickRow(toplevel, 1);
    await waitFor(async () => ((await selectedPositions()).join(",") === "1" ? 1 : null), {
      timeout: 15000,
      message: "one row selected",
    });
    // A document is open, so Sort all's keys work; Sort selected's keys need a second row.
    expect(await sortKeysDisabled(toplevel, "subtitle-sort-all", allKeys)).toEqual([false, false]);
    expect(await sortKeysDisabled(toplevel, "subtitle-sort-selected", selKeys)).toEqual([
      true,
      true,
    ]);

    await clickRow(toplevel, 1);
    pressKey("shift+Down");
    await waitFor(async () => ((await selectedPositions()).join(",") === "1,2" ? 1 : null), {
      timeout: 15000,
      message: "two rows selected",
    });
    expect(await sortKeysDisabled(toplevel, "subtitle-sort-selected", selKeys)).toEqual([
      false,
      false,
    ]);
  });
});
