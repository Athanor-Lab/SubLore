/* global describe, it, before, document, window */
/**
 * T3 C1 to C3: one registry behind the chrome, and commands that grey instead of vanishing.
 *
 * The owner ruling of 2026-09-03 reverses decision 24 A2, so most of what is asserted here is an
 * absence of movement: the same items, in the same order, on both routes, before and after a
 * document opens. What must not happen is a greyed command running anyway, and that is asserted the
 * way current-line.spec.js asserts a commit, by counting what crossed the IPC boundary, with the
 * same probe, now expecting nothing.
 *
 * Undo and Redo carry that count. Both send their command the moment they are asked, with no
 * chooser and no state check of their own in front of them, so a gate that let one through shows up
 * here as a name in the list rather than as something that has to be inferred.
 *
 * The rail is the fourth route and the one with teeth. Its greyed items are list rows carrying
 * aria-disabled, so a click on one arrives at the dispatch and only the availability test there
 * stops it; the menu bar and the toolbar draw native disabled buttons, which swallow the click
 * first, and the keyboard is the only other route that reaches the gate at all.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import { browser, expect } from "@wdio/globals";

import { answerChooser, cancelChooser, findChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow, pressKey } from "../lib/input.js";
import { takeCommands, watchCommands } from "../lib/ipc.js";
import { repoRoot, windowHeight, windowWidth } from "../lib/paths.js";
import { closeAnyOpenProject } from "../lib/rail.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

/**
 * Every command the registry declares with nothing open, as the token a drawn item carries: the id
 * with its dots turned into hyphens. Written down here so that an entry no route draws fails as
 * loudly as an item with no entry behind it (C1).
 */
const DECLARED = [
  "file-new",
  "file-open-subtitle",
  "file-open-encoding",
  "file-open-source",
  "file-close-source",
  "file-new-translation",
  "video-open",
  "file-save",
  "file-save-as",
  "file-export",
  "file-discard",
  "file-properties",
  "app-quit",
  "asr-transcribe",
  "edit-undo",
  "edit-redo",
  "edit-cut",
  "edit-copy",
  "edit-paste",
  "edit-paste-over",
  "edit-select-all",
  "edit-revert",
  "edit-clear",
  "edit-clear-text",
  "edit-insert-original",
  "edit-style-bold",
  "edit-style-italic",
  "edit-style-underline",
  "edit-style-strikeout",
  "edit-find",
  "edit-find-next",
  "edit-replace",
  "time-prev-cue",
  "time-next-cue",
  "time-start-to-playhead",
  "time-end-to-playhead",
  "time-shift",
  "time-shift-to-playhead",
  "time-continuous-start",
  "time-continuous-end",
  "edit-select-at-playhead",
  "wave-play-selection",
  "time-play-line",
  "wave-stop",
  "time-play-before",
  "time-play-after",
  "wave-play-first",
  "wave-play-last",
  "time-play-to-end",
  "time-lead-in",
  "time-lead-out",
  "time-start-earlier",
  "time-start-later",
  "time-end-earlier",
  "time-end-later",
  "subtitle-insert-before",
  "subtitle-insert-after",
  "subtitle-insert-before-at-playhead",
  "subtitle-insert-after-at-playhead",
  "subtitle-next-line",
  "subtitle-duplicate",
  "subtitle-delete",
  "subtitle-split",
  "subtitle-split-before-playhead",
  "subtitle-split-after-playhead",
  "subtitle-join-concat",
  "subtitle-join-keep-first",
  "subtitle-merge",
  "help-contents",
  "help-website",
  "help-report-bug",
  "help-check-updates",
  "help-event-log",
  "audio-use-video-track",
  "subtitle-move-up",
  "subtitle-move-down",
  "subtitle-sort-all-start",
  "subtitle-sort-all-end",
  "subtitle-sort-selected-start",
  "subtitle-sort-selected-end",
  "help-about",
  "video-toggle-subtitle-overlay",
  "video-show-source-on-video",
  "video-close",
  "video-details",
  "video-play",
  "video-play-cue",
  "video-stop",
  "video-toggle-follow-selection",
  "video-jump-to",
  "video-step-prev-frame",
  "video-step-next-frame",
  "video-jump-back",
  "video-jump-forward",
  "video-prev-boundary",
  "video-next-boundary",
  "video-jump-cue-start",
  "video-jump-cue-end",
  "view-layout-grid-only",
  "view-layout-video-grid",
  "view-layout-waveform-grid",
  "view-layout-full",
  "view-tags-show",
  "view-tags-simplify",
  "view-tags-hide",
  "view-waveform-panel",
  "wave-center-on-cue",
  "wave-toggle-autoscroll",
  "wave-toggle-autocommit",
  "wave-toggle-autonext",
  "view-interface-scale-90",
  "view-interface-scale-100",
  "view-interface-scale-110",
  "view-interface-scale-125",
  "view-interface-scale-150",
  "view-language",
  "view-preferences",
];

