/* global describe, it, before, document, window */
/**
 * M2.6 S1: the document being read from, beside the one being written.
 *
 * The criteria are in side-by-side-tasks.md S1 and they are all about what a translator sees: a
 * column that appears with the source and goes with it, aligned by index and by nothing else, and
 * a source file that is the same bytes afterwards as it was before.
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

/** The target: three cues, and the third is the row the source cannot reach. */
const TARGET = ["srt", "clean", "basic-lf.srt"];
/** The source: two cues, whose text shares no word with the target's. */
const SOURCE = ["srt", "clean", "starts-at-zero-short.srt"];
const SOURCE_LINES = ["Bring the nets in.", "The gulls know before we do, they always have.", ""];
const TARGET_FIRST = "The harbour was empty when we got there.";
/** What the bar says about the source once it is open, in the shape it says the target in. */
const SOURCE_STATUS = "Source: SRT · 2 cues · LF";
/** Typed over the target's first line, to prove an edit never reaches the file being read. */
const EDITED = "Written into the target";

function dataHome() {
  const home = process.env.SUBLORE_E2E_DATA_HOME;
  if (typeof home !== "string" || home === "") {
    throw new Error("SUBLORE_E2E_DATA_HOME is not set; e2e/wdio.conf.js sets it for every run.");
  }
  return home;
}

