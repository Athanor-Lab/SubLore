/* global describe, it, before, document, window */
/**
 * File then New: a document with nothing in it, and the first line written into it.
 *
 * An empty script is only worth having if it can be filled, so what is checked is the whole way
 * through: the empty document opens, takes its first line, saves where the chooser is answered and
 * reopens as the line that was typed. The unsaved work in the way is checked too, because New
 * throws away what is on screen if nothing stops it.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow, pressKey, typeText } from "../lib/input.js";
import { windowHeight, windowWidth } from "../lib/paths.js";
import { intoList } from "../lib/menu.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

/** Typed into the first line of the new document, so the save has something to carry. */
const FIRST_LINE = "The first line of a file that had none";

function dataHome() {
  const home = process.env.SUBLORE_E2E_DATA_HOME;
  if (typeof home !== "string" || home === "") {
    throw new Error("SUBLORE_E2E_DATA_HOME is not set; e2e/wdio.conf.js sets it for every run.");
  }
  return home;
}

function workingDir() {
  const directory = path.join(dataHome(), "new-document");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  return directory;
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

function rowCount() {
  return browser.execute(() => document.querySelectorAll(".cuelist__row").length);
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

/** Open a subtitle through the toolbar, answering the chooser with `file`. */
async function openSubtitle(toplevel, file) {
  await clickElement(toplevel, ".toolbar__file-open-subtitle");
  const chooser = await waitForChooser("Choose a subtitle");
  await answerChooser(chooser, file, "subtitle");
  focusWindow(toplevel.id);
}

/** Open one of the bar's menus and choose an item by command token. */
async function fromMenu(toplevel, title, token) {
  await clickElement(toplevel, `.menubar__title--${title}`);
  await waitFor(() => present(".menubar__menu"), {
    timeout: 15000,
    message: `the ${title} menu to open`,
  });
  await intoList((css) => clickElement(toplevel, css), token);
  await waitFor(() => present(`.menubar__item--${token}`), {
    timeout: 15000,
    message: `the ${title} menu to open on ${token}`,
  });
  await clickElement(toplevel, `.menubar__item--${token}`);
}

describe("a document with nothing in it", () => {
  let toplevel = null;
  let written = null;

  before(async () => {
    written = path.join(workingDir(), "new.ass");
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

  it("opens an empty script from the File menu, with no rows and no file behind it", async () => {
    await fromMenu(toplevel, "file", "file-new");
    await waitFor(
      async () => ((await textOf(".statusbar__document"))?.includes("0 cues") === true ? 1 : null),
      { timeout: 20000, message: "the empty document to open" },
    );

    expect(await rowCount()).toBe(0);
    // ASS, because that is the format that can hold everything the editor writes.
    expect(await textOf(".statusbar__document")).toContain("ASS");
    // Nothing has been edited, so there is nothing unsaved yet either.
    expect(await present(".statusbar__dirty")).toBe(false);
  });

  it("takes its first line, which is what an empty section could not do before", async () => {
    await fromMenu(toplevel, "subtitle", "subtitle-insert-after");
    await waitFor(async () => ((await rowCount()) === 1 ? 1 : null), {
      timeout: 20000,
      message: "the first row to appear",
    });

    // Typed into the current line's own box, which is the way a translator writes one.
    await clickElement(toplevel, ".currentline__text");
    typeText(FIRST_LINE);
    pressKey("Tab");
    await waitFor(
      async () =>
        (await browser.execute(
          () => document.querySelector(".cuelist__row .cuelist__text")?.textContent ?? null,
        )) === FIRST_LINE
          ? 1
          : null,
      { timeout: 20000, message: "the typed line to reach the grid" },
    );
  });

  it("asks where it goes, and the file it writes reopens as what was typed", async () => {
    await clickElement(toplevel, ".toolbar__file-save");
    const chooser = await waitForChooser("Save the subtitle");
    await answerChooser(chooser, written, "subtitle-first-save");
    focusWindow(toplevel.id);
    await waitFor(
      async () => ((await textOf(".statusbar__message"))?.includes("aved") === true ? 1 : null),
      { timeout: 20000, message: "the new document to be saved" },
    );

    expect(existsSync(written)).toBe(true);
    const bytes = readFileSync(written, "utf8");
    // A script, with its style and its one event: the header the empty document carried is on disk
    // too, so what reopens is a file every player reads.
    expect(bytes).toContain("[V4+ Styles]");
    expect(bytes).toContain("Style: Default,");
    expect(bytes).toContain(`,,${FIRST_LINE}`);

    await clickElement(toplevel, ".toolbar__file-open-subtitle");
    const reopen = await waitForChooser("Choose a subtitle");
    await answerChooser(reopen, written, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(
      async () => ((await textOf(".statusbar__document"))?.includes("1 cue") === true ? 1 : null),
      { timeout: 20000, message: "the saved file to reopen" },
    );
    expect(
      await browser.execute(
        () => document.querySelector(".cuelist__row .cuelist__text")?.textContent ?? null,
      ),
    ).toBe(FIRST_LINE);
  });

  it("waits for the unsaved work in its way, and goes ahead once it is discarded", async () => {
    // An edit that is not on disk, so New has something to refuse over.
    await clickElement(toplevel, ".currentline__text");
    typeText(" and an edit after the save");
    pressKey("Tab");
    await waitFor(() => present(".statusbar__dirty"), {
      timeout: 15000,
      message: "the document to be marked unsaved",
    });

    pressKey("ctrl+n");
    await waitFor(
      async () => ((await textOf(".statusbar__error"))?.includes("not saved") === true ? 1 : null),
      { timeout: 20000, message: "the refusal to reach the status bar" },
    );
    // What was on screen is still on screen: nothing was thrown away.
    expect(await rowCount()).toBe(1);

    await fromMenu(toplevel, "file", "file-discard");
    await waitFor(async () => ((await rowCount()) === 0 ? 1 : null), {
      timeout: 20000,
      message: "the empty document to arrive once the work was discarded",
    });
    expect(await textOf(".statusbar__document")).toContain("0 cues");
    // And the file on disk still holds what was saved into it, edit and all not written.
    expect(readFileSync(written, "utf8")).toContain(`,,${FIRST_LINE}`);
  });

  it("discards for the open that was refused last, not for the New refused before it", async () => {
    // Two refusals in a row, and Discard acts on one of them. The one it owes an answer to is the
    // last thing the user asked for, which here is the open. See BACKLOG.md N147.
    await openSubtitle(toplevel, written);
    await waitFor(async () => ((await rowCount()) === 1 ? 1 : null), {
      timeout: 20000,
      message: "the saved file to open with its one line",
    });

    await clickElement(toplevel, ".currentline__text");
    typeText(" and an edit that stands in the way");
    pressKey("Tab");
    await waitFor(() => present(".statusbar__dirty"), {
      timeout: 15000,
      message: "the document to be marked unsaved",
    });

    // New first, refused.
    pressKey("ctrl+n");
    await waitFor(
      async () => ((await textOf(".statusbar__error"))?.includes("not saved") === true ? 1 : null),
      { timeout: 20000, message: "New to be refused over the unsaved edit" },
    );
    // Then the open, refused too, and it is the one Discard owes an answer to.
    await openSubtitle(toplevel, written);
    await waitFor(
      async () => ((await textOf(".statusbar__error"))?.includes("not saved") === true ? 1 : null),
      { timeout: 20000, message: "the open to be refused over the same edit" },
    );

    await fromMenu(toplevel, "file", "file-discard");
    // The file's own line, not the empty document New would have made.
    await waitFor(async () => ((await rowText(1))?.includes(FIRST_LINE) === true ? 1 : null), {
      timeout: 20000,
      message: "the file the user asked for to open once the edit was discarded",
    });
    expect(await rowCount()).toBe(1);
  });
});
