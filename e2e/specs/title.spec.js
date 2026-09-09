/* global describe, it, before, document, window */
/**
 * N57: the window is named for the document it holds.
 *
 * Read off the X window's own name and not off the page. A title written into the DOM and never
 * handed to the window would satisfy any reading of the document, and a task bar would still show
 * three windows called the same thing, which is the complaint.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow, pressKey, typeText } from "../lib/input.js";
import { repoRoot, windowHeight, windowTitle, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel, findWindowsWithAppGeometry, rootTree } from "../lib/x11.js";

/**
 * The fixture this spec opens, copied first and opened from the copy. The mark going away is proved
 * by a save that writes in place, and a save in place must never land on a committed fixture.
 */
const FIXTURE = path.join(repoRoot, "fixtures", "subtitles", "srt", "clean", "basic-lf.srt");
const SUBTITLE_NAME = "episode-01.srt";

/** What the window is called with nothing open: the copy in `en.ts`, not a word chosen here. */
const UNTITLED = "Untitled";
/** What leads the name while there is unsaved work. */
const DIRTY_MARK = "* ";

/** The cue this spec edits to make unsaved work, and what it types over it. */
const EDIT_POSITION = 1;
const EDIT_TEXT = "Typed to make the window say so";

function named(document_) {
  return `${document_} - ${windowTitle}`;
}

/** The app's window as the display names it, waited for rather than read once. */
async function waitForWindowNamed(expected) {
  return waitFor(
    () => {
      const windows = findWindowsWithAppGeometry();
      return windows.length === 1 && windows[0].name === expected ? windows[0] : null;
    },
    {
      timeout: 20000,
      message: `the app's window to be named ${JSON.stringify(expected)}`,
    },
  ).catch((error) => {
    throw new Error(`${error.message}\n${rootTree()}`);
  });
}

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

/** The text a row shows, by 1-based list position, in the shape `subtitle.spec.js` reads it. */
function rowText(position) {
  return browser.execute((wanted) => {
    const rows = Array.from(document.querySelectorAll(".cuelist__row"));
    const row = rows.find(
      (candidate) => candidate.querySelector(".cuelist__pos")?.textContent === wanted,
    );
    return row?.querySelector(".cuelist__text")?.textContent ?? null;
  }, String(position));
}

/** Click a row's text cell, which is what opens the inline editor on it. */
async function clickRow(toplevel, position) {
  const centre = await browser.execute((wanted) => {
    const rows = Array.from(document.querySelectorAll(".cuelist__row"));
    const row = rows.find(
      (candidate) => candidate.querySelector(".cuelist__pos")?.textContent === wanted,
    );
    const cell = row?.querySelector(".cuelist__text");
    if (!cell) {
      return null;
    }
    const rect = cell.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    return { x: (rect.x + rect.width / 2) * dpr, y: (rect.y + rect.height / 2) * dpr };
  }, String(position));
  if (centre === null) {
    throw new Error(`row ${position} is missing from the DOM`);
  }
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

async function clickElement(toplevel, selector) {
  const box = await browser.execute((css) => {
    const element = document.querySelector(css);
    if (element === null) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    return { midX: (rect.x + rect.width / 2) * dpr, midY: (rect.y + rect.height / 2) * dpr };
  }, selector);
  if (box === null) {
    throw new Error(`${selector} is missing from the DOM, so there is nothing to click`);
  }
  clickAt(toplevel.absX + box.midX, toplevel.absY + box.midY);
}

/** Writes go to the harness temp dir, never beside a fixture. */
function saveDirectory() {
  const dataHome = process.env.SUBLORE_E2E_DATA_HOME;
  if (dataHome === undefined || dataHome === "") {
    throw new Error("SUBLORE_E2E_DATA_HOME is not set, so there is nowhere safe to write");
  }
  const directory = path.join(dataHome, "title-spec-saves");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  return directory;
}

describe("the window's name", () => {
  let toplevel = null;
  let saveDir = null;
  let subtitle = null;

  before(async () => {
    if (!existsSync(FIXTURE)) {
      throw new Error(`${FIXTURE} is committed and missing; restore it with git checkout`);
    }
    saveDir = saveDirectory();
    subtitle = path.join(saveDir, SUBTITLE_NAME);
    copyFileSync(FIXTURE, subtitle);
    toplevel = await waitFor(() => findToplevel(), {
      timeout: 30000,
      message: `a ${windowWidth}x${windowHeight} toplevel to appear`,
    });
  });

  it("opens called Untitled, because no file is open yet", async () => {
    // Select by geometry and assert the name, so a wrong name fails on the name rather than on "no
    // window found". GTK's 10x10 group-leader answers to the app's name and must never match.
    await waitForWindowNamed(named(UNTITLED));
  });

  it("keeps the page's own title, which is not the window's", async () => {
    // Two different things: the document title is what the webview holds, and the window name is
    // what a task bar shows. This one is unchanged by N57 and is asserted so it stays that way.
    expect(await browser.getTitle()).toBe(windowTitle);
  });

  it("takes the file's name when one is opened, without its folder", async () => {
    await clickElement(toplevel, ".toolbar__file-open-subtitle");
    const chooser = await waitForChooser("Choose a subtitle");
    await answerChooser(chooser, subtitle, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(() => present(".cuelist__row"), {
      timeout: 20000,
      message: "the cue grid to fill",
    });

    const window_ = await waitForWindowNamed(named(SUBTITLE_NAME));
    // The name and not the path: a title bar has room for one, and it is the one a translator reads.
    expect(window_.name).not.toContain(path.dirname(subtitle));
  });

  it("leads with a mark while there is unsaved work, and drops it once it is written", async () => {
    await clickRow(toplevel, EDIT_POSITION);
    await waitFor(() => present(".cuelist__editor"), {
      timeout: 15000,
      message: "the inline editor to open",
    });
    pressKey("ctrl+a");
    typeText(EDIT_TEXT);
    pressKey("Return");
    await waitFor(async () => ((await rowText(EDIT_POSITION))?.includes(EDIT_TEXT) ? true : null), {
      timeout: 20000,
      message: `row ${EDIT_POSITION} to hold the edit`,
    });

    await waitForWindowNamed(`${DIRTY_MARK}${named(SUBTITLE_NAME)}`);

    // Saved in place, into this spec's own copy: the mark goes and the name stays what it was.
    focusWindow(toplevel.id);
    pressKey("ctrl+s");
    await waitFor(async () => ((await present(".statusbar__dirty")) === false ? true : null), {
      timeout: 20000,
      message: "the dirty marker to clear after the save",
    });
    await waitForWindowNamed(named(SUBTITLE_NAME));
  });
});
