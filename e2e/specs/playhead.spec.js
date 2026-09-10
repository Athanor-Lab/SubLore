/* global describe, it, before, document, window */
/**
 * The five commands that tie the times to where the video is, driven from the Timing menu.
 *
 * Nothing here invokes a command: every one is run by opening the menu and clicking the item, which
 * is the only route a user has. What is asserted is the grid, the player's own readout, and the
 * bytes still on disk.
 *
 * The playhead's millisecond is READ rather than assumed. A seek asks for a time and the player
 * lands where it lands, so asserting a hardcoded 6500 would be asserting the seek's precision and
 * not the command's correctness. Every check below compares the cue against what the player says
 * about itself at that moment.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow, pressKey } from "../lib/input.js";
import { takeCommands, watchCommands } from "../lib/ipc.js";
import { repoRoot, requireVideoFixture, windowHeight, windowWidth } from "../lib/paths.js";
import { appLog } from "../lib/applog.js";
import { waitFor } from "../lib/proc.js";
import { playheadAt, seekTo, settledPlayhead } from "../lib/transport.js";
import { closeAnyOpenProject } from "../lib/rail.js";
import { findToplevel } from "../lib/x11.js";

const OPEN_STATUS = "SRT · 3 cues · LF";
/** The fixture's own third cue, committed and byte-frozen, so these are facts. */
const THIRD_START = "00:00:09.100";
const THIRD_END = "00:00:11.760";
/** Between the first cue's end at 4.880 and the second's start at 5.000: a gap, on purpose. */
const IN_THE_GAP = 4.94;
/** Inside the second cue, which runs 5.000 to 8.340. */
const INSIDE_SECOND = 6.5;

/** Every item the Timing menu draws, in the order the menu lists them. */
const TIMING_ITEMS = [
  "time-prev-cue",
  "time-next-cue",
  "time-start-to-playhead",
  "time-end-to-playhead",
  "wave-play-selection",
  "time-play-line",
  "wave-stop",
  "time-play-before",
  "time-play-after",
  "wave-play-first",
  "wave-play-last",
  "time-play-to-end",
  "time-lead-in",
  "time-lead-out",
  "time-start-earlier",
  "time-start-later",
  "time-end-earlier",
  "time-end-later",
];

/** The one clicked below: it sends its command the moment it is asked, so a leak has a name. */
const SENDS_ON_CLICK = "time-start-to-playhead";

function dataHome() {
  const home = process.env.SUBLORE_E2E_DATA_HOME;
  if (typeof home !== "string" || home === "") {
    throw new Error("SUBLORE_E2E_DATA_HOME is not set; e2e/wdio.conf.js sets it for every run.");
  }
  return home;
}

/** Writes go to the harness temp dir. The committed fixture is copied, never opened for editing. */
function workingCopy() {
  const source = path.join(repoRoot, "fixtures", "subtitles", "srt", "clean", "basic-lf.srt");
  if (!existsSync(source)) {
    throw new Error(
      `E2E prerequisite missing: ${source} does not exist. It is committed; restore it with ` +
        "`git checkout fixtures/subtitles`.",
    );
  }
  const directory = path.join(dataHome(), "playhead");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const copy = path.join(directory, "basic-lf.srt");
  copyFileSync(source, copy);
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
    throw new Error(`${selector} is missing from the DOM`);
  }
  // No window manager under Xvfb, so the toplevel origin is also the viewport origin.
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

function textOf(selector) {
  return browser.execute((css) => document.querySelector(css)?.textContent ?? null, selector);
}

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

function disabledOf(selector) {
  return browser.execute((css) => document.querySelector(css)?.disabled ?? null, selector);
}

/** Every row the grid draws, with the cursor marked, read in one round trip. */
function gridRows() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".cuelist__row")).map((row) => ({
      start: row.querySelector(".cuelist__start")?.textContent ?? null,
      end: row.querySelector(".cuelist__end")?.textContent ?? null,
      cursor: row.classList.contains("cuelist__row--active"),
    })),
  );
}

/** Where the player says it is, in seconds, off its own transport rather than off any state. */
function playhead() {
  return browser.execute(() => Number(document.querySelector(".controls__slider")?.value ?? -1));
}

/** The same instant as the grid draws it, so the two can be compared as strings. */
function asTimecode(seconds) {
  const total = Math.max(0, Math.floor(seconds * 1000));
  const pad = (value, width) => String(value).padStart(width, "0");
  return (
    `${pad(Math.floor(total / 3_600_000), 2)}:` +
    `${pad(Math.floor(total / 60_000) % 60, 2)}:` +
    `${pad(Math.floor(total / 1000) % 60, 2)}.${pad(total % 1000, 3)}`
  );
}

