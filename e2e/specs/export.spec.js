/* global describe, it, before, document, window, Event */
/**
 * Export (interface-spec 3.1 item 9): a copy of the open document at a chosen destination, encoded
 * as a charset the user names. The reference's order is dialog first, then the destination chooser.
 * What cannot be encoded refuses the whole export and writes nothing: a substitution character in
 * a subtitle file is data loss, the same one-point departure the open-side decode took.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow } from "../lib/input.js";
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

function scratch(name) {
  const dataHome = process.env.SUBLORE_E2E_DATA_HOME;
  if (typeof dataHome !== "string" || dataHome === "") {
    throw new Error("SUBLORE_E2E_DATA_HOME is not set; e2e/wdio.conf.js sets it for every run.");
  }
  const directory = path.join(dataHome, "export");
  mkdirSync(directory, { recursive: true });
  return path.join(directory, name);
}

function workingCopy(name, ...from) {
  const copy = scratch(name);
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

/** The open-side flow: picker, then the charset dialog, then the decoded document. */
async function openWithEncoding(toplevel, copy, label) {
  await clickElement(toplevel, ".menubar__title--file");
  await waitFor(() => present(".menubar__item--file-open-encoding"), {
    timeout: 15000,
    message: "the File menu to open on its Open-with-encoding item",
  });
  await clickElement(toplevel, ".menubar__item--file-open-encoding");
  const chooser = await waitForChooser("Choose a subtitle");
  await answerChooser(chooser, copy, "subtitle");
  focusWindow(toplevel.id);
  await waitFor(() => present(".openencoding"), {
    timeout: 15000,
    message: "the charset dialog to open once a file is picked",
  });
  await browser.execute((value) => {
    const select = document.querySelector(".openencoding__select");
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, label);
  await clickElement(toplevel, ".openencoding__open");
  await waitFor(() => present(".cuelist__row"), {
    timeout: 20000,
    message: "the decoded fixture to open",
  });
}

/** The export flow: the charset dialog first, then the destination chooser (3.1 item 9). */
async function exportAs(toplevel, label, destination) {
  await clickElement(toplevel, ".menubar__title--file");
  await waitFor(() => present(".menubar__item--file-export"), {
    timeout: 15000,
    message: "the File menu to open on its Export item",
  });
  await clickElement(toplevel, ".menubar__item--file-export");
  await waitFor(() => present(".openencoding"), {
    timeout: 15000,
    message: "the export charset dialog to open",
  });
  await browser.execute((value) => {
    const select = document.querySelector(".openencoding__select");
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, label);
  await clickElement(toplevel, ".openencoding__open");
  const chooser = await waitForChooser("Save the subtitle as");
  await answerChooser(chooser, destination, "export destination");
  focusWindow(toplevel.id);
}

describe("Export", () => {
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

  it("writes a Windows-1252 copy whose accents are the legacy bytes, and adopts nothing", async () => {
    const source = workingCopy("windows-1252.srt", "srt", "encoded", "windows-1252.srt");
    await openWithEncoding(toplevel, source, "windows-1252");

    const destination = scratch("exported-1252.srt");
    rmSync(destination, { force: true });
    await exportAs(toplevel, "windows-1252", destination);
    await waitFor(() => existsSync(destination), {
      timeout: 20000,
      message: "the exported copy to land on disk",
    });

    // The é is the single 0xE9 byte again: the copy round-trips the legacy code page.
    const bytes = readFileSync(destination);
    expect(bytes.includes(0xe9)).toBe(true);
    expect(bytes.includes(0xc3)).toBe(false);
    // The document on screen kept its own file: the export adopted nothing.
    expect(await textOf(".statusbar__error")).toBe(null);

    // The exported copy opens back through the same charset and shows the same first cue.
    await openWithEncoding(toplevel, destination, "windows-1252");
    const first = await browser.execute(
      () => document.querySelector(".cuelist__row .cuelist__text")?.textContent ?? null,
    );
    expect(first).toBe("Café Metropol at the corner.");
  });

  it("refuses a charset that cannot hold the document, and writes nothing", async () => {
    await openSubtitle(toplevel, workingCopy("arrow.srt", "srt", "clean", "arrow.srt"));

    const destination = scratch("refused.srt");
    rmSync(destination, { force: true });
    await exportAs(toplevel, "windows-1252", destination);

    // The arrow has no Windows-1252 byte, so the export refuses and the destination stays absent.
    await waitFor(
      async () =>
        (await textOf(".statusbar__error")) ===
        "The document holds a character the chosen charset cannot write. Nothing was exported.",
      { timeout: 20000, message: "the refusal to land on the status bar" },
    );
    expect(existsSync(destination)).toBe(false);
  });
});