/** Writes go to the harness temp dir. The committed fixtures are copied, never opened directly. */
function workingCopy(parts, name) {
  const from = path.join(repoRoot, "fixtures", "subtitles", ...parts);
  if (!existsSync(from)) {
    throw new Error(
      `E2E prerequisite missing: ${from} does not exist. It is committed; restore it with ` +
        "`git checkout fixtures/subtitles`.",
    );
  }
  const directory = path.join(dataHome(), "source-column");
  mkdirSync(directory, { recursive: true });
  const copy = path.join(directory, name);
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

/** The source cell of every rendered row, in list order, so alignment can be read in one trip. */
function sourceColumn() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".cuelist__row")).map((row) => ({
      position: row.querySelector(".cuelist__pos")?.textContent ?? null,
      target: row.querySelector(".cuelist__text")?.textContent ?? null,
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
  // Close it again the way Escape does, so the next gesture is not answered by the open menu.
  pressKey("Escape");
  await waitFor(async () => ((await present(`.menubar__item--${token}`)) ? null : 1), {
    timeout: 15000,
    message: "the File menu to close",
  });
  return state;
}

async function openTarget(toplevel, file) {
  await clickElement(toplevel, ".toolbar__file-open-subtitle");
  const chooser = await waitForChooser("Choose a subtitle");
  await answerChooser(chooser, file, "subtitle");
  focusWindow(toplevel.id);
}

async function openSource(toplevel, file) {
  await fromFileMenu(toplevel, "file-open-source");
  const chooser = await waitForChooser("Choose a subtitle");
  await answerChooser(chooser, file, "subtitle");
  focusWindow(toplevel.id);
}

describe("the document being read from", () => {
  let toplevel = null;
  let target = null;
  let source = null;
  let sourceBytes = null;

  before(async () => {
    rmSync(path.join(dataHome(), "source-column"), { recursive: true, force: true });
    target = workingCopy(TARGET, "target.srt");
    source = workingCopy(SOURCE, "source.srt");
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

  it("draws no column until a source is open, and greys the two items that need one", async () => {
    // Nothing open at all. Opening a source needs nothing before it, because a translation is
    // begun from one; closing waits for there to be one. See side-by-side-tasks.md S2.
    expect(await fileItem(toplevel, "file-open-source")).toEqual({ drawn: true, disabled: false });
    expect(await fileItem(toplevel, "file-close-source")).toEqual({ drawn: true, disabled: true });

    await openTarget(toplevel, target);
    await waitFor(
      async () => ((await textOf(".statusbar__document"))?.includes("3 cues") === true ? 1 : null),
      { timeout: 20000, message: "the target to open" },
    );
    expect(await present(".cuelist__headcell--source")).toBe(false);
    expect(await present(".cuelist__source")).toBe(false);

    // A target changes neither of them: the open never needed one and the close still has nothing.
    expect(await fileItem(toplevel, "file-open-source")).toEqual({ drawn: true, disabled: false });
    expect(await fileItem(toplevel, "file-close-source")).toEqual({ drawn: true, disabled: true });
  });

  it("draws the source beside the target, row for row, and blank past its last line", async () => {
    await openSource(toplevel, source);
    await waitFor(() => present(".cuelist__headcell--source"), {
      timeout: 20000,
      message: "the source column to appear",
    });

    const rows = await waitFor(
      async () => {
        const drawn = await sourceColumn();
        return drawn.length === 3 ? drawn : null;
      },
      { timeout: 15000, message: "three rows to be drawn" },
    );
    expect(rows.map((row) => row.position)).toEqual(["1", "2", "3"]);
    expect(rows.map((row) => row.source)).toEqual(SOURCE_LINES);
    // The target's own column is untouched by any of it.
    expect(rows[0].target).toBe(TARGET_FIRST);

    // And the bar says which document is being read, in the shape it says the target in.
    await waitFor(
      async () => ((await textOf(".statusbar__document"))?.includes(SOURCE_STATUS) ? 1 : null),
      { timeout: 15000, message: "the status bar to name the source" },
    );
  });

  it("never writes the file it is reading, whatever is done to the one being written", async () => {
    await clickElement(toplevel, ".currentline__text");
    await waitFor(
      () =>
        browser.execute(
          () => document.activeElement?.classList.contains("currentline__text") === true,
        ),
      { timeout: 15000, message: "the current line's box to take the keyboard" },
    );
    pressKey("ctrl+a");
    typeText(EDITED);
    await waitFor(
      async () =>
        (await browser.execute(
          () => document.querySelector(".currentline__text")?.value ?? null,
        )) === EDITED
          ? 1
          : null,
      { timeout: 15000, message: `the current line's box to hold exactly ${EDITED}` },
    );
    await clickElement(toplevel, ".toolbar__file-save");
    await waitFor(
      async () => ((await textOf(".statusbar__message"))?.includes("aved") === true ? 1 : null),
      { timeout: 20000, message: "the target to be saved" },
    );

    // The target took the edit; the source is the bytes it was before any of this.
    expect(readFileSync(target).toString()).toContain(EDITED);
    expect(readFileSync(source).equals(sourceBytes)).toBe(true);
  });

  it("takes the column away when the source is closed, and leaves the target where it was", async () => {
    expect(await fileItem(toplevel, "file-close-source")).toEqual({ drawn: true, disabled: false });
    await fromFileMenu(toplevel, "file-close-source");
    await waitFor(async () => ((await present(".cuelist__headcell--source")) ? null : 1), {
      timeout: 15000,
      message: "the source column to go with the source",
    });
    expect(await present(".cuelist__source")).toBe(false);

    // The target is still the document on screen, with the line that was written into it.
    const rows = await sourceColumn();
    expect(rows[0].target).toBe(EDITED);
    expect(await textOf(".statusbar__document")).not.toContain("Source:");
    expect(readFileSync(source).equals(sourceBytes)).toBe(true);
  });

  it("refuses a source it cannot read, and leaves the column as it found it", async () => {
    await openSource(toplevel, source);
    await waitFor(() => present(".cuelist__headcell--source"), {
      timeout: 20000,
      message: "the source column to come back",
    });

    const broken = path.join(
      repoRoot,
      "fixtures",
      "subtitles",
      "srt",
      "malformed",
      "missing-arrow.srt",
    );
    await openSource(toplevel, broken);
    const message = await waitFor(
      async () => {
        const said = await textOf(".statusbar__error");
        return said !== null && said.trim() !== "" ? said : null;
      },
      { timeout: 20000, message: "the refusal to be said on the status bar" },
    );
    expect(message.trim()).not.toBe("");

    // A refused open leaves no half-read document behind, so the column goes rather than lying.
    await waitFor(async () => ((await present(".cuelist__headcell--source")) ? null : 1), {
      timeout: 15000,
      message: "the column to go with the refused source",
    });
    // The target is untouched by a source that never opened.
    const rows = await sourceColumn();
    expect(rows[0].target).toBe(EDITED);
  });
});
