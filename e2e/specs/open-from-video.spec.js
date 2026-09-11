/* global describe, it, before, document, window */
/**
 * N116: the subtitles a video carries inside it, opened from the File menu with no picker.
 *
 * Three fixtures, each built so the assertion can name what it expects instead of comparing the app
 * with itself: one video with two SubRip streams whose texts differ, one with a single ASS stream
 * carrying a style and an override tag, and one with no subtitle stream at all. See
 * docs/open-from-video-tasks.md.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow } from "../lib/input.js";
import { menuItemDisabled, runFromMenu } from "../lib/menu.js";
import {
  requireAssSubFixture,
  requireNoSubsFixture,
  requireTwoSubsFixture,
  windowHeight,
  windowTitle,
  windowWidth,
} from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel, findWindowsWithAppGeometry } from "../lib/x11.js";

/** What the window is called while the document has no file of its own. */
const UNTITLED = "Untitled";
/** What leads the window's name while the document holds work that is on no disk. */
const DIRTY_MARK = "* ";

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

function textOf(selector) {
  return browser.execute((css) => document.querySelector(css)?.textContent ?? null, selector);
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
    throw new Error(`${selector} is missing from the DOM, so there is nothing to click`);
  }
  // No window manager under Xvfb, so the toplevel origin is also the viewport origin.
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

/** Every cue the grid draws, in its own order, as the text column reads them. */
function gridTexts() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".cuelist__row")).map(
      (row) => row.querySelector(".cuelist__text")?.textContent ?? "",
    ),
  );
}

/** The file's bytes and the minute it was last written, for the read-only check. */
function fingerprint(file) {
  return {
    digest: createHash("sha256").update(readFileSync(file)).digest("hex"),
    modified: statSync(file).mtimeMs,
  };
}

/** Open a video through the Video menu, and wait for the player to reach its ready state. */
async function openVideo(toplevel, file) {
  await runFromMenu((css) => clickElement(toplevel, css), "video", "video-open");
  const chooser = await waitForChooser("Choose a video");
  await answerChooser(chooser, file, "video");
  focusWindow(toplevel.id);
  await waitFor(
    () =>
      browser.execute(
        () =>
          document.querySelector(".stage__empty") === null &&
          document.querySelector(".controls__button")?.disabled === false,
      ),
    { timeout: 30000, message: `${file} to reach the ready state` },
  );
}

/** The File menu's items in the order it draws them, by the token in each one's class. */
async function fileMenuOrder(toplevel) {
  await clickElement(toplevel, ".menubar__title--file");
  await waitFor(() => present(".menubar__menu"), {
    timeout: 15000,
    message: "the File menu to open",
  });
  const tokens = await browser.execute(() =>
    Array.from(document.querySelectorAll(".menubar__menu .menubar__item"))
      .map(
        (item) =>
          Array.from(item.classList)
            .find((name) => name.startsWith("menubar__item--"))
            ?.slice("menubar__item--".length) ?? "",
      )
      .filter((token) => token !== ""),
  );
  await clickElement(toplevel, ".menubar__title--file");
  await waitFor(async () => ((await present(".menubar__menu")) ? null : 1), {
    timeout: 15000,
    message: "the File menu to close",
  });
  return tokens;
}

async function waitForWindowNamed(expected) {
  let seen = [];
  return waitFor(
    () => {
      const windows = findWindowsWithAppGeometry();
      seen = windows.map((window) => window.name);
      // Any window of the app's own size, not the only one: a video open here puts mpv's surface on
      // the display beside it, and the count is not what this is about.
      return windows.find((window) => window.name === expected) ?? null;
    },
    { timeout: 20000, message: `the app's window to be named ${JSON.stringify(expected)}` },
  ).catch((error) => {
    throw new Error(`${error.message}; the windows there were named ${JSON.stringify(seen)}`);
  });
}