/**
 * The bar with nothing open: every title present, in the order the reference's own bar has them,
 * and Audio greyed because no media has tracks.
 */
const TITLES = [
  { id: "file", label: "File", disabled: false },
  { id: "edit", label: "Edit", disabled: false },
  { id: "subtitle", label: "Subtitles", disabled: false },
  { id: "timing", label: "Timing", disabled: false },
  { id: "video", label: "Video", disabled: false },
  // Openable since the Use-the-video's-audio row exists: a title with a drawn greyed item is a
  // title with something behind it, which is the ruling's own geometry (3.6 item 1).
  { id: "audio", label: "Audio", disabled: false },
  { id: "view", label: "View", disabled: false },
  { id: "help", label: "Help", disabled: false },
];

/**
 * File with nothing open: Save, Save as and Discard are drawn and greyed, and so are the two
 * that need a document to act on. Open source subtitle is not among them: a translation is begun
 * from a source, so opening one is the first gesture of all (M2.6 S1 and S2).
 */
const FILE_ITEMS = [
  { id: "file-new", disabled: false },
  { id: "file-open-subtitle", disabled: false },
  { id: "file-open-encoding", disabled: false },
  { id: "file-open-source", disabled: false },
  { id: "file-close-source", disabled: true },
  { id: "file-new-translation", disabled: true },
  { id: "file-save", disabled: true },
  { id: "file-save-as", disabled: true },
  { id: "file-export", disabled: true },
  { id: "file-discard", disabled: true },
  { id: "file-properties", disabled: true },
  { id: "app-quit", disabled: false },
];

/** Edit with nothing open: Undo, Redo, Find, Find next and Replace are drawn, greyed. */
const EDIT_ITEMS = [
  { id: "edit-undo", disabled: true },
  { id: "edit-redo", disabled: true },
  { id: "edit-cut", disabled: true },
  { id: "edit-copy", disabled: true },
  { id: "edit-paste", disabled: true },
  { id: "edit-paste-over", disabled: true },
  { id: "edit-select-all", disabled: true },
  { id: "edit-revert", disabled: true },
  { id: "edit-clear", disabled: true },
  { id: "edit-clear-text", disabled: true },
  { id: "edit-insert-original", disabled: true },
  { id: "edit-style-bold", disabled: true },
  { id: "edit-style-italic", disabled: true },
  { id: "edit-style-underline", disabled: true },
  { id: "edit-style-strikeout", disabled: true },
  { id: "edit-find", disabled: true },
  { id: "edit-find-next", disabled: true },
  { id: "edit-replace", disabled: true },
  { id: "asr-transcribe", disabled: false },
];

