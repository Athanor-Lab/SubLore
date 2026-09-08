/* global describe, it, before, document, window */
/**
 * The status bar's timed message (interface-spec 1.5): a sentence a command pushes, cleared by its
 * own ten-second clock, replaced outright by the next push. The one v1 caller is the toolbar's
 * tag-display cycle, which reports the mode it switched to the way the reference reports it.
 */
import { browser, expect } from "@wdio/globals";

import { clickAt, focusWindow } from "../lib/input.js";
import { windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

const SIMPLIFY = "ASS Override Tag mode set to simplify tags.";
const HIDE = "ASS Override Tag mode set to hide tags.";

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

function noticeText() {
  return browser.execute(() => document.querySelector(".statusbar__notice")?.textContent ?? null);
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

describe("the status bar's timed message", () => {
  let toplevel = null;

  before(async () => {
    toplevel = await waitFor(findToplevel, {
      timeout: 30000,
      message: `the ${windowWidth}x${windowHeight} "Sublore" toplevel to appear`,
    });
    focusWindow(toplevel.id);
    await waitFor(() => present(".toolbar__view-tags-cycle"), {
      timeout: 30000,
      message: "the app UI to render",
    });
  });

  it("reports the cycle's landing, and clears itself after ten seconds", async () => {
    // A fresh app starts on show, so the first press lands on simplify.
    await clickElement(toplevel, ".toolbar__view-tags-cycle");
    await waitFor(async () => ((await noticeText()) === SIMPLIFY ? true : null), {
      timeout: 15000,
      message: "the cycle's report to land on the status bar",
    });

    // Ten seconds of silence clear it; nothing else on the bar moved to say so.
    await waitFor(async () => ((await noticeText()) === null ? true : null), {
      timeout: 20000,
      message: "the report to clear itself",
    });
    expect(await present(".statusbar__notice")).toBe(false);
  });

  it("a second push replaces the first and restarts the clock", async () => {
    await clickElement(toplevel, ".toolbar__view-tags-cycle");
    await waitFor(async () => ((await noticeText()) === HIDE ? true : null), {
      timeout: 15000,
      message: "the second cycle's report",
    });

    // Eight seconds in, push again: the new sentence gets a clock of its own.
    await browser.pause(8000);
    await clickElement(toplevel, ".toolbar__view-tags-cycle");
    const backToShow = "ASS Override Tag mode set to show full tags.";
    await waitFor(async () => ((await noticeText()) === backToShow ? true : null), {
      timeout: 15000,
      message: "the third cycle's report to replace the second",
    });

    // Four seconds later the first clock would have expired; the sentence is still there because
    // the clock is the second push's.
    await browser.pause(4000);
    expect(await noticeText()).toBe(backToShow);

    // And it still clears on its own once its ten seconds pass.
    await waitFor(async () => ((await noticeText()) === null ? true : null), {
      timeout: 20000,
      message: "the replacing report to clear on its own clock",
    });
  });
});