/** Wait for the File command to come alive, which it does once the track list has been read. */
async function waitForOpenFromVideoAlive(toplevel) {
  await waitFor(
    async () =>
      (await menuItemDisabled((css) => clickElement(toplevel, css), "file", "file-open-from-video"))
        ? null
        : 1,
    { timeout: 20000, message: "the command to come alive on a video that carries subtitles" },
  );
}

describe("opening the subtitles a video carries", () => {
  let toplevel = null;
  const twoSubs = requireTwoSubsFixture();
  const assSub = requireAssSubFixture();
  const noSubs = requireNoSubsFixture();
  const assBefore = fingerprint(assSub);

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

  it("is drawn after Open with encoding, and greyed with no video open", async () => {
    const order = await fileMenuOrder(toplevel);
    expect(order).toContain("file-open-from-video");
    expect(order.indexOf("file-open-from-video")).toBe(order.indexOf("file-open-encoding") + 1);
    expect(
      await menuItemDisabled((css) => clickElement(toplevel, css), "file", "file-open-from-video"),
    ).toBe(true);
  });

  it("stays greyed on a video that carries no subtitles at all", async () => {
    await openVideo(toplevel, noSubs);
    expect(
      await menuItemDisabled((css) => clickElement(toplevel, css), "file", "file-open-from-video"),
    ).toBe(true);
  });

  it("lights up on a video that carries text, and keeps an ASS stream as ASS", async () => {
    await openVideo(toplevel, assSub);
    await waitForOpenFromVideoAlive(toplevel);

    await runFromMenu((css) => clickElement(toplevel, css), "file", "file-open-from-video");
    await waitFor(async () => ((await gridTexts()).length === 2 ? 1 : null), {
      timeout: 20000,
      message: "the ASS stream's two cues to reach the grid",
    });
    const texts = await gridTexts();
    // An extraction that went through SubRip would have dropped both of these.
    expect(texts[0]).toContain("{\\i1}styled one{\\i0}");
    expect(texts[1]).toBe("styled two");
    expect(await textOf(".statusbar__document")).toContain("ASS");
  });

  it("carries the unsaved mark, because the cues are on no disk anywhere", async () => {
    // Not "Untitled" on its own: a document read out of a video has never been written, and the
    // mark is what stops it being closed without a word. The video is read-only, so there is
    // nowhere it came from to save back to either.
    await waitForWindowNamed(`${DIRTY_MARK}${UNTITLED} - ${windowTitle}`);
  });

  it("does not touch the video it read from", async () => {
    const after = fingerprint(assSub);
    expect(after.digest).toBe(assBefore.digest);
    expect(after.modified).toBe(assBefore.modified);
  });

  it("is refused while that work is unsaved, and takes the first of two streams after a discard", async () => {
    await openVideo(toplevel, twoSubs);
    await waitForOpenFromVideoAlive(toplevel);
    await runFromMenu((css) => clickElement(toplevel, css), "file", "file-open-from-video");
    // Discard comes alive exactly when an open is refused for unsaved work, so it is the reading
    // that says the refusal happened, the same one subtitle.spec.js takes.
    await waitFor(
      async () =>
        (await menuItemDisabled((css) => clickElement(toplevel, css), "file", "file-discard"))
          ? null
          : 1,
      { timeout: 20000, message: "Discard to come alive on the refused open" },
    );
    // Refused means refused: the ASS document is still the one on screen.
    expect((await gridTexts())[1]).toBe("styled two");

    await runFromMenu((css) => clickElement(toplevel, css), "file", "file-discard");
    await waitFor(async () => ((await gridTexts())[0] === "first track one" ? 1 : null), {
      timeout: 20000,
      message: "the video's own cues to arrive once the unsaved document was discarded",
    });
    // The second stream holds one cue reading "second track only", so this says which of the two
    // arrived rather than only that something did.
    expect(await gridTexts()).toEqual(["first track one", "first track two"]);
    expect(await textOf(".statusbar__document")).toContain("SRT");
  });
});
