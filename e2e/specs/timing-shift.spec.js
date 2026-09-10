/* global describe, it, before, document, window */
/**
 * Shift times: the amount, the direction, which lines and which of their two times.
 *
 * The four scopes are what this is for. A shift that moved every line when it was asked for the
 * selection would be found by nothing else, because the times it wrote would be right for the lines
 * it was allowed to touch and wrong only for the ones it was not.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { runFromMenu } from "../lib/menu.js";
import { clickAt, focusWindow, pressKey, typeText } from "../lib/input.js";
import { repoRoot, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

/** Three cues, far enough apart that a shift of one second cannot be confused with a rounding. */
const FIXTURE = ["srt", "clean", "basic-lf.srt"];
const OPENED = [
  { start: "00:00:02.120", end: "00:00:04.880" },
  { start: "00:00:05.000", end: "00:00:08.340" },
  { start: "00:00:09.100", end: "00:00:11.760" },
];
const ONE_SECOND = "00:00:01.000";

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
  const directory = path.join(dataHome(), "timing-shift");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const copy = path.join(directory, "basic-lf.srt");
  copyFileSync(from, copy);
  return copy;
}

/** A grid timecode into milliseconds, and back. */
function asMillis(spelled) {
  const [hours, minutes, rest] = spelled.split(":");
  const [seconds, millis] = rest.split(".");
  return (
    Number(hours) * 3_600_000 + Number(minutes) * 60_000 + Number(seconds) * 1000 + Number(millis)
  );
}

function timecode(millis) {
  const pad = (value, width) => String(value).padStart(width, "0");
  return (
    `${pad(Math.floor(millis / 3_600_000), 2)}:` +
    `${pad(Math.floor(millis / 60_000) % 60, 2)}:` +
    `${pad(Math.floor(millis / 1000) % 60, 2)}.${pad(millis % 1000, 3)}`
  );
}

