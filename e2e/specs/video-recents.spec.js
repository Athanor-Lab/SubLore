/* global describe, it, before, document, window */
/**
 * The Video menu's recent list: a video opened once is remembered and offered again, newest first,
 * and choosing it reopens it without the chooser. The store's own rules (sixteen, newest first, no
 * duplicates) are proved in the crate's unit tests; what is read here is the wiring, the whole point:
 * an opened video reaches the menu, and the menu reaches back to the file. See recent.rs and
 * interface-spec 3.5 item 3.
 */
import path from "node:path";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow, pressKey } from "../lib/input.js";
import { requireVideoFixture, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

const VIDEO_NAME = path.basename(requireVideoFixture());

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

function labelOf(selector) {
  return browser.execute(
    (css) => document.querySelector(css)?.querySelector(".menubar__label")?.textContent ?? null,
    selector,
  );
}

function videoReady() {
  return browser.execute(
    () =>
      document.querySelector(".stage__empty") === null &&
      document.querySelector(".controls__button")?.disabled === false,
  );
}

async function closeMenu() {
  await waitFor(
    async () => {
      if (!(await present(".menubar__menu"))) {
        return 1;
      }
      pressKey("Escape");
      return null;
    },
    { timeout: 15000, message: "the menu to close" },
  );
}

/** Open the Video menu and open its recent submenu. */
async function openRecent(toplevel) {
  await clickElement(toplevel, ".menubar__title--video");
  await waitFor(() => present(".menubar__submenu--video-recent"), {
    timeout: 15000,
    message: "the Video menu to open on the recent submenu",
  });
  await clickElement(toplevel, ".menubar__submenu--video-recent");
  await waitFor(() => present(".menubar__item--video-recent-0"), {
    timeout: 15000,
    message: "the recent list to open on its first entry",
  });
}

describe("the recent videos list", () => {
  let toplevel = null;

  before(async () => {
    toplevel = await waitFor(findToplevel, {
      timeout: 30000,
      message: `the ${windowWidth}x${windowHeight} "Sublore" toplevel`,
    });
    focusWindow(toplevel.id);
    await waitFor(() => present(".toolbar__video-open"), { timeout: 30000, message: "the app UI" });
    await clickElement(toplevel, ".toolbar__video-open");
    await answerChooser(await waitForChooser("Choose a video"), requireVideoFixture(), "video");
    focusWindow(toplevel.id);
    await waitFor(videoReady, { timeout: 30000, message: "the video to reach the ready state" });
  });

  it("remembers the video just opened, at the top of the recent list", async () => {
    await openRecent(toplevel);
    expect(await labelOf(".menubar__item--video-recent-0")).toBe(VIDEO_NAME);
    await closeMenu();
  });

  it("reopens a video from the recent list, without the chooser", async () => {
    // Close the video, then reopen it from the recent list: no chooser appears.
    await clickElement(toplevel, ".menubar__title--video");
    await waitFor(() => present(".menubar__item--video-close"), {
      timeout: 15000,
      message: "the Video menu to open on Close",
    });
    await clickElement(toplevel, ".menubar__item--video-close");
    await waitFor(async () => ((await videoReady()) ? null : 1), {
      timeout: 20000,
      message: "the video to close",
    });

    await openRecent(toplevel);
    await clickElement(toplevel, ".menubar__item--video-recent-0");
    await waitFor(videoReady, { timeout: 30000, message: "the video to reopen from the list" });
  });
});
