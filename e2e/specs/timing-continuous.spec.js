/* global describe, it, before, document, window, Event */
/**
 * The three timing commands that move more than one line: shift the selection to the playhead, and
 * make the times continuous by changing either the starts or the ends.
 *
 * All three are one undo step whatever the count, which is the thing worth checking: a translator
 * who shifts forty lines and changes their mind presses undo once, not forty times. The times are
 * read off the grid, which is where the translator reads them too.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow, pressKey } from "../lib/input.js";
import { repoRoot, requireVideoFixture, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

/** Three cues with a gap between each pair, which is what closing the gaps has to close. */
const FIXTURE = ["srt", "clean", "basic-lf.srt"];
const OPENED = [
  { start: "00:00:02.120", end: "00:00:04.880" },
  { start: "00:00:05.000", end: "00:00:08.340" },
  { start: "00:00:09.100", end: "00:00:11.760" },
];
/** Where the picture is put before the shift. Where it lands is read, not assumed: a seek stops on
 * a frame, which is near the second it was given and not on it. */
const PLAYHEAD_SECONDS = 10;

/** The same spelling the grid uses, so the two can be compared as strings. */
function timecode(millis) {
  const pad = (value, width) => String(value).padStart(width, "0");
  return (
    `${pad(Math.floor(millis / 3_600_000), 2)}:` +
    `${pad(Math.floor(millis / 60_000) % 60, 2)}:` +
    `${pad(Math.floor(millis / 1000) % 60, 2)}.${pad(millis % 1000, 3)}`
  );
}

/** Every opened time moved by the same number of milliseconds. */
function shiftedBy(millis) {
  return OPENED.map((row) => ({
    start: timecode(asMillis(row.start) + millis),
    end: timecode(asMillis(row.end) + millis),
  }));
}

/** A grid timecode back into milliseconds. */
function asMillis(spelled) {
  const [hours, minutes, rest] = spelled.split(":");
  const [seconds, millis] = rest.split(".");
  return (
    Number(hours) * 3_600_000 + Number(minutes) * 60_000 + Number(seconds) * 1000 + Number(millis)
  );
}

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
  const directory = path.join(dataHome(), "timing-continuous");
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

/** Every row's two times, as the grid draws them. */
function gridTimes() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".cuelist__row")).map((row) => ({
      start: row.querySelector(".cuelist__start")?.textContent ?? null,
      end: row.querySelector(".cuelist__end")?.textContent ?? null,
    })),
  );
}

function selectedCount() {
  return browser.execute(() => document.querySelectorAll(".cuelist__row--selected").length);
}

/** Click the row at a 1-based list position. */
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

/** Open the Timing menu and choose one of its items by command token. */
async function fromTimingMenu(toplevel, token) {
  await clickElement(toplevel, ".menubar__title--timing");
  await waitFor(() => present(`.menubar__item--${token}`), {
    timeout: 15000,
    message: `the Timing menu to open on ${token}`,
  });
  await clickElement(toplevel, `.menubar__item--${token}`);
}

/** Whether a Timing item is drawn and greyed, without choosing it. */
async function timingItem(toplevel, token) {
  await clickElement(toplevel, ".menubar__title--timing");
  await waitFor(() => present(`.menubar__item--${token}`), {
    timeout: 15000,
    message: `the Timing menu to open on ${token}`,
  });
  const state = await browser.execute((css) => {
    const item = document.querySelector(css);
    return item === null ? null : { drawn: true, disabled: item.disabled === true };
  }, `.menubar__item--${token}`);
  pressKey("Escape");
  await waitFor(async () => ((await present(`.menubar__item--${token}`)) ? null : 1), {
    timeout: 15000,
    message: "the Timing menu to close",
  });
  return state;
}

/** Put the playhead somewhere, the way the transport's own slider does. */
async function seekTo(seconds) {
  await browser.execute((target) => {
    const slider = document.querySelector(".controls__slider");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(slider, String(target));
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
  }, seconds);
  await browser.pause(300);
}

/** Where the playhead is once it has stopped moving there, in seconds. */
async function settledPlayhead() {
  const read = () =>
    browser.execute(() => Number(document.querySelector(".controls__slider")?.value ?? -1));
  let last = await read();
  for (let tries = 0; tries < 30; tries += 1) {
    await browser.pause(300);
    const now = await read();
    if (now === last) {
      return now;
    }
    last = now;
  }
  throw new Error(`the playhead never stopped moving; it last read ${last}`);
}

/** Undo, and wait for the grid to be the file as it was opened. */
async function undoToOpened(toplevel) {
  await clickElement(toplevel, ".toolbar__edit-undo");
  await waitFor(
    async () => (JSON.stringify(await gridTimes()) === JSON.stringify(OPENED) ? 1 : null),
    { timeout: 20000, message: "one undo to put every line back" },
  );
}