/** What the grid should read after moving the named rows by `millis`. */
function moved(rows, millis, which = "both") {
  return OPENED.map((row, index) => ({
    start:
      rows.includes(index) && which !== "end"
        ? timecode(Math.max(0, asMillis(row.start) + millis))
        : row.start,
    end:
      rows.includes(index) && which !== "start"
        ? timecode(Math.max(0, asMillis(row.end) + millis))
        : row.end,
  }));
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

/** Open the form, fill the amount, pick the options given, and shift. */
async function shift(toplevel, { amount = ONE_SECOND, direction, affect, times } = {}) {
  pressKey("ctrl+i");
  await waitFor(() => present(".shifttimes__panel"), {
    timeout: 15000,
    message: "the shift form to open",
  });
  await clickElement(toplevel, ".shifttimes__amount");
  pressKey("ctrl+a");
  typeText(amount);
  await waitFor(
    async () =>
      (await browser.execute(
        () => document.querySelector(".shifttimes__amount")?.value ?? null,
      )) === amount
        ? 1
        : null,
    { timeout: 15000, message: `the amount field to hold exactly ${amount}` },
  );
  for (const [name, value] of [
    ["direction", direction],
    ["affect", affect],
    ["times", times],
  ]) {
    if (value !== undefined) {
      await clickElement(toplevel, `.shifttimes__${name}-${value} input`);
    }
  }
  await clickElement(toplevel, ".shifttimes__go");
  await waitFor(async () => ((await present(".shifttimes__panel")) ? null : 1), {
    timeout: 15000,
    message: "the shift form to close",
  });
}

/** Undo, and wait for the grid to be the file as it was opened. */
async function undoToOpened(toplevel) {
  await runFromMenu((css) => clickElement(toplevel, css), "edit", "edit-undo");
  await waitFor(
    async () => (JSON.stringify(await gridTimes()) === JSON.stringify(OPENED) ? 1 : null),
    { timeout: 20000, message: "one undo to put every line back" },
  );
}

describe("shifting the times", () => {
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

    await clickElement(toplevel, ".toolbar__file-open-subtitle");
    const chooser = await waitForChooser("Choose a subtitle");
    await answerChooser(chooser, copy, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(
      async () => ((await textOf(".statusbar__document"))?.includes("3 cues") === true ? 1 : null),
      { timeout: 20000, message: "the fixture to open" },
    );
  });

  it("opens on Ctrl+I with the reference's own defaults, and closes on Escape", async () => {
    pressKey("ctrl+i");
    await waitFor(() => present(".shifttimes__panel"), {
      timeout: 15000,
      message: "the shift form to open on the key the menu draws",
    });

    // Backward, all lines, start and end: what the reference ships pre-selected.
    const picked = await browser.execute(() =>
      Array.from(document.querySelectorAll(".shifttimes__choice"))
        .filter((choice) => choice.querySelector("input")?.checked === true)
        .map((choice) => choice.className.replace("shifttimes__choice ", "")),
    );
    expect(picked).toEqual([
      "shifttimes__direction-backward",
      "shifttimes__affect-all",
      "shifttimes__times-both",
    ]);

    pressKey("Escape");
    await waitFor(async () => ((await present(".shifttimes__panel")) ? null : 1), {
      timeout: 15000,
      message: "the form to close on Escape",
    });
    expect(await gridTimes()).toEqual(OPENED);
  });

  it("moves every line forward by the amount, and one undo takes them all back", async () => {
    await shift(toplevel, { direction: "forward" });
    await waitFor(
      async () =>
        JSON.stringify(await gridTimes()) === JSON.stringify(moved([0, 1, 2], 1000)) ? 1 : null,
      { timeout: 20000, message: "every line to move forward one second" },
    );
    // A command is not a save.
    expect(readFileSync(copy).equals(openedBytes)).toBe(true);
    await undoToOpened(toplevel);
  });

  it("moves only the selected line when it is asked for the selection", async () => {
    await clickRow(toplevel, 2);
    await waitFor(async () => ((await selectedCount()) === 1 ? 1 : null), {
      timeout: 15000,
      message: "the second row alone to be selected",
    });

    await shift(toplevel, { direction: "forward", affect: "selected" });
    await waitFor(
      async () =>
        JSON.stringify(await gridTimes()) === JSON.stringify(moved([1], 1000)) ? 1 : null,
      { timeout: 20000, message: "only the second line to move" },
    );
    await undoToOpened(toplevel);
  });

  it("moves the selection and everything after it when it is asked for the run onward", async () => {
    await shift(toplevel, { direction: "forward", affect: "onward" });
    await waitFor(
      async () =>
        JSON.stringify(await gridTimes()) === JSON.stringify(moved([1, 2], 1000)) ? 1 : null,
      { timeout: 20000, message: "the second line and the one after it to move" },
    );
    await undoToOpened(toplevel);
  });

  it("moves one of the two times when it is asked for one, and backward takes time off", async () => {
    // Backward on the ends alone: the lines get shorter and no start moves.
    await shift(toplevel, { direction: "backward", affect: "all", times: "end" });
    await waitFor(
      async () =>
        JSON.stringify(await gridTimes()) === JSON.stringify(moved([0, 1, 2], -1000, "end"))
          ? 1
          : null,
      {
        timeout: 20000,
        message: "every end to come back one second, with the starts where they were",
      },
    );
    await undoToOpened(toplevel);
  });

  it("stops at the start of the media rather than going behind it", async () => {
    // Three seconds back takes the first line's start below zero and nothing else: exactly one
    // timestamp clamps, so the clamp is what this reads and not a whole file of zeroes.
    await shift(toplevel, { amount: "00:00:03.000", direction: "backward", affect: "all" });
    const expected = moved([0, 1, 2], -3000);
    expect(expected[0].start).toBe("00:00:00.000");
    await waitFor(
      async () => (JSON.stringify(await gridTimes()) === JSON.stringify(expected) ? 1 : null),
      { timeout: 20000, message: "the first line to stop at zero and the rest to move" },
    );
    await undoToOpened(toplevel);

    // Far enough back that both times of every line would go behind zero: each one stops there
    // instead, which is the other half of the same rule.
    await shift(toplevel, { amount: "00:00:20.000", direction: "backward", affect: "all" });
    await waitFor(
      async () =>
        (await gridTimes()).every(
          (row) => row.start === "00:00:00.000" && row.end === "00:00:00.000",
        )
          ? 1
          : null,
      { timeout: 20000, message: "every time to stop at the start of the media" },
    );
    await undoToOpened(toplevel);
  });

  it("refuses an amount that is not a time, and shifts nothing", async () => {
    pressKey("ctrl+i");
    await waitFor(() => present(".shifttimes__panel"), {
      timeout: 15000,
      message: "the shift form to open again",
    });
    await clickElement(toplevel, ".shifttimes__amount");
    pressKey("ctrl+a");
    typeText("a while");
    await clickElement(toplevel, ".shifttimes__go");

    await waitFor(() => present(".shifttimes__refusal"), {
      timeout: 15000,
      message: "the form to say that is not an amount",
    });
    // Still open, and the file is untouched: a refusal is not a shift of zero.
    expect(await present(".shifttimes__panel")).toBe(true);
    expect(await gridTimes()).toEqual(OPENED);

    pressKey("Escape");
    await waitFor(async () => ((await present(".shifttimes__panel")) ? null : 1), {
      timeout: 15000,
      message: "the form to close",
    });
  });
});
