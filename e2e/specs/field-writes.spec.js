/* global describe, it, before, document, window, Event */
/**
 * N148: a metadata field writes to every selected cue, not only the current one.
 *
 * The owner decided it on 3 September 2026, answer 46, and it had never been built: the command took
 * one cue and the panel handed it the row it was showing. The fixture is `speakers.ass`, five cues
 * whose third one already carries the other style, so setting the whole selection to that style
 * changes two rows and leaves the third alone: a write that reached one row cannot pass.
 *
 * Text and the two time fields stay on the current line, which is what the reference does; the last
 * check here is what keeps that true.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, clickWith, focusWindow, pressKey, typeText } from "../lib/input.js";
import { repoRoot, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

/** Five cues, two styles, the third cue already carrying the second one. */
const FIXTURE = ["ass", "clean", "speakers.ass"];
const OTHER_STYLE = "Sign";
const OPENED_STYLES = ["Default", "Default", "Sign", "Default", "Default"];

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
    throw new Error(`E2E prerequisite missing: ${from}. It is committed; restore it with git.`);
  }
  const directory = path.join(dataHome(), "field-writes");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const copy = path.join(directory, "speakers.ass");
  copyFileSync(from, copy);
  return copy;
}

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

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
    throw new Error(`${selector} is missing from the DOM, so there is nothing to click`);
  }
  // No window manager under Xvfb, so the toplevel origin is also the viewport origin.
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

/** Where a row's own position cell sits on the display, by its 1-based list position. */
async function rowAt(toplevel, position) {
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
  return { x: toplevel.absX + centre.x, y: toplevel.absY + centre.y };
}

/** The style column, row by row, in the grid's own order. */
function gridStyles() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".cuelist__row")).map(
      (row) => row.querySelector(".cuelist__style")?.textContent ?? "",
    ),
  );
}

/** Which rows the grid draws as comments, by their 1-based position. */
function commentedRows() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".cuelist__row--comment")).map(
      (row) => row.querySelector(".cuelist__pos")?.textContent ?? "",
    ),
  );
}

/** Which rows are drawn selected, by their 1-based position. */
function selectedRows() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".cuelist__row--selected")).map(
      (row) => row.querySelector(".cuelist__pos")?.textContent ?? "",
    ),
  );
}

/** Set the panel's style dropdown the way a person picks from it. */
function pickStyle(name) {
  return browser.execute((wanted) => {
    const choice = document.querySelector(".currentline__style");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
    setter.call(choice, wanted);
    choice.dispatchEvent(new Event("change", { bubbles: true }));
  }, name);
}

/** The text of the cue at a 1-based list position. */
function rowText(position) {
  return browser.execute((wanted) => {
    const row = Array.from(document.querySelectorAll(".cuelist__row")).find(
      (candidate) => candidate.querySelector(".cuelist__pos")?.textContent === wanted,
    );
    return row?.querySelector(".cuelist__text")?.textContent ?? null;
  }, String(position));
}

