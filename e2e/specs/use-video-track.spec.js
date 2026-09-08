/* global describe, it, before, document, window */
/**
 * Audio > Use the video's audio (interface-spec 3.6 item 1). In Sublore the audio is already the
 * open media's, so the command returns to the video's own default track, the first in file order,
 * through the same machinery the track submenu uses. Proved on the two-tone fixture the track
 * switch is proved on: pick the second track, then the command, and the first is marked again.
 */
import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow, pressKey } from "../lib/input.js";
import { requireTracksFixture, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

function centreOf(selector) {
  return browser.execute((css) => {
    const rect = document.querySelector(css)?.getBoundingClientRect();
    if (rect === undefined) {
      return null;
    }
    const dpr = window.devicePixelRatio;
    return { x: (rect.x + rect.width / 2) * dpr, y: (rect.y + rect.height / 2) * dpr };
  }, selector);
}

async function clickElement(toplevel, selector) {
  const centre = await centreOf(selector);
  if (centre === null) {
    throw new Error(`${selector} is missing from the DOM`);
  }
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

async function openAudioMenu(toplevel) {
  await clickElement(toplevel, ".menubar__title--audio");
  await waitFor(() => present(".menubar__item--audio-use-video-track"), {
    timeout: 15000,
    message: "the Audio menu to open on its Use-the-video's-audio item",
  });
}

/** Which track the submenu marks, read with the menu open. */
function checkedTrack() {
  return browser.execute(() => {
    for (const id of [1, 2]) {
      const item = document.querySelector(`.menubar__item--audio-track-${id}`);
      if (item !== null && item.getAttribute("aria-checked") === "true") {
        return id;
      }
    }
    return null;
  });
}

async function closeMenus() {
  pressKey("Escape");
  await waitFor(async () => ((await present(".menubar__menu")) ? null : 1), {
    timeout: 15000,
    message: "the menu to close",
  });
}

describe("Use the video's audio", () => {
  let toplevel = null;

  before(async () => {
    toplevel = await waitFor(findToplevel, {
      timeout: 30000,
      message: `the ${windowWidth}x${windowHeight} "Sublore" toplevel to appear`,
    });
    focusWindow(toplevel.id);
    await waitFor(() => present(".toolbar__video-open"), {
      timeout: 30000,
      message: "the app UI to render",
    });

    await clickElement(toplevel, ".toolbar__video-open");
    const video = await waitForChooser("Choose a video");
    await answerChooser(video, requireTracksFixture(), "video");
    focusWindow(toplevel.id);
    // The Audio title ungreys once the media's tracks are listed.
    await waitFor(
      () =>
        browser.execute(() => document.querySelector(".menubar__title--audio")?.disabled === false),
      { timeout: 40000, message: "the Audio title to ungrey with the two-track media" },
    );
  });

  it("returns to the video's first track after the second was picked", async () => {
    await openAudioMenu(toplevel);
    expect(await checkedTrack()).toBe(1);
    await clickElement(toplevel, ".menubar__item--audio-track-2");
    await waitFor(async () => ((await present(".menubar__menu")) ? null : 1), {
      timeout: 15000,
      message: "the menu to close on the switch",
    });

    await openAudioMenu(toplevel);
    await waitFor(async () => ((await checkedTrack()) === 2 ? true : null), {
      timeout: 15000,
      message: "the second track to be the marked one",
    });

    // The command under test: back to the video's own first track.
    await clickElement(toplevel, ".menubar__item--audio-use-video-track");
    await waitFor(async () => ((await present(".menubar__menu")) ? null : 1), {
      timeout: 15000,
      message: "the menu to close on the command",
    });
    await openAudioMenu(toplevel);
    await waitFor(async () => ((await checkedTrack()) === 1 ? true : null), {
      timeout: 15000,
      message: "the first track to be the marked one again",
    });
    await closeMenus();
  });
});