/** A timecode the grid spells, as seconds, which is what the transport speaks. */
function asSeconds(spelled) {
  const [hours, minutes, rest] = spelled.split(":");
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(rest);
}

async function openMenu(toplevel) {
  await clickElement(toplevel, ".menubar__title--timing");
  await waitFor(() => present(".menubar__menu"), {
    timeout: 15000,
    message: "the Timing menu to open",
  });
}

/** The Edit menu, where the two selections live (interface-spec 3.2, N118). */
async function runFromEditMenu(toplevel, token) {
  await clickElement(toplevel, ".menubar__title--edit");
  await waitFor(() => present(".menubar__menu"), {
    timeout: 15000,
    message: "the Edit menu to open",
  });
  await clickElement(toplevel, `.menubar__item--${token}`);
  await waitFor(async () => ((await present(".menubar__menu")) === false ? true : null), {
    timeout: 15000,
    message: `the menu to close after ${token}`,
  });
}

/** The Video menu, where the two jump commands live (interface-spec 3.5, N107). */
async function runFromVideoMenu(toplevel, token) {
  await clickElement(toplevel, ".menubar__title--video");
  await waitFor(() => present(".menubar__menu"), {
    timeout: 15000,
    message: "the Video menu to open",
  });
  await clickElement(toplevel, `.menubar__item--${token}`);
  await waitFor(async () => ((await present(".menubar__menu")) === false ? true : null), {
    timeout: 15000,
    message: `the menu to close after ${token}`,
  });
}

async function runFromMenu(toplevel, token) {
  await openMenu(toplevel);
  await clickElement(toplevel, `.menubar__item--${token}`);
  await waitFor(async () => ((await present(".menubar__menu")) === false ? true : null), {
    timeout: 15000,
    message: `the menu to close after ${token}`,
  });
}

/**
 * The fixture's own frame rate, read from the script that makes it rather than pinned here: a stop
 * is allowed to overshoot by a frame and the number of milliseconds that is belongs to the media.
 */
const FIXTURE_FPS = Number(
  /rate=(\d+)/.exec(
    readFileSync(path.join(repoRoot, "fixtures", "video", "make-sample.sh"), "utf8"),
  )?.[1] ?? "0",
);

/** Put the cursor on a row by clicking its number cell, which never opens an editor. */
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
    throw new Error(`row ${position} is missing from the DOM`);
  }
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
  await waitFor(async () => ((await gridRows())[position - 1]?.cursor === true ? true : null), {
    timeout: 15000,
    message: `the cursor to reach row ${position}`,
  });
}

