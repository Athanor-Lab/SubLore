/* global describe, it, before, document, window */
/**
 * Project properties, read-only in v1 (interface-spec 9.5). It opens the script-level metadata the
 * open file carries: an ASS file's title, resolution and wrap style, read off its `[Script Info]`
 * section; a format that has no such section says so rather than showing rows that read "not set".
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow, pressKey } from "../lib/input.js";
import { repoRoot, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

function textOf(selector) {
  return browser.execute((css) => document.querySelector(css)?.textContent ?? null, selector);
}

function fixture(...parts) {
  const file = path.join(repoRoot, "fixtures", "subtitles", ...parts);
  if (!existsSync(file)) {
    throw new Error(`E2E prerequisite missing: ${file} does not exist. Restore it with git.`);
  }
  return file;
}

/** A writable copy of a committed fixture, since opening one never writes it but a spec should not
 *  depend on that by opening the committed file directly. */
function workingCopy(name, ...from) {
  const dataHome = process.env.SUBLORE_E2E_DATA_HOME;
  if (typeof dataHome !== "string" || dataHome === "") {
    throw new Error("SUBLORE_E2E_DATA_HOME is not set; e2e/wdio.conf.js sets it for every run.");
  }
  const directory = path.join(dataHome, "properties");
  mkdirSync(directory, { recursive: true });
  const copy = path.join(directory, name);
  rmSync(copy, { force: true });
  copyFileSync(fixture(...from), copy);
  return copy;
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

async function openSubtitle(toplevel, copy) {
  await clickElement(toplevel, ".toolbar__file-open-subtitle");
  const chooser = await waitForChooser("Choose a subtitle");
  await answerChooser(chooser, copy, "subtitle");
  focusWindow(toplevel.id);
  await waitFor(() => present(".cuelist__row"), {
    timeout: 20000,
    message: "the fixture to open",
  });
}

/** Open the File menu and click Project properties, then wait for its dialog to be up. */
async function openProperties(toplevel) {
  await clickElement(toplevel, ".menubar__title--file");
  await waitFor(() => present(".menubar__item--file-properties"), {
    timeout: 15000,
    message: "the File menu to open on its Properties item",
  });
  await clickElement(toplevel, ".menubar__item--file-properties");
  await waitFor(() => present(".properties"), {
    timeout: 15000,
    message: "the Project properties dialog to open",
  });
}

async function closeProperties() {
  pressKey("Escape");
  await waitFor(async () => ((await present(".properties")) ? null : 1), {
    timeout: 15000,
    message: "Escape to close the dialog",
  });
}

describe("the Project properties dialog", () => {
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

  it("shows an ASS file's title, resolution and wrap style", async () => {
    await openSubtitle(toplevel, workingCopy("basic.ass", "ass", "clean", "basic.ass"));
    await openProperties(toplevel);

    expect(await textOf(".properties__title")).toBe("Nordic Line - Episode 03");
    expect(await textOf(".properties__resolution")).toBe("1920 x 1080");
    expect(await textOf(".properties__wrap-style")).toBe("0");
    // The ASS file carries every field, so the dialog draws no "no metadata" line.
    expect(await present(".properties__empty")).toBe(false);

    await closeProperties();
  });

  it("says a format with no script metadata carries none", async () => {
    await openSubtitle(toplevel, workingCopy("basic.srt", "srt", "clean", "basic-lf.srt"));
    await openProperties(toplevel);

    // An SRT has no [Script Info], so the dialog says so and every field reads "not set".
    expect(await present(".properties__empty")).toBe(true);
    expect(await textOf(".properties__title")).toBe("not set");
    expect(await textOf(".properties__resolution")).toBe("not set");

    await closeProperties();
  });
});
