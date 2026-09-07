/* global describe, it, before, document, window */
/**
 * The Video menu's transport: play, play the current line, stop, and follow selection.
 *
 * What is asserted is the clock under the picture, because that is what a translator reads: the
 * harness cannot see the frames. A picture that is playing moves the clock, one that was stopped
 * holds it, and a line played from the menu leaves the clock at that line's end and not past it.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow, pressKey } from "../lib/input.js";
import { repoRoot, requireVideoFixture, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

/** Three cues whose starts are far enough apart for a clock counting whole seconds to tell them. */
const FIXTURE = ["srt", "clean", "basic-lf.srt"];
/** Where the first two cues begin, as the clock spells them. */
const FIRST_START = "0:02";
const SECOND_START = "0:05";
/** Where the second cue ends, which is where playing it must leave the picture. */
const SECOND_END = "0:08";

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
  const directory = path.join(dataHome(), "video-transport");
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

/** What the clock under the picture reads, without the duration after it. */
async function clock() {
  const text = await textOf(".controls__time");
  return text === null ? null : (text.split("/")[0]?.trim() ?? null);
}

/** Wait until the clock reads a given second, whatever it was before. */
function clockReaches(reading) {
  return waitFor(async () => ((await clock())?.startsWith(reading) === true ? 1 : null), {
    timeout: 20000,
    message: `the clock to read ${reading}`,
  });
}

/**
 * Wait until the clock stops moving, and answer where it stopped.
 *
 * A stop is asked for and then happens: the command has to reach mpv and mpv has to stop decoding,
 * so the reading taken the instant after choosing Stop is still a moving one. The interval is over
 * a second because the clock counts whole seconds, and two readings inside one second are equal
 * whether the picture is playing or not.
 */
async function clockSettles() {
  let last = await clock();
  for (let tries = 0; tries < 10; tries += 1) {
    await sleep(1200);
    const now = await clock();
    if (now === last) {
      return now;
    }
    last = now;
  }
  throw new Error(`the clock never stopped moving; it last read ${last}`);
}

/** Open the Video menu and choose one of its items by command token. */
async function fromVideoMenu(toplevel, token) {
  await clickElement(toplevel, ".menubar__title--video");
  await waitFor(() => present(`.menubar__item--${token}`), {
    timeout: 15000,
    message: `the Video menu to open on ${token}`,
  });
  await clickElement(toplevel, `.menubar__item--${token}`);
}

/** Whether a Video menu item is drawn, greyed and marked, without choosing it. */
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
      : { drawn: true, disabled: item.disabled === true, checked: item.ariaChecked === "true" };
  }, `.menubar__item--${token}`);
  pressKey("Escape");
  await waitFor(async () => ((await present(`.menubar__item--${token}`)) ? null : 1), {
    timeout: 15000,
    message: "the Video menu to close",
  });
  return state;
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

describe("the video transport", () => {
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

  it("greys the three transport commands with no video, and leaves the follow alive", async () => {
    expect(await videoItem(toplevel, "video-play")).toEqual({
      drawn: true,
      disabled: true,
      checked: false,
    });
    expect(await videoItem(toplevel, "video-stop")).toEqual({
      drawn: true,
      disabled: true,
      checked: false,
    });
    expect(await videoItem(toplevel, "video-play-cue")).toEqual({
      drawn: true,
      disabled: true,
      checked: false,
    });
    // The follow is a setting and not an action, so it is alive with nothing loaded and marked on,
    // which is what the reference opens at.
    expect(await videoItem(toplevel, "video-toggle-follow-selection")).toEqual({
      drawn: true,
      disabled: false,
      checked: true,
    });
  });

  it("plays the picture from the menu, and stops it where it had got to", async () => {
    // The document first and the picture after it, so the cursor landing on the first row happens
    // while there is nothing to follow: the clock starts where the file was opened, at zero.
    await clickElement(toplevel, ".toolbar__file-open-subtitle");
    const chooser = await waitForChooser("Choose a subtitle");
    await answerChooser(chooser, copy, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(
      async () => ((await textOf(".statusbar__document"))?.includes("3 cues") === true ? 1 : null),
      { timeout: 20000, message: "the fixture to open" },
    );

    await clickElement(toplevel, ".toolbar__video-open");
    const videoChooser = await waitForChooser("Choose a video");
    await answerChooser(videoChooser, requireVideoFixture(), "video");
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
    expect(await clock()).toBe("0:00");

    await fromVideoMenu(toplevel, "video-play");
    await clockReaches("0:01");
    await fromVideoMenu(toplevel, "video-stop");
    // Stopped is not rewound: the reference's Stop leaves the playhead where the picture had got
    // to, so once it has settled it stays there.
    const stopped = await clockSettles();
    expect(stopped).not.toBe("0:00");
    await sleep(1500);
    expect(await clock()).toBe(stopped);
  });

  it("plays the line the cursor is on, and stops at that line's end", async () => {
    await clickRow(toplevel, 2);
    // The follow is on, so reaching the row is already a jump to where that line starts.
    await clockReaches(SECOND_START);

    await fromVideoMenu(toplevel, "video-play-cue");
    await clockReaches(SECOND_END);
    // It stopped there rather than running on into the next line's own seconds.
    const ended = await clockSettles();
    expect(ended).toBe(SECOND_END);
    await sleep(1500);
    expect(await clock()).toBe(SECOND_END);
  });

  it("takes the picture to the line the cursor reaches, until the follow is turned off", async () => {
    await clickRow(toplevel, 1);
    await clockReaches(FIRST_START);

    await fromVideoMenu(toplevel, "video-toggle-follow-selection");
    expect(await videoItem(toplevel, "video-toggle-follow-selection")).toEqual({
      drawn: true,
      disabled: false,
      checked: false,
    });

    // The cursor moves and the picture does not, which is the whole of what the toggle is for.
    await clickRow(toplevel, 3);
    await waitFor(
      () =>
        browser.execute(() =>
          document.querySelector(".cuelist__row--active .cuelist__pos")?.textContent === "3"
            ? 1
            : null,
        ),
      { timeout: 15000, message: "the cursor to reach the third row" },
    );
    await sleep(1000);
    expect(await clock()).toBe(FIRST_START);

    // Back on, and the next move follows again: the setting is a setting, not a one-shot.
    await fromVideoMenu(toplevel, "video-toggle-follow-selection");
    await clickRow(toplevel, 2);
    await clockReaches(SECOND_START);
  });
});
