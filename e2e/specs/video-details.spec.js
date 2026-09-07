/* global describe, it, before, document, window */
/**
 * Video details: what the open media says about itself, read off the fixture the repo generates.
 *
 * The numbers are the ones `fixtures/video/make-sample.sh` asks ffmpeg for, so the check is against
 * a file whose shape is written down rather than against whatever mpv happened to answer.
 */
import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow, pressKey } from "../lib/input.js";
import { requireVideoFixture, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

/** What make-sample.sh asks for: 640x360 at 30 frames a second, sixty seconds long. */
const RESOLUTION = "640 x 360";
const ASPECT = "16:9";

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

/** Open the Video menu and choose one of its items by command token. */
async function fromVideoMenu(toplevel, token) {
  await clickElement(toplevel, ".menubar__title--video");
  await waitFor(() => present(`.menubar__item--${token}`), {
    timeout: 15000,
    message: `the Video menu to open on ${token}`,
  });
  await clickElement(toplevel, `.menubar__item--${token}`);
}

/** Whether the item is drawn and greyed, without choosing it. */
async function videoItem(toplevel, token) {
  await clickElement(toplevel, ".menubar__title--video");
  await waitFor(() => present(`.menubar__item--${token}`), {
    timeout: 15000,
    message: `the Video menu to open on ${token}`,
  });
  const state = await browser.execute((css) => {
    const item = document.querySelector(css);
    return item === null ? null : { drawn: true, disabled: item.disabled === true };
  }, `.menubar__item--${token}`);
  pressKey("Escape");
  await waitFor(async () => ((await present(`.menubar__item--${token}`)) ? null : 1), {
    timeout: 15000,
    message: "the Video menu to close",
  });
  return state;
}

async function openDetails(toplevel) {
  await fromVideoMenu(toplevel, "video-details");
  await waitFor(() => present(".videodetails__panel"), {
    timeout: 15000,
    message: "the details panel to open",
  });
}

function panelGone() {
  return waitFor(async () => ((await present(".videodetails__panel")) ? null : 1), {
    timeout: 15000,
    message: "the details panel to close",
  });
}

describe("what the open media is", () => {
  let toplevel = null;

  before(async () => {
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

  it("greys the item with nothing open, and wakes it when a video is loaded", async () => {
    expect(await videoItem(toplevel, "video-details")).toEqual({ drawn: true, disabled: true });

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
      { timeout: 30000, message: "the video fixture to reach the ready state" },
    );
    expect(await videoItem(toplevel, "video-details")).toEqual({ drawn: true, disabled: false });
  });

  it("reads the shape of the file off the file, not off a guess", async () => {
    await openDetails(toplevel);

    expect(await textOf(".videodetails__file")).toContain("sample.mkv");
    // The reduction is the part with arithmetic in it: 640 by 360 is 16:9, not 640:360.
    expect(await textOf(".videodetails__resolution")).toBe(RESOLUTION);
    expect(await textOf(".videodetails__aspect")).toBe(ASPECT);
    // Three decimals, which is what the reference draws and what tells 23.976 from 24.
    expect(await textOf(".videodetails__fps")).toBe("30.000");
    expect(await textOf(".videodetails__duration")).toContain("1:00");

    // The two mpv answers for, whose exact wording is the container's and not ours: what is owed is
    // that they were read at all, so neither may be the sentence for a field with no answer.
    const frames = Number(await textOf(".videodetails__frames"));
    expect(frames).toBeGreaterThan(1700);
    expect(frames).toBeLessThan(1900);
    expect(await textOf(".videodetails__codec")).not.toBe("not reported");

    await clickElement(toplevel, ".videodetails__close");
    await panelGone();
  });

  it("closes on Escape and on a click beside the panel, like every other layer", async () => {
    await openDetails(toplevel);
    pressKey("Escape");
    await panelGone();

    await openDetails(toplevel);
    // The scrim, which is the dialog's own element and not the panel: a click there is a click
    // outside, and the shell behind it must not receive it.
    const corner = await browser.execute(() => {
      const scrim = document.querySelector(".videodetails");
      if (scrim === null) {
        return null;
      }
      const rect = scrim.getBoundingClientRect();
      const dpr = window.devicePixelRatio;
      return { x: (rect.x + 8) * dpr, y: (rect.y + 8) * dpr };
    });
    if (corner === null) {
      throw new Error("the details dialog has no scrim to click beside the panel");
    }
    clickAt(toplevel.absX + corner.x, toplevel.absY + corner.y);
    await panelGone();
  });
});
