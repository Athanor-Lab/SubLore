/* global describe, it, before, document, window */
/**
 * The four ways of asking for a new cue, which the interface keeps in a list of their own: before
 * the current line or after it, timed from the line beside it or from where the picture is.
 *
 * What is checked is the times each one chooses, because that is the whole difference between them
 * and it is what a translator sees. The one timed from the line takes the room there is and never
 * runs over what is already written; the one timed from the playhead takes the length it is given,
 * because the hand that put the playhead there has already said where the line goes.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow, pressKey } from "../lib/input.js";
import { intoList, runFromMenu } from "../lib/menu.js";
import { repoRoot, requireVideoFixture, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { seekTo, settledPlayhead } from "../lib/transport.js";
import { findToplevel } from "../lib/x11.js";

/** Three cues with a small gap after the first and a wide one after the second. */
const FIXTURE = ["srt", "clean", "basic-lf.srt"];
const FIRST = "The harbour was empty when we got there.";
const SECOND =
  "Nobody had told the crew we were coming,\nso we sat on the dock until it got light.";
const THIRD = "By then the fog had eaten the boats.";
/** How long a new cue runs where nothing is in its way: the preferences default (9.6). */
const NEW_CUE_MS = 3000;
/** Inside the second cue, so a line timed from here overlaps what is already written. */
const PLAYHEAD_SECONDS = 6;

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
    throw new Error(
      `E2E prerequisite missing: ${from} does not exist. It is committed; restore it with ` +
        "`git checkout fixtures/subtitles`.",
    );
  }
  const directory = path.join(dataHome(), "cue-insert");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const copy = path.join(directory, "basic-lf.srt");
  copyFileSync(from, copy);
  return copy;
}

/** The same spelling the grid uses, so the two can be compared as strings. */
function timecode(millis) {
  const pad = (value, width) => String(value).padStart(width, "0");
  return (
    `${pad(Math.floor(millis / 3_600_000), 2)}:` +
    `${pad(Math.floor(millis / 60_000) % 60, 2)}:` +
    `${pad(Math.floor(millis / 1000) % 60, 2)}.${pad(millis % 1000, 3)}`
  );
}

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

function gridRows() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".cuelist__row")).map((row) => {
      const read = (css) => row.querySelector(css)?.textContent ?? null;
      return {
        text: read(".cuelist__text"),
        start: read(".cuelist__start"),
        end: read(".cuelist__end"),
        cursor: row.classList.contains("cuelist__row--active"),
        selected: row.getAttribute("aria-selected") === "true",
      };
    }),
  );
}