/** Subtitles with nothing open: every cue edit needs a document, so all of them are greyed. */
const SUBTITLE_ITEMS = [
  { id: "subtitle-insert-before", disabled: true },
  { id: "subtitle-insert-after", disabled: true },
  { id: "subtitle-insert-before-at-playhead", disabled: true },
  { id: "subtitle-insert-after-at-playhead", disabled: true },
  { id: "subtitle-next-line", disabled: true },
  { id: "subtitle-duplicate", disabled: true },
  { id: "subtitle-delete", disabled: true },
  { id: "subtitle-split", disabled: true },
  { id: "subtitle-split-before-playhead", disabled: true },
  { id: "subtitle-split-after-playhead", disabled: true },
  { id: "subtitle-join-concat", disabled: true },
  { id: "subtitle-join-keep-first", disabled: true },
  { id: "subtitle-merge", disabled: true },
  { id: "subtitle-move-up", disabled: true },
  { id: "subtitle-move-down", disabled: true },
  { id: "subtitle-sort-all-start", disabled: true },
  { id: "subtitle-sort-all-end", disabled: true },
  { id: "subtitle-sort-selected-start", disabled: true },
  { id: "subtitle-sort-selected-end", disabled: true },
];

/** Every button the toolbar will ever draw, drawn with nothing open (C2). */
const TOOLBAR = [
  { id: "file-open-subtitle", disabled: false },
  { id: "video-open", disabled: false },
  { id: "file-save", disabled: true },
  { id: "file-save-as", disabled: true },
  { id: "file-discard", disabled: true },
  { id: "edit-undo", disabled: true },
  { id: "edit-redo", disabled: true },
  { id: "view-tags-cycle", disabled: false },
];

/**
 * The commands the reference draws on the toolbar and in no menu (interface-spec 4.1). They are
 * registry commands like any other, so the toolbar draws them, but the menu-vs-toolbar agreement
 * below has no menu record to hold them to.
 */
const TOOLBAR_ONLY = ["view-tags-cycle"];

const NO_FILE_STATUS = "No subtitle file open.";

/** The one greyed command drawn on both routes that also owns an accelerator of its own (C3). */
const THREE_ROUTES = "file-save-as";
const THREE_ROUTES_KEY = "ctrl+shift+s";
/** What that command raises before it sends anything, so a leak has a second shape to show in. */
const THREE_ROUTES_CHOOSER = "Save the subtitle as";

/**
 * The rail's project menu with nothing open: three commands that need a project, greyed. Each asks
 * its question before it changes anything, so a question standing open is what a leak looks like.
 */
const RAIL_GREYED = ["add-episode", "close-project", "delete-project"];
/** The one command on that menu that can run, which is how this route proves its clicks land. */
const RAIL_LIVE = "create-project";
const RAIL_LIVE_CHOOSER = "Choose a project folder";

/** Writes go to the harness temp dir: the committed fixture is copied, never opened for editing. */
function workingCopy() {
  const dataHome = process.env.SUBLORE_E2E_DATA_HOME;
  if (typeof dataHome !== "string" || dataHome === "") {
    throw new Error("SUBLORE_E2E_DATA_HOME is not set; e2e/wdio.conf.js sets it for every run.");
  }
  const source = path.join(repoRoot, "fixtures", "subtitles", "srt", "clean", "basic-lf.srt");
  if (!existsSync(source)) {
    throw new Error(
      `E2E prerequisite missing: ${source} does not exist. It is committed; restore it with ` +
        "`git checkout fixtures/subtitles`.",
    );
  }
  const directory = path.join(dataHome, "command-registry");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const copy = path.join(directory, "basic-lf.srt");
  copyFileSync(source, copy);
  return copy;
}

/** Centre of an element in physical pixels, which is what X11 pointer coordinates are. */
function centreOf(selector) {
  return browser.execute((css) => {
    const element = document.querySelector(css);
    if (element === null) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    return { x: (rect.x + rect.width / 2) * dpr, y: (rect.y + rect.height / 2) * dpr };
  }, selector);
}