describe("timing over more than one line", () => {
  let toplevel = null;
  let copy = null;
  let openedBytes = null;

  before(async () => {
    copy = workingCopy();
    openedBytes = readFileSync(copy);
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

  it("greys the shift until there is a picture, and the other two until there is a document", async () => {
    expect(await timingItem(toplevel, "time-shift-to-playhead")).toEqual({
      drawn: true,
      disabled: true,
    });
    expect(await timingItem(toplevel, "time-continuous-start")).toEqual({
      drawn: true,
      disabled: true,
    });
    expect(await timingItem(toplevel, "time-continuous-end")).toEqual({
      drawn: true,
      disabled: true,
    });

    await clickElement(toplevel, ".toolbar__file-open-subtitle");
    const chooser = await waitForChooser("Choose a subtitle");
    await answerChooser(chooser, copy, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(
      async () => ((await textOf(".statusbar__document"))?.includes("3 cues") === true ? 1 : null),
      { timeout: 20000, message: "the fixture to open" },
    );
    expect(await gridTimes()).toEqual(OPENED);

    // A document is enough for the two that only need lines; the shift still needs a picture.
    expect(await timingItem(toplevel, "time-continuous-start")).toEqual({
      drawn: true,
      disabled: false,
    });
    expect(await timingItem(toplevel, "time-shift-to-playhead")).toEqual({
      drawn: true,
      disabled: true,
    });
  });

  it("closes every gap by moving the starts, and one undo opens them again", async () => {
    pressKey("ctrl+a");
    await waitFor(async () => ((await selectedCount()) === 3 ? 1 : null), {
      timeout: 15000,
      message: "every row to be selected",
    });

    await fromTimingMenu(toplevel, "time-continuous-start");
    await waitFor(
      async () => {
        const rows = await gridTimes();
        return rows[1]?.start === OPENED[0].end && rows[2]?.start === OPENED[1].end ? 1 : null;
      },
      { timeout: 20000, message: "each line to start where the one before it ended" },
    );
    const rows = await gridTimes();
    // The first line has nothing before it, so it is the one that does not move.
    expect(rows[0]).toEqual(OPENED[0]);
    // The ends are untouched: this command moves starts.
    expect(rows.map((row) => row.end)).toEqual(OPENED.map((row) => row.end));
    // A command is not a save.
    expect(readFileSync(copy).equals(openedBytes)).toBe(true);

    await undoToOpened(toplevel);
  });

  it("closes every gap by moving the ends, and one undo opens them again", async () => {
    await fromTimingMenu(toplevel, "time-continuous-end");
    await waitFor(
      async () => {
        const rows = await gridTimes();
        return rows[0]?.end === OPENED[1].start && rows[1]?.end === OPENED[2].start ? 1 : null;
      },
      { timeout: 20000, message: "each line to end where the one after it starts" },
    );
    const rows = await gridTimes();
    // The last line has nothing after it, so it is the one that does not move.
    expect(rows[2]).toEqual(OPENED[2]);
    expect(rows.map((row) => row.start)).toEqual(OPENED.map((row) => row.start));

    await undoToOpened(toplevel);
  });

  it("joins a single selected line to the neighbour outside the selection", async () => {
    await clickRow(toplevel, 2);
    await waitFor(async () => ((await selectedCount()) === 1 ? 1 : null), {
      timeout: 15000,
      message: "the second row alone to be selected",
    });

    await fromTimingMenu(toplevel, "time-continuous-start");
    await waitFor(async () => ((await gridTimes())[1]?.start === OPENED[0].end ? 1 : null), {
      timeout: 20000,
      message: "the second line to start where the first one ended",
    });
    // Only that one moved: a single line acts as if its neighbour were selected, not the file.
    const rows = await gridTimes();
    expect(rows[0]).toEqual(OPENED[0]);
    expect(rows[2]).toEqual(OPENED[2]);

    await undoToOpened(toplevel);
  });

  it("greys the two continuous items for a selection with a hole in it", async () => {
    await clickRow(toplevel, 1);
    await waitFor(async () => ((await selectedCount()) === 1 ? 1 : null), {
      timeout: 15000,
      message: "the first row alone to be selected",
    });

    // The cursor walks to the third row without taking the selection with it, then adds that row:
    // one and three selected, two not, which is a selection with nothing to join across.
    pressKey("ctrl+Down");
    pressKey("ctrl+Down");
    pressKey("ctrl+space");
    await waitFor(async () => ((await selectedCount()) === 2 ? 1 : null), {
      timeout: 15000,
      message: "the first and third rows to be selected",
    });

    expect(await timingItem(toplevel, "time-continuous-start")).toEqual({
      drawn: true,
      disabled: true,
    });
    expect(await timingItem(toplevel, "time-continuous-end")).toEqual({
      drawn: true,
      disabled: true,
    });
  });

  it("shifts every selected line to the playhead, keeping the gaps between them", async () => {
    await clickElement(toplevel, ".toolbar__video-open");
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

    // The cursor on the first line, then every line selected: the cursor's line is the one that
    // lands on the playhead and the rest follow it.
    // The cursor lands first and the follow takes the picture to that line's start; only then is
    // the picture moved. A seek sent while the follow is still on its way is the one that is lost.
    await clickRow(toplevel, 1);
    await waitFor(
      async () =>
        (await browser.execute(
          () => document.querySelector(".cuelist__row--active .cuelist__pos")?.textContent ?? null,
        )) === "1"
          ? 1
          : null,
      { timeout: 15000, message: "the cursor to reach the first row" },
    );
    await settledPlayhead();
    await seekTo(PLAYHEAD_SECONDS);
    pressKey("ctrl+a");
    await waitFor(async () => ((await selectedCount()) === 3 ? 1 : null), {
      timeout: 15000,
      message: "every row to be selected",
    });
    expect(await timingItem(toplevel, "time-shift-to-playhead")).toEqual({
      drawn: true,
      disabled: false,
    });

    // Read off the transport rather than assumed: the shift is by the difference between where the
    // picture really is and where the cursor's line starts.
    const at = Math.round((await settledPlayhead()) * 1000);
    const shifted = shiftedBy(at - asMillis(OPENED[0].start));
    expect(shifted[0].start).toBe(timecode(at));

    await fromTimingMenu(toplevel, "time-shift-to-playhead");
    await waitFor(
      async () => (JSON.stringify(await gridTimes()) === JSON.stringify(shifted) ? 1 : null),
      { timeout: 20000, message: `every line to move to ${JSON.stringify(shifted)}` },
    );
    expect(readFileSync(copy).equals(openedBytes)).toBe(true);

    await undoToOpened(toplevel);
  });
});
