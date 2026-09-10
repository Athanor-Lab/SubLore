/* global describe, it, before, after, document, window, Event */
/**
 * Preferences (interface-spec 9.6): the small set v1 keeps, three numbers a translator may change.
 * The defaults are the reference's own, inherited rather than reinvented (question 42), and what
 * the dialog stores is what the commands then use.
 *
 * The CPS limit is not here: decision 24 A8 fixes it for v1. The interface language is not here
 * either; it has a dialog of its own, and one state with two doors is what the command registry
 * exists to prevent.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow, pressKey } from "../lib/input.js";
import { repoRoot, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

/** Where the numbers land: app_data_dir() as Tauri resolves it, beside layout and language. */
function storePath() {
  const dataHome = process.env.SUBLORE_E2E_DATA_HOME;
  if (typeof dataHome !== "string" || dataHome === "") {
    throw new Error("SUBLORE_E2E_DATA_HOME is not set; e2e/wdio.conf.js sets it for every run.");
  }
  return path.join(dataHome, "com.sublore.app", "preferences.json");
}

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

function valueOf(selector) {
  return browser.execute((css) => document.querySelector(css)?.value ?? null, selector);
}

function gridRows() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".cuelist__row")).map((row) => ({
      start: row.querySelector(".cuelist__start")?.textContent ?? null,
      end: row.querySelector(".cuelist__end")?.textContent ?? null,
      cursor: row.classList.contains("cuelist__row--active"),
    })),
  );
}

/** The cursor onto the row carrying that number, by its position cell. */
/** How many grid rows are flagged over the reading rate, and whether the current line is. */
function overTheRate() {
  return browser.execute(() => ({
    rows: document.querySelectorAll(".cuelist__cps--over").length,
    line: document.querySelector(".currentline__cps--over") !== null,
  }));
}

async function cursorToRow(toplevel, number) {
  const centre = await browser.execute((wanted) => {
    const cell = Array.from(document.querySelectorAll(".cuelist__row"))
      .find((row) => row.querySelector(".cuelist__pos")?.textContent === wanted)
      ?.querySelector(".cuelist__pos");
    if (!cell) {
      return null;
    }
    const rect = cell.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    return { x: (rect.x + rect.width / 2) * dpr, y: (rect.y + rect.height / 2) * dpr };
  }, String(number));
  if (centre === null) {
    throw new Error(`row ${number} is missing from the grid`);
  }
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
  await waitFor(async () => ((await gridRows())[number - 1]?.cursor === true ? 1 : null), {
    timeout: 20000,
    message: `the cursor to reach row ${number}`,
  });
}

