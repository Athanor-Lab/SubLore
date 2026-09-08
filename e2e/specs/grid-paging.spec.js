/* global describe, it, before, document, window */
/**
 * A page of the grid keeps two rows of context. The reference pages by the visible-row count less
 * two, so Page Down lands on the row at (visible − 2) rather than a whole fresh screen, and the two
 * rows above it were on the screen before (interface-spec 7.3).
 *
 * Proved on a file longer than one screen: the cursor's own row, read from the grid's
 * `aria-activedescendant`, moves by exactly that step and back.
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

/** How many whole rows the grid shows, which is what a page is measured against. */
function visibleRows() {
  return browser.execute((rowHeight) => {
    const list = document.querySelector(".cuelist");
    return list === null ? 0 : Math.floor(list.clientHeight / rowHeight);
  }, ROW_HEIGHT);
}

/** The zero-based index of the row the cursor is on, or null when the grid names none. */
function activeIndex() {
  return browser.execute(() => {
    const named = document.querySelector(".cuelist")?.getAttribute("aria-activedescendant");
    if (named === null || named === undefined) {
      return null;
    }
    const found = /^cuelist-row-(\d+)$/.exec(named);
    return found === null ? null : Number(found[1]);
  });
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

describe("paging the grid", () => {
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
    // The committed fixture is opened read-only; nothing writes it back, so no working copy.
    await answerChooser(chooser, from, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(() => present(".cuelist__row"), {
      timeout: 20000,
      message: "the large fixture to open",
    });
  });

  it("moves a page by the visible rows less two, and back", async () => {
    await selectRow(toplevel, 1);
    await waitFor(async () => ((await activeIndex()) === 0 ? 1 : null), {
      timeout: 15000,
      message: "the cursor to be on the first row",
    });

    const visible = await visibleRows();
    expect(visible).toBeGreaterThan(3); // a screen this test is worth running on shows several rows
    const step = Math.max(1, visible - 2);

    pressKey("Page_Down");
    await waitFor(async () => ((await activeIndex()) === step ? step : null), {
      timeout: 15000,
      message: `Page Down to land on row ${step}, two rows of context above it`,
    });

    pressKey("Page_Up");
    await waitFor(async () => ((await activeIndex()) === 0 ? 1 : null), {
      timeout: 15000,
      message: "Page Up to return to the first row",
    });
  });
});
