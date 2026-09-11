/* global describe, it, before, document, window */
/**
 * N138: the waveform's zoom is three commands in the registry, so it answers wherever the keyboard
 * is rather than only over the canvas.
 *
 * Written against `docs/waveform-zoom-commands-tasks.md`. Everything is read off `data-ms-per-px`,
 * which the panel already publishes, so the assertions are the scale itself and not a screenshot.
 *
 * The grid holds the keyboard for every case here. That is the point of the entry: before this the
 * zoom existed only while the canvas had focus, and the canvas is not where a translator types.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow, pressKey } from "../lib/input.js";
import { runFromMenu } from "../lib/menu.js";
import { repoRoot, requireWaveformFixture, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { closeAnyOpenProject } from "../lib/rail.js";
import { findToplevel } from "../lib/x11.js";

const OPEN_STATUS = "SRT · 3 cues · LF";

/** One press or one notch, from `ZOOM_FACTOR` in src/hooks/useWaveformView.ts. */
const ZOOM_FACTOR = 2;

function dataHome() {
  const home = process.env.SUBLORE_E2E_DATA_HOME;
  if (typeof home !== "string" || home === "") {
    throw new Error("SUBLORE_E2E_DATA_HOME is not set; e2e/wdio.conf.js sets it for every run.");
  }
  return home;
}

function workingCopy() {
  const source = path.join(repoRoot, "fixtures", "subtitles", "srt", "clean", "basic-lf.srt");
  if (!existsSync(source)) {
    throw new Error(
      `E2E prerequisite missing: ${source} does not exist. It is committed; restore it with ` +
        "`git checkout fixtures/subtitles`.",
    );
  }
  const directory = path.join(dataHome(), "waveform-zoom");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const copy = path.join(directory, "basic-lf.srt");
  copyFileSync(source, copy);
  return copy;
}

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

function textOf(selector) {
  return browser.execute((css) => document.querySelector(css)?.textContent ?? null, selector);
}

/** The scale the panel is drawing at, in milliseconds of media per device pixel. */
function scale() {
  return browser.execute(() => {
    const panel = document.querySelector(".waveform");
    const value = panel?.getAttribute("data-ms-per-px");
    return value === null || value === undefined ? null : Number(value);
  });
}

function valueOf(selector) {
  return browser.execute((css) => document.querySelector(css)?.value ?? null, selector);
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

/**
 * Put the keyboard on the grid, which is where a translator's hands are (D1). The press lands on
 * the row number and not on the text: a click on the text opens the inline editor, and a field owns
 * every bare key, so the registry would never see the press at all.
 */
async function focusTheGrid(toplevel) {
  await clickElement(toplevel, ".cuelist__row .cuelist__pos");
  focusWindow(toplevel.id);
}

/** A scale that settled after a press, so the assertion is not racing the render. */
async function scaleAfter(press) {
  const before = await scale();
  press();
  await waitFor(async () => (await scale()) !== before, {
    timeout: 5000,
    message: `the scale to move from ${before}`,
  });
  return scale();
}

describe("the waveform's zoom is in the registry", () => {
  let toplevel;
  let fitted;

  before(async () => {
    requireWaveformFixture();
    const copy = workingCopy();
    toplevel = await waitFor(findToplevel, {
      timeout: 30000,
      message: `the ${windowWidth}x${windowHeight} "Sublore" toplevel to appear`,
    });
    focusWindow(toplevel.id);
    await waitFor(
      () => browser.execute(() => document.querySelector(".toolbar__file-open-subtitle") !== null),
      { timeout: 30000, message: "the app UI to render" },
    );
    await closeAnyOpenProject(toplevel);

    await clickElement(toplevel, ".toolbar__file-open-subtitle");
    await answerChooser(await waitForChooser("Choose a subtitle"), copy, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(
      async () => (await textOf(".statusbar__document"))?.includes(OPEN_STATUS) === true,
      {
        timeout: 20000,
        message: "the status bar to report the open subtitle",
      },
    );

    await runFromMenu((css) => clickElement(toplevel, css), "video", "video-open");
    await answerChooser(await waitForChooser("Choose a video"), requireWaveformFixture(), "video");
    focusWindow(toplevel.id);
    await waitFor(() => present(".waveform"), {
      timeout: 40000,
      message: "the waveform panel to appear",
    });
    // The view opens on the whole file, which is the scale `wave.zoom-fit` must come back to.
    await waitFor(async () => (await scale()) !== null, {
      timeout: 10000,
      message: "the panel to publish its scale",
    });
    fitted = await scale();
  });

  it("zooms in from the grid, one press one halving", async () => {
    await focusTheGrid(toplevel);
    const deeper = await scaleAfter(() => pressKey("plus"));
    // Exactly one step: a press that reached both the registry and the canvas would be two.
    expect(deeper).toBeCloseTo(fitted / ZOOM_FACTOR, 6);
  });

  it("zooms out from the grid, one press one doubling", async () => {
    await focusTheGrid(toplevel);
    const shallower = await scaleAfter(() => pressKey("minus"));
    expect(shallower).toBeCloseTo(fitted, 6);
  });

  it("fits the whole file back into the panel", async () => {
    await focusTheGrid(toplevel);
    // Twice in, so fit has somewhere to come back from.
    await scaleAfter(() => pressKey("plus"));
    await scaleAfter(() => pressKey("plus"));
    const back = await scaleAfter(() => pressKey("0"));
    expect(back).toBeCloseTo(fitted, 6);
  });

  it("leaves the scale alone while someone is typing", async () => {
    await focusTheGrid(toplevel);
    await scaleAfter(() => pressKey("plus"));
    const held = await scale();

    await clickElement(toplevel, ".currentline__text");
    focusWindow(toplevel.id);
    const before = await valueOf(".currentline__text");
    // To the end first: the click put the caret where it landed, and this check is about which of
    // the two took the keys, not about where in the line they went.
    pressKey("End");
    pressKey("plus");
    pressKey("minus");
    pressKey("0");
    await waitFor(async () => (await valueOf(".currentline__text")) !== before, {
      timeout: 5000,
      message: "the three characters to arrive in the text box",
    });
    expect(await valueOf(".currentline__text")).toBe(`${before}+-0`);
    // The field took them and the panel never heard them.
    expect(await scale()).toBeCloseTo(held, 6);
  });
});