describe("a field writes to every selected cue", () => {
  let toplevel = null;
  let copy = null;

  before(async () => {
    copy = workingCopy();
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
    await waitFor(async () => ((await gridStyles()).length === 5 ? 1 : null), {
      timeout: 20000,
      message: "the five cues of the fixture to reach the grid",
    });
  });

  it("writes the style onto rows 2 to 4 and leaves the rest alone", async () => {
    expect(await gridStyles()).toEqual(OPENED_STYLES);

    const second = await rowAt(toplevel, 2);
    clickAt(second.x, second.y);
    const fourth = await rowAt(toplevel, 4);
    clickWith("shift", fourth.x, fourth.y);
    await waitFor(async () => ((await selectedRows()).length === 3 ? 1 : null), {
      timeout: 15000,
      message: "rows 2, 3 and 4 to be selected together",
    });
    expect(await selectedRows()).toEqual(["2", "3", "4"]);

    await pickStyle(OTHER_STYLE);
    // Rows 2 and 4 change and row 3 already held it, so a write that reached one row alone cannot
    // produce this. Rows 1 and 5 are the control.
    await waitFor(
      async () => {
        const styles = await gridStyles();
        return styles[1] === OTHER_STYLE && styles[3] === OTHER_STYLE ? 1 : null;
      },
      { timeout: 20000, message: "the style to reach every selected row" },
    );
    expect(await gridStyles()).toEqual(["Default", "Sign", "Sign", "Sign", "Default"]);
  });

  it("takes all three back in one undo step", async () => {
    pressKey("ctrl+z");
    await waitFor(async () => ((await gridStyles())[1] === "Default" ? 1 : null), {
      timeout: 20000,
      message: "the first undo to take the style write back",
    });
    // One step for the whole write, not one per row: a second undo would go past it into the open.
    expect(await gridStyles()).toEqual(OPENED_STYLES);
  });

  it("writes the comment flag onto the same three rows", async () => {
    expect(await commentedRows()).toEqual([]);
    await clickElement(toplevel, ".currentline__comment");
    await waitFor(async () => ((await commentedRows()).length === 3 ? 1 : null), {
      timeout: 20000,
      message: "the comment flag to reach every selected row",
    });
    expect(await commentedRows()).toEqual(["2", "3", "4"]);

    pressKey("ctrl+z");
    await waitFor(async () => ((await commentedRows()).length === 0 ? 1 : null), {
      timeout: 20000,
      message: "one undo to take the comment flag off all three",
    });
  });

  it("writes only its own row when the cursor is moved out of the selection", async () => {
    // Ctrl with an arrow moves the cursor and leaves the selection where it is, which is the one
    // gesture the reference has no equivalent for: its current line is always inside the selection.
    const grid = await rowAt(toplevel, 3);
    clickAt(grid.x, grid.y);
    const fifth = await rowAt(toplevel, 5);
    clickWith("shift", fifth.x, fifth.y);
    await waitFor(async () => ((await selectedRows()).length === 3 ? 1 : null), {
      timeout: 15000,
      message: "rows 3, 4 and 5 to be selected together",
    });
    // Three presses, so the cursor ends on row 2, which is outside the selection. Two would leave
    // it on row 3, still inside it, and the write would go to the whole selection after all.
    pressKey("ctrl+Up");
    pressKey("ctrl+Up");
    pressKey("ctrl+Up");
    await waitFor(
      async () =>
        (await browser.execute(
          () => document.querySelector(".cuelist__row--active .cuelist__pos")?.textContent ?? null,
        )) === "2"
          ? 1
          : null,
      { timeout: 15000, message: "the cursor to walk up to row 2 without moving the selection" },
    );
    expect(await selectedRows()).toEqual(["3", "4", "5"]);

    await pickStyle(OTHER_STYLE);
    await waitFor(async () => ((await gridStyles())[1] === OTHER_STYLE ? 1 : null), {
      timeout: 20000,
      message: "the style to reach the row the cursor is on",
    });
    // Rows 3, 4 and 5 are the selected ones and none of them moved: the cursor had left it.
    expect(await gridStyles()).toEqual(["Default", "Sign", "Sign", "Default", "Default"]);

    pressKey("ctrl+z");
    await waitFor(async () => ((await gridStyles())[1] === "Default" ? 1 : null), {
      timeout: 20000,
      message: "the undo to put row 2 back",
    });
  });

  it("keeps the text on the current line, whatever else is selected", async () => {
    const second = await rowAt(toplevel, 2);
    clickAt(second.x, second.y);
    const fourth = await rowAt(toplevel, 4);
    clickWith("shift", fourth.x, fourth.y);
    await waitFor(async () => ((await selectedRows()).length === 3 ? 1 : null), {
      timeout: 15000,
      message: "rows 2, 3 and 4 to be selected together",
    });
    const before = await Promise.all([rowText(2), rowText(3), rowText(4)]);

    await clickElement(toplevel, ".currentline__text");
    typeText(" typed into one row");
    pressKey("Tab");
    await waitFor(
      async () => ((await rowText(4))?.endsWith("typed into one row") === true ? 1 : null),
      {
        timeout: 20000,
        message: "the typed words to reach the row the cursor is on",
      },
    );
    // The other two rows of the selection are untouched: answer 46 is about the metadata fields,
    // and the reference writes text and times to the current line alone.
    expect([await rowText(2), await rowText(3)]).toEqual([before[0], before[1]]);
  });
});
