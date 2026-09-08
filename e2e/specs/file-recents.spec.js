/* global describe, it, before, document, window */
/**
 * File > Recent projects (interface-spec 3.1 item 5). The remembered projects, newest first,
 * numbered, at most ten (decision 24 D5); with nothing remembered the list holds one greyed
 * placeholder row instead of greying itself.
 *
 * Every spec in a run shares one data home, so specs before this one have usually remembered
 * projects already. The empty state is therefore made, not assumed: every remembered project is
 * opened from the list and deleted through the rail, which prunes it from the list too
 * (session.rs forgotten()), until the placeholder is what remains.
 */
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { dataHome } from "../lib/applog.js";
import { clickAt, focusWindow, pressKey } from "../lib/input.js";
import { windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import {
  chooseRailItem,
  closeAnyOpenProject,
  confirmRailDialog,
  openProjectMenu,
} from "../lib/rail.js";
import { findToplevel } from "../lib/x11.js";

/** More rounds than the list can hold, so a cleanup that is not emptying it fails loudly. */
const CLEANUP_ROUNDS = 12;

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

/** Open the File menu on its Recent projects row, then open that row's own list. */
async function openRecentList(toplevel) {
  await clickElement(toplevel, ".menubar__title--file");
  await waitFor(() => present(".menubar__submenu--file-recent"), {
    timeout: 15000,
    message: "the File menu to open on its Recent projects row",
  });
  await clickElement(toplevel, ".menubar__submenu--file-recent");
  await waitFor(() => present(".menubar__menu--sub"), {
    timeout: 15000,
    message: "the Recent projects list to open",
  });
}

/** The rows of the open recent list: id token, label and greying, in drawn order. */
function recentRows() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".menubar__menu--sub button")).map((row) => ({
      id: row.id.replace("menuitem-", ""),
      label: row.querySelector(".menubar__label")?.textContent ?? null,
      disabled: row.disabled,
    })),
  );
}

async function closeMenus() {
  pressKey("Escape");
  pressKey("Escape");
  await waitFor(async () => ((await present(".menubar__menu")) ? null : 1), {
    timeout: 15000,
    message: "the menus to close",
  });
}

/**
 * Empty the remembered list through the app itself: open the newest remembered project from the
 * list and delete it through the rail, which prunes it from the list too, until the placeholder
 * is what the list holds. Earlier specs remember projects and this one may run after any of them.
 */
async function deleteEveryRememberedProject(toplevel) {
  for (let round = 0; round < CLEANUP_ROUNDS; round += 1) {
    await openRecentList(toplevel);
    const rows = await recentRows();
    if (rows.length === 1 && rows[0].id === "file-recent-empty") {
      await closeMenus();
      return;
    }
    await clickElement(toplevel, `.menubar__item--${rows[0].id}`);
    await waitFor(() => present(".rail__project"), {
      timeout: 20000,
      message: `the project behind ${rows[0].label} to open from the list`,
    });
    await openProjectMenu(toplevel);
    await chooseRailItem(toplevel, "delete-project");
    await confirmRailDialog(toplevel);
    await waitFor(() => present(".rail__empty"), {
      timeout: 20000,
      message: "the rail to empty once the remembered project is deleted",
    });
  }
  throw new Error(`the remembered list was not empty after ${CLEANUP_ROUNDS} deletions`);
}

/** Make a project in a fresh folder through the rail, the way a person does. */
async function createProject(toplevel, folder) {
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  await openProjectMenu(toplevel);
  await chooseRailItem(toplevel, "create-project");
  const chooser = await waitForChooser("Choose a project folder");
  await answerChooser(chooser, folder, "project folder");
  focusWindow(toplevel.id);
  await waitFor(
    async () => {
      const title = await browser.execute(
        () => document.querySelector(".rail__project")?.getAttribute("title") ?? null,
      );
      return title !== null && title.includes(folder) ? title : null;
    },
    { timeout: 20000, message: `the rail to hold the project at ${folder}` },
  );
}

/** Close the open project through the rail, leaving the remembered list as it is. */
async function closeProject(toplevel) {
  await openProjectMenu(toplevel);
  await chooseRailItem(toplevel, "close-project");
  await confirmRailDialog(toplevel);
  await waitFor(() => present(".rail__empty"), {
    timeout: 20000,
    message: "the rail to empty after the close",
  });
}

describe("File > Recent projects", () => {
  let toplevel = null;
  const nordwind = path.join(dataHome(), "file-recents", "nordwind");
  const sirkka = path.join(dataHome(), "file-recents", "sirkka");

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
    await closeAnyOpenProject(toplevel);
  });

  it("holds one greyed placeholder once nothing is remembered, and the placeholder runs nothing", async () => {
    await deleteEveryRememberedProject(toplevel);

    await openRecentList(toplevel);
    expect(await recentRows()).toEqual([
      { id: "file-recent-empty", label: "Empty", disabled: true },
    ]);

    // A greyed row swallows its click: the list stays open, and no project arrives on the rail.
    await clickElement(toplevel, ".menubar__item--file-recent-empty");
    expect(await present(".menubar__menu--sub")).toBe(true);
    expect(await present(".rail__project")).toBe(false);
    await closeMenus();
  });

  it("numbers the remembered projects, newest first, with no placeholder", async () => {
    await createProject(toplevel, nordwind);
    await closeProject(toplevel);
    await createProject(toplevel, sirkka);

    await openRecentList(toplevel);
    expect(await recentRows()).toEqual([
      { id: "file-recent-0", label: "1 sirkka", disabled: false },
      { id: "file-recent-1", label: "2 nordwind", disabled: false },
    ]);
    await closeMenus();
  });

  it("opens the project a numbered row names, which then leads the list", async () => {
    await openRecentList(toplevel);
    await clickElement(toplevel, ".menubar__item--file-recent-1");
    await waitFor(
      async () => {
        const title = await browser.execute(
          () => document.querySelector(".rail__project")?.getAttribute("title") ?? null,
        );
        return title !== null && title.includes(nordwind) ? title : null;
      },
      { timeout: 20000, message: "the rail to hold the project the row named" },
    );

    // The reopened project moves to the head of the list, the way most-recent lists move.
    await openRecentList(toplevel);
    expect(await recentRows()).toEqual([
      { id: "file-recent-0", label: "1 nordwind", disabled: false },
      { id: "file-recent-1", label: "2 sirkka", disabled: false },
    ]);
    await closeMenus();
  });
});
