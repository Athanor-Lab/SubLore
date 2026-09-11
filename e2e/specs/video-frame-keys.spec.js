/* global describe, it, before, document, window, WheelEvent */
/**
 * The picture's own navigation keys: one frame either way, and the edges of the current line.
 *
 * The clock under the picture counts whole seconds, which cannot show a frame, so what is read here
 * is the seek slider's own value: it carries the position as a number and a frame at thirty a
 * second is three hundredths of it. The last check is the one that pays for the rest: with the
 * caret in a text box the same chords belong to the box, or a translator could not move a word at
 * a time through a line they are writing.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { runFromMenu } from "../lib/menu.js";
import { stopFollowingTheCursor } from "../lib/transport.js";
import { clickAt, focusWindow, pressKey, typeText } from "../lib/input.js";
import { repoRoot, requireVideoFixture, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

/** Three cues, whose starts and ends are what the boundary walk stops on. */
const FIXTURE = ["srt", "clean", "basic-lf.srt"];
const FIRST_START = 2.12;
const FIRST_END = 4.88;
const SECOND_START = 5.0;
/** The sample fixture runs at thirty frames a second, so one frame is a thirtieth of a second. */
const FRAME = 1 / 30;

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
  const directory = path.join(dataHome(), "video-frame-keys");
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

/** Where the playhead is, as the seek slider carries it: seconds, with the fraction. */
async function playhead() {
  return browser.execute(() => Number(document.querySelector(".controls__slider")?.value ?? -1));
}

/** Wait until the playhead is within a frame of `seconds`. */
function playheadReaches(seconds, what) {
  return waitFor(async () => (Math.abs((await playhead()) - seconds) < FRAME ? 1 : null), {
    timeout: 20000,
    message: `the playhead to reach ${what}`,
  });
}

/**
 * Wait until the playhead stops moving, and answer where it stopped.
 *
 * A seek reaches the slider before mpv has finished making it, and the position mpv settles on
 * arrives afterwards. Stepping a frame off a reading taken in between would be undone by that late
 * report, which is what this waits out.
 */
async function playheadSettles(seconds) {
  let last = await playhead();
  for (let tries = 0; tries < 30; tries += 1) {
    await browser.pause(300);
    const now = await playhead();
    // Where it stopped, and where it was asked to stop when the caller says: mpv reports the frame
    // it is really showing, which is at or just past the time a seek asked for.
    if (now === last && (seconds === undefined || Math.abs(now - seconds) < FRAME)) {
      return now;
    }
    last = now;
  }
  throw new Error(`the playhead never settled at ${seconds ?? "anything"}; it last read ${last}`);
}

/**
 * One wheel gesture over the seek slider, in notches, as a `WheelEvent` the way the waveform's own
 * checks send theirs: a notch is 100 pixels of `deltaY` in pixel mode. Answers with whether the
 * handler took the gesture, which a synthetic event does carry.
 */
function wheelOverSlider(notches) {
  return browser.execute((delta) => {
    const slider = document.querySelector(".controls__slider");
    if (slider === null) {
      return null;
    }
    const event = new WheelEvent("wheel", {
      deltaY: delta,
      deltaMode: 0,
      bubbles: true,
      cancelable: true,
    });
    slider.dispatchEvent(event);
    return event.defaultPrevented;
  }, notches * 100);
}

/** Which row carries the cursor, by its 1-based position. */
function activeRow() {
  return browser.execute(
    () => document.querySelector(".cuelist__row--active .cuelist__pos")?.textContent ?? null,
  );
}

