/* global describe, it, before, document, window */
/**
 * Decision 7: the open subtitle document is on the video frame, in either order, and View turns it
 * off and on again.
 *
 * What is asserted, and what is not. The harness cannot read the picture: `video-surface.spec.js`
 * says in its own header why nothing in CI asserts pixels under Xvfb and llvmpipe, and that has not
 * changed. What is asserted instead is mpv's own answer about the overlay it holds, which the app
 * reads back off mpv after every change and writes into its log: how many external subtitle tracks
 * there are, whether the document's own is selected, whether it is visible, and how many characters
 * long the line at the playhead is. That is one step short of the glyphs, and it is the strongest
 * signal this harness can reach: the count only moves when mpv has really read the document that
 * was just written.
 *
 * The two fixtures open on a cue that already covers the frame a paused player shows at zero, so
 * nothing here has to seek before it can ask what is on screen.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import { browser, expect } from "@wdio/globals";

import { appLog } from "../lib/applog.js";
import { runFromMenu } from "../lib/menu.js";
import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow, pressKey, typeText } from "../lib/input.js";
import { repoRoot, requireVideoFixture, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

/** The first cue of each fixture, which is the line covering the frame at zero. */
const LONG_FIRST_CUE = "The ferry runs at six, not before.";
const SHORT_FIRST_CUE = "Bring the nets in.";
/** Typed over the short fixture's first cue. Its length is what proves the edit reached mpv. */
const EDITED_FIRST_CUE = "Nets in, all of them.";
/** The row the edit lands on, 1-based in the cue list. */
const FIRST_ROW = 1;

const LONG_STATUS = "SRT · 3 cues · LF";
const SHORT_STATUS = "SRT · 2 cues · LF";

function dataHome() {
  const home = process.env.SUBLORE_E2E_DATA_HOME;
  if (typeof home !== "string" || home === "") {
    throw new Error("SUBLORE_E2E_DATA_HOME is not set; e2e/wdio.conf.js sets it for every run.");
  }
  return home;
}

function fixture(name) {
  const file = path.join(repoRoot, "fixtures", "subtitles", "srt", "clean", name);
  if (!existsSync(file)) {
    throw new Error(
      `E2E prerequisite missing: ${file} does not exist. It is committed; restore it with \`git checkout fixtures/subtitles\`.`,
    );
  }
  return file;
}

/** A folder of the harness's own, so the file this spec edits is never a committed fixture. */
function workingDirectory() {
  const directory = path.join(dataHome(), "preview");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  return directory;
}

/** Everything the app has kept in its backup store, so a preview adding to it would show up. */
function backups() {
  const store = path.join(dataHome(), "com.sublore.app", "backups");
  return existsSync(store) ? readdirSync(store, { recursive: true }).sort() : [];
}

/** The last thing the app said about the overlay mpv holds, or null before it has said anything. */
function lastDrawn() {
  const lines = appLog(dataHome())
    .split("\n")
    .filter((line) => line.includes("preview: mpv holds the document"));
  return lines.at(-1) ?? null;
}

/**
 * The newest thing the app said about the frame, whichever of its two reports that was.
 *
 * `lastDrawn` reads only the report mpv answers with. This one also sees the report the app writes
 * when there is no frame at all, which is the only thing outside the window that says the media was
 * really let go.
 */
function lastPreviewReport() {
  const lines = appLog(dataHome())
    .split("\n")
    .filter(
      (line) =>
        line.includes("preview: mpv holds the document") ||
        line.includes("preview: the document is shadowed"),
    );
  return lines.at(-1) ?? null;
}

/**
 * Wait until the app's newest report about the overlay contains `expected`.
 *
 * The newest and not any: the log keeps every line, so "somewhere in the file" would let a reading
 * from before a toggle answer for the state after it.
 */
