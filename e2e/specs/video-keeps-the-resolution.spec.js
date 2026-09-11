/* global describe, it, before, document, window */
/**
 * Interface spec §6.4's first refused behaviour, on the only format where it could happen.
 *
 * The reference, on loading a video, compares the script's declared resolution to the video's and
 * can force it, rewrite it, or resample every override coordinate in the document, marking it
 * modified. Opening a video is not an edit, and CLAUDE.md §3 is what makes that a rule here rather
 * than a preference.
 *
 * `preview.spec.js` already opens a video over a clean document and over an edited one and reads
 * the unsaved mark and the bytes back, but it does that with an SRT, which declares no resolution
 * at all. This is the case that could go wrong: an ASS saying 1920 by 1080 with a 640 by 360 video
 * opened under it.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow } from "../lib/input.js";
import { runFromMenu } from "../lib/menu.js";
import { repoRoot, requireVideoFixture, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { closeAnyOpenProject } from "../lib/rail.js";
import { findToplevel } from "../lib/x11.js";

/** What the fixture declares, and what the video is. Different on purpose: that is the whole case. */
const DECLARED = ["PlayResX: 1920", "PlayResY: 1080"];
const OPEN_STATUS = "ASS";

function dataHome() {
  const home = process.env.SUBLORE_E2E_DATA_HOME;
  if (typeof home !== "string" || home === "") {
    throw new Error("SUBLORE_E2E_DATA_HOME is not set; e2e/wdio.conf.js sets it for every run.");
  }
  return home;
}

function workingCopy() {
  const source = path.join(repoRoot, "fixtures", "subtitles", "ass", "clean", "basic.ass");
  if (!existsSync(source)) {
    throw new Error(
      `E2E prerequisite missing: ${source} does not exist. It is committed; restore it with ` +
        "`git checkout fixtures/subtitles`.",
    );
  }
  const directory = path.join(dataHome(), "video-keeps-the-resolution");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const copy = path.join(directory, "basic.ass");
  copyFileSync(source, copy);
  return copy;
}

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

function textOf(selector) {
  return browser.execute((css) => document.querySelector(css)?.textContent ?? null, selector);
}

async function clickElement(toplevel, selector) {
  const centre = await browser.execute((css) => {
    const element = document.querySelector(css);
    if (element === null) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    return { x: (rect.x + rect.width / 2) * dpr, y: (rect.y + rect.height / 2) * dpr };
  }, selector);
  if (centre === null) {
    throw new Error(`${selector} is missing from the DOM`);
  }
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

describe("a video opened under a document that declares a resolution", () => {
  let toplevel = null;
  let copy = null;
  let openedBytes = null;

  before(async () => {
    requireVideoFixture();
    copy = workingCopy();
    openedBytes = readFileSync(copy);
    // The fixture has to actually declare one, or this file proves nothing.
    for (const line of DECLARED) {
      expect(openedBytes.toString("utf8")).toContain(line);
    }

    toplevel = await waitFor(findToplevel, {
      timeout: 30000,
      message: `the ${windowWidth}x${windowHeight} "Sublore" toplevel to appear`,
    });
    focusWindow(toplevel.id);
    await waitFor(() => present(".toolbar__file-open-subtitle"), {
      timeout: 30000,
      message: "the app UI to render",
    });
    await closeAnyOpenProject(toplevel);

    await clickElement(toplevel, ".toolbar__file-open-subtitle");
    await answerChooser(await waitForChooser("Choose a subtitle"), copy, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(
      async () => (await textOf(".statusbar__document"))?.includes(OPEN_STATUS) === true,
      { timeout: 20000, message: "the status bar to report the open subtitle" },
    );
    expect(await present(".statusbar__dirty")).toBe(false);

    await runFromMenu((css) => clickElement(toplevel, css), "video", "video-open");
    await answerChooser(await waitForChooser("Choose a video"), requireVideoFixture(), "video");
    focusWindow(toplevel.id);
    await waitFor(() => present(".controls__slider"), {
      timeout: 40000,
      message: "the transport to appear, which is the video being open",
    });
  });

  it("leaves the document clean", async () => {
    // Nothing was edited, so nothing may be marked as edited. A resolution forced on the script
    // would show here first, before it showed anywhere else.
    expect(await present(".statusbar__dirty")).toBe(false);
  });

  it("leaves the file on disk exactly as it was", async () => {
    expect(readFileSync(copy).equals(openedBytes)).toBe(true);
  });

  it("writes the same bytes back when the document is saved afterwards", async () => {
    // The reading that sees a field changed in memory and not yet written. A save right after
    // opening the video has to reproduce the file it opened.
    await clickElement(toplevel, ".toolbar__file-save");
    await waitFor(async () => ((await present(".statusbar__dirty")) === false ? true : null), {
      timeout: 20000,
      message: "the save to finish",
    });
    const written = readFileSync(copy).toString("utf8");
    for (const line of DECLARED) {
      expect(written).toContain(line);
    }
    expect(readFileSync(copy).equals(openedBytes)).toBe(true);
  });
});
