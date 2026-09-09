/* global describe, it, before, after, afterEach, document, window */
/**
 * Paste over's field dialog (N45, docs/paste-over-tasks.md).
 *
 * Sublore took the text and left everything else, which is the common case and was all it could do.
 * The reference asks first, with the eleven fields an event has, and reuses the answer for every row
 * that one paste touches. It asks again on the next paste: the vector of answers there is local to
 * the command, so what survives between pastes is only the set of boxes the dialog opens with.
 *
 * The fixture is ASS, because that is the format with fields to choose between.
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

const FIXTURE = ["ass", "clean", "basic.ass"];

function dataHome() {
  const home = process.env.SUBLORE_E2E_DATA_HOME;
  if (typeof home !== "string" || home === "") {
    throw new Error("SUBLORE_E2E_DATA_HOME is not set; e2e/wdio.conf.js sets it for every run.");
  }
  return home;
}

function workingCopy(name) {
  const from = path.join(repoRoot, "fixtures", "subtitles", ...FIXTURE);
  if (!existsSync(from)) {
    throw new Error(`E2E prerequisite missing: ${from}. Restore it with git.`);
  }
  const directory = path.join(dataHome(), "paste-over");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const to = path.join(directory, name);
  copyFileSync(from, to);
  return to;
}

const present = (selector) =>
  browser.execute((css) => document.querySelector(css) !== null, selector);

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
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

/** Every row the grid draws, as the fields this spec asserts on. */
function rows() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".cuelist__row")).map((row) => ({
      start: row.querySelector(".cuelist__start")?.textContent ?? null,
      end: row.querySelector(".cuelist__end")?.textContent ?? null,
      text: row.querySelector(".cuelist__text")?.textContent ?? null,
      style: row.querySelector(".cuelist__style")?.textContent ?? null,
      actor: row.querySelector(".cuelist__actor")?.textContent ?? null,
    })),
  );
}

/** Which of the eleven boxes the dialog is drawing, and how each one stands. */
function boxes() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".pasteover__field")).map((label) => ({
      token:
        Array.from(label.classList)
          .find((name) => name.startsWith("pasteover__") && name !== "pasteover__field")
          ?.replace("pasteover__", "") ?? "",
      checked: label.querySelector("input")?.checked ?? null,
      disabled: label.querySelector("input")?.disabled ?? null,
    })),
  );
}