function waitForTexts(expected, what) {
  return waitFor(
    async () => {
      const rows = await gridRows();
      const same =
        rows.length === expected.length && rows.every((row, at) => row.text === expected[at]);
      return same ? rows : null;
    },
    { timeout: 20000, message: `the grid to hold ${what}` },
  );
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

/** Put the cursor on a row by clicking its number cell, which selects without opening an editor. */
async function cursorTo(toplevel, position) {
  const centre = await browser.execute((wanted) => {
    const row = Array.from(document.querySelectorAll(".cuelist__row")).find(
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

/** Open the Subtitles menu and the list the four sit in. */
async function openInsertList(toplevel, token) {
  await clickElement(toplevel, ".menubar__title--subtitle");
  await waitFor(() => present(".menubar__menu"), {
    timeout: 15000,
    message: "the Subtitles menu to open",
  });
  await intoList((css) => clickElement(toplevel, css), token);
  await waitFor(() => present(`.menubar__item--${token}`), {
    timeout: 15000,
    message: `the list to open on ${token}`,
  });
}

async function runInsert(toplevel, token) {
  await openInsertList(toplevel, token);
  await clickElement(toplevel, `.menubar__item--${token}`);
}

/** Escape gives back one level at a time, so a list inside a menu takes two of them. */
async function closeMenus() {
  await waitFor(
    async () => {
      if (!(await present(".menubar__menu"))) {
        return 1;
      }
      pressKey("Escape");
      return null;
    },
    { timeout: 15000, message: "every open menu to close" },
  );
}

/** Drive the transport's own slider, which is the only seek a spec can make without a hand. */

describe("the four ways of asking for a cue", () => {
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
    await clickElement(toplevel, ".toolbar__file-open-subtitle");
    const chooser = await waitForChooser("Choose a subtitle");
    await answerChooser(chooser, copy, "subtitle");
    focusWindow(toplevel.id);
    await waitForTexts([FIRST, SECOND, THIRD], "the fixture");
  });

  it("keeps all four in a list of their own, with the two greyed that have no picture", async () => {
    await openInsertList(toplevel, "subtitle-insert-after");

    const drawn = await browser.execute(() =>
      [
        "subtitle-insert-before",
        "subtitle-insert-after",
        "subtitle-insert-before-at-playhead",
        "subtitle-insert-after-at-playhead",
      ].map((token) => {
        const item = document.querySelector(`.menubar__item--${token}`);
        return { token, drawn: item !== null, disabled: item?.disabled === true };
      }),
    );
    // The two timed from the picture are drawn with no picture open, and greyed: a command that
    // exists is drawn (CLAUDE.md, owner ruling 2026-09-03).
    expect(drawn).toEqual([
      { token: "subtitle-insert-before", drawn: true, disabled: false },
      { token: "subtitle-insert-after", drawn: true, disabled: false },
      { token: "subtitle-insert-before-at-playhead", drawn: true, disabled: true },
      { token: "subtitle-insert-after-at-playhead", drawn: true, disabled: true },
    ]);

    await closeMenus();
  });

  it("puts a line before the current one, ending where that one starts", async () => {
    await cursorTo(toplevel, 2);
    await waitFor(async () => ((await gridRows())[1]?.cursor === true ? 1 : null), {
      timeout: 15000,
      message: "the cursor to reach the second row",
    });

    await runInsert(toplevel, "subtitle-insert-before");

    const grown = await waitForTexts([FIRST, "", SECOND, THIRD], "the new line above the second");
    // It ends where the line it went before begins, and starts where the line above it ended: the
    // gap between the two, which is 120 ms here and not the two seconds it would take given room.
    expect({ start: grown[1].start, end: grown[1].end }).toEqual({
      start: "00:00:04.880",
      end: "00:00:05.000",
    });
    // The rows on either side keep their own times: an insert is not a re-timing.
    expect(grown[0].end).toBe("00:00:04.880");
    expect(grown[2].start).toBe("00:00:05.000");
    // And the line that landed is the one the cursor is on.
    expect(grown.map((row) => row.cursor)).toEqual([false, true, false, false]);

    await runFromMenu((css) => clickElement(toplevel, css), "edit", "edit-undo");
    await waitForTexts([FIRST, SECOND, THIRD], "the fixture again");
  });

  it("times a line from the playhead, taking the room it is given rather than the room there is", async () => {
    await clickElement(toplevel, ".toolbar__video-open");
    const chooser = await waitForChooser("Choose a video");
    await answerChooser(chooser, requireVideoFixture(), "video");
    focusWindow(toplevel.id);
    await waitFor(
      () =>
        browser.execute(
          () =>
            document.querySelector(".stage__empty") === null &&
            document.querySelector(".controls__button")?.disabled === false,
        ),
      { timeout: 40000, message: "the video fixture to reach the ready state" },
    );

    // The cursor lands first and the picture follows it to that line's start; only then is the
    // picture moved. A seek sent while the follow is still on its way is the one that is lost.
    await cursorTo(toplevel, 1);
    await settledPlayhead();
    await seekTo(PLAYHEAD_SECONDS);
    const playhead = await settledPlayhead();
    // Near where it was sent, which is the barrier: a seek that never took would leave the playhead
    // somewhere else and the times below would be read off that instead.
    expect(Math.abs(playhead - PLAYHEAD_SECONDS)).toBeLessThan(1);

    await runInsert(toplevel, "subtitle-insert-after-at-playhead");

    const grown = await waitForTexts([FIRST, "", SECOND, THIRD], "the new line under the first");
    const startMs = Math.round(playhead * 1000);
    // Where the picture is, and the preference long: the second cue starts at 5 s and this one
    // starts after it, so a line timed from the playhead may overlap what is already written.
    expect({ start: grown[1].start, end: grown[1].end }).toEqual({
      start: timecode(startMs),
      end: timecode(startMs + NEW_CUE_MS),
    });

    await runFromMenu((css) => clickElement(toplevel, css), "edit", "edit-undo");
    await waitForTexts([FIRST, SECOND, THIRD], "the fixture again");
  });
});
