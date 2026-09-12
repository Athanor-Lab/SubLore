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
  });

  it("first proves the key works with nothing over the document", async () => {
    // The control. Without it the check below would pass just as well against a greyed command,
    // which is exactly how the first version of this fooled itself.
    const before = ranges().length;
    focusWindow(toplevel.id);
    pressKey("t");
    await waitFor(async () => (ranges().length > before ? 1 : null), {
      timeout: 30000,
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
    pressKey("t");
    await browser.pause(2500);
    expect(ranges().length).toBe(before);

    // And it comes back the moment the panel goes, so what stopped it was the layer.
    pressKey("Escape");
    await waitFor(async () => ((await present(".videodetails__panel")) ? null : 1), {
      timeout: 15000,
      message: "the details panel to close",
    });
    focusWindow(toplevel.id);
    pressKey("t");
    await waitFor(async () => (ranges().length > before ? 1 : null), {
      timeout: 30000,
      message: "T to play again once the panel has closed",
    });
  });
});