async function clickElement(toplevel, selector) {
  const centre = await centreOf(selector);
  if (centre === null) {
    throw new Error(`${selector} is missing from the DOM`);
  }
  // No window manager under Xvfb, so the toplevel origin is also the viewport origin.
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

function textOf(selector) {
  return browser.execute((css) => document.querySelector(css)?.textContent ?? null, selector);
}

function disabledOf(selector) {
  return browser.execute((css) => document.querySelector(css)?.disabled ?? null, selector);
}

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

/** A rail item is greyed with `aria-disabled`, not `disabled`, so its click reaches the gate. */
function ariaDisabledOf(selector) {
  return browser.execute(
    (css) => document.querySelector(css)?.getAttribute("aria-disabled") ?? null,
    selector,
  );
}

/** The title of the open dropdown, or null when none is open. */
function openMenu() {
  return browser.execute(
    () => document.querySelector(".menubar__menu")?.getAttribute("aria-label") ?? null,
  );
}

async function waitForOpenMenu(wanted) {
  return waitFor(async () => ((await openMenu()) === wanted ? true : null), {
    timeout: 15000,
    message: `the ${wanted} dropdown to be the open one`,
  });
}

async function waitForNoMenu() {
  return waitFor(async () => ((await openMenu()) === null ? true : null), {
    timeout: 15000,
    message: "the dropdown to close",
  });
}

/** The bar's titles, in the order it draws them, each with the id its class carries. */
function titlesOnTheBar() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".menubar__title")).map((title) => ({
      id:
        Array.from(title.classList)
          .find((name) => name.startsWith("menubar__title--"))
          ?.replace("menubar__title--", "") ?? null,
      label: title.textContent,
      disabled: title.disabled,
    })),
  );
}

/** Every command in the open dropdown's own list of items, in the order it draws them. */
function itemsIn(selector) {
  return browser.execute(
    (css) =>
      Array.from(document.querySelectorAll(css)).map((item) => ({
        id: item.id.replace("menuitem-", ""),
        label: item.querySelector(".menubar__label")?.textContent ?? null,
        accelerator: item.querySelector(".menubar__accelerator")?.textContent ?? null,
        disabled: item.disabled,
      })),
    selector,
  );
}

/**
 * What the open dropdown draws, by command token, in the order it draws it, with every list inside
 * it walked into.
 *
 * A submenu is a row and not a command, so it is not counted here; what it holds is counted in its
 * place, which is what keeps this a reading of the registry rather than of the shape of the menu.
 */
async function itemsOfOpenMenu(toplevel) {
  const rows = await browser.execute(() =>
    Array.from(document.querySelector(".menubar__menu")?.children ?? [])
      // A rule between two groups is drawn but is not a command, so it is skipped the way a
      // submenu's opener is not counted: this stays a reading of the registry, not of the shape.
      .filter((row) => !row.classList.contains("menubar__separator"))
      .map((row) => {
        const opener = row.querySelector(".menubar__submenu");
        return opener === null
          ? {
              item: {
                id: row.id.replace("menuitem-", ""),
                label: row.querySelector(".menubar__label")?.textContent ?? null,
                accelerator: row.querySelector(".menubar__accelerator")?.textContent ?? null,
                disabled: row.disabled,
              },
            }
          : { submenu: opener.id.replace("menuitem-", ""), disabled: opener.disabled };
      }),
  );

  const items = [];
  for (const row of rows) {
    if (row.item !== undefined) {
      items.push(row.item);
      continue;
    }
    // A greyed opener holds a generated list with nothing in it: nothing behind it to collect,
    // and neither a hover nor a click opens it (3.5).
    if (row.disabled) {
      continue;
    }
    await clickElement(toplevel, `.menubar__submenu--${row.submenu}`);
    await waitFor(() => present(".menubar__menu--sub"), {
      timeout: 15000,
      message: `the ${row.submenu} list to open`,
    });
    items.push(...(await itemsIn(".menubar__menu--sub .menubar__item")));
    // One Escape gives back one level, so the dropdown around it stays open for the next row.
    pressKey("Escape");
    await waitFor(async () => ((await present(".menubar__menu--sub")) ? null : 1), {
      timeout: 15000,
      message: `the ${row.submenu} list to close`,
    });
  }
  return items;
}

