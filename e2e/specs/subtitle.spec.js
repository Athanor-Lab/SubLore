/* global describe, it, before, document, window */
import { Buffer } from "node:buffer";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { menuItemDisabled, runFromMenu } from "../lib/menu.js";
import { clickAt, focusWindow, pressKey, typeText } from "../lib/input.js";
import { repoRoot, windowHeight, windowTitle, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel, findWindowsWithAppGeometry } from "../lib/x11.js";

/** What the status line says for the clean fixtures this spec opens, one per format in v1 scope. */
const LF_STATUS = "SRT · 3 cues · LF";
const CRLF_STATUS = "SRT · 3 cues · CRLF";
const ASS_STATUS = "ASS · 3 cues · CRLF";
const VTT_STATUS = "VTT · 3 cues · LF";
/** missing-arrow.srt loses its arrow on line 6; the sidecar next to the fixture says so too. */
const MALFORMED_LINE = "Line 6";
const NO_FILE_STATUS = "No subtitle file open.";
/** The cue the discard check edits, 1-based in the list, and what it types over the text there. */
const DISCARD_POSITION = 1;
const DISCARD_TEXT = "Typed and then thrown away";

/** Subtitle fixtures are committed, unlike the video one: a missing file is a broken checkout. */
function fixture(...parts) {
  const file = path.join(repoRoot, "fixtures", "subtitles", ...parts);
  if (!existsSync(file)) {
    throw new Error(
      `E2E prerequisite missing: ${file} does not exist. It is committed; restore it with \`git checkout fixtures/subtitles\`.`,
    );
  }
  return file;
}

/** Writes go to the harness temp dir, never into the repo and never beside a fixture. */
function saveDirectory() {
  const dataHome = process.env.SUBLORE_E2E_DATA_HOME;
  if (typeof dataHome !== "string" || dataHome === "") {
    throw new Error("SUBLORE_E2E_DATA_HOME is not set; e2e/wdio.conf.js sets it for every run.");
  }
  const directory = path.join(dataHome, "save-as");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  return directory;
}

/**
 * Every backup the app has kept for one file, by the name it gives them.
 *
 * `XDG_DATA_HOME/<identifier>/backups`, the identifier being the one in `tauri.conf.json`. Held to
 * one file rather than counting the whole store: other checks in this file write too, and what is
 * being read here is what the save that overwrote **this** file left behind.
 */
