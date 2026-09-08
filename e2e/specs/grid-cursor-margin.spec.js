/* global describe, it, before, document, window */
/**
 * The cursor keeps context when a move scrolls it into view. The reference keeps three rows below
 * the cursor as it scrolls a row into the bottom of the grid (interface-spec 7.3), so a move to a
 * row off the bottom lands the cursor three rows short of the edge rather than hard against it.
 *
 * Proved on a file longer than one screen: the cursor's own row and the grid's scroll are read
 * together, and the gap between them is what the margin makes.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow, pressKey } from "../lib/input.js";
import { repoRoot, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

/** Two thousand cues, far more than one screen holds. Read directly: it is never written. */
const FIXTURE = ["srt", "clean", "large-2000.srt"];
/** The grid's own row height, the number the windowing is built on (CueList.tsx `ROW_HEIGHT`). */
const ROW_HEIGHT = 28;

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

/** The cursor row, the first visible row, and how many rows the grid shows, together. */
function gridState() {
  return browser.execute((rowHeight) => {
    const list = document.querySelector(".cuelist");
    if (list === null) {
      return null;
    }
    const named = list.getAttribute("aria-activedescendant");
    const found = named === null ? null : /^cuelist-row-(\d+)$/.exec(named);
    return {
      cursor: found === null ? null : Number(found[1]),
      firstVisible: Math.floor(list.scrollTop / rowHeight),
      visible: Math.floor(list.clientHeight / rowHeight),
    };
  }, ROW_HEIGHT);
}

/** Click the number cell of the row at a 1-based position, which selects it and focuses the grid. */
async function selectRow(toplevel, position) {
  const centre = await browser.execute((wanted) => {
    const row = Array.from(document.querySelectorAll(".cuelist__row")).find(
      (candidate) => candidate.querySelector(".cuelist__pos")?.textContent === wanted,
    );
    const rect = row?.querySelector(".cuelist__pos")?.getBoundingClientRect();
    if (rect === undefined) {
      return null;
    }
    const dpr = window.devicePixelRatio;
    return { x: (rect.x + rect.width / 2) * dpr, y: (rect.y + rect.height / 2) * dpr };
  }, String(position));
  if (centre === null) {
    throw new Error(`row ${position} is not rendered`);
  }
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

describe("the cursor's margin as it scrolls into view", () => {
  let toplevel = null;

  before(async () => {
    const from = path.join(repoRoot, "fixtures", "subtitles", ...FIXTURE);
    if (!existsSync(from)) {
      throw new Error(`E2E prerequisite missing: ${from} does not exist. Restore it with git.`);
    }
    if (typeof process.env.SUBLORE_E2E_DATA_HOME !== "string") {
      throw new Error("SUBLORE_E2E_DATA_HOME is not set; e2e/wdio.conf.js sets it for every run.");
    }
    toplevel = await waitFor(findToplevel, {
      timeout: 30000,
      message: `the ${windowWidth}x${windowHeight} "Sublore" toplevel to appear`,
    });
    focusWindow(toplevel.id);
    await waitFor(() => present(".toolbar__file-open-subtitle"), {
      timeout: 30000,
      message: "the app UI to render",
    });
    await clickElement(toplevel, ".toolbar__file-open-subtitle");
    const chooser = await waitForChooser("Choose a subtitle");
    await answerChooser(chooser, from, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(() => present(".cuelist__row"), {
      timeout: 20000,
      message: "the large fixture to open",
    });
  });

  it("lands the cursor three rows above the bottom edge, not on it", async () => {
    await selectRow(toplevel, 1);
    const start = await waitFor(
      async () => {
        const state = await gridState();
        return state !== null && state.cursor === 0 ? state : null;
      },
      { timeout: 15000, message: "the cursor to be on the first row" },
    );
    // A screen this test is worth running on shows enough rows for a three-row margin to fit.
    expect(start.visible).toBeGreaterThan(6);

    // A page down moves the cursor off the bottom, which is what scrolls the grid to follow it.
    pressKey("Page_Down");
    const after = await waitFor(
      async () => {
        const state = await gridState();
        return state !== null && state.cursor !== null && state.cursor > 0 && state.firstVisible > 0
          ? state
          : null;
      },
      { timeout: 15000, message: "the grid to scroll the cursor down" },
    );
    // Three rows of the file are still below the cursor, so it sits at (visible − 3) from the top.
    expect(after.cursor - after.firstVisible).toBe(after.visible - 3);
  });
});
