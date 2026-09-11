/* global describe, it, before, document, window */
/**
 * The five timing commands M2.5 asks for by name and nothing was exercising.
 *
 * Written against `docs/timing-keys-unproved-tasks.md`. Every one of the four play commands makes
 * something play, so "something is playing" cannot tell them apart. What tells them apart is where
 * each one stops, and the app writes that down: `playback: range stopped at X for a target of Y`.
 * The target is the assertion.
 *
 * The keys are pressed by their X11 names with NumLock off, which is how the numpad reaches the
 * app here: `Num 3` is `KP_Next` and `Num 2` and `Num 8` are `KP_Down` and `KP_Up`. See N106.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { appLog } from "../lib/applog.js";
import { clickAt, focusWindow, pressKey } from "../lib/input.js";
import { runFromMenu } from "../lib/menu.js";
import { repoRoot, requireVideoFixture, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { closeAnyOpenProject } from "../lib/rail.js";
import { findToplevel } from "../lib/x11.js";

const OPEN_STATUS = "SRT · 3 cues · LF";

/** The fixture's third cue, committed and byte-frozen, so these are facts. */
const THIRD_START = 9.1;
const THIRD_END = 11.76;
/** `CONTEXT_MS` in src/App.tsx, the half second every one of these windows is built from. */
const CONTEXT = 0.5;
/** The transport updates ten times a second, and a target is compared against a written number. */
const SLACK = 0.06;
/**
 * How long a range is given to play and stop itself.
 *
 * Thirty seconds until 2026-09-12, when the first of these checks failed on the runner twice with
 * no range line in the app's log at all. The first press pays for everything the video open has not
 * finished doing, and that machine answers the preview's own question in thirty-two seconds where
 * this one takes four (N101). Sixty, for the same reason and with the same honesty: it is the
 * runner being slow, not the app being wrong.
 */
const RANGE_TIMEOUT_MS = 60000;

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
  const directory = path.join(dataHome(), "timing-play-keys");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const copy = path.join(directory, "basic-lf.srt");
  copyFileSync(source, copy);
  return copy;
}

function textOf(selector) {
  return browser.execute((css) => document.querySelector(css)?.textContent ?? null, selector);
}

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

/** Every row the grid draws, with the cursor marked. */
function gridRows() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".cuelist__row")).map((row) => ({
      position: row.querySelector(".cuelist__pos")?.textContent ?? null,
      cursor: row.classList.contains("cuelist__row--active"),
    })),
  );
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

/** The row number cell, never the text: a click on the text opens the inline editor. */
async function cursorTo(toplevel, position) {
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
    throw new Error(`row ${position} is missing from the DOM`);
  }
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
  await waitFor(async () => ((await gridRows())[position - 1]?.cursor === true ? true : null), {
    timeout: 15000,
    message: `the cursor to land on row ${position}`,
  });
  // Take the keyboard back before any press. There is no window manager under Xvfb, so when the
  // chooser closes the focus it held is not handed anywhere, and the first key pressed afterwards
  // can reach nothing at all: the app's log showed the E case with no `playback:` line whatever,
  // while D and the numpad's 3 right after it worked. See BACKLOG.md N162.
  focusWindow(toplevel.id);
}

/** Every range the app has finished playing, oldest first, as pairs of numbers. */
function stops() {
  return Array.from(
    appLog(dataHome()).matchAll(/playback: range stopped at ([\d.]+) for a target of ([\d.]+)/g),
  ).map((found) => ({ at: Number(found[1]), target: Number(found[2]) }));
}

/**
 * Press a key and answer the range that press played, read off the app's own account of its stop.
 * The count before is taken first: the log is one file for the whole run and older stops are in it.
 */
async function playedBy(key) {
  const before = stops().length;
  pressKey(key);
  return waitFor(
    async () => {
      const seen = stops();
      return seen.length > before ? seen[seen.length - 1] : null;
    },
    {
      timeout: RANGE_TIMEOUT_MS,
      message: `${key} to play a range and stop itself at the end of it`,
    },
  );
}

/** What the transport says the media's length is, which is what "to the end" ends at. */
function mediaDuration() {
  return browser.execute(() => {
    const slider = document.querySelector(".controls__slider");
    return slider === null ? null : Number(slider.getAttribute("max"));
  });
}

/** Where the transport says the playhead is, in seconds. */
function playhead() {
  return browser.execute(() => {
    const slider = document.querySelector(".controls__slider");
    return slider === null ? null : Number(slider.value);
  });
}

