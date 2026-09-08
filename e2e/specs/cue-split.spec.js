/* global describe, it, before, document, window */
/**
 * Splitting a cue at the playhead: with a video open, the cue is cut in two at a frame boundary near
 * the playhead, the whole text kept in both halves, unlike the caret split which divides it. The
 * exact frame boundary is proved in the crate's unit tests (frames and SplitInTwo); what is read
 * here is the shape the grid draws, the whole point of the wiring: two cues where one was, both with
 * the text, the first keeping the start and the second the end. See docs/split-at-playhead-tasks.md.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow, pressKey, typeText } from "../lib/input.js";
import { takeCommands, watchCommands } from "../lib/ipc.js";
import { repoRoot, requireVideoFixture, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

const FIXTURE = ["srt", "clean", "basic-lf.srt"];
const CUE0_TEXT = "The harbour was empty when we got there.";

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
    throw new Error(`E2E prerequisite missing: ${from}. Restore it with git checkout fixtures.`);
  }
  const directory = path.join(dataHome(), "cue-split");
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
    return {
      x: (rect.x + rect.width / 2) * window.devicePixelRatio,
      y: (rect.y + rect.height / 2) * window.devicePixelRatio,
    };
  }, selector);
}

async function clickElement(toplevel, selector) {
  const centre = await centreOf(selector);
  if (centre === null) {
    throw new Error(`${selector} is missing from the DOM`);
  }
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

const present = (selector) =>
  browser.execute((css) => document.querySelector(css) !== null, selector);
const textOf = (selector) =>
  browser.execute((css) => document.querySelector(css)?.textContent ?? null, selector);

/** The three cells a row draws, found by its 1-based position. */
function rowCells(position) {
  return browser.execute((wanted) => {
    const row = Array.from(document.querySelectorAll(".cuelist__row")).find(
      (candidate) => candidate.querySelector(".cuelist__pos")?.textContent === wanted,
    );
    if (!row) {
      return null;
    }
    return {
      start: row.querySelector(".cuelist__start")?.textContent ?? null,
      end: row.querySelector(".cuelist__end")?.textContent ?? null,
      text: row.querySelector(".cuelist__text")?.textContent ?? null,
    };
  }, String(position));
}

function rowCount() {
  return browser.execute(() => document.querySelectorAll(".cuelist__row").length);
}

