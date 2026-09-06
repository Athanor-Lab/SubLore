/* global describe, it, before, document, window */
/**
 * M2.6 S2: a translation that starts from the source.
 *
 * Decision 13 in BACKLOG.md M2.6: the command carries every cue and every timing over with empty
 * text, the source is never modified, and the first save asks where to put the new file. The
 * criteria are in side-by-side-tasks.md S2.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow, pressKey, typeText } from "../lib/input.js";
import { repoRoot, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

/** Three cues, with timings this check reads back off the new document. */
const SOURCE = ["srt", "clean", "basic-lf.srt"];
const SOURCE_TIMES = [
  { start: "00:00:02.120", end: "00:00:04.880" },
  { start: "00:00:05.000", end: "00:00:08.340" },
  { start: "00:00:09.100", end: "00:00:11.760" },
];
/** Written into the first line of the translation, so the save has something to carry. */
const TRANSLATED = "Il porto era vuoto quando siamo arrivati.";

function dataHome() {
  const home = process.env.SUBLORE_E2E_DATA_HOME;
  if (typeof home !== "string" || home === "") {
    throw new Error("SUBLORE_E2E_DATA_HOME is not set; e2e/wdio.conf.js sets it for every run.");
  }
  return home;
}

function workingDir() {
  const directory = path.join(dataHome(), "new-translation");
  mkdirSync(directory, { recursive: true });
  return directory;
}

/** Writes go to the harness temp dir. The committed fixture is copied, never opened directly. */
function workingCopy() {
  const from = path.join(repoRoot, "fixtures", "subtitles", ...SOURCE);
  if (!existsSync(from)) {
    throw new Error(
      `E2E prerequisite missing: ${from} does not exist. It is committed; restore it with ` +
        "`git checkout fixtures/subtitles`.",
    );
  }
  const copy = path.join(workingDir(), "source.srt");
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

/** What the grid shows for every rendered row, so the carried timings can be read in one trip. */
function rows() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".cuelist__row")).map((row) => ({
      position: row.querySelector(".cuelist__pos")?.textContent ?? null,
      text: row.querySelector(".cuelist__text")?.textContent ?? null,
      start: row.querySelector(".cuelist__start")?.textContent ?? null,
      end: row.querySelector(".cuelist__end")?.textContent ?? null,
      source: row.querySelector(".cuelist__source")?.textContent ?? null,
    })),
  );
}

/** Open the File menu and choose one of its items by command id. */
async function fromFileMenu(toplevel, token) {
  await clickElement(toplevel, ".menubar__title--file");
  await waitFor(() => present(`.menubar__item--${token}`), {
    timeout: 15000,
    message: `the File menu to open on ${token}`,
  });
  await clickElement(toplevel, `.menubar__item--${token}`);
}

/** Whether a File menu item is drawn and whether it is greyed, without choosing it. */
async function fileItem(toplevel, token) {
  await clickElement(toplevel, ".menubar__title--file");
  await waitFor(() => present(`.menubar__item--${token}`), {
    timeout: 15000,
    message: `the File menu to open on ${token}`,
  });
  const state = await browser.execute((css) => {
    const item = document.querySelector(css);
    return item === null ? null : { drawn: true, disabled: item.disabled === true };
  }, `.menubar__item--${token}`);
  pressKey("Escape");
  await waitFor(async () => ((await present(`.menubar__item--${token}`)) ? null : 1), {
    timeout: 15000,
    message: "the File menu to close",
  });
  return state;
}

describe("a translation begun from the source", () => {
  let toplevel = null;
  let source = null;
  let sourceBytes = null;

  before(async () => {
    rmSync(path.join(dataHome(), "new-translation"), { recursive: true, force: true });
    source = workingCopy();
    sourceBytes = readFileSync(source);
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

  it("waits for a source and needs no target, because the target is what it makes", async () => {
    // Nothing open at all. A translation is begun from a source, so opening one is the first
    // gesture and needs nothing before it; the command that makes the target waits for the source.
    expect(await fileItem(toplevel, "file-open-source")).toEqual({ drawn: true, disabled: false });
    expect(await fileItem(toplevel, "file-new-translation")).toEqual({
      drawn: true,
      disabled: true,
    });

    await fromFileMenu(toplevel, "file-open-source");
    const chooser = await waitForChooser("Choose a subtitle");
    await answerChooser(chooser, source, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(
      async () => ((await textOf(".statusbar__document"))?.includes("Source:") === true ? 1 : null),
      { timeout: 20000, message: "the source to open with no target beside it" },
    );
    expect(await fileItem(toplevel, "file-new-translation")).toEqual({
      drawn: true,
      disabled: false,
    });
  });

  it("carries every cue and every timing over, with nothing written in them yet", async () => {
    await fromFileMenu(toplevel, "file-new-translation");
    const carried = await waitFor(
      async () => {
        const drawn = await rows();
        return drawn.length === SOURCE_TIMES.length ? drawn : null;
      },
      { timeout: 20000, message: "the translation to be drawn over the source's rows" },
    );

    expect(carried.map((row) => row.position)).toEqual(["1", "2", "3"]);
    expect(carried.map((row) => ({ start: row.start, end: row.end }))).toEqual(SOURCE_TIMES);
    // Every line empty: this is the whole of what a new translation is.
    expect(carried.map((row) => row.text)).toEqual(["", "", ""]);
    // And the source is still beside it, so the translator can read what they are translating.
    expect(carried[0].source).toBe("The harbour was empty when we got there.");
    expect(readFileSync(source).equals(sourceBytes)).toBe(true);
  });

  it("has nothing to undo, so the first undo cannot bring the source's words back", async () => {
    // The emptying is not a step in this document's history: it happened before the translator was
    // given it. Undo is greyed, and the line stays empty.
    expect(await fileItem(toplevel, "file-open-source")).toEqual({ drawn: true, disabled: false });
    const undo = await browser.execute(
      () => document.querySelector(".toolbar__edit-undo")?.disabled === true,
    );
    expect(undo).toBe(true);
    expect((await rows())[0].text).toBe("");
  });

  it("saves to a file of its own, and leaves the source it came from untouched", async () => {
    await clickElement(toplevel, ".currentline__text");
    await waitFor(
      () =>
        browser.execute(
          () => document.activeElement?.classList.contains("currentline__text") === true,
        ),
      { timeout: 15000, message: "the current line's box to take the keyboard" },
    );
    typeText(TRANSLATED);
    await waitFor(
      async () =>
        (await browser.execute(
          () => document.querySelector(".currentline__text")?.value ?? null,
        )) === TRANSLATED
          ? 1
          : null,
      { timeout: 15000, message: "the first line to hold what was typed" },
    );

    // A document that has never had a file asks where to put itself.
    await clickElement(toplevel, ".toolbar__file-save");
    const chooser = await waitForChooser("Save the subtitle");
    const written = path.join(workingDir(), "translation.srt");
    await answerChooser(chooser, written, "subtitle-first-save");
    focusWindow(toplevel.id);
    await waitFor(
      async () => ((await textOf(".statusbar__message"))?.includes("aved") === true ? 1 : null),
      { timeout: 20000, message: "the translation to be saved" },
    );

    const saved = readFileSync(written).toString();
    expect(saved).toContain(TRANSLATED);
    // The timings came with it, and the two lines nobody translated are still empty.
    expect(saved).toContain("00:00:02,120 --> 00:00:04,880");
    expect(saved).toContain("00:00:09,100 --> 00:00:11,760");
    // The file it was made from is the bytes it was before any of this.
    expect(readFileSync(source).equals(sourceBytes)).toBe(true);
  });
});