/** Put the player back down, for a check that does not wait for a range to end on its own. */
async function pausePlayback(toplevel) {
  if ((await textOf(".controls__button")) === "Pause") {
    await clickElement(toplevel, ".controls__button");
  }
  await waitFor(async () => ((await textOf(".controls__button")) === "Play" ? true : null), {
    timeout: 20000,
    message: "the player to pause",
  });
}

describe("the timing keys M2.5 names are exercised", () => {
  let toplevel;

  before(async () => {
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
      { timeout: 20000, message: "the status bar to report the open subtitle" },
    );

    await runFromMenu((css) => clickElement(toplevel, css), "video", "video-open");
    await answerChooser(await waitForChooser("Choose a video"), requireVideoFixture(), "video");
    focusWindow(toplevel.id);
    await waitFor(() => present(".controls__slider"), {
      timeout: 40000,
      message: "the transport to appear",
    });
    // The transport being drawn is not the player being ready, and every command below is greyed
    // until it is: a press against a greyed command does nothing and this file would sit out its
    // whole timeout. The length arriving is what says the media is open, and the button coming
    // alive is what says it can be played. Under four workers the gap is wide enough to matter,
    // which is how this was found: green alone, red in the battery.
    await waitFor(
      async () => {
        const duration = await mediaDuration();
        const greyed = await browser.execute(
          () => document.querySelector(".controls__button")?.disabled ?? true,
        );
        return duration !== null && duration > 0 && greyed === false ? true : null;
      },
      { timeout: 60000, message: "the player to be ready to play" },
    );
  });

  it("plays the first half second of the line on E", async () => {
    await cursorTo(toplevel, 3);
    const played = await playedBy("e");
    expect(played.target).toBeCloseTo(THIRD_START + CONTEXT, 1);
    // And it is not the whole line: this fixture's third cue is 2.66 s long.
    expect(played.target).toBeLessThan(THIRD_END - SLACK);
  });

  it("plays the last half second of the line on D", async () => {
    await cursorTo(toplevel, 3);
    const played = await playedBy("d");
    expect(played.target).toBeCloseTo(THIRD_END, 1);
    // Where it stopped is the line's end, and where it began is what tells it from Play line: the
    // window is half a second, so a stop at the end says nothing on its own.
    expect(played.at).toBeGreaterThan(THIRD_END - CONTEXT - SLACK);
  });

  it("plays the half second after the line on the numpad's 3", async () => {
    await cursorTo(toplevel, 3);
    const played = await playedBy("KP_Next");
    expect(played.target).toBeCloseTo(THIRD_END + CONTEXT, 1);
    // Past the line's own end, which no other command in this set reaches.
    expect(played.target).toBeGreaterThan(THIRD_END + SLACK);
  });

  it("plays past the line's own end on T, which no other key in the set does", async () => {
    // Not read off a stop like the three above: this one ends at the end of the media, which is
    // sixty seconds here, and a check is not going to sit through fifty-one of them. What
    // distinguishes it is that it keeps going past the cue's end, where every other command in
    // this set stops at or before it. So that is what is measured, and then the player is put
    // back down rather than left running into the next check.
    await cursorTo(toplevel, 3);
    const duration = await mediaDuration();
    expect(duration).toBeGreaterThan(THIRD_END + 1);

    pressKey("t");
    await waitFor(async () => ((await playhead()) > THIRD_END + 0.3 ? true : null), {
      timeout: 30000,
      message: "T to carry the playhead past the end of the third cue",
    });
    await pausePlayback(toplevel);
  });

  it("walks the cursor a line at a time on the numpad's 2 and 8", async () => {
    await cursorTo(toplevel, 2);
    pressKey("ctrl+KP_Down");
    await waitFor(async () => ((await gridRows())[2]?.cursor === true ? true : null), {
      timeout: 15000,
      message: "Ctrl and the numpad's 2 to move the cursor to the third line",
    });
    pressKey("ctrl+KP_Up");
    await waitFor(async () => ((await gridRows())[1]?.cursor === true ? true : null), {
      timeout: 15000,
      message: "Ctrl and the numpad's 8 to bring it back to the second",
    });
    // One row, not two. This is the assertion that found N158: the grid read `key` rather than
    // `code`, the numpad's 8 carries a `key` of "ArrowUp", and the press moved the cursor twice.
    // Downward it looked right, because the second move ran off the end of a three-line file.
    expect((await gridRows())[0]?.cursor).toBe(false);
  });
});
