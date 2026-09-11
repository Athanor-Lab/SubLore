/* global describe, it, before, document, window */
/**
 * N151: a double-click in the current line's text box takes the format's word, not the browser's.
 *
 * Interface-spec §8.5 gives this row the scope v1: "Double-click selects the format tokenizer's
 * notion of a word, not a whitespace-delimited run". A plain textarea would take `an8` out of
 * `{\an8\pos(320,50)}`, which is not a thing a translator ever wants on its own.
 *
 * The assertions are built from the box's own value rather than from a counted offset, so the check
 * says what it means and does not go stale if the fixture's first line is ever reworded.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, doubleClickAt, focusWindow } from "../lib/input.js";
import { repoRoot, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

/** Its first cue opens with a long override block and then four plain words. */
const FIXTURE = ["ass", "clean", "override-tags.ass"];

function dataHome() {
  const home = process.env.SUBLORE_E2E_DATA_HOME;
  if (typeof home !== "string" || home === "") {
    throw new Error("SUBLORE_E2E_DATA_HOME is not set; e2e/wdio.conf.js sets it for every run.");
  }
  return home;
}

function workingCopy() {
  const from = path.join(repoRoot, "fixtures", "subtitles", ...FIXTURE);
  if (!existsSync(from)) {
    throw new Error(`E2E prerequisite missing: ${from}. It is committed; restore it with git.`);
  }
  const directory = path.join(dataHome(), "text-tokens");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const copy = path.join(directory, "override-tags.ass");
  copyFileSync(from, copy);
  return copy;
}

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
    throw new Error(`${selector} is missing from the DOM, so there is nothing to click`);
  }
  // No window manager under Xvfb, so the toplevel origin is also the viewport origin.
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

/** The text box's rectangle on the display, so a click can be aimed inside its first line. */
async function boxRect(toplevel) {
  const rect = await browser.execute(() => {
    const found = document.querySelector(".currentline__text")?.getBoundingClientRect();
    if (found === undefined) {
      return null;
    }
    const dpr = window.devicePixelRatio;
    return { x: found.x * dpr, y: found.y * dpr, height: found.height * dpr };
  });
  if (rect === null) {
    throw new Error(".currentline__text is missing from the DOM");
  }
  return { x: toplevel.absX + rect.x, y: toplevel.absY + rect.y, height: rect.height };
}

/** What the box holds and what of it is selected. */
function selection() {
  return browser.execute(() => {
    const box = document.querySelector(".currentline__text");
    return box === null
      ? null
      : { value: box.value, taken: box.value.slice(box.selectionStart, box.selectionEnd) };
  });
}

describe("a double-click in the text box takes the format's word", () => {
  let toplevel = null;
  let copy = null;

  before(async () => {
    copy = workingCopy();
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
    await answerChooser(chooser, copy, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(
      async () => ((await selection())?.value.startsWith("{\\an8") === true ? 1 : null),
      { timeout: 20000, message: "the fixture's first line to reach the text box" },
    );
  });

  it("takes the whole braced run, not the one word inside it the browser sees", async () => {
    const rect = await boxRect(toplevel);
    // A few pixels in from the left of the first line, which is inside the opening block whatever
    // the font measures at: the block is thirty characters and the box starts with it.
    doubleClickAt(rect.x + 14, rect.y + 10);

    const read = await waitFor(
      async () => {
        const now = await selection();
        return now !== null && now.taken !== "" ? now : null;
      },
      { timeout: 15000, message: "the double-click to select something" },
    );
    const run = read.value.slice(0, read.value.indexOf("}") + 1);
    expect(run.length).toBeGreaterThan(10);
    // The browser alone would have taken `an8` or `pos`, three characters out of thirty.
    expect(read.taken).toBe(run);
  });

  it("still takes one word where the text is plain", async () => {
    const rect = await boxRect(toplevel);
    const read0 = await selection();
    // Far enough right to be past the block and inside the words after it.
    doubleClickAt(rect.x + 420, rect.y + 10);

    const read = await waitFor(
      async () => {
        const now = await selection();
        return now !== null && now.taken !== "" && now.taken !== read0.taken ? now : null;
      },
      { timeout: 15000, message: "the second double-click to select something else" },
    );
    // One of the plain words, whole and on its own: not the block, and not a run across a space.
    expect(read.taken).toMatch(/^[A-Z]+$/);
    expect(read.value.slice(read.value.indexOf("}") + 1)).toContain(read.taken);
  });
});
