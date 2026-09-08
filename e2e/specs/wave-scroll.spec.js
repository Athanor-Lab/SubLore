/* global describe, it, before, document, window, WheelEvent */
/**
 * The waveform's two scroll commands (interface-spec 5, pan table): A pans left and F pans right,
 * 128 device pixels a press whatever the zoom, keyboard-only the way the reference keeps them. The
 * pan is read where it is drawn: a timing marker's canvas column moves by exactly the step.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow, pressKey } from "../lib/input.js";
import { repoRoot, requireWaveformFixture, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { closeAnyOpenProject } from "../lib/rail.js";
import { findToplevel } from "../lib/x11.js";

/** The step the two commands make: 128 device px, the number the criteria pin (G1). */
const STEP = 128;

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
    throw new Error(`${selector} is missing from the DOM`);
  }
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

function workingCopy() {
  const dataHome = process.env.SUBLORE_E2E_DATA_HOME;
  if (typeof dataHome !== "string" || dataHome === "") {
    throw new Error("SUBLORE_E2E_DATA_HOME is not set; e2e/wdio.conf.js sets it for every run.");
  }
  const directory = path.join(dataHome, "wave-scroll");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const source = path.join(repoRoot, "fixtures", "subtitles", "srt", "clean", "midfile.srt");
  if (!existsSync(source)) {
    throw new Error(`E2E prerequisite missing: ${source}. Restore it with git.`);
  }
  const copy = path.join(directory, "midfile.srt");
  copyFileSync(source, copy);
  return copy;
}

/** The playhead's canvas column, by the accent it is drawn in: the cursor parks it on the cue's
 *  start (video follow), so it is a stable time the pan moves across the canvas. */
function playheadColumn() {
  return browser.execute(() => {
    const canvas = document.querySelector(".waveform__canvas");
    if (canvas === null) {
      return null;
    }
    const root = window.getComputedStyle(document.documentElement);
    const hex = root.getPropertyValue("--accent").trim().replace("#", "");
    const want = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16));
    const middle = Math.floor(canvas.height / 2);
    const row = canvas.getContext("2d").getImageData(0, middle, canvas.width, 1).data;
    for (let x = 0; x < canvas.width; x += 1) {
      const at = x * 4;
      const off =
        Math.abs(row[at] - want[0]) +
        Math.abs(row[at + 1] - want[1]) +
        Math.abs(row[at + 2] - want[2]);
      if (off <= 6) {
        return x;
      }
    }
    return null;
  });
}

/** A ctrl-wheel notch over the canvas at a column: the panel's own zoom, anchored there. */
async function zoomAt(column, notches) {
  await browser.execute(
    (at, count) => {
      const canvas = document.querySelector(".waveform__canvas");
      const box = canvas.getBoundingClientRect();
      const clientX = box.x + at / window.devicePixelRatio;
      for (let step = 0; step < count; step += 1) {
        canvas.dispatchEvent(
          new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            clientX,
            clientY: box.y + box.height / 2,
            deltaY: -100,
            ctrlKey: true,
          }),
        );
      }
    },
    column,
    notches,
  );
  await browser.pause(200);
}

async function waitForPlayhead(wanted, what) {
  return waitFor(
    async () => {
      const column = await playheadColumn();
      return column !== null && Math.abs(column - wanted) <= 1 ? column : null;
    },
    { timeout: 15000, message: `${what} (playhead near column ${wanted})` },
  );
}

describe("the waveform scroll pair", () => {
  let toplevel = null;

  before(async () => {
    requireWaveformFixture();
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
    await closeAnyOpenProject(toplevel);

    await clickElement(toplevel, ".toolbar__file-open-subtitle");
    const subtitle = await waitForChooser("Choose a subtitle");
    await answerChooser(subtitle, copy, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(() => present(".cuelist__row"), {
      timeout: 20000,
      message: "the fixture to open",
    });

    await clickElement(toplevel, ".toolbar__video-open");
    const video = await waitForChooser("Choose a video");
    await answerChooser(video, requireWaveformFixture(), "video");
    focusWindow(toplevel.id);
    await waitFor(() => present(".waveform__canvas"), {
      timeout: 40000,
      message: "the waveform panel to appear",
    });
    // The cue sits mid-file, and the cursor parks the playhead on its
    // start. The whole file fits the panel at the shallowest zoom and nothing can pan there, so
    // the window is zoomed in anchored on the playhead, which stays put while the span shrinks.
    // Row two, because row one is already the active row on open and a click that changes no
    // selection makes no seek: the second row's click moves the selection and the follow takes
    // the playhead to second forty, mid-file.
    const posCell = await browser.execute(() => {
      const cell = Array.from(document.querySelectorAll(".cuelist__row"))
        .find((row) => row.querySelector(".cuelist__pos")?.textContent === "2")
        ?.querySelector(".cuelist__pos");
      if (!cell) {
        return null;
      }
      const rect = cell.getBoundingClientRect();
      const dpr = window.devicePixelRatio;
      return { x: (rect.x + rect.width / 2) * dpr, y: (rect.y + rect.height / 2) * dpr };
    });
    if (posCell === null) {
      throw new Error("the second row is missing from the DOM");
    }
    clickAt(toplevel.absX + posCell.x, toplevel.absY + posCell.y);
    // Found away from the left edge, which is what says the follow's seek landed.
    await waitFor(
      async () => {
        const column = await playheadColumn();
        return column !== null && column > 100 ? column : null;
      },
      { timeout: 20000, message: "the playhead to land mid-canvas after the follow's seek" },
    );
    await zoomAt(await playheadColumn(), 14);
    await waitFor(async () => ((await playheadColumn()) === null ? null : 1), {
      timeout: 15000,
      message: "the playhead to still be in view after the zoom",
    });
  });

  it("F pans right by 128 device px and A pans back, whatever was zoomed", async () => {
    const at = await playheadColumn();

    // The window moves right, so what is drawn in it moves left by exactly the step.
    pressKey("f");
    await waitForPlayhead(at - STEP, "F to pan the window right");
    pressKey("f");
    await waitForPlayhead(at - STEP * 2, "a second F to pan the same step again");

    pressKey("a");
    pressKey("a");
    await waitForPlayhead(at, "two As to bring the window back where it began");
    expect(Math.abs((await playheadColumn()) - at)).toBeLessThanOrEqual(1);
  });
});