describe("the times follow the playhead", () => {
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
    await waitFor(
      () => browser.execute(() => document.querySelector(".toolbar__file-open-subtitle") !== null),
      { timeout: 30000, message: "the app UI to render" },
    );
    // One data home for the whole run, so the emptiest state is one this file makes. See N19.
    await closeAnyOpenProject(toplevel);
  });

  it("draws all five greyed while no video is open, and running one does nothing", async () => {
    await openMenu(toplevel);
    for (const token of TIMING_ITEMS) {
      expect({
        token,
        drawn: await present(`.menubar__item--${token}`),
        disabled: await disabledOf(`.menubar__item--${token}`),
      }).toEqual({ token, drawn: true, disabled: true });
    }

    await watchCommands();
    await clickElement(toplevel, `.menubar__item--${SENDS_ON_CLICK}`);
    await browser.pause(500);
    // Nothing crossed the boundary, which is what "greyed" has to mean and not just how it looks.
    expect(await takeCommands()).toEqual([]);
    // XTEST, not WebDriver: the Actions endpoint answers "unsupported operation" against a wry
    // webview, which is why this harness has its own input layer. See e2e/README.md.
    pressKey("Escape");
    await waitFor(async () => ((await present(".menubar__menu")) === false ? true : null), {
      timeout: 15000,
      message: "the menu to close",
    });
  });

  it("sets the cursor's cue to start where the video is paused", async () => {
    await clickElement(toplevel, ".toolbar__file-open-subtitle");
    const subtitle = await waitForChooser("Choose a subtitle");
    await answerChooser(subtitle, copy, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(
      async () => (await textOf(".statusbar__document"))?.includes(OPEN_STATUS) === true,
      { timeout: 20000, message: "the status bar to report the open subtitle" },
    );

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
      { timeout: 40000, message: "the video to be ready to play" },
    );

    // The cursor first and the picture after it: moving the cursor takes the picture to that
    // line's start, so a seek made before it would be undone by the move.
    await cursorTo(toplevel, 2);
    const wasAt = (await gridRows())[1]?.start;
    // The follow has to land before the seek is sent, or the seek is the one that is lost. Waited
    // for at its destination, which is this row's own start: `settledPlayhead` only proved the
    // picture had stopped, which a follow that has not started yet satisfies too (N89).
    await playheadAt(asSeconds(wasAt), "the follow to row 2's start");
    await seekTo(INSIDE_SECOND);
    await settledPlayhead();
    // Read, not assumed: the seek asked for a time and the player landed where it landed.
    const paused = asTimecode(await playhead());
    // And the seek has to have moved the picture off this line's own start, or the command below
    // would have nothing to do and the check below it would pass on a document nobody edited. The
    // cursor puts the picture at that start, so a seek that was lost leaves it exactly there. This
    // is the precondition, named, rather than a silent pass. See BACKLOG.md N9.
    expect(paused).not.toBe(wasAt);

    await runFromMenu(toplevel, "time-start-to-playhead");
    const rows = await waitFor(
      async () => {
        const now = await gridRows();
        return now[1]?.start === paused ? now : null;
      },
      { timeout: 20000, message: `the second row to start at ${paused}` },
    );
    // Only the start moved: the end is the fixture's own, untouched.
    expect(rows[1].end).toBe("00:00:08.340");
    // Waited for, not sampled: the mark follows the edit reaching the document, and this test fails
    // alone on main because it read the mark in the same breath as the row. It passed in a full run
    // only because the specs before it had left the app warm (N19).
    await waitFor(async () => ((await present(".statusbar__dirty")) ? 1 : null), {
      timeout: 20000,
      message: "the unsaved mark to follow the edit",
    });
    // A command is not a save.
    expect(readFileSync(copy).equals(openedBytes)).toBe(true);
  });

  it("takes that back in one undo", async () => {
    await clickElement(toplevel, ".toolbar__edit-undo");
    await waitFor(async () => ((await gridRows())[1]?.start === "00:00:05.000" ? true : null), {
      timeout: 20000,
      message: "one undo to put the second row's start back",
    });
    expect(readFileSync(copy).equals(openedBytes)).toBe(true);
  });

  it("moves the video to the cursor's cue start, and to its end", async () => {
    await cursorTo(toplevel, 3);

    await runFromVideoMenu(toplevel, "video-jump-cue-start");
    const atStart = await waitFor(
      async () => {
        const now = asTimecode(await playhead());
        return now === THIRD_START ? now : null;
      },
      { timeout: 20000, message: `the player to reach ${THIRD_START}` },
    );
    expect(atStart).toBe(THIRD_START);

    await runFromVideoMenu(toplevel, "video-jump-cue-end");
    // The end, or up to one frame past it. Playing to a target stops on a frame boundary and mpv
    // reports `time-pos` at frame rate, so the app overshoots by design and says so in its own log:
    // `range stopped at 11.767 for a target of 11.760` (N20, and N97 for this wait). Only forward:
    // stopping short of the cue's end would be a real defect and stays red.
    const wantEnd = asSeconds(THIRD_END);
    const frame = FIXTURE_FPS > 0 ? 1 / FIXTURE_FPS : 0;
    let sawEnd = -1;
    const atEnd = await waitFor(
      async () => {
        sawEnd = await playhead();
        return sawEnd >= wantEnd - 0.001 && sawEnd <= wantEnd + frame + 0.001 ? sawEnd : null;
      },
      {
        timeout: 20000,
        message: () =>
          `the player to reach ${THIRD_END}, or up to one frame past it. It read ${sawEnd}s`,
      },
    );
    expect(atEnd).toBeGreaterThanOrEqual(wantEnd - 0.001);
  });

  it("moves one boundary by ten milliseconds and leaves the other where it was", async () => {
    await cursorTo(toplevel, 3);
    const before = (await gridRows())[2];
    expect(before.start).toBe(THIRD_START);
    expect(before.end).toBe(THIRD_END);

    await runFromMenu(toplevel, "time-start-later");
    const later = await waitFor(
      async () => {
        const now = (await gridRows())[2];
        return now?.start === "00:00:09.110" ? now : null;
      },
      { timeout: 20000, message: "the third cue's start to move ten milliseconds on" },
    );
    // Ten, not nine and not eleven, and the end has not moved with it.
    expect(later.end).toBe(THIRD_END);

    await runFromMenu(toplevel, "time-end-earlier");
    const shorter = await waitFor(
      async () => {
        const now = (await gridRows())[2];
        return now?.end === "00:00:11.750" ? now : null;
      },
      { timeout: 20000, message: "the third cue's end to move ten milliseconds back" },
    );
    expect(shorter.start).toBe("00:00:09.110");

    // Two edits, two undos: each nudge is its own step and neither swallowed the other.
    await clickElement(toplevel, ".toolbar__edit-undo");
    await clickElement(toplevel, ".toolbar__edit-undo");
    await waitFor(
      async () => {
        const now = (await gridRows())[2];
        return now?.start === THIRD_START && now?.end === THIRD_END ? true : null;
      },
      { timeout: 20000, message: "two undos to put both boundaries back" },
    );
    expect(readFileSync(copy).equals(openedBytes)).toBe(true);
  });

  it("plays the cursor's cue and stops itself at its end", async () => {
    await cursorTo(toplevel, 3);
    await seekTo(0);

    await runFromMenu(toplevel, "time-play-line");
    // It starts: the player leaves the beginning under its own steam, which a seek alone would not
    // do because a seek leaves it paused.
    await waitFor(async () => ((await playhead()) > 9 ? true : null), {
      timeout: 20000,
      message: "playback to reach the third cue",
    });
    // And it stops itself, without anything here asking it to.
    const stopped = await waitFor(
      async () => {
        const label = await textOf(".controls__button");
        return label === "Play" ? await playhead() : null;
      },
      { timeout: 20000, message: "the player to pause itself at the cue's end" },
    );
    // The window is the UI's resolution, not the stop's. The stop is checked on the event thread,
    // which sees every frame, but this reads the transport slider, which the app updates ten times
    // a second: a reading can lag the player by up to that. Measured here at 11.70 for a cue ending
    // at 11.760. Asserting a frame's precision through a tenth-of-a-second window would be
    // asserting something this harness cannot see.
    expect(stopped).toBeGreaterThan(11.6);
    expect(stopped).toBeLessThan(11.9);

    // And the precision the slider cannot show, read from the app's own account of the stop. The
    // check lives on the branch that sees every frame; one moved to the branch that feeds the
    // interface would overshoot by up to a tenth, and a tenth is three frames at this fixture's
    // rate. That is the difference this assertion exists to see. See BACKLOG.md N20.
    const said = /playback: range stopped at ([\d.]+) for a target of ([\d.]+)/.exec(
      appLog(dataHome()),
    );
    expect(said).not.toBe(null);
    const overshoot = Number(said[1]) - Number(said[2]);
    expect(overshoot).toBeGreaterThanOrEqual(0);
    // A frame and a half. Clean, this branch overshoots by under a frame; moved under the
    // throttle it overshot by 73 ms against a 30 fps fixture, which is more than two. The margin
    // is deliberate on both sides so a slow runner cannot decide the verdict.
    expect(overshoot).toBeLessThan(1.5 / FIXTURE_FPS);
  });

  it("plays the half second before the cue, and stops where the cue starts", async () => {
    await seekTo(0);
    await runFromMenu(toplevel, "time-play-before");
    const stopped = await waitFor(
      async () => {
        const label = await textOf(".controls__button");
        return label === "Play" && (await playhead()) > 8 ? await playhead() : null;
      },
      { timeout: 20000, message: "the player to pause itself where the third cue starts" },
    );
    // 9.100 is the cue's start and 8.600 is where this began. Same window and same reason as above:
    // the slider lags the player by up to a tenth. Measured here at 9.07.
    expect(stopped).toBeGreaterThan(8.95);
    expect(stopped).toBeLessThan(9.25);
  });

  it("puts the cursor on the cue that starts next when the video sits in a gap", async () => {
    await cursorTo(toplevel, 1);
    await seekTo(IN_THE_GAP);
    // Between the first cue's end and the second's start, so no cue covers this instant.
    expect(await playhead()).toBeGreaterThan(4.88);
    expect(await playhead()).toBeLessThan(5);

    await runFromEditMenu(toplevel, "edit-select-at-playhead");
    const rows = await waitFor(
      async () => {
        const now = await gridRows();
        return now[1]?.cursor === true ? now : null;
      },
      { timeout: 20000, message: "the cursor to land on the cue that starts next" },
    );
    // Forwards, not backwards: the cue that ended is not the one a translator is about to time.
    expect(rows.map((row) => row.cursor)).toEqual([false, true, false]);
  });
});
