/* global describe, it, before, document, window */
/**
 * A layer owns the keyboard while it is open.
 *
 * With the video details panel on screen, pressing T ran `time.play-to-end` on the document behind
 * it: the app's log said `asked mpv for the range 2.120 to 60.023` with `videodetails__panel`
 * drawn. The dispatcher asked `ownsTheKeyboard`, which knows about text fields and nothing about
 * dialogs, and `layers.covered` was read only by the video, to cover itself. See BACKLOG.md N168.
 *
 * Both a subtitle and a video are opened here, and that is the point rather than setup: the command
 * under test needs a document, a cursor and a loaded video to be enabled at all. Placed in the
 * details spec first, where no document is open, the check passed while proving nothing, because a
 * greyed command does not run whatever the layers say.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { appLog, dataHome } from "../lib/applog.js";
import { clickAt, focusWindow, pressKey } from "../lib/input.js";
import { runFromMenu } from "../lib/menu.js";
import { repoRoot, requireVideoFixture, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { closeAnyOpenProject } from "../lib/rail.js";
import { findToplevel } from "../lib/x11.js";

const OPEN_STATUS = "SRT · 3 cues · LF";

/**
 * Room for the stall N101 records, which this file paid for on 2026-09-12: the app processed
 * nothing for thirty-two seconds and a wait of thirty called it a defect. The same battery had
 * `video-aspect.spec.js` silent for thirty. Forty-five, not sixty: `mochaOpts.timeout` is sixty and
 * a wait set to it is killed at the instant it would have spoken. Not an assertion about time, and
 * the stall itself is still open.
 */
const STALL_ROOM_MS = 45000;

function workingCopy() {
  const source = path.join(repoRoot, "fixtures", "subtitles", "srt", "clean", "basic-lf.srt");
  if (!existsSync(source)) {
    throw new Error(
      `E2E prerequisite missing: ${source} does not exist. It is committed; restore it with ` +
        "`git checkout fixtures/subtitles`.",
    );
  }
  const directory = path.join(dataHome(), "layer-owns-the-keyboard");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const copy = path.join(directory, "basic-lf.srt");
  copyFileSync(source, copy);
  return copy;
}

/**
 * How many keydowns the page has been given, which `App.tsx` counts on the element.
 *
 * The difference this is here to name: a key the app dropped and a key that never arrived read
 * exactly the same from outside, and on the runner this file has twice waited out its whole timeout
 * for a press that produced no line at all. See BACKLOG.md N101.
 */
function keysSeen() {
  return browser.execute(() => Number(document.documentElement.dataset.keysSeen) || 0);
}

/** Press a key and say which half failed: the page never saw it, or nothing came of it. */
async function pressAndConfirmArrival(key) {
  const before = await keysSeen();
  pressKey(key);
  await waitFor(async () => ((await keysSeen()) > before ? 1 : null), {
    timeout: 10000,
    message:
      `the page to be given the ${key} keypress at all. It was sent through XTEST to a window ` +
      `that holds the focus, and the page never saw a keydown`,
  });
}

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

function textOf(selector) {
  return browser.execute((css) => document.querySelector(css)?.textContent ?? null, selector);
}

/** Every range the app has been asked to play, from its own log: the trace N163 added. */
function ranges() {
  return (appLog(dataHome()) ?? "").match(/asked mpv for the range [\d.]+ to [\d.]+/g) ?? [];
}

async function clickElement(toplevel, selector) {
  const centre = await browser.execute((css) => {
    const element = document.querySelector(css);
    if (element === null) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    return { x: (rect.x + rect.width / 2) * dpr, y: (rect.y + rect.height / 2) * dpr };
  }, selector);
  if (centre === null) {
    throw new Error(`${selector} is missing from the DOM`);
  }
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

describe("a layer owns the keyboard while it is open", () => {
  let toplevel = null;

  before(async () => {
    const copy = workingCopy();
    toplevel = await waitFor(findToplevel, {
      timeout: 30000,
      message: `the ${windowWidth}x${windowHeight} "Sublore" toplevel to appear`,
    });
    focusWindow(toplevel.id);
    await waitFor(() => present(".toolbar__file-open-subtitle"), {
      timeout: 30000,
      message: "the app UI to render",
    });
    await closeAnyOpenProject(toplevel);

    await clickElement(toplevel, ".toolbar__file-open-subtitle");
    await answerChooser(await waitForChooser("Choose a subtitle"), copy, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(
      async () => (await textOf(".statusbar__document"))?.includes(OPEN_STATUS) === true,
      { timeout: 20000, message: "the status bar to report the open subtitle" },
    );

    await runFromMenu((css) => clickElement(toplevel, css), "video", "video-open");
    await answerChooser(await waitForChooser("Choose a video"), requireVideoFixture(), "video");
    focusWindow(toplevel.id);
    await waitFor(() => present(".controls__slider"), {
      timeout: 40000,
      message: "the transport to appear, which is the video being open",
    });
    // The transport being drawn is not the player being ready, and T is greyed until it is. A press
    // against a greyed command does nothing at all, so this file sat out its whole wait and read as
    // a silence: green alone, red in the battery, three times. The length arriving says the media is
    // open and the button coming alive says it can be played. Same lesson as `timing-play-keys`,
    // paid for twice. See BACKLOG.md N173.
    await waitFor(
      async () => {
        const ready = await browser.execute(() => {
          const slider = document.querySelector(".controls__slider");
          const button = document.querySelector(".controls__button");
          return {
            duration: slider === null ? null : Number(slider.getAttribute("max")),
            greyed: button?.disabled ?? true,
          };
        });
        return ready.duration !== null && ready.duration > 0 && ready.greyed === false
          ? true
          : null;
      },
      { timeout: 40000, message: "the player to be ready, which is what wakes the timing keys" },
    );
  });

  it("first proves the key works with nothing over the document", async () => {
    // The control. Without it the check below would pass just as well against a greyed command,
    // which is exactly how the first version of this fooled itself.
    const before = ranges().length;
    focusWindow(toplevel.id);
    await pressAndConfirmArrival("t");
    await waitFor(async () => (ranges().length > before ? 1 : null), {
      timeout: STALL_ROOM_MS,
      message: "T to play a range with no layer on screen",
    });
    await clickElement(toplevel, ".controls__button");
  });

  it("does not run a command on the document behind a dialog", async () => {
    await runFromMenu((css) => clickElement(toplevel, css), "video", "video-details");
    await waitFor(() => present(".videodetails__panel"), {
      timeout: 15000,
      message: "the details panel to open",
    });

    const before = ranges().length;
    focusWindow(toplevel.id);
    await pressAndConfirmArrival("t");
    await browser.pause(2500);
    expect(ranges().length).toBe(before);

    // And it comes back the moment the panel goes, so what stopped it was the layer.
    pressKey("Escape");
    await waitFor(async () => ((await present(".videodetails__panel")) ? null : 1), {
      timeout: 15000,
      message: "the details panel to close",
    });
    focusWindow(toplevel.id);
    await pressAndConfirmArrival("t");
    await waitFor(async () => (ranges().length > before ? 1 : null), {
      timeout: STALL_ROOM_MS,
      message: "T to play again once the panel has closed",
    });
  });
});
