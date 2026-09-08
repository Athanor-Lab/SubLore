/* global describe, it, before, document, window */
/**
 * The one toolbar button that steps the tag-display setting through show, simplify and hide, which
 * the reference keeps on the toolbar and gives no menu of its own (interface-spec 4.1). It is a
 * registry command like any other, so its own greying and the radio it drives are drawn by the same
 * records the View menu draws.
 *
 * Proved through the View menu's own radio: each press of the toolbar button moves the checked mode
 * on by one, and three presses come back to where they started.
 */
import { browser, expect } from "@wdio/globals";

import { clickAt, focusWindow, pressKey } from "../lib/input.js";
import { windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

/** The order the modes step in, which is the order the reference steps them (grid.cpp). */
const ORDER = ["show", "simplify", "hide"];

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

/** Which of the three tag modes the View menu draws as checked, read with the menu open. */
function checkedMode() {
  return browser.execute((order) => {
    for (const mode of order) {
      const item = document.querySelector(`.menubar__item--view-tags-${mode}`);
      if (item !== null && item.getAttribute("aria-checked") === "true") {
        return mode;
      }
    }
    return null;
  }, ORDER);
}

/** Open the View menu, read the checked mode, and close the menu again. */
async function modeFromMenu(toplevel) {
  await clickElement(toplevel, ".menubar__title--view");
  await waitFor(() => present(".menubar__menu"), {
    timeout: 15000,
    message: "the View menu to open",
  });
  const mode = await checkedMode();
  await waitFor(
    async () => {
      if (!(await present(".menubar__menu"))) {
        return 1;
      }
      pressKey("Escape");
      return null;
    },
    { timeout: 15000, message: "the View menu to close" },
  );
  return mode;
}

describe("the tag-display cycle button", () => {
  let toplevel = null;

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

  it("steps the tag mode on by one each press, and wraps after three", async () => {
    const start = await modeFromMenu(toplevel);
    expect(ORDER).toContain(start);

    let mode = start;
    for (let press = 1; press <= 3; press += 1) {
      const expected = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
      await clickElement(toplevel, ".toolbar__view-tags-cycle");
      await waitFor(async () => ((await modeFromMenu(toplevel)) === expected ? 1 : null), {
        timeout: 15000,
        message: `the ${press} press to step the tag mode from ${mode} to ${expected}`,
      });
      mode = expected;
    }
    // Three presses through three modes come back to where they began.
    expect(mode).toBe(start);
  });
});