async function clickRow(toplevel, position) {
  const centre = await browser.execute((wanted) => {
    const row = Array.from(document.querySelectorAll(".cuelist__row")).find(
      (candidate) => candidate.querySelector(".cuelist__pos")?.textContent === wanted,
    );
    const cell = row?.querySelector(".cuelist__pos");
    if (!cell) {
      return null;
    }
    const rect = cell.getBoundingClientRect();
    return {
      x: (rect.x + rect.width / 2) * window.devicePixelRatio,
      y: (rect.y + rect.height / 2) * window.devicePixelRatio,
    };
  }, String(position));
  if (centre === null) {
    throw new Error(`row ${position} is not rendered`);
  }
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

function playhead() {
  return browser.execute(() => Number(document.querySelector(".controls__slider")?.value ?? -1));
}

/** Jump the playhead to a timecode through the Jump-to-time dialog, which selects its field on open. */
async function seekTo(toplevel, timecode, seconds) {
  pressKey("ctrl+g");
  await waitFor(() => present(".jumpto__value"), { timeout: 15000, message: "the jump dialog" });
  typeText(timecode);
  pressKey("Return");
  await waitFor(async () => ((await present(".jumpto")) ? null : 1), {
    timeout: 15000,
    message: "the jump dialog to close",
  });
  await waitFor(async () => (Math.abs((await playhead()) - seconds) < 0.1 ? 1 : null), {
    timeout: 20000,
    message: `the playhead to settle near ${seconds}s`,
  });
}

async function splitAtPlayhead(toplevel, which) {
  await clickElement(toplevel, ".menubar__title--subtitle");
  await waitFor(() => present(`.menubar__item--subtitle-split-${which}-playhead`), {
    timeout: 15000,
    message: `the Subtitle menu to open on split ${which}`,
  });
  await clickElement(toplevel, `.menubar__item--subtitle-split-${which}-playhead`);
}

async function itemDisabled(token) {
  return browser.execute(
    (css) => document.querySelector(css)?.disabled === true,
    `.menubar__item--${token}`,
  );
}

describe("splitting a cue at the playhead", () => {
  let toplevel = null;

  before(async () => {
    const copy = workingCopy();
    toplevel = await waitFor(findToplevel, {
      timeout: 30000,
      message: `the ${windowWidth}x${windowHeight} "Sublore" toplevel`,
    });
    focusWindow(toplevel.id);
    await waitFor(() => present(".toolbar__file-open-subtitle"), {
      timeout: 30000,
      message: "the app UI",
    });
    await clickElement(toplevel, ".toolbar__file-open-subtitle");
    await answerChooser(await waitForChooser("Choose a subtitle"), copy, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(
      async () => ((await textOf(".statusbar__document"))?.includes("3 cues") === true ? 1 : null),
      { timeout: 20000, message: "the fixture to open" },
    );
    await clickElement(toplevel, ".toolbar__video-open");
    await answerChooser(await waitForChooser("Choose a video"), requireVideoFixture(), "video");
    focusWindow(toplevel.id);
    await waitFor(
      () =>
        browser.execute(
          () =>
            document.querySelector(".stage__empty") === null &&
            document.querySelector(".controls__button")?.disabled === false,
        ),
      { timeout: 30000, message: "the video to reach the ready state" },
    );
  });

  it("enables the two playhead splits once a video is open", async () => {
    await clickRow(toplevel, 1);
    await clickElement(toplevel, ".menubar__title--subtitle");
    await waitFor(() => present(".menubar__item--subtitle-split-after-playhead"), {
      timeout: 15000,
      message: "the Subtitle menu to open",
    });
    expect(await itemDisabled("subtitle-split-before-playhead")).toBe(false);
    expect(await itemDisabled("subtitle-split-after-playhead")).toBe(false);
    pressKey("Escape");
  });

  it("cuts the cue in two at the playhead, the whole text in both halves", async () => {
    const before = await rowCells(1);
    expect(before.text).toBe(CUE0_TEXT);

    await clickRow(toplevel, 1);
    await seekTo(toplevel, "00:00:03.500", 3.5);
    await splitAtPlayhead(toplevel, "after");
    await waitFor(async () => ((await rowCount()) === 4 ? 1 : null), {
      timeout: 15000,
      message: "the cue to become two",
    });

    const first = await rowCells(1);
    const second = await rowCells(2);
    // The whole text rides into both halves.
    expect(first.text).toBe(CUE0_TEXT);
    expect(second.text).toBe(CUE0_TEXT);
    // The first keeps the cue's start, the second its end, and they meet at the split point.
    expect(first.start).toBe(before.start);
    expect(second.end).toBe(before.end);
    expect(first.end).toBe(second.start);
    // The split moved off the cue's own start, so the first half is not empty.
    expect(first.end).not.toBe(before.start);
    // The third cue is untouched.
    expect((await rowCells(3)).text).not.toBe(CUE0_TEXT);
  });

  it("does nothing when the playhead is outside the cue, and sends no command", async () => {
    await clickRow(toplevel, 1);
    // The first cue starts at 2.120 s; seek before it.
    await seekTo(toplevel, "00:00:01.000", 1.0);
    await watchCommands();
    await splitAtPlayhead(toplevel, "after");
    // A real split would emit subtitle_split_at_playhead; prove none did with a following one that
    // does not fit the pattern is awkward, so read after a settle: the count is unchanged.
    await waitFor(async () => ((await present(".menubar__menu")) ? null : 1), {
      timeout: 15000,
      message: "the menu to close after the no-op",
    });
    expect(await rowCount()).toBe(4);
    expect(await takeCommands()).toEqual([]);
  });
});
