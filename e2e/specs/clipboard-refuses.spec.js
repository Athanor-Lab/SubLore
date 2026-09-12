/* global describe, it, before, document, window */
/**
 * What the app says when the clipboard will not take the text.
 *
 * The clipboard can genuinely refuse: GTK's own can fail, and on Windows `clipboard.rs` is a stub
 * that returns an error by construction. Until N169 the backend logged the refusal and handed it
 * back, and the page threw it away, so a copy that wrote nowhere looked exactly like one that
 * worked. This spec runs against a clipboard that always refuses, which `wdio.conf.js` arranges by
 * this file's name, and reads what the status bar says.
 *
 * The control is the rest of the battery: `clipboard.spec.js` round trips through the real
 * clipboard twice, so a refusal that leaked into every spec would take those with it.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { appLog, waitForLog } from "../lib/applog.js";
import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow, pressKey } from "../lib/input.js";
import { repoRoot, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

const FIXTURE = ["srt", "clean", "basic-lf.srt"];

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
  const directory = path.join(dataHome(), "clipboard-refuses");
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

/** How many rows the grid draws. The cut's whole point is that this number does not move. */
function rowCount() {
  return browser.execute(() => document.querySelectorAll(".cuelist__row").length);
}

function selectedCount() {
  return browser.execute(() => document.querySelectorAll(".cuelist__row--selected").length);
}

describe("a clipboard that refuses", () => {
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

    await clickElement(toplevel, ".toolbar__file-open-subtitle");
    const chooser = await waitForChooser("Choose a subtitle");
    await answerChooser(chooser, copy, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(
      async () => ((await textOf(".statusbar__document"))?.includes("3 cues") === true ? 1 : null),
      { timeout: 20000, message: "the fixture to open" },
    );
  });

  it("says nothing until something is asked of it", async () => {
    // The contrast the other two need: the bar is quiet with a document open and no copy made, so
    // a line found later came from the press rather than from the app's opening state.
    expect(await present(".statusbar__chrome-error")).toBe(false);
    expect(await rowCount()).toBe(3);
    expect(await selectedCount()).toBe(1);
  });

  it("says so when a copy cannot be written", async () => {
    pressKey("ctrl+c");
    await waitFor(
      async () => {
        const line = await textOf(".statusbar__chrome-error");
        return line?.includes("could not put the lines on the clipboard") === true ? 1 : null;
      },
      { timeout: 20000, message: "the status bar to say the copy could not be written" },
    );
    expect(await textOf(".statusbar__chrome-error")).toContain("document has not changed");

    // The backend's half of the boundary, which was always working: it logs and returns.
    await waitForLog(dataHome(), /clipboard: the copy failed/, {
      timeout: 20000,
      what: "the app to log the refusal it handed back",
    });
    expect(await rowCount()).toBe(3);
  });

  it("says so when a cut cannot be written, and cuts nothing", async () => {
    pressKey("ctrl+x");
    await waitFor(
      async () => {
        const line = await textOf(".statusbar__chrome-error");
        return line?.includes("nothing was cut") === true ? 1 : null;
      },
      { timeout: 20000, message: "the status bar to say nothing was cut" },
    );

    // The rule that matters is the data one, and it held before this change: the write goes first
    // and the rows come out only if it succeeded. Read here so a later edit cannot quietly swap
    // the order and leave the user with a refusal and a hole.
    expect(await rowCount()).toBe(3);
    expect(await selectedCount()).toBe(1);
    expect(readFileSync(copy)).toEqual(bytesBefore);
    expect(appLog(dataHome())).toContain("SUBLORE_CLIPBOARD_REFUSES=1");
  });
});