/** What the toolbar draws, by command token, in the order it draws it. */
function buttonsOnTheToolbar() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".toolbar__button")).map((button) => ({
      id:
        Array.from(button.classList)
          .find((name) => name !== "toolbar__button")
          ?.replace("toolbar__", "") ?? null,
      label: button.textContent,
      disabled: button.disabled,
    })),
  );
}

/**
 * Everything the chrome draws right now, read one dropdown at a time because only the open one is
 * in the document. A greyed title opens nothing, which is the point of C2, so there is no dropdown
 * behind it to read and it contributes its title alone.
 */
async function drawnEverywhere(toplevel) {
  const bar = await titlesOnTheBar();
  const menus = [];
  for (const title of bar) {
    if (title.disabled) {
      menus.push({ id: title.id, items: [] });
      continue;
    }
    await clickElement(toplevel, `.menubar__title--${title.id}`);
    await waitForOpenMenu(title.label);
    menus.push({ id: title.id, items: await itemsOfOpenMenu(toplevel) });
    pressKey("Escape");
    await waitForNoMenu();
  }
  return { titles: bar, menus, toolbar: await buttonsOnTheToolbar() };
}

/** One menu's items as the greying alone, which is what the C2 lists above are written as. */
function greying(snapshot, menu) {
  return snapshot.menus
    .find((candidate) => candidate.id === menu)
    .items.map(({ id, disabled }) => ({ id, disabled }));
}

/** Every command drawn in the bar, across the dropdowns, flattened. */
function everyMenuItem(snapshot) {
  return snapshot.menus.flatMap((menu) => menu.items);
}

/** The ids whose greying differs between two snapshots, per route, and what they moved to. */
function flips(before, after) {
  const moved = [];
  const compare = (route, was, is) => {
    is.forEach((item, index) => {
      if (was[index] !== undefined && was[index].disabled !== item.disabled) {
        moved.push({ route, id: item.id, disabled: item.disabled });
      }
    });
  };
  compare("menu", everyMenuItem(before), everyMenuItem(after));
  compare("toolbar", before.toolbar, after.toolbar);
  return moved;
}

