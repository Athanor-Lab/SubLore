/* global describe, it, before, document, window */
/**
 * A menu row that opens a list of its own, which the interface asks for in eight places: the two
 * recent-file lists, the four ways of inserting a cue, the two joins, the two sorts, and the two
 * ways of making times continuous. The last of those is the one built here, and the rest are the
 * same row with different items behind it.
 *
 * What is checked is the row's behaviour on every gesture it answers, because that is what a
 * translator meets: the pointer passing over it, a click on it, and the keyboard walking in and
 * back out. A row that only opened on a click would be a row that reads as broken to a hand that
 * expects a menu.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow, hoverAt, pressKey } from "../lib/input.js";
import { takeCommands, watchCommands } from "../lib/ipc.js";
import { openMenu } from "../lib/menu.js";
import { repoRoot, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

/** Three cues with a gap between each pair, which is what the two items in the list close. */
const FIXTURE = ["srt", "clean", "basic-lf.srt"];
/** The row that opens the list, and the two commands behind it (interface-spec 3.4 item 9). */
const OPENER = ".menubar__submenu--time-continuous";
const START = ".menubar__item--time-continuous-start";
const END = ".menubar__item--time-continuous-end";

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
  const directory = path.join(dataHome(), "submenus");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const copy = path.join(directory, "basic-lf.srt");
  copyFileSync(from, copy);
  return copy;
}

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
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

async function pointAt(toplevel, selector, press) {
  const centre = await centreOf(selector);
  if (centre === null) {
    throw new Error(`${selector} is missing from the DOM, so there is nothing to point at`);
  }
  // No window manager under Xvfb, so the toplevel origin is also the viewport origin.
  const where = [toplevel.absX + centre.x, toplevel.absY + centre.y];
  if (press) {
    clickAt(...where);
  } else {
    hoverAt(...where);
  }
}

const clickElement = (toplevel, selector) => pointAt(toplevel, selector, true);
const hoverElement = (toplevel, selector) => pointAt(toplevel, selector, false);

/** Click the row at a 1-based list position, which is also what selects it. */
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

/** The label a row draws, or null when the row is not there. */
function labelOf(selector) {
  return browser.execute(
    (css) => document.querySelector(css)?.querySelector(".menubar__label")?.textContent ?? null,
    selector,
  );
}

async function openTiming(toplevel) {
  await clickElement(toplevel, ".menubar__title--timing");
  await waitFor(() => present(".menubar__menu"), {
    timeout: 15000,
    message: "the Timing menu to open",
  });
}

/** Escape gives back one level at a time, so a list inside a menu takes two of them. */
async function closeMenus() {
  await waitFor(
    async () => {
      if (!(await present(".menubar__menu"))) {
        return 1;
      }
      pressKey("Escape");
      return null;
    },
    { timeout: 15000, message: "every open menu to close" },
  );
}

/** Whether a row is the one the keyboard is on. */
function hasCursor(selector, marker) {
  return browser.execute(
    (css, mark) => document.querySelector(css)?.classList.contains(mark) === true,
    selector,
    marker,
  );
}

describe("a menu row that opens a list of its own", () => {
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

  it("keeps its two items behind the row rather than on the menu itself", async () => {
    await openTiming(toplevel);

    expect(await labelOf(OPENER)).toBe("Make times continuous");
    // Behind it, which is the whole point: a menu that drew them both places would be a menu with
    // two ways to reach the same command and no list at all.
    expect(await present(START)).toBe(false);
    expect(await present(END)).toBe(false);

    await clickElement(toplevel, OPENER);
    await waitFor(() => present(START), {
      timeout: 15000,
      message: "the list to open on its first item",
    });
    expect(await labelOf(START)).toBe("Change start");
    expect(await labelOf(END)).toBe("Change end");

    await closeMenus();
  });

  it("opens under the pointer, without being clicked", async () => {
    await openTiming(toplevel);
    // The pointer passing over the row is the gesture a menu answers by opening it. Nothing is
    // pressed here at all.
    await hoverElement(toplevel, OPENER);
    await waitFor(() => present(START), {
      timeout: 15000,
      message: "the list to open under the pointer",
    });

    // And it closes again when the pointer moves to a row that opens nothing.
    await hoverElement(toplevel, ".menubar__item--time-shift");
    await waitFor(async () => ((await present(START)) ? null : 1), {
      timeout: 15000,
      message: "the list to close when the pointer leaves the row",
    });

    await closeMenus();
  });

  it("runs the command that is clicked inside it, and closes the whole menu", async () => {
    // The second row, because changing starts moves a line onto the end of the one before it and
    // the first line has nothing before it: an item that ran and changed nothing would look here
    // exactly like an item that never ran.
    await clickRow(toplevel, 2);
    await waitFor(
      () =>
        browser.execute(() => document.querySelectorAll(".cuelist__row--selected").length === 1),
      { timeout: 15000, message: "the second row alone to be selected" },
    );
    await openTiming(toplevel);
    await clickElement(toplevel, OPENER);
    await waitFor(() => present(START), {
      timeout: 15000,
      message: "the list to open",
    });

    await watchCommands();
    await clickElement(toplevel, START);

    // The edit landing is what says the command ran, and the probe is read once: reading it puts
    // the page's own `fetch` back, so a second read would be a read of nothing.
    await waitFor(() => present(".statusbar__dirty"), {
      timeout: 20000,
      message: "the edit behind the item to reach the document",
    });
    expect(await takeCommands()).toEqual(["subtitle_set_many_times"]);
    expect(await present(".menubar__menu")).toBe(false);
  });

  it("walks in with the right arrow and back out with the left", async () => {
    await openTiming(toplevel);
    // Down until the cursor reaches the row: which position it sits at is the menu's own order and
    // not this check's business.
    await waitFor(
      async () => {
        if (await hasCursor(OPENER, "menubar__submenu--cursor")) {
          return 1;
        }
        pressKey("Down");
        return null;
      },
      { timeout: 15000, message: "the cursor to reach the row that opens the list" },
    );

    pressKey("Right");
    await waitFor(() => present(".menubar__menu--sub"), {
      timeout: 15000,
      message: "the right arrow to open the list",
    });
    expect(await hasCursor(START, "menubar__item--cursor")).toBe(true);

    pressKey("Down");
    await waitFor(() => hasCursor(END, "menubar__item--cursor"), {
      timeout: 15000,
      message: "the cursor to walk to the second item",
    });

    pressKey("Left");
    await waitFor(async () => ((await present(".menubar__menu--sub")) ? null : 1), {
      timeout: 15000,
      message: "the left arrow to close the list",
    });
    // Back on the row that opened it, not off the menu and not on the title beside it.
    expect(await hasCursor(OPENER, "menubar__submenu--cursor")).toBe(true);
    expect(await present(".menubar__menu")).toBe(true);

    await closeMenus();
  });

  it("opens a menu that is already open, rather than toggling it shut", async () => {
    // A click on the title of the menu that is **already** open closes it: clicking another title
    // switches, which is why this check names the same one twice. A caller that asked for a menu
    // somebody had left open would then wait out its whole timeout for an item one click away.
    // `openMenu` closes first and opens after, so the answer does not depend on what came before.
    await clickElement(toplevel, ".menubar__title--timing");
    await waitFor(() => present(".menubar__menu"), {
      timeout: 15000,
      message: "the Timing menu to be left open, which is this check's own precondition",
    });

    await openMenu((css) => clickElement(toplevel, css), "timing");
    expect(await present(".menubar__menu")).toBe(true);

    await closeMenus();
  });
});
