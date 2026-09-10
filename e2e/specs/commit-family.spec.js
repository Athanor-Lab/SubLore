/* global describe, it, before, document, window */
/**
 * The commit family (interface-spec 5): with auto-commit off, which is what Sublore ships, a marker
 * drag is held rather than written, and one of the three commits writes it. Auto-advance decides
 * where the cursor goes after a plain commit.
 *
 * The line change is the one place Sublore does not copy the reference, which discards pending
 * changes outright there: CLAUDE.md §3 forbids losing a translator's work in silence, so the change
 * of line commits instead. That is the assumption this slice was built on, and the last check here
 * is what proves it.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, dragAt, focusWindow, pressKey } from "../lib/input.js";
import { repoRoot, requireWaveformFixture, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { closeAnyOpenProject } from "../lib/rail.js";
import { findToplevel } from "../lib/x11.js";

/** The fixture's second cue, as the grid draws its times. */
const SECOND_START = "00:00:05.000";
const SECOND_END = "00:00:08.340";

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

function gridRows() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".cuelist__row")).map((row) => ({
      start: row.querySelector(".cuelist__start")?.textContent ?? null,
      end: row.querySelector(".cuelist__end")?.textContent ?? null,
      cursor: row.classList.contains("cuelist__row--active"),
    })),
  );
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

function workingCopy() {
  const dataHome = process.env.SUBLORE_E2E_DATA_HOME;
  if (typeof dataHome !== "string" || dataHome === "") {
    throw new Error("SUBLORE_E2E_DATA_HOME is not set; e2e/wdio.conf.js sets it for every run.");
  }
  const directory = path.join(dataHome, "commit-family");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const source = path.join(repoRoot, "fixtures", "subtitles", "srt", "clean", "basic-lf.srt");
  if (!existsSync(source)) {
    throw new Error(`E2E prerequisite missing: ${source}. Restore it with git.`);
  }
  const copy = path.join(directory, "basic-lf.srt");
  copyFileSync(source, copy);
  return copy;
}

/** The canvas box in device pixels, which is what a drag is measured in. */
async function canvasBox() {
  return browser.execute(() => {
    const canvas = document.querySelector(".waveform__canvas");
    if (canvas === null) {
      return null;
    }
    const box = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    return { x: box.x * dpr, midY: (box.y + box.height / 2) * dpr, width: canvas.width };
  });
}

/** The start marker's column, by its own colour, the way waveform-timing finds it. */
function startColumn() {
  return browser.execute(() => {
    const canvas = document.querySelector(".waveform__canvas");
    if (canvas === null) {
      return null;
    }
    const root = window.getComputedStyle(document.documentElement);
    const hex = root.getPropertyValue("--marker-start").trim().replace("#", "");
    const want = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16));
    const middle = Math.floor(canvas.height / 2);
    const row = canvas.getContext("2d").getImageData(0, middle, canvas.width, 1).data;
    for (let x = 0; x < canvas.width; x += 1) {
      const at = x * 4;
      const off =
        Math.abs(row[at] - want[0]) +
        Math.abs(row[at + 1] - want[1]) +
        Math.abs(row[at + 2] - want[2]);
      if (off <= 6) {
        return x;
      }
    }
    return null;
  });
}

async function dragColumns(toplevel, fromColumn, byColumns) {
  const box = await canvasBox();
  if (box === null) {
    throw new Error(".waveform__canvas is missing from the DOM");
  }
  const y = toplevel.absY + box.midY;
  const fromX = toplevel.absX + box.x + fromColumn;
  dragAt(fromX, y, fromX + byColumns, y);
  await browser.pause(400);
}

/** Put the cursor on a row by clicking its position cell. */
async function cursorToRow(toplevel, position) {
  const centre = await browser.execute((wanted) => {
    const cell = Array.from(document.querySelectorAll(".cuelist__row"))
      .find((row) => row.querySelector(".cuelist__pos")?.textContent === wanted)
      ?.querySelector(".cuelist__pos");
    if (!cell) {
      return null;
    }
    const rect = cell.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    return { x: (rect.x + rect.width / 2) * dpr, y: (rect.y + rect.height / 2) * dpr };
  }, position);
  if (centre === null) {
    throw new Error(`row ${position} is missing from the DOM`);
  }
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
  await waitFor(
    async () => ((await gridRows())[Number(position) - 1]?.cursor === true ? 1 : null),
    { timeout: 15000, message: `the cursor to reach row ${position}` },
  );
}

/**
 * Press one of the panel's own strip buttons. The reference draws the commits and their toggles on
 * the audio box's strip and in no menu at all (its `default_menu.json` names none of them), so that
 * is where Sublore draws them too.
 */
/** The three commits are keyboard commands: the reference draws no variant in any menu, and the
 *  panel's strip has no room to grow without taking it out of the wave. G, Shift+G, Ctrl+G. */