describe("the command registry", () => {
  let toplevel = null;
  let opened = null;
  /** What the chrome draws with nothing open, read once and compared against after an open. */
  let empty = null;

  before(async () => {
    opened = workingCopy();
    toplevel = await waitFor(findToplevel, {
      timeout: 30000,
      message: `the ${windowWidth}x${windowHeight} "Sublore" toplevel to appear`,
    });
    focusWindow(toplevel.id);
    await waitFor(
      () => browser.execute(() => document.querySelector(".toolbar__file-open-subtitle") !== null),
      { timeout: 30000, message: "the app UI to render" },
    );
    // Every spec shares one data home and the app reopens the project it had, so the emptiest state
    // this file reads is one it has to make. Two specs earlier leave one open.
    await closeAnyOpenProject(toplevel);
    empty = await drawnEverywhere(toplevel);
  });

  it("draws one item per registry entry, and both routes draw the same record", async () => {
    const ids = everyMenuItem(empty)
      .map((item) => item.id)
      // The recent-video items are one per remembered file, generated like the audio tracks, so
      // they are data and not part of the static declared set; a video opened earlier in the run
      // may have left some behind.
      .filter((id) => !id.startsWith("video-recent-"))
      // The recent-project rows are one per remembered folder plus the placeholder, generated like
      // the audio tracks, so they are data and not part of the static declared set; a project made
      // earlier in the run may have left some behind.
      .filter((id) => !id.startsWith("file-recent-"));
    // One entry, one item: an id drawn twice would be two records, or one record drawn from two
    // hand-written lists, which is the shape the registry replaced.
    expect(ids.length).toBe(new Set(ids).size);
    // The two sets agree: nothing drawn without an entry, and no entry drawn nowhere (C1).
    expect(ids.slice().sort()).toEqual(DECLARED.slice().sort());

    // Every toolbar button is a menu command too, except the few the reference keeps to the
    // toolbar alone (interface-spec 4.1): those are still registry commands, just with no menu twin.
    const onToolbar = empty.toolbar.map((button) => button.id);
    expect(onToolbar.filter((id) => !ids.includes(id) && !TOOLBAR_ONLY.includes(id))).toEqual([]);

    // The same record on both routes: a label or a greying that differed between them would mean
    // the two routes are reading two lists again. A toolbar-only command has no menu twin to check.
    for (const button of empty.toolbar) {
      const item = everyMenuItem(empty).find((candidate) => candidate.id === button.id);
      if (item === undefined) {
        expect(TOOLBAR_ONLY).toContain(button.id);
        continue;
      }
      expect({ id: button.id, label: button.label, disabled: button.disabled }).toEqual({
        id: button.id,
        label: item.label,
        disabled: item.disabled,
      });
    }
  });

  it("draws each accelerator against one command, because only one of two can fire", async () => {
    const claimed = new Map();
    const doubled = [];
    for (const item of everyMenuItem(empty)) {
      if (item.accelerator === null) {
        continue;
      }
      const first = claimed.get(item.accelerator);
      if (first === undefined) {
        claimed.set(item.accelerator, item.id);
      } else if (first !== item.id) {
        doubled.push(`${item.accelerator}: ${first} and ${item.id}`);
      }
    }
    // The positive control, without which this passes by reading nothing: the walk found
    // accelerators at all, and one that is known by name.
    expect(claimed.size).toBeGreaterThan(20);
    expect(claimed.get("Ctrl+S")).toBe("file-save");
    // `commandFor` returns the first entry in the registry whose chord matches, so a second claim
    // on the same accord is a menu item drawing a key that runs the other one (N107).
    expect(doubled).toEqual([]);
  });

  it("draws every command with nothing open, greyed rather than absent", async () => {
    expect(await textOf(".statusbar__document")).toBe(NO_FILE_STATUS);

    // Every title is on the bar. Audio has no tracks behind it and is greyed, not dropped.
    expect(empty.titles).toEqual(TITLES);
    // The recent rows move with what earlier specs remembered, so the static list is compared
    // without them; their own behaviour is file-recents.spec.js's subject.
    expect(greying(empty, "file").filter(({ id }) => !id.startsWith("file-recent-"))).toEqual(
      FILE_ITEMS,
    );
    expect(greying(empty, "edit")).toEqual(EDIT_ITEMS);
    expect(greying(empty, "subtitle")).toEqual(SUBTITLE_ITEMS);
    expect(empty.toolbar.map(({ id, disabled }) => ({ id, disabled }))).toEqual(TOOLBAR);
  });

  it("refuses a greyed command from the menu, the toolbar, the rail and the keyboard", async () => {
    await watchCommands();

    // The menu route. Undo is the one that would show a leak with nothing else in the way: it sends
    // its command the moment it is asked, so a name here means the gate let a greyed command run.
    await clickElement(toplevel, ".menubar__title--edit");
    await waitForOpenMenu("Edit");
    expect(await disabledOf("#menuitem-edit-undo")).toBe(true);
    await clickElement(toplevel, "#menuitem-edit-undo");
    // Nothing ran, and nothing closed either: a greyed item is inert, not a dead click that dismisses.
    expect(await openMenu()).toBe("Edit");
    pressKey("Escape");
    await waitForNoMenu();

    await clickElement(toplevel, ".menubar__title--file");
    await waitForOpenMenu("File");
    expect(await disabledOf(`#menuitem-${THREE_ROUTES}`)).toBe(true);
    await clickElement(toplevel, `#menuitem-${THREE_ROUTES}`);
    pressKey("Escape");
    await waitForNoMenu();

    // The toolbar route, over the same three greyed commands.
    for (const id of ["edit-undo", "edit-redo", THREE_ROUTES]) {
      expect(await disabledOf(`.toolbar__${id}`)).toBe(true);
      await clickElement(toplevel, `.toolbar__${id}`);
    }

    // The rail route. The two above draw their greyed commands as native disabled buttons, which
    // swallow the click before anything sees it, so they cannot show the gate working; a rail item
    // is a list row carrying aria-disabled and its click really does arrive (BACKLOG.md N18).
    await clickElement(toplevel, ".rail__empty");
    await waitFor(() => present(".railmenu"), {
      timeout: 15000,
      message: "the rail's project menu to open",
    });
    for (const key of RAIL_GREYED) {
      expect(await ariaDisabledOf(`.railmenu__item--${key}`)).toBe("true");
      await clickElement(toplevel, `.railmenu__item--${key}`);
      // Nothing ran: each of these asks its question first, so a question on screen is the leak.
      expect(await present(".raildialog")).toBe(false);
      // And nothing closed either, the same inertness the menu bar's greyed item has above.
      expect(await present(".railmenu")).toBe(true);
    }

    // This route's barrier, on the same menu and the same kind of click: the one command that can
    // run takes the menu down and raises its chooser, so the silences above are refusals rather
    // than three clicks that landed on nothing.
    expect(await ariaDisabledOf(`.railmenu__item--${RAIL_LIVE}`)).toBe("false");
    await clickElement(toplevel, `.railmenu__item--${RAIL_LIVE}`);
    await waitFor(async () => ((await present(".railmenu")) ? null : true), {
      timeout: 15000,
      message: "the rail menu to close behind the command that ran",
    });
    await cancelChooser(await waitForChooser(RAIL_LIVE_CHOOSER), "project folder");
    // A cancelled chooser creates nothing, so the rail is back where it was for the last check.
    expect(await present(".rail__empty")).toBe(true);

    // The keyboard route: the accelerator the File menu draws beside the greyed item.
    focusWindow(toplevel.id);
    pressKey(THREE_ROUTES_KEY);
    // A leak raises its chooser before it sends anything, and a chooser needs a moment to map.
    await sleep(2500);

    expect(findChooser(THREE_ROUTES_CHOOSER)).toBe(null);
    expect(await takeCommands()).toEqual([]);
    expect(await textOf(".statusbar__document")).toBe(NO_FILE_STATUS);
    expect(await textOf(".statusbar__message")).toBe(null);
    expect(await textOf(".statusbar__error")).toBe(null);

    // The barrier the zero needs: the same probe, the same chrome, one command that is not greyed.
    // Without it an empty list could mean a probe that never took hold.
    await watchCommands();
    await clickElement(toplevel, ".toolbar__file-open-subtitle");
    const chooser = await waitForChooser("Choose a subtitle");
    await answerChooser(chooser, opened, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(async () => (await textOf(".statusbar__document"))?.startsWith("SRT") === true, {
      timeout: 20000,
      message: "the status bar to report the subtitle the toolbar opened",
    });

    expect(await takeCommands()).toEqual(["subtitle_open"]);
    expect(await textOf(".statusbar__error")).toBe(null);

    // The keyboard's own barrier: the same key, at the same window, now that the command behind it
    // is enabled. Without it the silence above could be a keystroke that never arrived.
    pressKey(THREE_ROUTES_KEY);
    await cancelChooser(await waitForChooser(THREE_ROUTES_CHOOSER), "subtitle-save");
    focusWindow(toplevel.id);
  });

  it("greys and ungreys in place, with nothing appearing or disappearing", async () => {
    const open = await drawnEverywhere(toplevel);

    expect(open.titles).toEqual(empty.titles);
    expect(open.menus.map((menu) => menu.items.map((item) => item.id))).toEqual(
      empty.menus.map((menu) => menu.items.map((item) => item.id)),
    );
    expect(open.toolbar.map((button) => button.id)).toEqual(
      empty.toolbar.map((button) => button.id),
    );

    // Exactly the items that now work stop being grey. The document opened clean, so Save has
    // nothing to write and Undo has nothing to take back: Save as is the whole difference on
    // File, and it moved on both routes because both draw the one record. The fixture's three cues
    // seed the cursor onto row 0 (decision 5): insert, delete and merge all only need that, so they
    // ungrey too. Split stays gated behind a caret nothing has placed yet.
    expect(flips(empty, open)).toEqual([
      // Neither source item moves with a target: opening one never needed a target, and closing
      // and translating both wait for a source, which this open is not (S1, S2).
      { route: "menu", id: "file-save-as", disabled: false },
      // The order is the menu's own: Export writes a copy of the document, so it wakes with one the
      // way Save as does, and Project properties has a script to read once a document is open.
      { route: "menu", id: "file-export", disabled: false },
      { route: "menu", id: "file-properties", disabled: false },
      // A document opens on its first row, so a row is selected and the four that act on a
      // selection wake with it. Paste over asks the clipboard nothing until it is chosen.
      { route: "menu", id: "edit-cut", disabled: false },
      { route: "menu", id: "edit-copy", disabled: false },
      { route: "menu", id: "edit-paste", disabled: false },
      { route: "menu", id: "edit-paste-over", disabled: false },
      { route: "menu", id: "edit-select-all", disabled: false },
      // The two clears need a line with something in it, which the fixture's first row is. Revert
      // beside them stays greyed, because nothing has moved it since the cursor arrived, and so
      // does Insert original, which wants a caret and a source and has neither (B13).
      { route: "menu", id: "edit-clear", disabled: false },
      { route: "menu", id: "edit-clear-text", disabled: false },
      // Find and Replace need a document and nothing else, so both ungrey with the file (F2, F3).
      // Find next is absent from this list on purpose: it also needs a pattern, and nothing here
      // has typed one, so it stays greyed through the open (F5).
      { route: "menu", id: "edit-find", disabled: false },
      { route: "menu", id: "edit-replace", disabled: false },
      { route: "menu", id: "subtitle-insert-before", disabled: false },
      { route: "menu", id: "subtitle-insert-after", disabled: false },
      { route: "menu", id: "subtitle-next-line", disabled: false },
      { route: "menu", id: "subtitle-duplicate", disabled: false },
      { route: "menu", id: "subtitle-delete", disabled: false },
      { route: "menu", id: "subtitle-merge", disabled: false },
      // A document opens on a selected row, so the two moves wake with it; a move at the edge is
      // enabled and does nothing rather than greying, which is what the reference does (§3.3 12-13).
      { route: "menu", id: "subtitle-move-up", disabled: false },
      { route: "menu", id: "subtitle-move-down", disabled: false },
      // A document open is one selected row: sort all wakes (it needs only a document), sort
      // selected stays greyed until two or more are selected.
      { route: "menu", id: "subtitle-sort-all-start", disabled: false },
      { route: "menu", id: "subtitle-sort-all-end", disabled: false },
      // Next line needs a row after the cursor's, which the fixture's three cues give it; Previous
      // line stays greyed because the cursor opens on row 0 and there is nothing above it.
      { route: "menu", id: "time-next-cue", disabled: false },
      // Making the times continuous needs a document and a selection with no hole in it, which a
      // document that opens on its first row already is. The shift beside them wants a video too.
      { route: "menu", id: "time-continuous-start", disabled: false },
      { route: "menu", id: "time-continuous-end", disabled: false },
      // The two leads move a boundary, so a cursor is all they want, exactly like the nudges below.
      { route: "menu", id: "time-lead-in", disabled: false },
      { route: "menu", id: "time-lead-out", disabled: false },
      // The four nudges need a cursor and nothing else, so a document alone ungreys them. The
      // playback commands beside them in Timing want a video too, and stay greyed here, and so do
      // the waveform's own two in View: there are no peaks to centre on without one.
      { route: "menu", id: "time-start-earlier", disabled: false },
      { route: "menu", id: "time-start-later", disabled: false },
      { route: "menu", id: "time-end-earlier", disabled: false },
      { route: "menu", id: "time-end-later", disabled: false },
      { route: "toolbar", id: "file-save-as", disabled: false },
    ]);
  });
});
