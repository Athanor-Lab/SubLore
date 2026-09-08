/* global describe, it, before, document, window, Event */
/**
 * Open with encoding (interface-spec 9.8). The file picker, then a charset dialog: the user names
 * the encoding their file is in and the backend decodes it to UTF-8 before parsing. The two files
 * here are a Windows-1252 and a UTF-16LE subtitle whose accented text plain Open cannot read, one
 * because `0xE9` is not valid UTF-8 and one because of its wide byte-order mark.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
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

/** The target text of the cue at a given 1-based position, read the way find.spec.js reads it. */
function rowText(position) {
  return browser.execute((wanted) => {
    const row = Array.from(document.querySelectorAll(".cuelist__row")).find(
      (candidate) => candidate.querySelector(".cuelist__pos")?.textContent === wanted,
    );
    return row?.querySelector(".cuelist__text")?.textContent ?? null;
  }, position);
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
  const directory = path.join(dataHome, "open-encoding");
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

/**
 * The reference's order: File then Open with encoding raises the file picker, and only once a file
 * is chosen does the charset dialog appear. Name the charset in the select, then Open.
 */
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
  // Set the select the way the dialog's own onChange does; the native popup is never opened.
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

describe("Open with encoding", () => {
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

  it("reads a Windows-1252 file's accented text when Windows-1252 is named", async () => {
    await openWithEncoding(
      toplevel,
      workingCopy("windows-1252.srt", "srt", "encoded", "windows-1252.srt"),
      "windows-1252",
    );

    // 0xE9 decoded as é, not a parse error and not mojibake.
    expect(await rowText("1")).toBe("Café Metropol at the corner.");
    expect(await rowText("2")).toBe("Señora Núñez paid the bill.");
    expect(await rowText("3")).toBe("We left before the déjeuner.");
  });

  it("reads a UTF-16LE file when UTF-16LE is named", async () => {
    await openWithEncoding(
      toplevel,
      workingCopy("utf-16le.srt", "srt", "encoded", "utf-16le.srt"),
      "utf-16le",
    );

    // Plain Open refuses this file on its wide byte-order mark; named UTF-16LE, its BOM is stripped
    // and the same accented lines come through.
    expect(await rowText("1")).toBe("Café Metropol at the corner.");
    expect(await rowText("2")).toBe("Señora Núñez paid the bill.");
  });
});