function commitKey(which) {
  pressKey(which === "plain" ? "g" : which === "next" ? "shift+g" : "alt+g");
}

/** Drag the start marker a little later and answer with where it was before. */
async function dragStartLater(toplevel) {
  const at = await startColumn();
  if (at === null) {
    throw new Error("no start marker is drawn to grab");
  }
  await dragColumns(toplevel, at, 12);
  // Waited for, not slept through: the callers assert the marker moved, which is a positive claim
  // about something the drag does asynchronously, and 400 ms was a guess (N93).
  await waitFor(
    async () => {
      const now = await startColumn();
      return now !== null && now > at ? now : null;
    },
    { timeout: 15000, interval: 100, message: `the start marker to move past column ${at}` },
  );
  return at;
}

describe("the commit family", () => {
  let toplevel = null;

  before(async () => {
    requireWaveformFixture();
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
    const subtitle = await waitForChooser("Choose a subtitle");
    await answerChooser(subtitle, copy, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(() => present(".cuelist__row"), {
      timeout: 20000,
      message: "the fixture to open",
    });

    await clickElement(toplevel, ".toolbar__video-open");
    const video = await waitForChooser("Choose a video");
    await answerChooser(video, requireWaveformFixture(), "video");
    focusWindow(toplevel.id);
    await waitFor(() => present(".waveform__canvas"), {
      timeout: 40000,
      message: "the waveform panel to appear",
    });
    await cursorToRow(toplevel, "2");
    await waitFor(async () => ((await startColumn()) === null ? null : 1), {
      timeout: 20000,
      message: "the cursor's cue to draw its start marker",
    });
  });

  it("holds a drag until a commit writes it, and stays where it was", async () => {
    const before = await dragStartLater(toplevel);

    // The document has not moved: the grid still draws the times the file holds.
    const held = await gridRows();
    expect(held[1].start).toBe(SECOND_START);
    expect(held[1].end).toBe(SECOND_END);
    // The wave draws the marker where the hand left it, which is what makes the pending visible.
    const after = await startColumn();
    expect(after).toBeGreaterThan(before);

    // Commit and stay: the times land, the cursor does not move.
    commitKey("stay");
    const written = await waitFor(
      async () => {
        const rows = await gridRows();
        return rows[1]?.start !== SECOND_START ? rows : null;
      },
      { timeout: 20000, message: "the committed start to reach the grid" },
    );
    expect(written[1].end).toBe(SECOND_END);
    expect(written[1].cursor).toBe(true);

    // One undo takes the whole commit back.
    await clickElement(toplevel, ".toolbar__edit-undo");
    await waitFor(async () => ((await gridRows())[1]?.start === SECOND_START ? 1 : null), {
      timeout: 20000,
      message: "one undo to put the times back",
    });
  });

  it("moves on after a plain commit, and creates a line past the last one", async () => {
    await cursorToRow(toplevel, "2");
    // Nothing dragged: a commit with no pending still walks the file, which is the workflow.
    commitKey("plain");
    await waitFor(async () => ((await gridRows())[2]?.cursor === true ? 1 : null), {
      timeout: 20000,
      message: "a plain commit to move on to the third row",
    });

    // On the last row, commit-and-next has nowhere to go, so it makes somewhere.
    const before = (await gridRows()).length;
    commitKey("next");
    const rows = await waitFor(
      async () => {
        const now = await gridRows();
        return now.length > before ? now : null;
      },
      { timeout: 20000, message: "commit-and-next to make a line past the last" },
    );
    expect(rows.length).toBe(before + 1);
    expect(rows[rows.length - 1].cursor).toBe(true);

    await clickElement(toplevel, ".toolbar__edit-undo");
    await waitFor(async () => ((await gridRows()).length === before ? 1 : null), {
      timeout: 20000,
      message: "one undo to take the made line back",
    });
  });

  it("commits the pending markers when the line changes, rather than dropping them", async () => {
    await cursorToRow(toplevel, "2");
    await waitFor(async () => ((await startColumn()) === null ? null : 1), {
      timeout: 20000,
      message: "the second cue's start marker",
    });
    await dragStartLater(toplevel);
    // Still pending: the grid holds the file's times.
    expect((await gridRows())[1].start).toBe(SECOND_START);

    // The line changes with the markers uncommitted. The reference would drop them here.
    await cursorToRow(toplevel, "1");
    const written = await waitFor(
      async () => {
        const rows = await gridRows();
        return rows[1]?.start !== SECOND_START ? rows : null;
      },
      { timeout: 20000, message: "the line change to commit what was pending" },
    );
    expect(written[1].end).toBe(SECOND_END);

    // And it is one undo step like any other commit, so nothing was lost either way.
    await clickElement(toplevel, ".toolbar__edit-undo");
    await waitFor(async () => ((await gridRows())[1]?.start === SECOND_START ? 1 : null), {
      timeout: 20000,
      message: "one undo to put the committed times back",
    });
  });
});
