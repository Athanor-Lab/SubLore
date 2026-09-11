/* global describe, it, before, document, window, Event */
/**
 * N150: Undo and Redo name the edit they would reverse.
 *
 * Owner answer 15, and interface-spec §2.5 and §3.2, which mark both commands "plain, dynamic
 * label" in v1. The labels are read by opening the Edit menu and looking at the items, not off a
 * variable: a label derived correctly and never drawn would satisfy any other reading.
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

/** Five cues and two styles, so a style write has somewhere to go. */
const FIXTURE = ["ass", "clean", "speakers.ass"];
const TYPED = "Typed to give undo something to name";

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
    throw new Error(`E2E prerequisite missing: ${from}. It is committed; restore it with git.`);
  }
  const directory = path.join(dataHome(), "undo-names-the-edit");
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

/**
 * What the Edit menu's Undo and Redo items read, and whether each is greyed. Opens the menu and
 * closes it again, so it belongs outside a polling loop (N121).
 */
async function undoAndRedo(toplevel) {
  await clickElement(toplevel, ".menubar__title--edit");
  await waitFor(() => present(".menubar__item--edit-undo"), {
    timeout: 15000,
    message: "the Edit menu to open",
  });
  const read = await browser.execute(() => {
    const of = (css) => {
      const item = document.querySelector(css);
      if (item === null) {
        return null;
      }
      const accelerator = item.querySelector(".menubar__accelerator")?.textContent ?? "";
      const label = (item.textContent ?? "").replace(accelerator, "").trim();
      return { label, disabled: item.disabled === true };
    };
    return { undo: of(".menubar__item--edit-undo"), redo: of(".menubar__item--edit-redo") };
  });
  pressKey("Escape");
  await waitFor(async () => ((await present(".menubar__item--edit-undo")) ? null : 1), {
    timeout: 15000,
    message: "the Edit menu to close",
  });
  return read;
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

function rowCount() {
  return browser.execute(() => document.querySelectorAll(".cuelist__row").length);
}

/**
 * The style column of the row the cursor is on.
 *
 * The row and not the first one: committing the current line advances the cursor, which the panel's
 * own auto-advance does by default, so which row a field write lands on is not fixed. Reading the
 * cursor's row asks the question this check is actually about, that the write landed at all.
 */
function activeRowStyle() {
  return browser.execute(
    () => document.querySelector(".cuelist__row--active .cuelist__style")?.textContent ?? null,
  );
}

describe("undo and redo name the edit", () => {
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

  it("reads the bare verbs, greyed, with nothing open", async () => {
    // Drawn and greyed, never absent (the 2026-09-03 ruling), and with nothing on the stack there
    // is no edit to name.
    expect(await undoAndRedo(toplevel)).toEqual({
      undo: { label: "Undo", disabled: true },
      redo: { label: "Redo", disabled: true },
    });
  });

  it("names the typing once a line has been edited", async () => {
    await clickElement(toplevel, ".toolbar__file-open-subtitle");
    const chooser = await waitForChooser("Choose a subtitle");
    await answerChooser(chooser, copy, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(async () => ((await rowCount()) === 5 ? 1 : null), {
      timeout: 20000,
      message: "the fixture to open",
    });

    await clickElement(toplevel, ".currentline__text");
    typeText(TYPED);
    pressKey("Tab");
    await waitFor(() => present(".statusbar__dirty"), {
      timeout: 20000,
      message: "the edit to reach the document",
    });

    const read = await undoAndRedo(toplevel);
    expect(read.undo).toEqual({ label: "Undo typing", disabled: false });
    // Nothing has been undone yet, so redo has nothing to name and stays greyed.
    expect(read.redo).toEqual({ label: "Redo", disabled: true });
  });

  it("names the field, and the field by its own name", async () => {
    const before = await activeRowStyle();
    expect(before).toBe("Default");
    await pickStyle("Sign");
    await waitFor(async () => ((await activeRowStyle()) === "Sign" ? 1 : null), {
      timeout: 20000,
      message: "the style write to reach the row the cursor is on",
    });

    expect((await undoAndRedo(toplevel)).undo).toEqual({ label: "Undo style", disabled: false });
  });

  it("hands the name to redo when the edit is taken back", async () => {
    focusWindow(toplevel.id);
    pressKey("ctrl+z");
    await waitFor(async () => ((await activeRowStyle()) === "Default" ? 1 : null), {
      timeout: 20000,
      message: "the style write to be taken back",
    });

    const read = await undoAndRedo(toplevel);
    // The style write moved to the redo side and the typing under it is what undo now names.
    expect(read.redo).toEqual({ label: "Redo style", disabled: false });
    expect(read.undo).toEqual({ label: "Undo typing", disabled: false });
  });
});
