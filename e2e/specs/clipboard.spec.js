/* global describe, it, before, document, window */
/**
 * The clipboard group of the Edit menu: copy cues, paste over cues, select all cues.
 *
 * Paste over asks which fields to take before it takes them (N45), so every paste here answers
 * that dialog with the boxes it opens holding. What the dialog itself does is `paste-over.spec.js`.
 *
 * The round trip is what is checked, and it has to be: the page cannot reach the clipboard at all
 * under this webview, so a copy that wrote nowhere and a paste that read nothing would both look
 * like success from inside the page. Copying and then pasting back is the only thing that proves
 * the text left the app and came home.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow, pressKey } from "../lib/input.js";
import { repoRoot, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

/** Three cues whose texts differ, which is what makes a paste visible. */
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
  const directory = path.join(dataHome(), "clipboard");
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

function textOf(selector) {
  return browser.execute((css) => document.querySelector(css)?.textContent ?? null, selector);
}

/** The text of every rendered row, in list order. */
function rowTexts() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".cuelist__row")).map(
      (row) => row.querySelector(".cuelist__text")?.textContent ?? null,
    ),
  );
}

/** How many rows the grid marks as selected. */
function selectedCount() {
  return browser.execute(() => document.querySelectorAll(".cuelist__row--selected").length);
}

