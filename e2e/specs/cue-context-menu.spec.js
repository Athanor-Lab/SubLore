/* global describe, it, before, document, window */
/**
 * The grid's own context menu, which the reference opens on a right-click of a row (interface-spec
 * 3.9). It is drawn from the same registry as the menu bar, grouped with the same rules, and every
 * command on it reaches the one gate: a greyed item is inert, an enabled one runs and takes the
 * menu down.
 *
 * A right-click selects the row it lands on unless that row is already in the selection, so the
 * menu acts on what a translator meant to point at.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow, pressKey, rightClickAt } from "../lib/input.js";
import { takeCommands, watchCommands } from "../lib/ipc.js";
import { repoRoot, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

/** Three cues, which is enough to right-click one that is not the first. */
const FIXTURE = ["srt", "clean", "basic-lf.srt"];

function dataHome() {
  const home = process.env.SUBLORE_E2E_DATA_HOME;
  if (typeof home !== "string" || home === "") {
    throw new Error("SUBLORE_E2E_DATA_HOME is not set; e2e/wdio.conf.js sets it for every run.");
  }
  return home;
}

/** Writes go to the harness temp dir. The committed fixture is copied, never opened directly. */
function workingCopy() {
  const from = path.join(repoRoot, "fixtures", "subtitles", ...FIXTURE);
  if (!existsSync(from)) {
    throw new Error(`E2E prerequisite missing: ${from} does not exist. Restore it with git.`);
  }
  const directory = path.join(dataHome(), "cue-context-menu");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const copy = path.join(directory, "basic-lf.srt");
  copyFileSync(from, copy);
  return copy;
}

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

function count(selector) {
  return browser.execute((css) => document.querySelectorAll(css).length, selector);
}

/** The centre of an element in physical pixels, or null when it is not drawn. */
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

/** The centre of the row at a 1-based position, in physical pixels, or null when it is not drawn. */
function rowCentre(position) {
  return browser.execute((wanted) => {
    const row = Array.from(document.querySelectorAll(".cuelist__row")).find(
      (candidate) => candidate.querySelector(".cuelist__pos")?.textContent === wanted,
    );
    const rect = row?.getBoundingClientRect();
    if (rect === undefined) {
      return null;
    }
    const dpr = window.devicePixelRatio;
    return { x: (rect.x + rect.width / 2) * dpr, y: (rect.y + rect.height / 2) * dpr };
  }, String(position));
}

async function rightClickRow(toplevel, position) {
  const centre = await rowCentre(position);
  if (centre === null) {
    throw new Error(`row ${position} is not rendered`);
  }
  // No window manager under Xvfb, so the toplevel origin is also the viewport origin.
  rightClickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

async function clickRow(toplevel, position) {
  const centre = await rowCentre(position);
  if (centre === null) {
    throw new Error(`row ${position} is not rendered`);
  }
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

/** The 1-based positions of the rows that are selected. */
function selectedPositions() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".cuelist__row--selected"))
      .map((row) => row.querySelector(".cuelist__pos")?.textContent)
      .filter((position) => position !== null && position !== undefined),
  );
}

async function closeMenu() {
  await waitFor(
    async () => {
      if (!(await present(".railmenu"))) {
        return 1;
      }
      pressKey("Escape");
      return null;
    },
    { timeout: 15000, message: "the context menu to close" },
  );
}

describe("the grid's context menu", () => {
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

  it("opens on a right-click, grouped with rules, and selects the row it opened on", async () => {
    await rightClickRow(toplevel, 2);
    await waitFor(() => present(".railmenu"), {
      timeout: 15000,
      message: "the context menu to open on the right-click",
    });

    // Drawn from the registry, the way the reference's grid menu is (interface-spec 3.9).
    for (const key of [
      "insert-before",
      "duplicate",
      "split",
      "join-concat",
      "continuous-start",
      "cut",
      "copy",
      "paste",
      "paste-over",
      "delete",
    ]) {
      expect(await present(`.railmenu__item--${key}`)).toBe(true);
    }
    // Six groups, so five rules between them.
    expect(await count(".railmenu__separator")).toBe(5);

    // The right-click selected the row it landed on, and only that row.
    expect(await selectedPositions()).toEqual(["2"]);

    await closeMenu();
  });

  it("opens from the keyboard and closes on Escape", async () => {
    await clickRow(toplevel, 1);
    focusWindow(toplevel.id);
    await waitFor(() => selectedPositions().then((rows) => (rows.length === 1 ? 1 : null)), {
      timeout: 15000,
      message: "a row to be selected before the keyboard opens its menu",
    });

    // The menu key opens the context menu under the cursor row (interface-spec 3.9).
    pressKey("Menu");
    await waitFor(() => present(".railmenu"), {
      timeout: 15000,
      message: "the menu key to open the context menu",
    });

    pressKey("Escape");
    await waitFor(async () => ((await present(".railmenu")) ? null : 1), {
      timeout: 15000,
      message: "Escape to close the context menu",
    });
  });

  it("keeps a greyed command inert and runs an enabled one through the one gate", async () => {
    await rightClickRow(toplevel, 2);
    await waitFor(() => present(".railmenu"), {
      timeout: 15000,
      message: "the context menu to open",
    });
    // One row is selected, so join needs a second and is greyed.
    expect(
      await browser.execute(
        () =>
          document.querySelector(".railmenu__item--join-concat")?.getAttribute("aria-disabled") ===
          "true",
      ),
    ).toBe(true);

    await watchCommands();

    // A greyed item is inert: the click reaches the gate, which refuses it, and the menu stays up.
    await clickElement(toplevel, ".railmenu__item--join-concat");
    await browser.pause(300);
    expect(await present(".railmenu")).toBe(true);

    // An enabled one runs and takes the menu down.
    await clickElement(toplevel, ".railmenu__item--duplicate");
    await waitFor(async () => ((await present(".railmenu")) ? null : 1), {
      timeout: 15000,
      message: "the menu to close after an enabled command",
    });
    expect(await takeCommands()).toEqual(["subtitle_duplicate"]);
  });
});
