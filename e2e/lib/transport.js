/* global document, window, Event */
import { browser } from "@wdio/globals";

import { pressKey } from "./input.js";
import { runFromMenu } from "./menu.js";
import { waitFor } from "./proc.js";

/**
 * The transport's slider: the only seek a spec can make without a hand on a mouse.
 *
 * Three specs carried a copy of this and of `settledPlayhead`, and the copies had drifted: one
 * paused 300 ms after the dispatch, one did not, and only one of them carried the landing guard
 * below. All three are the ones that retry on the CI runner. See BACKLOG.md N84 and N87.
 */

/** How far from the second it was given a seek may stop, because it stops on a frame. */
export const SEEK_TOLERANCE_SECONDS = 0.5;
/** Between readings, and long enough for the app to draw the slider from the picture again. */
const SEEK_POLL_MS = 200;
/** How long a seek has to land before the failure is worth reporting. */
const SEEK_TIMEOUT_MS = 15000;

/**
 * Where the playhead is once it has stopped moving there, in seconds.
 *
 * The pause between readings is the point: the slider's value can be set from outside for a moment
 * before the app draws it again from where the picture really is, and two readings taken back to
 * back would both see that moment.
 */
export async function settledPlayhead() {
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

/**
 * Seek, and wait until the picture is there.
 *
 * Landed, not sent. On CI the seek was still on its way when the caller read the playhead, so the
 * caller computed its expectation from where the picture used to be while the app worked from
 * where it had got to, and the two never met: forty seconds burned on a comparison that named
 * neither number (N84). Moving the cursor also sends the picture to that line's start, and a seek
 * sent into that window is the one that is lost.
 * @returns {Promise<number>} where the playhead actually landed, in seconds
 */
export async function seekTo(seconds) {
  await browser.execute((target) => {
    const slider = document.querySelector(".controls__slider");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(slider, String(target));
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
  }, seconds);
  return playheadAt(seconds, `the seek to ${seconds}s`);
}

/**
 * Wait until the picture is at `seconds`, sending nothing.
 *
 * Moving the cursor sends the picture to that line's start, and on a loaded machine that follow
 * arrives after a seek made straight afterwards and drags the picture back: measured on CI, where
 * the landing guard passed at ten seconds and the test then read 2.13, the start of the row the
 * cursor had just reached (N89). Waiting for the follow to arrive is the only thing that closes it,
 * and its destination is the row's own start, which the callers already read.
 * @param {number} seconds where the picture has to be
 * @param {string} what names the wait in the failure, so it says which of the two it was waiting on
 */
export async function playheadAt(seconds, what = `the playhead to reach ${seconds}s`) {
  // One loop with one cadence, not a `waitFor` wrapped around `settledPlayhead`: that nests a
  // hundred millisecond poll around a function that sleeps three hundred and can take nine
  // seconds, and the three specs using it got slow enough to move the whole parallel schedule.
  // Measured on 2026-09-10: the battery went from green every run to one red spec in each of two
  // consecutive runs, in files this change does not touch (N87).
  const read = () =>
    browser.execute(() => Number(document.querySelector(".controls__slider")?.value ?? -1));
  let previous = null;
  let now = -1;
  const deadline = Date.now() + SEEK_TIMEOUT_MS;
  for (;;) {
    await browser.pause(SEEK_POLL_MS);
    now = await read();
    // Settled and where it was asked to be: either alone is not enough, because the slider holds a
    // value written from outside for a moment before the app draws it again from the picture.
    if (now === previous && Math.abs(now - seconds) <= SEEK_TOLERANCE_SECONDS) {
      return now;
    }
    previous = now;
    if (Date.now() >= deadline) {
      throw new Error(
        `${what} never landed: the playhead settled at ${now}s. Nothing read after this would ` +
          `be about the position the test asked for.`,
      );
    }
  }
}

/** The Video menu's own item for the follow, which is where both routes to it are read. */
const FOLLOW_ITEM = ".menubar__item--video-toggle-follow-selection";

/**
 * Turn off the follow that takes the picture to the cursor's line, through the menu a person uses,
 * and answer once the menu says it is off.
 *
 * For a check that seeks after moving the cursor. The follow is a second seek nobody asked for, and
 * on a loaded machine it arrives **after** the one the check sent and takes the picture back to the
 * line's own start: measured on the runner, where the log reads 6.000 s twice and then 2.133 s,
 * which is row one's start. Waiting for it was tried first and could not be proved, because it
 * fires at a different moment on the machine this suite is written on. A setting that is off cannot
 * arrive late. See BACKLOG.md N143.
 *
 * @param {(css: string) => Promise<void>} click the caller's own clicker, as `runFromMenu` takes
 */
export async function stopFollowingTheCursor(click) {
  if (!(await followsTheCursor(click))) {
    return;
  }
  await runFromMenu(click, "video", "video-toggle-follow-selection");
  const stillFollows = await followsTheCursor(click);
  if (stillFollows) {
    throw new Error(
      "the follow is still on after the menu item ran, so the picture can still be taken to the " +
        "cursor's line while this check is seeking somewhere else",
    );
  }
}

/** Whether the Video menu draws the follow as on, by opening the menu and closing it again. */
export async function followsTheCursor(click) {
  await click(".menubar__title--video");
  await waitFor(() => browser.execute((css) => document.querySelector(css) !== null, FOLLOW_ITEM), {
    timeout: 15000,
    message: "the Video menu to open on the follow",
  });
  const checked = await browser.execute(
    (css) => document.querySelector(css)?.ariaChecked ?? null,
    FOLLOW_ITEM,
  );
  pressKey("Escape");
  await waitFor(
    async () =>
      (await browser.execute((css) => document.querySelector(css) !== null, FOLLOW_ITEM))
        ? null
        : 1,
    { timeout: 15000, message: "the Video menu to close" },
  );
  return checked === "true";
}