/**
 * Which of the four facts differs, rather than two long strings to compare by eye.
 *
 * The wait below matches `external tracks 1, selected yes, visible no, 21 chars at the playhead`
 * as one string, so any one of the four being momentarily other than wanted fails the whole thing
 * and the failure named none of them (N95).
 */
function whatDiffers(expected, line) {
  if (line === null) {
    return "the app has said nothing about the overlay yet";
  }
  const want = expected.split(", ");
  const said = line.slice(line.indexOf("external tracks")).split(", ");
  const off = [];
  for (let index = 0; index < want.length; index += 1) {
    if (said[index] !== want[index]) {
      off.push(
        `wanted ${JSON.stringify(want[index])}, saw ${JSON.stringify(said[index] ?? "nothing")}`,
      );
    }
  }
  return off.length === 0
    ? `every field matches, so the line itself is shaped differently: ${line}`
    : off.join("; ");
}

async function waitForDrawn(expected, what, timeout = 30000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const line = lastDrawn();
    if (line !== null && line.includes(expected)) {
      return line;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `the app never reported ${what} within ${timeout}ms. ${whatDiffers(expected, line)}. ` +
          `It last said: ${line ?? "(nothing about the overlay yet)"}`,
      );
    }
    await sleep(100);
  }
}

/** What one line of the given length looks like in the app's report. */
function drawing(chars) {
  return `external tracks 1, selected yes, visible yes, ${chars} chars at the playhead`;
}

/** Centre of an element in physical pixels, which is what X11 pointer coordinates are. */
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
    throw new Error(`${selector} is missing from the DOM`);
  }
  // No window manager under Xvfb, so the toplevel origin is also the viewport origin.
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

function textOf(selector) {
  return browser.execute((css) => document.querySelector(css)?.textContent ?? null, selector);
}

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

