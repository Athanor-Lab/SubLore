/* global describe, it, before, document, window */
/**
 * N60: Play pressed the moment the transport appears is the Play that happens.
 *
 * The backend emits the ready state before `video_open` returns, and that event is what puts the
 * video panel and its transport on screen. So there is a window where the transport is drawn and
 * clickable while the open's own promise is still in flight, and what that promise did when it
 * landed was write `paused: true` over whatever the user had asked for since.
 *
 * Measured from the app's own record: the page saw `paused=false` from the backend and from its own
 * command, then `open resolved, writing paused=true` last, and every render after that drew the
 * button as Play while the clock ran.
 *
 * The button and the clock together, never one alone: a button that reads right over a video that
 * is not moving is the same defect wearing the other mask.
 */
import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow } from "../lib/input.js";
import { requireVideoFixture, videoFixture, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

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

/** The position the transport shows, which is mpv's own clock. */
async function position() {
  const shown = await browser.execute(
    () => document.querySelector(".controls__slider")?.value ?? null,
  );
  const parsed = Number.parseFloat(shown);
  return Number.isFinite(parsed) ? parsed : null;
}

function transportLabel() {
  return browser.execute(() => document.querySelector(".controls__button")?.textContent ?? null);
}

async function clickTransport(toplevel) {
  const button = await centreOf(".controls__button");
  if (button === null) {
    throw new Error(".controls__button is missing from the DOM, so there is nothing to press");
  }
  clickAt(toplevel.absX + button.x, toplevel.absY + button.y);
}

/** What the button reads, waited for, with what it actually says when it never gets there. */
async function expectTransportToRead(wanted) {
  await waitFor(async () => ((await transportLabel()) === wanted ? true : null), {
    timeout: 5000,
    message: `the transport button to read ${JSON.stringify(wanted)}`,
  }).catch(async (error) => {
    throw new Error(
      `${error.message}\nit reads ${JSON.stringify(await transportLabel())} and the clock is at ` +
        `${await position()}`,
    );
  });
}

describe("the transport right after a video opens", () => {
  let toplevel = null;

  before(async () => {
    requireVideoFixture();
    toplevel = await waitFor(findToplevel, {
      timeout: 30000,
      message: `a ${windowWidth}x${windowHeight} toplevel to appear`,
    });
    focusWindow(toplevel.id);
    await waitFor(
      () => browser.execute(() => document.querySelector(".toolbar__video-open") !== null),
      { timeout: 30000, message: "the app UI to render" },
    );

    const open = await centreOf(".toolbar__video-open");
    clickAt(toplevel.absX + open.x, toplevel.absY + open.y);
    const chooser = await waitForChooser("Choose a video");
    await answerChooser(chooser, videoFixture, "video");
    focusWindow(toplevel.id);
    // Deliberately the earliest moment the transport exists, and nothing else: waiting for anything
    // further would wait past the window this spec is about.
    await waitFor(() => browser.execute(() => document.querySelector(".controls") !== null), {
      timeout: 30000,
      message: "the transport to appear once the video is open",
    });
  });

  it("plays, and says so, when Play is pressed the moment the transport appears", async () => {
    expect(await transportLabel()).toBe("Play");

    await clickTransport(toplevel);

    await expectTransportToRead("Pause");
    // And it is really playing: a button that reads right over a still video is the same defect.
    await waitFor(async () => ((await position()) > 0 ? true : null), {
      timeout: 15000,
      message: "the clock to start moving",
    });
  });

  it("pauses again on the next press, and the clock stops with it", async () => {
    await clickTransport(toplevel);
    await expectTransportToRead("Play");

    // The clock settles first: positions reach the page at most ten times a second and what the
    // throttle held back is still sent, so one reading can land after the pause did. Two equal
    // reads is the clock having stopped; a third across a real interval is it staying stopped.
    let previous = null;
    const stopped = await waitFor(
      async () => {
        const now = await position();
        const same = previous !== null && now === previous;
        previous = now;
        return same ? now : null;
      },
      { timeout: 10000, message: "the clock to settle after the pause" },
    );
    await browser.pause(1000);
    expect(await position()).toBe(stopped);
  });
});