function backupsOf(file) {
  const root = path.join(process.env.SUBLORE_E2E_DATA_HOME, "com.sublore.app", "backups");
  if (!existsSync(root)) {
    return [];
  }
  const named = new RegExp(
    `^${path.basename(file).replace(/\./gu, "\\.")}\\.\\d{8}-\\d{6}(-\\d{1,2})?\\.bak$`,
    "u",
  );
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (named.test(entry.name)) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found;
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

/** The text a row shows, by 1-based list position, or null when that row is not rendered. */
function rowText(position) {
  return browser.execute((wanted) => {
    const rows = Array.from(document.querySelectorAll(".cuelist__row"));
    const row = rows.find(
      (candidate) => candidate.querySelector(".cuelist__pos")?.textContent === wanted,
    );
    return row?.querySelector(".cuelist__text")?.textContent ?? null;
  }, String(position));
}

function textOf(selector) {
  return browser.execute((css) => document.querySelector(css)?.textContent ?? null, selector);
}

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

/**
 * What the window says it is holding: the document's name, and whether the session still has
 * unsaved work in it. The two hypotheses N30 poses are told apart by exactly this, and it needs
 * nothing added to the app now that the window carries the document (N57).
 */
function heldDocument() {
  const windows = findWindowsWithAppGeometry();
  const name = windows.length === 1 ? windows[0].name : null;
  const suffix = ` - ${windowTitle}`;
  if (typeof name !== "string" || !name.endsWith(suffix)) {
    return null;
  }
  const document_ = name.slice(0, -suffix.length);
  return { name: document_.replace(/^\* /, ""), dirty: document_.startsWith("* ") };
}

/** A drawn control's greying, or null when the control is not drawn at all. */

/** Open a subtitle through the system chooser, which is the only route since T1. */
async function openSubtitle(toplevel, file) {
  await clickElement(toplevel, ".toolbar__file-open-subtitle");
  const chooser = await waitForChooser("Choose a subtitle");
  await answerChooser(chooser, file, "subtitle");
  focusWindow(toplevel.id);
}

/** Name the file in the save chooser. Its filename field is what the destination box used to be. */
async function saveAsTo(toplevel, destination) {
  await runFromMenu((css) => clickElement(toplevel, css), "file", "file-save-as");
  const chooser = await waitForChooser("Save the subtitle as");
  await answerChooser(chooser, destination, "save as");
  focusWindow(toplevel.id);
}

/** Save the open document elsewhere and prove the written file holds the bytes that were opened. */
async function savesIdenticalCopy(toplevel, source, saveDir) {
  const destination = path.join(saveDir, path.basename(source));

  await saveAsTo(toplevel, destination);
  await waitFor(async () => (await textOf(".statusbar__message"))?.includes(destination) === true, {
    timeout: 20000,
    message: `the status line to report the file written at ${destination}`,
  });

  expect(await textOf(".statusbar__error")).toBe(null);
  // The point of the whole milestone: what came back out is what went in, byte for byte.
  expect(Buffer.compare(readFileSync(source), readFileSync(destination))).toBe(0);
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

describe("subtitle open and save", () => {
  let toplevel = null;
  let saveDir = null;

  before(async () => {
    saveDir = saveDirectory();
    toplevel = await waitFor(findToplevel, {
      timeout: 30000,
      message: `the ${windowWidth}x${windowHeight} "Sublore" toplevel to appear`,
    });
    focusWindow(toplevel.id);
    await waitFor(
      () => browser.execute(() => document.querySelector(".toolbar__file-open-subtitle") !== null),
      {
        timeout: 30000,
        message: "the subtitle bar to render",
      },
    );
  });

  it("opens an SRT fixture and shows its format and cue count", async () => {
    await openSubtitle(toplevel, fixture("srt", "clean", "basic-lf.srt"));

    expect(await waitForStatus(LF_STATUS)).toBe(LF_STATUS);
    expect(await textOf(".statusbar__error")).toBe(null);
  });

  it("saves a byte-identical copy", async () => {
    const source = fixture("srt", "clean", "basic-crlf.srt");

    await openSubtitle(toplevel, source);
    await waitForStatus(CRLF_STATUS);

    await savesIdenticalCopy(toplevel, source, saveDir);
  });

  // SRT is not the format range: CONTRIBUTING.md section 1 puts ASS and VTT in v1 with the same
  // lossless promise, and until these two the app was only ever driven through one of the three.
  it("opens an ASS fixture and saves a byte-identical copy", async () => {
    const source = fixture("ass", "clean", "basic.ass");

    await openSubtitle(toplevel, source);
    expect(await waitForStatus(ASS_STATUS)).toBe(ASS_STATUS);
    expect(await textOf(".statusbar__error")).toBe(null);

    await savesIdenticalCopy(toplevel, source, saveDir);
  });

  it("opens a VTT fixture and saves a byte-identical copy", async () => {
    const source = fixture("vtt", "clean", "basic.vtt");

    await openSubtitle(toplevel, source);
    expect(await waitForStatus(VTT_STATUS)).toBe(VTT_STATUS);
    expect(await textOf(".statusbar__error")).toBe(null);

    await savesIdenticalCopy(toplevel, source, saveDir);
  });

  it("reports a malformed file readably and stays usable", async () => {
    await openSubtitle(toplevel, fixture("srt", "malformed", "missing-arrow.srt"));

    const message = await waitFor(
      async () => {
        const text = await textOf(".statusbar__error");
        return text !== null && text.trim() !== "" ? text : null;
      },
      { timeout: 20000, message: "the subtitle error line to appear" },
    );
    expect(message).toContain(MALFORMED_LINE);
    expect(await textOf(".statusbar__document")).toBe(NO_FILE_STATUS);

    // Still usable: the clean fixture opens straight afterwards, with the error line gone.
    await openSubtitle(toplevel, fixture("srt", "clean", "basic-lf.srt"));
    expect(await waitForStatus(LF_STATUS)).toBe(LF_STATUS);
    expect(await textOf(".statusbar__error")).toBe(null);
  });

  it("goes on editing the file it was saved as, leaving the one it came from alone", async () => {
    // The difference between Save as and a copy, and the only place it shows: what the next save
    // writes. See interface-spec 3.1, item 8.
    const from = path.join(saveDir, "before-save-as.srt");
    copyFileSync(fixture("srt", "clean", "basic-lf.srt"), from);
    const opened = readFileSync(from);
    const to = path.join(saveDir, "after-save-as.srt");

    await openSubtitle(toplevel, from);
    await waitForStatus(LF_STATUS);
    await saveAsTo(toplevel, to);
    await waitFor(async () => (await textOf(".statusbar__message"))?.includes(to) === true, {
      timeout: 20000,
      message: `the status line to report the file written at ${to}`,
    });
    // What the file holds before the save below overwrites it, read from the file rather than
    // assumed to be the source's bytes: the backup has to hold these.
    const overwritten = readFileSync(to);

    await clickRow(toplevel, DISCARD_POSITION);
    await waitFor(() => present(".cuelist__editor"), {
      timeout: 15000,
      message: "the inline editor to open",
    });
    pressKey("ctrl+a");
    typeText(DISCARD_TEXT);
    pressKey("Return");
    await waitFor(async () => (await rowText(DISCARD_POSITION)) === DISCARD_TEXT, {
      timeout: 20000,
      message: `row ${DISCARD_POSITION} to hold the edit`,
    });

    // Save, with no chooser: the document has a file, and it is the one it was saved as.
    await clickElement(toplevel, ".toolbar__file-save");
    await waitFor(async () => ((await present(".statusbar__dirty")) === false ? true : null), {
      timeout: 20000,
      message: "the document to be saved without asking where",
    });
    expect(readFileSync(to, "utf8")).toContain(DISCARD_TEXT);
    // And the file it came from is every byte it was, edit and all.
    expect(readFileSync(from).equals(opened)).toBe(true);

    // The save above overwrote a file that was already there, which CONTRIBUTING.md section 3.3
    // says is never done without keeping what was overwritten. Not "a backup exists": one holding
    // the **old** bytes, because a backup of what was just written protects nothing (N74). The
    // rule had one guard and it was the close gate's, which the battery never runs (N141).
    const kept = backupsOf(to);
    expect(kept.length).toBe(1);
    expect(readFileSync(kept[0]).equals(overwritten)).toBe(true);
  });

  it("throws an unsaved edit away and writes nothing when the edit is discarded", async () => {
    // The committed fixture is copied first: the file the app is pointed at here is one it may
    // legitimately write to, so a defect shows up as a changed copy rather than a changed fixture.
    const file = path.join(saveDir, "discard-basic-lf.srt");
    copyFileSync(fixture("srt", "clean", "basic-lf.srt"), file);
    const opened = readFileSync(file);

    await openSubtitle(toplevel, file);
    await waitForStatus(LF_STATUS);
    const original = await rowText(DISCARD_POSITION);
    expect(original).not.toBe(null);

    await clickRow(toplevel, DISCARD_POSITION);
    await waitFor(() => present(".cuelist__editor"), {
      timeout: 15000,
      message: "the inline editor to open",
    });
    pressKey("ctrl+a");
    typeText(DISCARD_TEXT);
    pressKey("Return");
    await waitFor(async () => (await rowText(DISCARD_POSITION)) === DISCARD_TEXT, {
      timeout: 20000,
      message: `row ${DISCARD_POSITION} to hold the edit`,
    });
    expect(await present(".statusbar__dirty")).toBe(true);

    // Discard is drawn from the start and usable only where it is meant: an open the unsaved edit
    // refused. Reopening the same file is that refusal at its plainest, and what comes back is the
    // file on disk (owner ruling 2026-09-03).
    expect(
      await menuItemDisabled((css) => clickElement(toplevel, css), "file", "file-discard"),
    ).toBe(true);
    await openSubtitle(toplevel, file);
    await waitFor(
      async () =>
        (await menuItemDisabled((css) => clickElement(toplevel, css), "file", "file-discard")) ===
        false
          ? true
          : null,
      { timeout: 20000, message: "the discard button to come alive once the edit refused an open" },
    );
    // The two readings taken together at the moment of the refusal, which is what N30 asked for:
    // the row, and what the session says it is holding. If the row ever goes back to the file's own
    // text here while the window still carries the unsaved mark, the grid and the session disagree
    // and it is the grid that is wrong. The failure then says which of the two it was.
    const held = heldDocument();
    expect({ row: await rowText(DISCARD_POSITION), held }).toEqual({
      row: DISCARD_TEXT,
      held: { name: path.basename(file), dirty: true },
    });

    await runFromMenu((css) => clickElement(toplevel, css), "file", "file-discard");
    await waitFor(async () => (await rowText(DISCARD_POSITION)) === original, {
      timeout: 20000,
      message: `row ${DISCARD_POSITION} to go back to the text it was opened with`,
    });
    expect(await waitForStatus(LF_STATUS)).toBe(LF_STATUS);
    expect(await present(".statusbar__dirty")).toBe(false);
    // Back to greyed, and still drawn: there is nothing left to discard.
    expect(
      await menuItemDisabled((css) => clickElement(toplevel, css), "file", "file-discard"),
    ).toBe(true);
    expect(await present(".statusbar__error")).toBe(false);
    // Discarding is not a write: the file is still every byte it was opened with.
    expect(readFileSync(file).equals(opened)).toBe(true);
  });
});
