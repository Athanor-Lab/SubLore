/* global describe, it, before, document, window, WheelEvent */
/**
 * The wheel over the grid moves three rows a notch, a page with Shift held, and keeps the part of a
 * row a gesture does not spend (interface-spec 7.3). Before this the list was a plain scrolling box
 * and the browser decided the step, which is not the same number and with Shift is not even the
 * same axis.
 *
 * The notches are dispatched as `WheelEvent`s rather than pressed with the X server, the way
 * `waveform-view.spec.js` sends its own: one notch is 100 pixels of `deltaY`, which is what a
 * browser reports for a detent in pixel mode. A synthetic event never reaches the page's own
 * scrolling, so what the checks below read is the handler's work and nothing else; that the handler
 * takes the gesture away from the page is read off `defaultPrevented`, which a synthetic event does
 * carry.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow } from "../lib/input.js";
import { repoRoot, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

/** Two thousand cues, far more than one screen holds. Read directly: it is never written. */
const FIXTURE = ["srt", "clean", "large-2000.srt"];
/** The grid's own row height, the number the windowing is built on (CueList.tsx `ROW_HEIGHT`). */
const ROW_HEIGHT = 28;
/** One notch, in pixels of `deltaY`, and the rows one of them moves. */
const NOTCH_PX = 100;
const NOTCH_ROWS = 3;

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

async function clickElement(toplevel, selector) {
  const centre = await browser.execute((css) => {
    const rect = document.querySelector(css)?.getBoundingClientRect();
    if (rect === undefined) {
      return null;
    }
    const dpr = window.devicePixelRatio;
    return { x: (rect.x + rect.width / 2) * dpr, y: (rect.y + rect.height / 2) * dpr };
  }, selector);
  if (centre === null) {
    throw new Error(`${selector} is missing from the DOM`);
  }
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

/** Where the grid is scrolled to, in whole rows and in pixels, with the cursor it names. */
function gridAt() {
  return browser.execute(() => {
    const list = document.querySelector(".cuelist");
    if (list === null) {
      return null;
    }
    return {
      scrollTop: list.scrollTop,
      cursor: list.getAttribute("aria-activedescendant"),
      selected: Array.from(document.querySelectorAll(".cuelist__row--selected")).map(
        (row) => row.id,
      ),
    };
  });
}

/** How many whole rows the grid shows, which is what a page is measured against. */
function visibleRows() {
  return browser.execute((rowHeight) => {
    const list = document.querySelector(".cuelist");
    return list === null ? 0 : Math.floor(list.clientHeight / rowHeight);
  }, ROW_HEIGHT);
}

/**
 * One wheel gesture over the grid, in pixels of `deltaY`. Answers with whether the handler took the
 * gesture and where the grid stands after it.
 *
 * Dispatch and reading are one call because the handler sets `scrollTop` inside it: what comes back
 * is the element's own property straight after the gesture, with no frame to wait for and no window
 * in which something else could scroll it.
 */
async function wheel(deltaY, shift = false) {
  const after = await browser.execute(
    (delta, shifted) => {
      const list = document.querySelector(".cuelist");
      if (list === null) {
        return null;
      }
      const event = new WheelEvent("wheel", {
        deltaY: delta,
        deltaMode: 0,
        shiftKey: shifted,
        bubbles: true,
        cancelable: true,
      });
      list.dispatchEvent(event);
      return {
        cancelled: event.defaultPrevented,
        scrollTop: list.scrollTop,
        cursor: list.getAttribute("aria-activedescendant"),
        selected: Array.from(document.querySelectorAll(".cuelist__row--selected")).map(
          (row) => row.id,
        ),
      };
    },
    deltaY,
    shift,
  );
  if (after === null) {
    throw new Error("the grid is not in the DOM");
  }
  return after;
}

describe("the wheel over the grid", () => {
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

  it("moves three rows a notch, down and back up, and stops at the top", async () => {
    const start = await gridAt();
    expect(start.scrollTop).toBe(0);

    const down = await wheel(NOTCH_PX);
    expect(down.cancelled).toBe(true);
    expect(down.scrollTop).toBe(NOTCH_ROWS * ROW_HEIGHT);

    // The cursor and the selection are the view's passengers: the wheel moved neither.
    expect({ cursor: down.cursor, selected: down.selected }).toEqual({
      cursor: start.cursor,
      selected: start.selected,
    });

    const twice = await wheel(NOTCH_PX);
    expect(twice.scrollTop).toBe(2 * NOTCH_ROWS * ROW_HEIGHT);

    const back = await wheel(-NOTCH_PX);
    expect(back.scrollTop).toBe(NOTCH_ROWS * ROW_HEIGHT);

    // Two notches up from one notch down: the top is the floor, not a negative offset.
    const floor = await wheel(-2 * NOTCH_PX);
    expect(floor.scrollTop).toBe(0);
  });

  it("moves a page a notch with Shift held", async () => {
    const visible = await visibleRows();
    expect(visible).toBeGreaterThan(3); // a screen this test is worth running on shows several rows
    // The same page the Page Down key moves, which `grid-paging.spec.js` holds to this number.
    const page = Math.max(1, visible - 2);

    const start = await gridAt();
    expect(start.scrollTop).toBe(0);

    const down = await wheel(NOTCH_PX, true);
    expect(down.cancelled).toBe(true);
    expect(down.scrollTop).toBe(page * ROW_HEIGHT);
    expect(page).toBeGreaterThan(NOTCH_ROWS); // or this check would not tell the two steps apart

    const back = await wheel(-NOTCH_PX, true);
    expect(back.scrollTop).toBe(0);
  });

  it("keeps the part of a row a gesture does not spend", async () => {
    const start = await gridAt();
    expect(start.scrollTop).toBe(0);

    // Half a notch is a row and a half. The half is kept rather than dropped, so the second half
    // notch moves two rows and the pair of them moves what one whole notch moves.
    const first = await wheel(NOTCH_PX / 2);
    expect(first.scrollTop).toBe(ROW_HEIGHT);

    const second = await wheel(NOTCH_PX / 2);
    expect(second.scrollTop).toBe(NOTCH_ROWS * ROW_HEIGHT);

    const back = await wheel(-NOTCH_PX);
    expect(back.scrollTop).toBe(0);
  });
});
