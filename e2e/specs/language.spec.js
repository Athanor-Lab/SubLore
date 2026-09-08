/* global describe, it, before, document, window */
/**
 * View > Language (interface-spec 3.7 item 12): the interface languages Sublore ships, one chosen
 * and remembered beside the layout. The list holds English alone today, so what is asserted is the
 * dialog's own behaviour and the store: OK writes the choice, Escape and Cancel write nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { clickAt, focusWindow, pressKey } from "../lib/input.js";
import { windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

/** Where the choice lands: app_data_dir() as Tauri resolves it, the way interface-scale reads it. */
function storePath() {
  const dataHome = process.env.SUBLORE_E2E_DATA_HOME;
  if (typeof dataHome !== "string" || dataHome === "") {
    throw new Error("SUBLORE_E2E_DATA_HOME is not set; e2e/wdio.conf.js sets it for every run.");
  }
  return path.join(dataHome, "com.sublore.app", "language.json");
}

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

async function openLanguage(toplevel) {
  await clickElement(toplevel, ".menubar__title--view");
  await waitFor(() => present(".menubar__item--view-language"), {
    timeout: 15000,
    message: "the View menu to open on its Language item",
  });
  await clickElement(toplevel, ".menubar__item--view-language");
  await waitFor(() => present(".languagedialog"), {
    timeout: 15000,
    message: "the Language dialog to open",
  });
}

async function waitForClosed() {
  await waitFor(async () => ((await present(".languagedialog")) ? null : 1), {
    timeout: 15000,
    message: "the Language dialog to close",
  });
}

describe("View > Language", () => {
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

  it("lists English chosen, and Escape closes without writing anything", async () => {
    // Nothing has chosen a language this run, so the store starts absent.
    expect(existsSync(storePath())).toBe(false);

    await openLanguage(toplevel);
    const selected = await browser.execute(() => {
      const select = document.querySelector(".languagedialog__select");
      return {
        value: select?.value ?? null,
        options: Array.from(select?.options ?? []).map((option) => option.textContent),
      };
    });
    expect(selected).toEqual({ value: "en", options: ["English"] });

    pressKey("Escape");
    await waitForClosed();
    expect(existsSync(storePath())).toBe(false);
  });

  it("Cancel closes without writing anything either", async () => {
    await openLanguage(toplevel);
    await clickElement(toplevel, ".languagedialog__cancel");
    await waitForClosed();
    expect(existsSync(storePath())).toBe(false);
  });

  it("OK stores the choice beside the layout", async () => {
    await openLanguage(toplevel);
    await clickElement(toplevel, ".languagedialog__ok");
    await waitForClosed();

    await waitFor(() => existsSync(storePath()), {
      timeout: 15000,
      message: "the choice to land in language.json",
    });
    expect(JSON.parse(readFileSync(storePath(), "utf8"))).toEqual({ language: "en" });

    // Reopened, the stored language is the one selected.
    await openLanguage(toplevel);
    const value = await browser.execute(
      () => document.querySelector(".languagedialog__select")?.value ?? null,
    );
    expect(value).toBe("en");
    pressKey("Escape");
    await waitForClosed();
  });
});
