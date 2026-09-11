/* global describe, it, before, console, document, window */
/**
 * N13: a machine with no audio device still plays the video.
 *
 * A translator times subtitles against the picture and the clock. On a server, in a container, or
 * on any machine whose sound stack is not up, mpv cannot open an audio device, and its default is
 * to end the file rather than play it silently: measured as "finished playback, audio output
 * initialization failed (reason 4)", about a second in. That is what CI kept seeing as playback
 * that had stopped between two tests with nothing to stop it.
 *
 * This spec's app is launched against exactly that machine. `wdio.conf.js` gives it, and only it,
 * an environment where every backend mpv would try goes somewhere that does not answer, so what is
 * asserted here is not this developer's sound card being absent, it is arranged.
 *
 * The assertion is the clock, not the transport's label: a player can report itself playing while
 * its position never moves, and on this machine the two disagree outright (N60).
 *
 * **What this does and does not prove, said rather than implied.** Told not to fall back, mpv still
 * plays here: the mutation was run and this spec stayed green, because this machine's libmpv finds
 * an output that works even with ALSA, PipeWire and PulseAudio all sent nowhere. The same
 * environment given to the mpv command line does end the file, measured twice. So the guard this
 * spec is worth lives on a machine that genuinely has no output, which is what a CI runner is, and
 * a green run here is not evidence the fallback is doing anything. The fallback itself is proved
 * against mpv directly, in `sublore-meta/docs/silent-machine-tasks.md`.
 */
import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { runFromMenu } from "../lib/menu.js";
import { clickAt, focusWindow } from "../lib/input.js";
import { requireVideoFixture, videoFixture, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

/**
 * How far the clock has to travel. mpv ends the file about a second in when the device will not
 * open, so three seconds is past that with room, and the fixture is sixty seconds long.
 */
const PAST_THE_FAILURE_S = 3;

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

/** The position mpv reports, read off the transport's own clock. */
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

describe("a machine with no audio device", () => {
  let toplevel = null;

  before(async () => {
    requireVideoFixture();
    toplevel = await waitFor(findToplevel, {
      timeout: 30000,
      message: `a ${windowWidth}x${windowHeight} toplevel to appear`,
    });
    focusWindow(toplevel.id);
    await waitFor(
      () => browser.execute(() => document.querySelector(".toolbar__file-open-subtitle") !== null),
      { timeout: 30000, message: "the app UI to render" },
    );

    await runFromMenu(
      async (css) => {
        const at = await centreOf(css);
        clickAt(toplevel.absX + at.x, toplevel.absY + at.y);
      },
      "video",
      "video-open",
    );
    const chooser = await waitForChooser("Choose a video");
    await answerChooser(chooser, videoFixture, "video");
    focusWindow(toplevel.id);
    await waitFor(() => browser.execute(() => document.querySelector(".controls") !== null), {
      timeout: 30000,
      message: "the transport to appear once the video is open",
    });
  });

  it("opens the video and gives it a transport, with no sound to play it through", async () => {
    // The precondition, said rather than assumed: an open that failed would make everything below
    // pass for the wrong reason, because a clock that never starts is also a clock that stopped.
    expect(await transportLabel()).toBe("Play");
    expect(await position()).toBe(0);
  });

  it("keeps playing past the second where the audio device would have ended it", async () => {
    const play = await centreOf(".controls__button");
    // What is actually under the point about to be clicked, read at the moment of the click rather
    // than assumed from the measurement before it. A layout still settling moves the button between
    // the two, and a click that lands elsewhere produces no command at all, which is exactly the
    // silence N108 has been reading in this spec's log. Printed either way, so a green run says the
    // aim was right and a red one says where it went. See BACKLOG.md N108.
    const under = await browser.execute(
      (x, y) => {
        const found = document.elementFromPoint(x, y);
        return found === null ? null : `${found.tagName}.${found.className}`;
      },
      play.x / (await browser.execute(() => window.devicePixelRatio)),
      play.y / (await browser.execute(() => window.devicePixelRatio)),
    );
    console.log(`N108 the point the Play click is aimed at holds: ${under}`);
    clickAt(toplevel.absX + play.x, toplevel.absY + play.y);

    // Past three seconds and still counting. Without the fallback mpv ends the file around one, and
    // the clock stops wherever it got to.
    const reached = await waitFor(
      async () => {
        const at = await position();
        return at !== null && at >= PAST_THE_FAILURE_S ? at : null;
      },
      {
        timeout: 30000,
        message:
          `the clock to pass ${PAST_THE_FAILURE_S}s with no audio device. mpv ends the file ` +
          "about a second in unless it is told to fall back to no sound at all (N13)",
      },
    );

    // Still moving, not merely past the mark: a file that ended at 3.1 would satisfy the wait above.
    await waitFor(async () => ((await position()) > reached ? true : null), {
      timeout: 15000,
      message: `the clock to keep moving past ${reached}s`,
    });
    // The clock and not the transport's label. On this machine the two disagree: the position
    // advances while the button still offers Play, which is its own defect and is filed as N60. The
    // claim here is that the file did not end, and the clock is what says so.
    const stillMoving = await position();
    expect(stillMoving).toBeGreaterThan(PAST_THE_FAILURE_S);
  });
});
