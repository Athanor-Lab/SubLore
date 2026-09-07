/* global describe, it, before, document, window */
/**
 * View's three ways of drawing override tags in the grid, which is a radio set of three.
 *
 * The text box is deliberately not one of them: it edits the file's own text, and a mode that hid
 * part of it there would let a translator overwrite what they cannot see. That is asserted too.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow, pressKey, typeText } from "../lib/input.js";
import { repoRoot, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

const FIXTURE = ["ass", "clean", "speakers.ass"];
/** Typed into the first line, so the three modes have a braced run and words to tell apart. */
const TAGGED = "{\\b1}bold{\\b0} and plain";
const SIMPLIFIED = "☀bold☀ and plain";
const HIDDEN = "bold and plain";

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
  const directory = path.join(dataHome(), "tag-modes");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const copy = path.join(directory, "speakers.ass");
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

function textOf(selector) {
  return browser.execute((css) => document.querySelector(css)?.textContent ?? null, selector);
}

/** The first row's text cell, which is where the three modes are visible. */
function firstCell() {
  return browser.execute(
    () => document.querySelector(".cuelist__row .cuelist__text")?.textContent ?? null,
  );
}

/** What the current line's box holds, which is the file's own text whatever the mode is. */
function boxText() {
  return browser.execute(() => document.querySelector(".currentline__text")?.value ?? null);
}

/** Open View and choose one of the three, answering with which one is marked afterwards. */
async function chooseMode(toplevel, token) {
  await clickElement(toplevel, ".menubar__title--view");
  await waitFor(() => present(`.menubar__item--${token}`), {
    timeout: 15000,
    message: `the View menu to open on ${token}`,
  });
  await clickElement(toplevel, `.menubar__item--${token}`);
}

/** Which of the three the menu marks, read without choosing anything. */
async function markedMode(toplevel) {
  await clickElement(toplevel, ".menubar__title--view");
  await waitFor(() => present(".menubar__item--view-tags-show"), {
    timeout: 15000,
    message: "the View menu to open on its tag items",
  });
  const marked = await browser.execute(() =>
    ["show", "simplify", "hide"].filter(
      (mode) =>
        document
          .querySelector(`.menubar__item--view-tags-${mode}`)
          ?.getAttribute("aria-checked") === "true",
    ),
  );
  pressKey("Escape");
  await waitFor(async () => ((await present(".menubar__item--view-tags-show")) ? null : 1), {
    timeout: 15000,
    message: "the View menu to close",
  });
  return marked;
}

describe("the grid's override tags", () => {
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
  });

  it("draws them as the file spells them until told otherwise", async () => {
    await clickElement(toplevel, ".toolbar__file-open-subtitle");
    const chooser = await waitForChooser("Choose a subtitle");
    await answerChooser(chooser, copy, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(
      async () => ((await textOf(".statusbar__document"))?.includes("cues") === true ? 1 : null),
      { timeout: 20000, message: "the fixture to open" },
    );

    // Exactly one of the three is marked, and it is the one that shows the file's own text.
    expect(await markedMode(toplevel)).toEqual(["show"]);

    await clickElement(toplevel, ".currentline__text");
    pressKey("ctrl+a");
    typeText(TAGGED);
    // Waited for rather than assumed: the blur below commits whatever the box holds, and on a busy
    // machine the keystrokes have not all arrived when the click lands.
    await waitFor(async () => ((await boxText()) === TAGGED ? 1 : null), {
      timeout: 15000,
      message: "the box to hold exactly the tagged line",
    });
    await clickElement(toplevel, ".currentline__comment");
    await clickElement(toplevel, ".currentline__comment");
    await waitFor(async () => ((await firstCell()) === TAGGED ? 1 : null), {
      timeout: 15000,
      message: "the grid to draw the braced run as it stands",
    });
  });

  it("replaces each braced run with one mark, and then takes them away", async () => {
    await chooseMode(toplevel, "view-tags-simplify");
    await waitFor(async () => ((await firstCell()) === SIMPLIFIED ? 1 : null), {
      timeout: 15000,
      message: "each braced run to become one mark",
    });
    expect(await markedMode(toplevel)).toEqual(["simplify"]);

    await chooseMode(toplevel, "view-tags-hide");
    await waitFor(async () => ((await firstCell()) === HIDDEN ? 1 : null), {
      timeout: 15000,
      message: "the braced runs to go entirely",
    });
    expect(await markedMode(toplevel)).toEqual(["hide"]);
  });

  it("never hides anything in the box, whatever the grid is drawing", async () => {
    // The mode is still hide from the check above, and the box still holds every character.
    expect(await boxText()).toBe(TAGGED);

    await chooseMode(toplevel, "view-tags-show");
    await waitFor(async () => ((await firstCell()) === TAGGED ? 1 : null), {
      timeout: 15000,
      message: "the grid to go back to the file's own text",
    });
    expect(await boxText()).toBe(TAGGED);
  });
});