/** Click the row at a 1-based list position, the way a person moves the cursor. */
async function clickRow(toplevel, position) {
  const centre = await browser.execute((wanted) => {
    const rows = Array.from(document.querySelectorAll(".cuelist__row"));
    const row = rows.find(
      (candidate) => candidate.querySelector(".cuelist__pos")?.textContent === wanted,
    );
    const cell = row?.querySelector(".cuelist__pos");
    if (!cell) {
      return null;
    }
    const rect = cell.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    return { x: (rect.x + rect.width / 2) * dpr, y: (rect.y + rect.height / 2) * dpr };
  }, String(position));
  if (centre === null) {
    throw new Error(`row ${position} is not rendered`);
  }
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

/** Whether a Video menu item is drawn, greyed, and what key it draws. */
async function videoItem(toplevel, token) {
  await clickElement(toplevel, ".menubar__title--video");
  await waitFor(() => present(`.menubar__item--${token}`), {
    timeout: 15000,
    message: `the Video menu to open on ${token}`,
  });
  const state = await browser.execute((css) => {
    const item = document.querySelector(css);
    return item === null
      ? null
      : {
          disabled: item.disabled === true,
          key: item.querySelector(".menubar__accelerator")?.textContent ?? null,
        };
  }, `.menubar__item--${token}`);
  pressKey("Escape");
  await waitFor(async () => ((await present(`.menubar__item--${token}`)) ? null : 1), {
    timeout: 15000,
    message: "the Video menu to close",
  });
  return state;
}

describe("stepping the picture and walking a line's edges", () => {
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

  it("greys the four with nothing open, and draws the keys beside them", async () => {
    expect(await videoItem(toplevel, "video-step-prev-frame")).toEqual({
      disabled: true,
      key: "Left",
    });
    expect(await videoItem(toplevel, "video-step-next-frame")).toEqual({
      disabled: true,
      key: "Right",
    });
    expect(await videoItem(toplevel, "video-prev-boundary")).toEqual({
      disabled: true,
      key: "Ctrl+Left",
    });
    expect(await videoItem(toplevel, "video-next-boundary")).toEqual({
      disabled: true,
      key: "Ctrl+Right",
    });

    // And the wheel over the slider is the same command by another gesture, so with no picture it
    // moves nothing either. The slider is greyed and its value is where an empty transport sits.
    expect(
      await browser.execute(() => document.querySelector(".controls__slider")?.disabled === true),
    ).toBe(true);
    await wheelOverSlider(3);
    expect(await playhead()).toBe(0);
  });

  it("steps one frame forward and one back, on a picture that is standing still", async () => {
    await clickElement(toplevel, ".toolbar__file-open-subtitle");
    const chooser = await waitForChooser("Choose a subtitle");
    await answerChooser(chooser, copy, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(
      async () => ((await textOf(".statusbar__document"))?.includes("3 cues") === true ? 1 : null),
      { timeout: 20000, message: "the fixture to open" },
    );

    await runFromMenu((css) => clickElement(toplevel, css), "video", "video-open");
    const video = await waitForChooser("Choose a video");
    await answerChooser(video, requireVideoFixture(), "video");
    focusWindow(toplevel.id);
    await waitFor(
      () =>
        browser.execute(
          () =>
            document.querySelector(".stage__empty") === null &&
            document.querySelector(".controls__button")?.disabled === false,
        ),
      { timeout: 30000, message: "the video fixture to reach the ready state" },
    );
    // The document opened before the picture, so the cursor landed while there was nothing to
    // follow and the playhead is still at the start of the media.
    expect(await playhead()).toBe(0);

    // The keys belong to the grid's context in the reference, so the grid is where they are pressed
    // from. The second row is chosen and not the first: stepping backwards asks mpv to decode the
    // frame before this one, and at the very start of a file there is not always one to decode.
    focusWindow(toplevel.id);
    await clickRow(toplevel, 2);
    const from = await playheadSettles(SECOND_START);

    pressKey("Right");
    await waitFor(async () => ((await playhead()) > from + FRAME / 2 ? 1 : null), {
      timeout: 20000,
      message: "the picture to step forward one frame",
    });
    expect(await playhead()).toBeLessThan(from + FRAME * 2);

    pressKey("Left");
    await waitFor(async () => ((await playhead()) < from + FRAME / 2 ? 1 : null), {
      timeout: 20000,
      message: "the picture to step back again",
    });
  });

  it("steps a frame for every notch of the wheel over the slider", async () => {
    await clickRow(toplevel, 2);
    const from = await playheadSettles(SECOND_START);

    // Down is forward: it is the direction this window already moves under a wheel, where the
    // waveform scrolls on and the grid walks down the file (interface-spec 6.1, N133).
    expect(await wheelOverSlider(1)).toBe(true);
    await waitFor(async () => ((await playhead()) > from + FRAME / 2 ? 1 : null), {
      timeout: 20000,
      message: "the picture to step forward one frame under the wheel",
    });
    expect(await playhead()).toBeLessThan(from + FRAME * 2);

    await wheelOverSlider(-1);
    await waitFor(async () => ((await playhead()) < from + FRAME / 2 ? 1 : null), {
      timeout: 20000,
      message: "the picture to step back again",
    });
    const back = await playheadSettles();

    // Three notches are three frames and not one: the count is the gesture's, not a flag.
    await wheelOverSlider(3);
    await waitFor(async () => ((await playhead()) > back + FRAME * 2.5 ? 1 : null), {
      timeout: 20000,
      message: "the picture to step three frames under three notches",
    });
    expect(await playhead()).toBeLessThan(back + FRAME * 4);

    await wheelOverSlider(-3);
    await waitFor(async () => ((await playhead()) < back + FRAME / 2 ? 1 : null), {
      timeout: 20000,
      message: "the picture to come back to where it started",
    });
  });

  it("steps once, not twice, when the numpad sends the same arrow", async () => {
    // Measured on 2026-09-10: with NumLock off the numpad's 4 arrives as `code` "Numpad4" with a
    // `key` of "ArrowLeft", so an accelerator matched on `key` answers both keys (N107).
    const from = await playheadSettles();
    pressKey("KP_Left");
    pressKey("Left");
    // Read once the picture has stopped moving, not at the first sign of movement: a wait that
    // returns on "it went back a bit" is satisfied by the first of two steps and would pass with
    // the defect in place, which is how the first version of this check passed.
    const landed = await playheadSettles();
    // One frame back and no more. Two is the numpad press stepping as well. The real Left is the
    // positive control inside the same assertion, so a playhead that never moved fails here too.
    expect(landed).toBeLessThan(from - FRAME / 2);
    expect(landed).toBeGreaterThan(from - FRAME * 1.5);

    // The numpad's 4 is the start nudge now, so this check edits the document on its way past.
    // Put it back: the checks after this one read the fixture's own boundaries, and one undo
    // spending the whole history is what says the edit was the only one.
    await runFromMenu((css) => clickElement(toplevel, css), "edit", "edit-undo");
    // Waited on the unsaved marker rather than on Undo's greying: this is inside a wait, and asking
    // the menu would open and close it on every turn of the loop. The marker clears exactly when
    // the document is back where it was opened, which is the same sentence (N121).
    await waitFor(
      () =>
        browser.execute(() => (document.querySelector(".statusbar__dirty") === null ? 1 : null)),
      { timeout: 20000, message: "the one nudge to be undone, clearing the unsaved marker" },
    );
  });

  it("steps a frame on the numpad's own chord, which the arrows no longer answer", async () => {
    const from = await playheadSettles();
    // `ctrl+KP_Left` is `Ctrl+Num 4`, the reference's own frame step. Its `key` is "ArrowLeft", so
    // before the arrows moved to `code` this chord was `Ctrl+Left`, the boundary walk (N109).
    pressKey("ctrl+KP_Left");
    const landed = await playheadSettles();
    expect(landed).toBeLessThan(from - FRAME / 2);
    expect(landed).toBeGreaterThan(from - FRAME * 1.5);

    pressKey("ctrl+KP_Right");
    const back = await playheadSettles();
    expect(back).toBeGreaterThan(landed + FRAME / 2);
  });

  it("leaves a picture that is playing where it is going", async () => {
    await clickElement(toplevel, ".controls__button");
    await waitFor(async () => ((await textOf(".controls__button")) === "Pause" ? 1 : null), {
      timeout: 20000,
      message: "the picture to start playing",
    });

    // mpv's own frame step pauses what it steps, so the guard against stepping a running picture is
    // what keeps this key from stopping playback under a translator's hand.
    pressKey("Right");
    pressKey("Left");
    expect(await textOf(".controls__button")).toBe("Pause");

    await clickElement(toplevel, ".controls__button");
    await waitFor(async () => ((await textOf(".controls__button")) === "Play" ? 1 : null), {
      timeout: 20000,
      message: "the picture to stop again",
    });
  });

  it("walks the current line's own edges, then moves the cursor to the next line", async () => {
    // The cursor is on the second row from the step check, so this reaches the first one by moving.
    await clickRow(toplevel, 1);
    await playheadReaches(FIRST_START, "the first line's start, which the follow takes it to");

    // Forward from the start: the line's own end is the next edge ahead.
    pressKey("ctrl+Right");
    await playheadReaches(FIRST_END, "the first line's end");
    expect(await activeRow()).toBe("1");

    // Past both of the first line's edges, so the walk moves the cursor and takes the next start.
    pressKey("ctrl+Right");
    await playheadReaches(SECOND_START, "the second line's start");
    expect(await activeRow()).toBe("2");

    // And back the same way: the second line's own start is behind the playhead by nothing, so the
    // walk steps to the line before it and lands on that one's end.
    pressKey("ctrl+Left");
    await playheadReaches(FIRST_END, "the first line's end again");
    expect(await activeRow()).toBe("1");
  });

  it("jumps ten frames either way, and Alt held with an arrow opens no menu", async () => {
    // Back on a still picture, and settled, so the ten frames can be counted off a fixed reading.
    const from = await playheadSettles();

    pressKey("alt+Right");
    await waitFor(async () => ((await playhead()) > from + FRAME * 5 ? 1 : null), {
      timeout: 20000,
      message: "the picture to jump forward ten frames",
    });
    // Ten and not eleven: a jump that overshot would be a different command.
    expect(await playhead()).toBeLessThan(from + FRAME * 15);
    // The chord holds Alt, and the bar must not have opened under it.
    expect(await present(".menubar__menu")).toBe(false);

    pressKey("alt+Left");
    await waitFor(async () => ((await playhead()) < from + FRAME * 5 ? 1 : null), {
      timeout: 20000,
      message: "the picture to jump back again",
    });
    expect(await present(".menubar__menu")).toBe(false);

    // And Alt on its own still opens the bar, which is the other half of the same rule.
    pressKey("alt");
    await waitFor(() => present(".menubar__menu"), {
      timeout: 15000,
      message: "the bar to open on Alt let go by itself",
    });
    pressKey("Escape");
    await waitFor(async () => ((await present(".menubar__menu")) ? null : 1), {
      timeout: 15000,
      message: "the bar to close again",
    });
  });

  it("leaves the arrows to the box the caret is in", async () => {
    const before = await playheadSettles();
    await clickElement(toplevel, ".currentline__text");
    typeText("Some words to move a caret through");

    // Both the bare arrows and the chorded ones: in a text box every one of them is the caret's.
    // One at a time, because a pair that moved the picture and moved it back would leave it where
    // it started and say nothing.
    for (const key of ["Left", "ctrl+Left", "Right", "ctrl+Right"]) {
      pressKey(key);
      // A character after the arrow, waited for: keys arrive in the order they were sent, so the
      // box holding this one is the app saying it has dealt with the arrow before it.
      typeText("|");
      await waitFor(
        async () =>
          (
            await browser.execute(() => document.querySelector(".currentline__text")?.value ?? null)
          )?.includes("|") === true
            ? 1
            : null,
        { timeout: 15000, message: `the box to take a character after ${key}` },
      );
      expect(await playhead()).toBe(before);
      pressKey("BackSpace");
    }

    // And the box still holds what was typed, so the keys did reach it.
    expect(
      await browser.execute(() => document.querySelector(".currentline__text")?.value ?? null),
    ).toContain("Some words to move a caret through");
  });

  it("drops the part of a notch it had left when the next picture opens", async () => {
    // The follow is off for the whole check: it would take the picture to the cursor's line as the
    // second media opens, and this needs the playhead to be where the media starts (N143).
    await stopFollowingTheCursor((css) => clickElement(toplevel, css));
    const from = await playheadSettles();

    // Half a notch is half a frame: nothing moves, and the half is kept for the gesture after it
    // (N133). What is under test is what becomes of that half when the picture changes.
    expect(await wheelOverSlider(0.5)).toBe(true);
    expect(await playheadSettles()).toBe(from);

    await runFromMenu((css) => clickElement(toplevel, css), "video", "video-close");
    await waitFor(
      () => browser.execute(() => (document.querySelector(".stage__empty") === null ? null : 1)),
      { timeout: 20000, message: "the picture to close" },
    );
    await runFromMenu((css) => clickElement(toplevel, css), "video", "video-open");
    const again = await waitForChooser("Choose a video");
    await answerChooser(again, requireVideoFixture(), "video");
    focusWindow(toplevel.id);
    await waitFor(
      () =>
        browser.execute(
          () =>
            document.querySelector(".stage__empty") === null &&
            document.querySelector(".controls__button")?.disabled === false,
        ),
      { timeout: 30000, message: "the video fixture to reach the ready state a second time" },
    );
    const start = await playheadSettles(0);

    // Half a notch and then three: with the half from the last picture dropped that is three
    // frames, because the new half is still half. Carried over it would be four, the first half
    // completing the old one before the three arrived.
    expect(await wheelOverSlider(0.5)).toBe(true);
    await wheelOverSlider(3);
    await waitFor(async () => ((await playhead()) > start + FRAME * 2.5 ? 1 : null), {
      timeout: 20000,
      message: "the picture to step three frames under three notches and a half",
    });
    expect(await playheadSettles()).toBeLessThan(start + FRAME * 3.5);
  });
});