/** Click the text cell of the row at a 1-based list position, which opens its inline editor. */
async function clickRow(toplevel, position) {
  const centre = await browser.execute((wanted) => {
    const rows = Array.from(document.querySelectorAll(".cuelist__row"));
    const row = rows.find(
      (candidate) => candidate.querySelector(".cuelist__pos")?.textContent === wanted,
    );
    const cell = row?.querySelector(".cuelist__text");
    if (!cell) {
      return null;
    }
    const rect = cell.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    return { x: (rect.x + rect.width / 2) * dpr, y: (rect.y + rect.height / 2) * dpr };
  }, String(position));
  if (centre === null) {
    throw new Error(`row ${position} is missing from the DOM`);
  }
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

function rowText(position) {
  return browser.execute((wanted) => {
    const rows = Array.from(document.querySelectorAll(".cuelist__row"));
    const row = rows.find(
      (candidate) => candidate.querySelector(".cuelist__pos")?.textContent === wanted,
    );
    return row?.querySelector(".cuelist__text")?.textContent ?? null;
  }, String(position));
}

async function waitForStatus(expected) {
  return waitFor(
    async () => {
      const status = await textOf(".statusbar__document");
      return status !== null && status.startsWith(expected) ? status : null;
    },
    {
      timeout: 20000,
      message: `the subtitle status line to start with ${JSON.stringify(expected)}`,
    },
  );
}

async function openSubtitle(toplevel, file) {
  await clickElement(toplevel, ".toolbar__file-open-subtitle");
  const chooser = await waitForChooser("Choose a subtitle");
  await answerChooser(chooser, file, "subtitle");
  focusWindow(toplevel.id);
}

async function openVideo(toplevel, file) {
  await runFromMenu((css) => clickElement(toplevel, css), "video", "video-open");
  const chooser = await waitForChooser("Choose a video");
  await answerChooser(chooser, file, "video");
  focusWindow(toplevel.id);
}

/** Whether the item is marked, read off the menu it lives in, which is Video (interface-spec 3.4). */
async function subtitlesChecked(toplevel) {
  await clickElement(toplevel, ".menubar__title--video");
  await waitFor(() => present(".menubar__item--video-toggle-subtitle-overlay"), {
    timeout: 15000,
    message: "the Video menu to open on its subtitle item",
  });
  return browser.execute(
    () =>
      document
        .querySelector(".menubar__item--video-toggle-subtitle-overlay")
        ?.getAttribute("aria-checked") === "true",
  );
}

/** Open View and choose the subtitle toggle. */
async function toggleSubtitles(toplevel) {
  const before = await subtitlesChecked(toplevel);
  await clickElement(toplevel, ".menubar__item--video-toggle-subtitle-overlay");
  return !before;
}

/** The state of the other toggle: which of the two documents the frame draws. See S3. */
async function sourceOnVideo(toplevel) {
  await clickElement(toplevel, ".menubar__title--video");
  await waitFor(() => present(".menubar__item--video-show-source-on-video"), {
    timeout: 15000,
    message: "the Video menu to open on its source item",
  });
  return browser.execute(() => {
    const item = document.querySelector(".menubar__item--video-show-source-on-video");
    return item === null
      ? null
      : { checked: item.getAttribute("aria-checked") === "true", disabled: item.disabled === true };
  });
}

/** Open View and choose the source toggle, answering with the state it moves to. */
async function toggleSource(toplevel) {
  const before = await sourceOnVideo(toplevel);
  await clickElement(toplevel, ".menubar__item--video-show-source-on-video");
  return !before.checked;
}

/** Open a second document to read from, through the File menu. */
async function openSource(toplevel, file) {
  await clickElement(toplevel, ".menubar__title--file");
  await waitFor(() => present(".menubar__item--file-open-source"), {
    timeout: 15000,
    message: "the File menu to open on its source item",
  });
  await clickElement(toplevel, ".menubar__item--file-open-source");
  const chooser = await waitForChooser("Choose a subtitle");
  await answerChooser(chooser, file, "subtitle");
  focusWindow(toplevel.id);
}

describe("the document on the video frame", () => {
  let toplevel = null;
  let working = null;
  let longCopy = null;
  let shortCopy = null;
  let openedBytes = null;

  before(async () => {
    requireVideoFixture();
    working = workingDirectory();
    // Copies, never the committed fixtures: a preview that wrote to the file it draws from would
    // show up here as a changed copy rather than as a changed fixture in the repository.
    longCopy = path.join(working, "starts-at-zero.srt");
    shortCopy = path.join(working, "starts-at-zero-short.srt");
    copyFileSync(fixture("starts-at-zero.srt"), longCopy);
    copyFileSync(fixture("starts-at-zero-short.srt"), shortCopy);
    openedBytes = readFileSync(shortCopy);

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

  it("puts a document that was open first onto a video opened after it", async () => {
    await openSubtitle(toplevel, longCopy);
    expect(await waitForStatus(LONG_STATUS)).toBe(LONG_STATUS);

    await openVideo(toplevel, requireVideoFixture());
    await waitFor(
      () =>
        browser.execute(
          () =>
            document.querySelector(".stage__empty") === null &&
            document.querySelector(".controls__button")?.disabled === false,
        ),
      { timeout: 30000, message: "the video fixture to reach the ready state" },
    );

    await waitForDrawn(
      drawing(LONG_FIRST_CUE.length),
      `the ${LONG_FIRST_CUE.length} characters of the first cue on the frame`,
    );
    expect(await textOf(".statusbar__preview-error")).toBe(null);
  });

  it("puts a document opened while the video is already loaded onto the frame", async () => {
    await openSubtitle(toplevel, shortCopy);
    expect(await waitForStatus(SHORT_STATUS)).toBe(SHORT_STATUS);

    // The other order of the same pair, which is the half of the bug that had no test.
    await waitForDrawn(
      drawing(SHORT_FIRST_CUE.length),
      `the ${SHORT_FIRST_CUE.length} characters of the second fixture on the frame`,
    );
  });

  it("puts an edit on the frame without stacking a second subtitle track", async () => {
    await clickRow(toplevel, FIRST_ROW);
    await waitFor(() => present(".cuelist__editor"), {
      timeout: 15000,
      message: "the inline editor to open",
    });
    pressKey("ctrl+a");
    typeText(EDITED_FIRST_CUE);
    pressKey("Return");
    await waitFor(async () => (await rowText(FIRST_ROW)) === EDITED_FIRST_CUE, {
      timeout: 20000,
      message: `row ${FIRST_ROW} to hold the edit`,
    });

    // "external tracks 1" is the other half of the assertion: mpv re-reads the file it already has
    // rather than loading a second copy of it, so an edit does not cost a track.
    await waitForDrawn(
      drawing(EDITED_FIRST_CUE.length),
      `the edited line's ${EDITED_FIRST_CUE.length} characters on the frame, on one track`,
    );
  });

  it("takes the document off the frame from the Video menu, and puts it back", async () => {
    expect(await toggleSubtitles(toplevel)).toBe(false);
    await waitForDrawn(
      `external tracks 1, selected yes, visible no, ${EDITED_FIRST_CUE.length} chars at the playhead`,
      "the overlay turned off while mpv still holds the document",
    );

    expect(await toggleSubtitles(toplevel)).toBe(true);
    await waitForDrawn(
      drawing(EDITED_FIRST_CUE.length),
      "the overlay turned back on with the same line under it",
    );
    // Turning it back on is not a re-open: the item is marked again and nothing was reloaded.
    expect(await subtitlesChecked(toplevel)).toBe(true);
    await clickElement(toplevel, ".menubar__title--video");
  });

  it("draws the source on the frame while the toggle asks for it, and the translation again after", async () => {
    // Greyed until there is a second document: there would be nothing else to draw (S3).
    expect(await sourceOnVideo(toplevel)).toEqual({ checked: false, disabled: true });
    pressKey("Escape");

    await openSource(toplevel, longCopy);
    await waitFor(
      async () => ((await textOf(".statusbar__document"))?.includes("Source:") === true ? 1 : null),
      { timeout: 20000, message: "the source to open beside the document being written" },
    );
    expect(await sourceOnVideo(toplevel)).toEqual({ checked: false, disabled: false });
    pressKey("Escape");

    // Both first cues start at zero, so the playhead is inside each of them and the length on the
    // frame is the whole of what changes: 21 characters of the edited line, 34 of the source's.
    expect(await toggleSource(toplevel)).toBe(true);
    await waitForDrawn(
      drawing(LONG_FIRST_CUE.length),
      `the source's ${LONG_FIRST_CUE.length} characters on the frame`,
    );

    expect(await toggleSource(toplevel)).toBe(false);
    await waitForDrawn(
      drawing(EDITED_FIRST_CUE.length),
      `the translation's ${EDITED_FIRST_CUE.length} characters back on the frame`,
    );
    await clickElement(toplevel, ".menubar__title--video");
  });

  it("jumps the picture to the current line's start and to its end, from the Video menu", async () => {
    const clock = () =>
      browser.execute(() => document.querySelector(".controls__time")?.textContent ?? null);
    const fromVideoMenu = async (token) => {
      await clickElement(toplevel, ".menubar__title--video");
      await waitFor(() => present(`.menubar__item--${token}`), {
        timeout: 15000,
        message: `the Video menu to open on ${token}`,
      });
      await clickElement(toplevel, `.menubar__item--${token}`);
    };

    // The short fixture is the open document and its first cue runs 0 to 9 seconds, so the two
    // jumps land on two readings a clock can tell apart.
    await clickRow(toplevel, FIRST_ROW);
    await fromVideoMenu("video-jump-cue-end");
    await waitFor(async () => ((await clock())?.startsWith("00:00:09") === true ? 1 : null), {
      timeout: 15000,
      message: "the picture to jump to the line's end",
    });

    await fromVideoMenu("video-jump-cue-start");
    await waitFor(async () => ((await clock())?.startsWith("00:00:00") === true ? 1 : null), {
      timeout: 15000,
      message: "the picture to jump back to the line's start",
    });
  });

  it("closes the video and leaves the document where it was", async () => {
    const fromVideoMenu = async (token) => {
      await clickElement(toplevel, ".menubar__title--video");
      await waitFor(() => present(`.menubar__item--${token}`), {
        timeout: 15000,
        message: `the Video menu to open on ${token}`,
      });
      await clickElement(toplevel, `.menubar__item--${token}`);
    };

    await fromVideoMenu("video-close");
    // Nothing is loaded any more: the stage says so and the transport cannot be pressed.
    await waitFor(
      () =>
        browser.execute(
          () =>
            document.querySelector(".stage__empty") !== null &&
            document.querySelector(".controls__button")?.disabled === true,
        ),
      { timeout: 20000, message: "the stage to go back to saying nothing is open" },
    );
    expect(await textOf(".statusbar__video-error")).toBe(null);

    // Whether mpv really let the media go is not on screen, and the interface alone would say the
    // same thing if the file were still loaded. The app says it the next time it has something to
    // draw, so an edit is made here and the report that follows it is read.
    await runFromMenu((css) => clickElement(toplevel, css), "edit", "edit-undo");
    await waitFor(
      async () =>
        lastPreviewReport()?.includes("no video is open to draw it on") === true ? 1 : null,
      { timeout: 20000, message: "the app to report it has no frame to draw the document on" },
    );
    await runFromMenu((css) => clickElement(toplevel, css), "edit", "edit-redo");
    await waitFor(async () => ((await rowText(FIRST_ROW)) === EDITED_FIRST_CUE ? 1 : null), {
      timeout: 15000,
      message: "the redo to put the edited line back",
    });

    // Nothing left to close, so the item that closed it is greyed and stays drawn (24 A2).
    await clickElement(toplevel, ".menubar__title--video");
    await waitFor(() => present(".menubar__item--video-close"), {
      timeout: 15000,
      message: "the Video menu to open on its close item",
    });
    expect(
      await browser.execute(
        () => document.querySelector(".menubar__item--video-close")?.disabled ?? null,
      ),
    ).toBe(true);
    pressKey("Escape");
    await waitFor(async () => ((await present(".menubar__item--video-close")) ? null : 1), {
      timeout: 15000,
      message: "the Video menu to close",
    });

    // The document is untouched by any of it: closing a video is not closing a subtitle.
    expect(await textOf(".statusbar__document")).toContain(SHORT_STATUS);

    // And the same video opens again straight afterwards, because the player never went down.
    await openVideo(toplevel, requireVideoFixture());
    await waitFor(
      () =>
        browser.execute(
          () =>
            document.querySelector(".stage__empty") === null &&
            document.querySelector(".controls__button")?.disabled === false,
        ),
      { timeout: 30000, message: "the video fixture to reach the ready state again" },
    );
    await waitForDrawn(
      drawing(EDITED_FIRST_CUE.length),
      "the document back on the frame after a second open",
    );
  });

  it("never writes the subtitle file it is drawing from, and keeps no backup of it", async () => {
    const kept = backups();
    const before = statSync(shortCopy);

    // Everything above has already happened to this document: it was opened, drawn, edited and
    // toggled, and none of it is a save. The file is still the one that was opened.
    expect(readFileSync(shortCopy).equals(openedBytes)).toBe(true);
    expect(statSync(shortCopy).mtimeMs).toBe(before.mtimeMs);
    // Nothing new landed beside it either: a shadow copy in the user's own folder is the failure
    // this asserts against (CONTRIBUTING.md section 3).
    expect(readdirSync(working).sort()).toEqual(
      [path.basename(longCopy), path.basename(shortCopy)].sort(),
    );
    // And no backup was taken, because nothing was overwritten to make a picture.
    expect(backups()).toEqual(kept);
    expect(await present(".statusbar__dirty")).toBe(true);
  });
});