/** A timecode the grid drew, as the milliseconds the product reasons in (decision 11). */
function asMillis(timecode) {
  const parts = /^(\d+):(\d+):(\d+)\.(\d+)$/.exec(timecode ?? "");
  if (parts === null) {
    throw new Error(`"${timecode}" is not a timecode the grid draws`);
  }
  return (
    Number(parts[1]) * 3_600_000 +
    Number(parts[2]) * 60_000 +
    Number(parts[3]) * 1000 +
    Number(parts[4])
  );
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

function workingCopy() {
  const dataHome = process.env.SUBLORE_E2E_DATA_HOME;
  const directory = path.join(dataHome, "preferences");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const source = path.join(repoRoot, "fixtures", "subtitles", "srt", "clean", "basic-lf.srt");
  if (!existsSync(source)) {
    throw new Error(`E2E prerequisite missing: ${source}. Restore it with git.`);
  }
  const copy = path.join(directory, "basic-lf.srt");
  copyFileSync(source, copy);
  return copy;
}

async function openPreferences(toplevel) {
  await clickElement(toplevel, ".menubar__title--view");
  await waitFor(() => present(".menubar__item--view-preferences"), {
    timeout: 15000,
    message: "the View menu to open on its Preferences item",
  });
  await clickElement(toplevel, ".menubar__item--view-preferences");
  await waitFor(() => present(".preferences"), {
    timeout: 15000,
    message: "the Preferences dialog to open",
  });
}

async function waitForClosed() {
  await waitFor(async () => ((await present(".preferences")) ? null : 1), {
    timeout: 15000,
    message: "the Preferences dialog to close",
  });
}

/** Put a number in one of the three fields, replacing what is there. */
async function typeInto(field, value) {
  await browser.execute(
    (css, text) => {
      const input = document.querySelector(css);
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      ).set;
      setter.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
    `.preferences__${field}`,
    String(value),
  );
}

describe("Preferences", () => {
  let toplevel = null;

  before(async () => {
    const copy = workingCopy();
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
    await waitFor(() => present(".cuelist__row"), {
      timeout: 20000,
      message: "the fixture to open",
    });
  });

  // The store is shared with every other spec, so the numbers this one types are taken back out.
  // Left behind, a lead-in of 500 reaches the specs that run after this one and reddens them.
  after(() => {
    rmSync(storePath(), { force: true });
  });

  it("opens on the reference's own numbers, and Escape writes nothing", async () => {
    expect(existsSync(storePath())).toBe(false);

    await openPreferences(toplevel);
    expect(await valueOf(".preferences__leadInMs")).toBe("100");
    expect(await valueOf(".preferences__leadOutMs")).toBe("350");
    expect(await valueOf(".preferences__newCueMs")).toBe("3000");
    expect(await valueOf(".preferences__cpsLimit")).toBe("21");

    pressKey("Escape");
    await waitForClosed();
    expect(existsSync(storePath())).toBe(false);
  });

  it("stores what was typed, and the lead command uses it", async () => {
    const before = (await gridRows())[0];

    await openPreferences(toplevel);
    await typeInto("leadInMs", 500);
    await clickElement(toplevel, ".preferences__confirm");
    await waitForClosed();

    await waitFor(() => existsSync(storePath()), {
      timeout: 15000,
      message: "the numbers to land in preferences.json",
    });
    expect(JSON.parse(readFileSync(storePath(), "utf8")).leadInMs).toBe(500);

    // The command reads the store: the cursor's line starts half a second earlier, not a tenth.
    await clickElement(toplevel, ".cuelist__row .cuelist__pos");
    pressKey("c");
    const moved = await waitFor(
      async () => {
        const now = (await gridRows())[0];
        return now.start !== before.start ? now : null;
      },
      { timeout: 20000, message: "the lead-in to reach the grid" },
    );
    expect(asMillis(before.start) - asMillis(moved.start)).toBe(500);

    // One undo takes it back, like any other edit.
    await clickElement(toplevel, ".toolbar__edit-undo");
    await waitFor(async () => ((await gridRows())[0]?.start === before.start ? 1 : null), {
      timeout: 20000,
      message: "one undo to put the start back",
    });

    // And the dialog reopens holding what was stored.
    await openPreferences(toplevel);
    expect(await valueOf(".preferences__leadInMs")).toBe("500");
    pressKey("Escape");
    await waitForClosed();
  });

  it("refuses what is not a whole number of milliseconds, and stores nothing", async () => {
    const stored = readFileSync(storePath(), "utf8");

    await openPreferences(toplevel);
    await typeInto("newCueMs", "half a second");
    await clickElement(toplevel, ".preferences__confirm");

    // Refused where it was typed: the dialog stays open and says so, and the file is untouched.
    await waitFor(() => present(".preferences__refusal"), {
      timeout: 15000,
      message: "the refusal to be drawn",
    });
    expect(await present(".preferences")).toBe(true);
    expect(readFileSync(storePath(), "utf8")).toBe(stored);

    pressKey("Escape");
    await waitForClosed();
  });

  it("flags a different set of lines when the reading rate limit moves", async () => {
    // The fixture's three lines run at about 14.5, 24.6 and 13.5 characters a second, so the
    // default of 21 flags exactly the middle one. The counts are asserted rather than one row's
    // class: a limit that stopped being read would flag the same rows at every setting, and a
    // count catches that where a single row cannot (N103).
    await cursorToRow(toplevel, 1);
    expect(await overTheRate()).toEqual({ rows: 1, line: false });

    await openPreferences(toplevel);
    await typeInto("cpsLimit", 30);
    await clickElement(toplevel, ".preferences__confirm");
    await waitForClosed();
    await waitFor(async () => ((await overTheRate()).rows === 0 ? true : null), {
      timeout: 15000,
      message: "no line to be over a limit of 30",
    });

    await openPreferences(toplevel);
    await typeInto("cpsLimit", 5);
    await clickElement(toplevel, ".preferences__confirm");
    await waitForClosed();
    // Every line over, and the current line's band with them: they are two views of one row
    // (decision 5) and a limit that reached one and not the other would let them disagree.
    await waitFor(
      async () => {
        const now = await overTheRate();
        return now.rows === 3 && now.line ? now : null;
      },
      { timeout: 15000, message: "every line and the current line's band to be over a limit of 5" },
    );

    expect(JSON.parse(readFileSync(storePath(), "utf8")).cpsLimit).toBe(5);
  });

  it("makes a new cue as long as the preference says", async () => {
    await openPreferences(toplevel);
    await typeInto("newCueMs", 5000);
    await clickElement(toplevel, ".preferences__confirm");
    await waitForClosed();

    const rows = await gridRows();
    await cursorToRow(toplevel, rows.length);

    // Commit and go to next, on the last line, makes one to move on to. Its length is the number
    // the dialog was left holding, not the one the app started on.
    pressKey("shift+g");
    const grown = await waitFor(
      async () => {
        const now = await gridRows();
        return now.length > rows.length ? now : null;
      },
      { timeout: 20000, message: "the new line under the last" },
    );
    const made = grown[grown.length - 1];
    expect(asMillis(made.end) - asMillis(made.start)).toBe(5000);

    await clickElement(toplevel, ".toolbar__edit-undo");
    await waitFor(async () => ((await gridRows()).length === rows.length ? 1 : null), {
      timeout: 20000,
      message: "one undo to take the new line back",
    });
  });
});
