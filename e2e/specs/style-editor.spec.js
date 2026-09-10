/* global describe, it, before, document, window */
/**
 * B10: the style editor, which Edit beside the Style dropdown opens.
 *
 * The claim worth checking is not that a field takes a value: it is that writing a style moves the
 * style line and nothing else. Every event line in the saved file is compared byte for byte.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { runFromMenu } from "../lib/menu.js";
import { clickAt, focusWindow, pressKey, typeText } from "../lib/input.js";
import { repoRoot, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

/** Three cues and one declared style, which the first row names. */
const FIXTURE = ["ass", "clean", "basic.ass"];
/** Typed into the editor's font field. It has a space in it, which a style line may hold. */
const FONT = "Gentium Book";

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
  const directory = path.join(dataHome(), "style-editor");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const copy = path.join(directory, "basic.ass");
  copyFileSync(from, copy);
  return copy;
}

function centreOf(selector) {
  return browser.execute((css) => {
    const element = document.querySelector(css);
    if (element === null) {
      return null;
    }
    // The style editor is taller than the window and scrolls inside itself, so a control further
    // down has a rectangle outside the viewport and a click at its centre would land on nothing.
    element.scrollIntoView({ block: "center" });
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

function valueOf(selector) {
  return browser.execute((css) => document.querySelector(css)?.value ?? null, selector);
}

/** Every `Dialogue:` line of a file, which a style write may never touch. */
function events(file) {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("Dialogue:") || line.startsWith("Comment:"));
}

/** The one `Style:` line of the fixture. */
function styleLine(file) {
  return (
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .find((line) => line.startsWith("Style:")) ?? null
  );
}

describe("the style editor", () => {
  let toplevel = null;
  let copy = null;
  let eventsBefore = null;

  before(async () => {
    copy = workingCopy();
    eventsBefore = events(copy);
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

  it("opens on the style the line names, with the values the file holds", async () => {
    await clickElement(toplevel, ".toolbar__file-open-subtitle");
    const chooser = await waitForChooser("Choose a subtitle");
    await answerChooser(chooser, copy, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(
      async () => ((await textOf(".statusbar__document"))?.includes("3 cues") === true ? 1 : null),
      { timeout: 20000, message: "the fixture to open" },
    );

    await clickElement(toplevel, ".currentline__style-edit");
    await waitFor(() => present(".styleeditor__panel"), {
      timeout: 15000,
      message: "the style editor to open",
    });

    // The title is the style's own name, and the fields are what the file spells, not a guess.
    expect(await textOf(".styleeditor__title")).toBe("Default");
    const line = styleLine(copy);
    expect(line).not.toBe(null);
    const columns = line.replace(/^Style:\s*/, "").split(",");
    expect(await valueOf(".styleeditor__fontname")).toBe(columns[1].trim());
    expect(await valueOf(".styleeditor__fontsize")).toBe(columns[2].trim());
    expect(await valueOf(".styleeditor__primary")).toBe(columns[3].trim());
  });

  it("writes the font into the style line and moves no event at all", async () => {
    await clickElement(toplevel, ".styleeditor__fontname");
    pressKey("ctrl+a");
    typeText(FONT);
    await waitFor(async () => ((await valueOf(".styleeditor__fontname")) === FONT ? 1 : null), {
      timeout: 15000,
      message: `the font field to hold exactly ${FONT}`,
    });
    pressKey("Return");

    // Nothing is on disk yet: the write is an edit like any other and waits for a save.
    await waitFor(() => present(".statusbar__dirty"), {
      timeout: 15000,
      message: "the document to be marked unsaved",
    });
    await clickElement(toplevel, ".styleeditor__close");
    await waitFor(async () => ((await present(".styleeditor__panel")) ? null : 1), {
      timeout: 15000,
      message: "the editor to close",
    });

    await clickElement(toplevel, ".toolbar__file-save");
    await waitFor(
      async () => ((await textOf(".statusbar__message"))?.includes("aved") === true ? 1 : null),
      { timeout: 20000, message: "the document to be saved" },
    );

    expect(styleLine(copy)).toContain(FONT);
    // The whole of what this check is for: a style line that swallowed a comma would move every
    // column of every event under it, and this is the only place that would be seen.
    expect(events(copy)).toEqual(eventsBefore);
  });

  it("moves the line's place on the grid, and writes the number ASS uses for it", async () => {
    await clickElement(toplevel, ".currentline__style-edit");
    await waitFor(() => present(".styleeditor__alignment"), {
      timeout: 15000,
      message: "the alignment grid to be drawn",
    });
    const marked = () =>
      browser.execute(() =>
        Array.from(document.querySelectorAll(".styleeditor__place"))
          .filter((place) => place.getAttribute("aria-checked") === "true")
          .map((place) => place.getAttribute("aria-label")),
      );
    // The fixture's own place, which the file spells and the grid reads back rather than guessing.
    expect(await marked()).toEqual(["2"]);

    // Top left, which ASS numbers 7: the grid draws it first and the number is not its position.
    await clickElement(toplevel, ".styleeditor__place-7");
    await waitFor(async () => (JSON.stringify(await marked()) === '["7"]' ? 1 : null), {
      timeout: 15000,
      message: "the top left place to be marked",
    });
    await clickElement(toplevel, ".styleeditor__close");
    await waitFor(async () => ((await present(".styleeditor__panel")) ? null : 1), {
      timeout: 15000,
      message: "the editor to close",
    });

    await clickElement(toplevel, ".toolbar__file-save");
    await waitFor(async () => (styleLine(copy)?.includes(",7,") === true ? 1 : null), {
      timeout: 20000,
      message: "the place to reach the file",
    });
    expect(events(copy)).toEqual(eventsBefore);

    await runFromMenu((css) => clickElement(toplevel, css), "edit", "edit-undo");
    await waitFor(async () => ((await present(".statusbar__dirty")) ? 1 : null), {
      timeout: 15000,
      message: "the undo to leave the document unsaved again",
    });
  });

  it("turns a flag on in the style line, and one undo takes it back", async () => {
    await clickElement(toplevel, ".currentline__style-edit");
    await waitFor(() => present(".styleeditor__panel"), {
      timeout: 15000,
      message: "the style editor to open again",
    });
    const flag = () =>
      browser.execute(() => document.querySelector(".styleeditor__bold")?.checked ?? null);
    expect(await flag()).toBe(false);

    await clickElement(toplevel, ".styleeditor__bold");
    await waitFor(async () => ((await flag()) === true ? 1 : null), {
      timeout: 15000,
      message: "the style's bold flag to come on",
    });
    await clickElement(toplevel, ".styleeditor__close");
    await waitFor(async () => ((await present(".styleeditor__panel")) ? null : 1), {
      timeout: 15000,
      message: "the editor to close",
    });

    // ASS writes -1 for on, and the font written a moment ago is still there beside it.
    await clickElement(toplevel, ".toolbar__file-save");
    await waitFor(async () => (styleLine(copy)?.includes("-1") === true ? 1 : null), {
      timeout: 20000,
      message: "the flag to reach the file",
    });
    expect(styleLine(copy)).toContain(FONT);
    expect(events(copy)).toEqual(eventsBefore);

    await runFromMenu((css) => clickElement(toplevel, css), "edit", "edit-undo");
    await waitFor(async () => ((await present(".statusbar__dirty")) ? 1 : null), {
      timeout: 15000,
      message: "the undo to leave the document unsaved again",
    });
    await clickElement(toplevel, ".currentline__style-edit");
    await waitFor(() => present(".styleeditor__panel"), {
      timeout: 15000,
      message: "the style editor to open once more",
    });
    expect(await flag()).toBe(false);
    expect(await valueOf(".styleeditor__fontname")).toBe(FONT);
    await clickElement(toplevel, ".styleeditor__close");
  });
});