/** Click the row at a 1-based list position. */
async function clickRow(toplevel, position) {
  const centre = await browser.execute((wanted) => {
    const rows = Array.from(document.querySelectorAll(".cuelist__row"));
    const row = rows.find(
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

/** Open the Edit menu and choose one of its items by command id. */
async function fromEditMenu(toplevel, token) {
  await clickElement(toplevel, ".menubar__title--edit");
  await waitFor(() => present(`.menubar__item--${token}`), {
    timeout: 15000,
    message: `the Edit menu to open on ${token}`,
  });
  await clickElement(toplevel, `.menubar__item--${token}`);
}

/** Whether an Edit menu item is drawn and greyed, without choosing it. */
/**
 * Answer the field dialog by asking for the text and nothing else, which is what these tests are
 * about. Said out loud rather than left to what the dialog opens holding: that is the last answer
 * any spec gave, and a test that passes because of the run order is a test that proves nothing.
 */
async function takeTheTextAlone(toplevel) {
  await waitFor(() => present(".pasteover"), {
    timeout: 15000,
    message: "the paste over field dialog to open",
  });
  await clickElement(toplevel, ".pasteover__onlytext");
  await clickElement(toplevel, ".pasteover__confirm");
  await waitFor(async () => ((await present(".pasteover")) ? null : 1), {
    timeout: 15000,
    message: "the paste over field dialog to close",
  });
}

async function editItem(toplevel, token) {
  await clickElement(toplevel, ".menubar__title--edit");
  await waitFor(() => present(`.menubar__item--${token}`), {
    timeout: 15000,
    message: `the Edit menu to open on ${token}`,
  });
  const state = await browser.execute((css) => {
    const item = document.querySelector(css);
    return item === null ? null : { drawn: true, disabled: item.disabled === true };
  }, `.menubar__item--${token}`);
  pressKey("Escape");
  await waitFor(async () => ((await present(`.menubar__item--${token}`)) ? null : 1), {
    timeout: 15000,
    message: "the Edit menu to close",
  });
  return state;
}

describe("the clipboard", () => {
  let toplevel = null;
  let copy = null;
  let bytesBefore = null;

  before(async () => {
    copy = workingCopy();
    bytesBefore = readFileSync(copy);
    toplevel = await waitFor(findToplevel, {
      timeout: 30000,
      message: `the ${windowWidth}x${windowHeight} "Sublore" toplevel to appear`,
    });
    focusWindow(toplevel.id);
    await waitFor(() => present(".toolbar__file-open-subtitle"), {
      timeout: 30000,
      message: "the app UI to render",
    });
  });

  it("greys the five of them with nothing open, and wakes them with a document", async () => {
    expect(await editItem(toplevel, "edit-cut")).toEqual({ drawn: true, disabled: true });
    expect(await editItem(toplevel, "edit-copy")).toEqual({ drawn: true, disabled: true });
    expect(await editItem(toplevel, "edit-paste")).toEqual({ drawn: true, disabled: true });
    expect(await editItem(toplevel, "edit-paste-over")).toEqual({ drawn: true, disabled: true });
    expect(await editItem(toplevel, "edit-select-all")).toEqual({ drawn: true, disabled: true });

    await clickElement(toplevel, ".toolbar__file-open-subtitle");
    const chooser = await waitForChooser("Choose a subtitle");
    await answerChooser(chooser, copy, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(
      async () => ((await textOf(".statusbar__document"))?.includes("3 cues") === true ? 1 : null),
      { timeout: 20000, message: "the fixture to open" },
    );

    // A document opens on its first row, so a row is selected and all of them can run.
    expect(await editItem(toplevel, "edit-cut")).toEqual({ drawn: true, disabled: false });
    expect(await editItem(toplevel, "edit-copy")).toEqual({ drawn: true, disabled: false });
    expect(await editItem(toplevel, "edit-paste")).toEqual({ drawn: true, disabled: false });
    expect(await editItem(toplevel, "edit-select-all")).toEqual({ drawn: true, disabled: false });
  });

  it("selects every row from the menu", async () => {
    expect(await selectedCount()).toBe(1);
    await fromEditMenu(toplevel, "edit-select-all");
    await waitFor(async () => ((await selectedCount()) === 3 ? 1 : null), {
      timeout: 15000,
      message: "all three rows to be selected",
    });
  });

  it("carries a line out to the clipboard and back over another row", async () => {
    await clickRow(toplevel, 1);
    await waitFor(async () => ((await selectedCount()) === 1 ? 1 : null), {
      timeout: 15000,
      message: "the first row alone to be selected",
    });
    await fromEditMenu(toplevel, "edit-copy");

    await clickRow(toplevel, 3);
    await waitFor(async () => ((await rowTexts())[2] === THIRD ? 1 : null), {
      timeout: 15000,
      message: "the third row to be the one it was",
    });
    await fromEditMenu(toplevel, "edit-paste-over");
    await takeTheTextAlone(toplevel);

    // The whole round trip: the text left the app through GTK's clipboard and came back through it.
    await waitFor(async () => ((await rowTexts())[2] === FIRST ? 1 : null), {
      timeout: 20000,
      message: "the first row's line to land on the third",
    });
    // Only that row moved, and the file on disk is untouched until a save.
    expect((await rowTexts())[0]).toBe(FIRST);
    expect(readFileSync(copy).equals(bytesBefore)).toBe(true);

    await clickElement(toplevel, ".toolbar__edit-undo");
    await waitFor(async () => ((await rowTexts())[2] === THIRD ? 1 : null), {
      timeout: 15000,
      message: "one undo to put the third row back",
    });
  });

  it("carries two cues out with the blank line that separates them, and both come back", async () => {
    // Two at once is the case a single cue cannot see: an SRT block is followed by a blank line,
    // and a copy that left it out would read back as one cue with the other's words stuck on.
    await fromEditMenu(toplevel, "edit-select-all");
    await waitFor(async () => ((await selectedCount()) === 3 ? 1 : null), {
      timeout: 15000,
      message: "every row to be selected",
    });
    await fromEditMenu(toplevel, "edit-copy");

    await fromEditMenu(toplevel, "edit-paste-over");
    await takeTheTextAlone(toplevel);
    // Three rows, three lines, and the second is the two-line one: a paste that read the clipboard
    // as one cue would put the whole file's text on the first row and leave the others alone.
    await waitFor(
      async () => {
        const rows = await rowTexts();
        return rows[0] === FIRST && rows[1] === SECOND && rows[2] === THIRD ? 1 : null;
      },
      { timeout: 20000, message: "the three lines to land on the three rows, unchanged" },
    );

    // Nothing moved, so nothing was written: pasting a document over itself is a no-op edit.
    expect(await present(".statusbar__dirty")).toBe(false);
  });

  it("takes the cue out of the document and puts it on the clipboard", async () => {
    await clickRow(toplevel, 2);
    await waitFor(async () => ((await selectedCount()) === 1 ? 1 : null), {
      timeout: 15000,
      message: "the second row alone to be selected",
    });

    await fromEditMenu(toplevel, "edit-cut");
    await waitFor(
      async () => {
        const rows = await rowTexts();
        return rows.length === 2 && rows[0] === FIRST && rows[1] === THIRD ? 1 : null;
      },
      { timeout: 20000, message: "the second row to go and the other two to close over it" },
    );

    // Where it went: the same round trip the copy check makes, so the cut is a copy as well as a
    // delete rather than a delete that happened to empty the clipboard.
    await clickRow(toplevel, 1);
    await fromEditMenu(toplevel, "edit-paste-over");
    await takeTheTextAlone(toplevel);
    await waitFor(async () => ((await rowTexts())[0] === SECOND ? 1 : null), {
      timeout: 20000,
      message: "the cut line to come back over the first row",
    });

    await clickElement(toplevel, ".toolbar__edit-undo");
    await waitFor(async () => ((await rowTexts())[0] === FIRST ? 1 : null), {
      timeout: 15000,
      message: "one undo to take the paste back",
    });
    await clickElement(toplevel, ".toolbar__edit-undo");
    await waitFor(
      async () => {
        const rows = await rowTexts();
        return rows.length === 3 && rows[1] === SECOND ? 1 : null;
      },
      { timeout: 15000, message: "one more undo to put the cut row back" },
    );
  });

  it("takes a scattered pair and leaves the row standing between them", async () => {
    await clickRow(toplevel, 1);
    await waitFor(async () => ((await selectedCount()) === 1 ? 1 : null), {
      timeout: 15000,
      message: "the first row alone to be selected",
    });
    // The cursor walks without taking the selection with it, and Ctrl+Space adds the row it
    // reaches: the only route to a scattered set there is (decision 5).
    pressKey("ctrl+Down");
    pressKey("ctrl+Down");
    pressKey("ctrl+space");
    await waitFor(async () => ((await selectedCount()) === 2 ? 1 : null), {
      timeout: 15000,
      message: "the first and the third rows to be selected",
    });

    await fromEditMenu(toplevel, "edit-cut");
    await waitFor(
      async () => {
        const rows = await rowTexts();
        return rows.length === 1 && rows[0] === SECOND ? 1 : null;
      },
      { timeout: 20000, message: "the two named rows to go and the one between them to stay" },
    );

    await clickElement(toplevel, ".toolbar__edit-undo");
    await waitFor(
      async () => {
        const rows = await rowTexts();
        return rows.length === 3 && rows[0] === FIRST && rows[2] === THIRD ? 1 : null;
      },
      { timeout: 15000, message: "one undo to put both of them back" },
    );
  });

  it("puts what the cut took back in, before the row the cursor is on", async () => {
    // The clipboard still holds the pair the check above cut, so this is the other half of that
    // gesture rather than a new fixture: what a cut takes out, a paste puts back.
    await clickRow(toplevel, 2);
    await waitFor(async () => ((await selectedCount()) === 1 ? 1 : null), {
      timeout: 15000,
      message: "the second row alone to be selected",
    });

    await fromEditMenu(toplevel, "edit-paste");
    await waitFor(
      async () => {
        const rows = await rowTexts();
        return rows.length === 5 && rows[1] === FIRST && rows[2] === THIRD ? 1 : null;
      },
      { timeout: 20000, message: "the two cut lines to land before the second row" },
    );
    // In before it, not over it: the row the cursor was on is still there, after them.
    expect((await rowTexts())[3]).toBe(SECOND);
    // And the rows that landed are the rows left selected, which is where the reference leaves
    // them and what makes a second paste land somewhere a translator can predict.
    expect(await selectedCount()).toBe(2);

    await clickElement(toplevel, ".toolbar__edit-undo");
    await waitFor(async () => ((await rowTexts()).length === 3 ? 1 : null), {
      timeout: 15000,
      message: "one undo to take the whole paste back",
    });
  });
});