async function clickRow(toplevel, position) {
  const centre = await browser.execute((wanted) => {
    const cell = Array.from(document.querySelectorAll(".cuelist__row"))
      .find((row) => row.querySelector(".cuelist__pos")?.textContent === wanted)
      ?.querySelector(".cuelist__pos");
    if (!cell) {
      return null;
    }
    const rect = cell.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    return { x: (rect.x + rect.width / 2) * dpr, y: (rect.y + rect.height / 2) * dpr };
  }, String(position));
  if (centre === null) {
    throw new Error(`row ${position} is missing from the grid`);
  }
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

async function fromEditMenu(toplevel, token) {
  await clickElement(toplevel, ".menubar__title--edit");
  await waitFor(() => present(`.menubar__item--${token}`), {
    timeout: 15000,
    message: `the Edit menu to draw ${token}`,
  });
  await clickElement(toplevel, `.menubar__item--${token}`);
}

async function openDialog(toplevel) {
  await fromEditMenu(toplevel, "edit-paste-over");
  await waitFor(() => present(".pasteover"), {
    timeout: 15000,
    message: "the field dialog to open",
  });
}

async function closeDialog() {
  pressKey("Escape");
  await waitFor(async () => ((await present(".pasteover")) ? null : 1), {
    timeout: 15000,
    message: "the field dialog to close",
  });
}

describe("choosing what a paste over takes", () => {
  let toplevel = null;
  let copy = null;

  before(async () => {
    copy = workingCopy("basic.ass");
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

    // One line on the clipboard, from the second cue: it has a speaker and a style, which is what
    // makes taking one field rather than another visible.
    await clickRow(toplevel, 2);
    await fromEditMenu(toplevel, "edit-copy");
  });

  // What this spec chooses must not reach the specs that run after it. `clipboard.spec.js` pastes
  // over too, and an answer left behind here decides what its dialog opens holding.
  after(() => {
    rmSync(path.join(dataHome(), "com.sublore.app", "paste-fields.json"), { force: true });
  });

  afterEach(async () => {
    if (await present(".pasteover")) {
      await closeDialog();
    }
    await waitFor(
      async () => {
        if (!(await present(".menubar__menu"))) {
          return 1;
        }
        pressKey("Escape");
        return null;
      },
      { timeout: 15000, message: "the menu to close between tests" },
    );
  });

  it("asks before it takes, and Escape takes nothing", async () => {
    const before = await rows();
    await clickRow(toplevel, 1);
    await openDialog(toplevel);

    // The eleven, in the reference's own order.
    expect((await boxes()).map((box) => box.token)).toEqual([
      "comment",
      "layer",
      "start",
      "end",
      "style",
      "actor",
      "marginL",
      "marginR",
      "marginV",
      "effect",
      "text",
    ]);
    // The text alone, which is what Sublore did before this dialog existed.
    const ticked = (await boxes()).filter((box) => box.checked).map((box) => box.token);
    expect(ticked).toEqual(["text"]);

    await closeDialog();
    expect(await rows()).toEqual(before);
  });

  it("takes the speaker without taking the words, and one undo puts it back", async () => {
    const before = await rows();
    await clickRow(toplevel, 1);
    await openDialog(toplevel);

    // Only the speaker. Not the style: both rows of this fixture are Default, so taking it would
    // change nothing and the test would be asserting on a value that was already there.
    await clickElement(toplevel, ".pasteover__none");
    await clickElement(toplevel, ".pasteover__actor input");
    await clickElement(toplevel, ".pasteover__confirm");
    await waitFor(async () => ((await present(".pasteover")) ? null : 1), {
      timeout: 15000,
      message: "the dialog to close on Paste over",
    });

    const after = await waitFor(
      async () => {
        const now = await rows();
        return now[0]?.actor !== before[0]?.actor ? now : null;
      },
      { timeout: 20000, message: "the speaker to reach the first row" },
    );
    expect(after[0].actor).toBe(before[1].actor);
    // What was not taken: the words, the times and the style are the first row's own.
    expect(after[0].text).toBe(before[0].text);
    expect(after[0].start).toBe(before[0].start);
    expect(after[0].style).toBe(before[0].style);

    await clickElement(toplevel, ".toolbar__edit-undo");
    await waitFor(async () => ((await rows())[0]?.actor === before[0]?.actor ? 1 : null), {
      timeout: 20000,
      message: "one undo to put the speaker back",
    });
  });

  it("opens next time holding what it was left holding", async () => {
    await clickRow(toplevel, 1);
    await openDialog(toplevel);
    const ticked = (await boxes()).filter((box) => box.checked).map((box) => box.token);
    expect(ticked).toEqual(["actor"]);
    await closeDialog();
  });

  it("the four quick buttons set the boxes and confirm nothing", async () => {
    const before = await rows();
    await clickRow(toplevel, 1);
    await openDialog(toplevel);

    await clickElement(toplevel, ".pasteover__all");
    expect((await boxes()).every((box) => box.checked)).toBe(true);

    await clickElement(toplevel, ".pasteover__times");
    expect((await boxes()).filter((box) => box.checked).map((box) => box.token)).toEqual([
      "start",
      "end",
    ]);

    await clickElement(toplevel, ".pasteover__onlytext");
    expect((await boxes()).filter((box) => box.checked).map((box) => box.token)).toEqual(["text"]);

    await clickElement(toplevel, ".pasteover__none");
    expect((await boxes()).some((box) => box.checked)).toBe(false);
    // None ticked is nothing to paste, so the button that would do it is greyed.
    expect(
      await browser.execute(() => document.querySelector(".pasteover__confirm")?.disabled),
    ).toBe(true);

    // And through all of that, the document was not touched.
    await closeDialog();
    expect(await rows()).toEqual(before);
  });

  it("leaves the file on disk alone until a save", async () => {
    expect(readFileSync(copy, "utf8")).toContain("Ingrid");
  });
});
