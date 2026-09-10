/* global describe, it, before, after, console, document, window, Event, setTimeout */
/**
 * The current line's bands: the character count on the first one, and the row structure both bands
 * have to survive at every interface size. See sublore-meta docs/edit-bar-first-tasks.md, E1 and E5.
 *
 * The reach sweep is written in the shape of the `stripOutOfReach` check in
 * `interface-scale.spec.js` rather than as a second mechanism: a control is reachable when the
 * element under its own middle is that control, because that is the only reading that fails for a
 * control drawn on a row the panel is not tall enough to show. The audio panel paid for that once.
 *
 * The counts below are facts about committed, byte-frozen fixtures, derived from their bytes
 * against the rule in D1 and not read off an implementation.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { runFromMenu } from "../lib/menu.js";
import { clippedAtWindowEdge } from "../lib/clipping.js";
import {
  askForWindowSize,
  clickAt,
  focusWindow,
  pressKey,
  typeText,
  waitForWindowSize,
} from "../lib/input.js";
import { takeCommands, watchCommands } from "../lib/ipc.js";
import { repoRoot, requireWaveformFixture, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { interfaceScale } from "../lib/scale.js";
import { findToplevel, rootTree } from "../lib/x11.js";

/** The three sizes the reach criterion is stated at, all of them on the View menu. */
const REACH_PERCENTS = [90, 110, 150];
/** The wide window the criterion names, beside the narrowest the shell allows. */
const WIDE_WIDTH = 1920;
const WIDE_HEIGHT = 1080;
/** Percentage widths and scaled type both land on fractions of a pixel. */
const SLOP_PX = 1;

/**
 * Every control the panel draws, by name. Named rather than collected by tag so that a control
 * which stopped being drawn is caught as missing rather than quietly shrinking a count, and so the
 * failure says which one (E5.2, E5.3).
 */
const CONTROLS = [
  ".currentline__comment",
  ".currentline__edit-style-bold",
  ".currentline__style",
  ".currentline__actor",
  ".currentline__actor-open",
  ".currentline__start",
  ".currentline__end",
  ".currentline__colour-primary",
  ".currentline__subtitle-next-line",
  ".currentline__text",
];

/**
 * What the panel does not show at once when the waveform sits above it, per interface size, at the
 * narrowest window the shell allows and at 1920. Measured, not chosen: the tools column is 216 CSS
 * px and the stored waveform height is 128 at every interface size, so the panel is given 84 and
 * its content wants 121, 159 and 212 at the narrow window and 88, 104 and 139 at 1920.
 *
 * This is a recorded shortfall and not a target. It is pinned here so that adding a band cannot
 * make it worse without a check saying so, and so that fixing it reddens this table and forces the
 * number to be looked at again. What it waits on is `MIN_CURRENT_LINE` and the stored waveform
 * height in `src/App.tsx`, which this change may not touch. See edit-bar-first-tasks.md E5.6.
 */
/**
 * The same, for a panel with no waveform above it, where there is more room and it used to be
 * nothing at every size. The text box needs the scroll at 150 per cent in the narrowest window: the
 * block's opening height is a pixel count and the interface size does not move it, on purpose,
 * because the waveform's own measurements are in device pixels and `interface-scale.spec.js` holds
 * the block to its pixels across a size change. So the panel's contents scale and its box does not,
 * and at 150 per cent that is one control's worth. See BACKLOG N38.
 */
const BARE_SHORTFALL = {
  90: [],
  110: [],
  150: [".currentline__text", ".currentline__colour-primary", ".currentline__subtitle-next-line"],
};

/**
 * The most the panel may fail to show at once, pinned so it cannot grow in silence. A ceiling and
 * not an identity: which controls fall outside a short panel depends on how the machine renders the
 * type, and this repository's own runner and the CI runner do not agree to the pixel. What must
 * hold everywhere is that the set never grows past what was measured before the panel gained the
 * effect, the drawing order and the three margins, which is what these entries are. Every control
 * is drawn and every control is reachable through the panel's scroll.
 *
 * Two entries have grown since, and they are here rather than paid for: the panel's own button row
 * needs the scroll at 110 and at 150 per cent in the narrowest window with a waveform above it. It
 * is the last row in the panel, so the narrow window is where it falls outside. Raising the
 * block's opening height again would clear it and would take that height from the grid at every
 * size, for one control in one configuration out of six. See edit-bar-tasks.md question 1, which is
 * what actually closes this.
 *
 * The colour beside them at 110 per cent is that same row and not a new shortfall: the entries on
 * either side of it are the first and the last control of the button row, so the row was already
 * behind the scroll there before the colours were drawn into it. B12.
 *
 * **2026-09-07, and this is a real growth rather than a reading of the same one.** Edit beside the
 * Style dropdown made the first band wide enough to wrap at the narrow window, which pushed the
 * button row down by a line at 90 per cent with a waveform and at 150 per cent without one. It is
 * paid here rather than fixed for the reason the paragraph above gives: what fixes it is N38, and
 * N38 needs the owner. Every control is still drawn and every one is still reachable by scrolling
 * the panel, which is what these two checks actually guard.
 *
 * **2026-09-07 again, and it is that same button row a third time.** Save a copy became Save as on
 * the toolbar, and the toolbar is one of the rows the window's floor is measured off, so the
 * narrowest window there is at 90 per cent is a word narrower than it was. The bands wrap one line
 * sooner in it and Bold, the first control of the button row, goes behind the scroll where it
 * already was at the other two sizes. Paid here for the reason above: N38 is what clears the row.
 */
const SHORTFALL = {
  90: {
    floor: [
      ".currentline__text",
      ".currentline__edit-style-bold",
      ".currentline__colour-primary",
      ".currentline__subtitle-next-line",
    ],
    wide: [],
  },
  110: {
    floor: [
      ".currentline__text",
      ".currentline__edit-style-bold",
      ".currentline__colour-primary",
      ".currentline__subtitle-next-line",
    ],
    wide: [],
  },
  150: {
    floor: [
      ".currentline__start",
      ".currentline__end",
      ".currentline__text",
      ".currentline__edit-style-bold",
      ".currentline__colour-primary",
      ".currentline__subtitle-next-line",
    ],
    wide: [".currentline__text"],
  },
};

/**
 * The rows of each fixture, and the length of each row's longest line under D1. Every number here
 * was derived from the fixture's own bytes: markup counts nothing, a drawing counts nothing, `\h`
 * counts one, `\N` ends a line, and what is counted is graphemes.
 */
const COUNTS = {
  "ass/clean/basic.ass": [37, 45, 36],
  // 21 is the sign with three override tags in front of it; 0 is a drawing, whose coordinates are
  // not text; 30 is three plain runs with a braced middle that counts nothing; 17 is a transform.
  "ass/clean/override-tags.ass": [21, 0, 30, 17],
  // 51 is the second of two lines divided by `\N`, not the first at 48 and not their sum.
  "ass/clean/text-with-commas.ass": [51, 25],
  // 9 is the one that says the count is of what a reader sees rather than of code units.
  "ass/clean/non-latin.ass": [14, 16, 19, 9],
  // Text is text, so the count works on an SRT. 41 is a two line cue of 40 and 41, not their 81.
  "srt/clean/basic-lf.srt": [40, 41, 36],
};

/** Fixed at 42 and not configurable (D2). The rows above it are the ones that must take the ink. */
const CHARACTER_LIMIT = 42;

function dataHome() {
  const home = process.env.SUBLORE_E2E_DATA_HOME;
  if (typeof home !== "string" || home === "") {
    throw new Error("SUBLORE_E2E_DATA_HOME is not set; e2e/wdio.conf.js sets it for every run.");
  }
  return home;
}

/** Writes go to the harness temp dir. The committed fixtures are copied, never opened for editing. */
function workingCopy(relative) {
  const source = path.join(repoRoot, "fixtures", "subtitles", ...relative.split("/"));
  if (!existsSync(source)) {
    throw new Error(
      `E2E prerequisite missing: ${source} does not exist. It is committed; restore it with ` +
        "`git checkout fixtures/subtitles`.",
    );
  }
  const directory = path.join(dataHome(), "current-line-bands");
  mkdirSync(directory, { recursive: true });
  const copy = path.join(directory, path.basename(source));
  copyFileSync(source, copy);
  return copy;
}

const storedLayout = () =>
  path.join(process.env.SUBLORE_E2E_DATA_HOME, "com.sublore.app", "layout.json");

/** Rub out the last `count` characters of whatever field has the keyboard. */
function backspace(count) {
  for (let done = 0; done < count; done += 1) {
    pressKey("BackSpace");
  }
}

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
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

/** Put a colour in the picker's own field, the way a person typing one would. */
async function typeHex(value) {
  await browser.execute((text) => {
    const input = document.querySelector(".currentline__hex");
    // Focused as well as filled: a key pressed afterwards has to land inside the picker, and
    // Escape sent to the body closes nothing.
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

async function clickElement(toplevel, selector) {
  const centre = await centreOf(selector);
  if (centre === null) {
    throw new Error(`${selector} is missing from the DOM, so there is nothing to click`);
  }
  // No window manager under Xvfb, so the toplevel origin is also the viewport origin.
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

/** What the first band says about the row the cursor is on, read in one round trip. */
function bandOne() {
  return browser.execute(() => {
    const chars = document.querySelector(".currentline__chars");
    const box = document.querySelector(".currentline__text");
    return {
      characters: chars === null ? null : Number(chars.textContent),
      over: chars === null ? null : chars.classList.contains("currentline__chars--over"),
      text: box === null ? null : box.value,
    };
  });
}

/** Everything the speaker control says about the row the cursor is on, in one round trip. */
function speaker() {
  return browser.execute(() => {
    const field = document.querySelector(".currentline__actor");
    const opener = document.querySelector(".currentline__actor-open");
    const refusal = document.querySelector(".currentline__refusal");
    return {
      // Drawn is asserted apart from usable: a greyed control is present, and an absent one is the
      // defect E3.1 exists to catch.
      drawn: field !== null && opener !== null,
      value: field === null ? null : field.value,
      disabled: field === null ? null : field.disabled,
      openerDisabled: opener === null ? null : opener.disabled,
      refusal: refusal === null ? null : refusal.textContent,
    };
  });
}

/** The four numeric fields, read as one so a failure says which of them was wrong. */
function numberFields() {
  return browser.execute(() => {
    const read = (css) => {
      const field = document.querySelector(css);
      if (field === null) {
        return { drawn: false };
      }
      return {
        drawn: true,
        value: field.value,
        disabled: field.disabled,
        invalid: field.classList.contains("currentline__time--invalid"),
      };
    };
    return {
      layer: read(".currentline__layer"),
      marginL: read(".currentline__marginl"),
      marginR: read(".currentline__marginr"),
      marginV: read(".currentline__marginv"),
    };
  });
}

/** Which row the cursor is on, counted the way the grid numbers them. */
function cursorRow() {
  return browser.execute(() => {
    const row = document.querySelector(".cuelist__row--active");
    const text = row?.querySelector(".cuelist__pos")?.textContent;
    return text === undefined || text === null ? null : Number(text);
  });
}

/** The two times the panel is showing, as it spells them. */
function currentTimes() {
  return browser.execute(() => ({
    start: document.querySelector(".currentline__start")?.value ?? null,
    end: document.querySelector(".currentline__end")?.value ?? null,
  }));
}

/** The effect combo, read the way the speaker's is: drawn apart from usable. */
function effectCombo() {
  return browser.execute(() => {
    const field = document.querySelector(".currentline__effect");
    const opener = document.querySelector(".currentline__effect-open");
    return {
      drawn: field !== null && opener !== null,
      value: field === null ? null : field.value,
      disabled: field === null ? null : field.disabled,
      openerDisabled: opener === null ? null : opener.disabled,
    };
  });
}

/** Replace what the effect field holds, the way a person would. */
async function typeIntoEffect(toplevel, value) {
  await clickElement(toplevel, ".currentline__effect");
  await waitFor(
    () =>
      browser.execute(
        () => document.activeElement?.classList.contains("currentline__effect") === true,
      ),
    { timeout: 15000, message: "the effect field to take the keyboard" },
  );
  pressKey("ctrl+a");
  typeText(value);
  await waitFor(async () => ((await effectCombo()).value === value ? 1 : null), {
    timeout: 15000,
    message: `the effect field to hold exactly ${value}`,
  });
}

/** Replace what one numeric field holds, the way a person would: click it, select all, type. */
async function typeIntoNumber(toplevel, field, value) {
  const css = `.currentline__${field.toLowerCase()}`;
  await clickElement(toplevel, css);
  await waitFor(
    () => browser.execute((selector) => document.activeElement?.matches(selector) === true, css),
    { timeout: 15000, message: `the ${field} field to take the keyboard` },
  );
  pressKey("ctrl+a");
  if (value === "") {
    pressKey("BackSpace");
  } else {
    typeText(value);
  }
  await waitFor(async () => ((await numberFields())[field].value === value ? 1 : null), {
    timeout: 15000,
    message: `the ${field} field to hold exactly "${value}"`,
  });
}

/**
 * Whether the shell would run a save. Read off the command's own control rather than off any state:
 * under the greying ruling a greyed Save does not run, so this is what "the work can be saved" is.
 */
function saveEnabled() {
  return browser.execute(() => {
    const save = document.querySelector(".toolbar__file-save");
    return save === null ? null : !save.disabled;
  });
}

/** What one grid row's speaker column shows, so the two views of a row can be read together. */
function gridActor(position) {
  return browser.execute((wanted) => {
    const rows = Array.from(document.querySelectorAll(".cuelist__row"));
    const row = rows.find(
      (candidate) => candidate.querySelector(".cuelist__pos")?.textContent === wanted,
    );
    return row?.querySelector(".cuelist__actor")?.textContent ?? null;
  }, String(position));
}

/** The names the list offers, in the order it offers them. Null while the list is closed. */
function offeredNames() {
  return browser.execute(() => {
    const list = document.querySelector(".currentline__actor-list");
    if (list === null) {
      return null;
    }
    return Array.from(list.querySelectorAll(".currentline__actor-name")).map(
      (option) => option.textContent,
    );
  });
}

/** Replace what the speaker field holds, the way a person would: click it, select all, type. */
async function typeIntoActor(toplevel, value) {
  await clickElement(toplevel, ".currentline__actor");
  await waitFor(
    () =>
      browser.execute(
        () => document.activeElement?.classList.contains("currentline__actor") === true,
      ),
    { timeout: 15000, message: "the speaker field to take the keyboard" },
  );
  pressKey("ctrl+a");
  typeText(value);
  await waitFor(async () => ((await speaker()).value === value ? 1 : null), {
    timeout: 15000,
    message: `the speaker field to hold exactly ${value}`,
  });
}

/**
 * What each band is called and what it holds, left to right, read off the labels a translator sees
 * rather than off class names: the criterion is about where a control sits on the screen (E5.1).
 */
function bandOrder() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".currentline__band")).map((band) => ({
      band: band.className.replace("currentline__band ", "").replace("currentline__", ""),
      parts: Array.from(band.querySelectorAll(".currentline__label")).map(
        (label) => label.textContent,
      ),
    })),
  );
}

/**
 * Every control the panel draws that does not answer where it is drawn: the element under its own
 * middle, when that element is not the control. A panel taller than the box the layout gives it
 * scrolls inside it, and a control on a band the panel is not showing is under the grid instead.
 *
 * Nothing is scrolled first. A control moved into view before the reading is taken cannot fail it,
 * so a sweep that scrolled would pass whatever the panel did. Where the panel is too short to show
 * every band at once, `reachedByScrolling` below is the separate, weaker reading, and what it is
 * weaker about is stated where it is used (E5.5).
 */
function panelOutOfReach(wanted) {
  return browser.execute((names) => {
    const panel = document.querySelector(".currentline");
    if (panel === null) {
      return null;
    }
    const missing = [];
    const outOfReach = [];
    for (const name of names) {
      const control = panel.querySelector(name);
      // A control that stopped being drawn is the other half of the defect this sweep exists for,
      // so it is reported by name rather than lowering the count it is measured against.
      if (control === null) {
        missing.push(name);
        continue;
      }
      const rect = control.getBoundingClientRect();
      const under = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      if (under === null || !(under === control || control.contains(under))) {
        outOfReach.push(name);
      }
    }
    return { swept: names.length - missing.length, missing, outOfReach };
  }, wanted);
}

/**
 * The same reading, taken after the panel has been scrolled to each control. This is the weaker
 * one: it says a control the panel clips can still be reached through the panel's own scroll, and
 * it says nothing about whether it should have had to be. It exists so that the panel's scroll is
 * proved to work, not so that a clipped control can pass a reach check.
 */
function reachedByScrolling(wanted) {
  return browser.execute((names) => {
    const panel = document.querySelector(".currentline");
    if (panel === null) {
      return null;
    }
    const outOfReach = [];
    for (const name of names) {
      const control = panel.querySelector(name);
      if (control === null) {
        outOfReach.push(`${name} MISSING`);
        continue;
      }
      control.scrollIntoView({ block: "nearest" });
      const rect = control.getBoundingClientRect();
      const under = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      if (under === null || !(under === control || control.contains(under))) {
        outOfReach.push(name);
      }
    }
    panel.scrollTop = 0;
    return outOfReach;
  }, wanted);
}
/**
 * Whether the panel offers the scroll it needs. A panel whose content is taller than its box and
 * which cannot be scrolled has drawn a control where no gesture reaches it, which is the audio
 * panel's defect exactly. `clips` is reported too, so a run says whether the reading meant
 * anything or passed because everything happened to fit.
 */
function panelScroll() {
  return browser.execute(() => {
    const panel = document.querySelector(".currentline");
    if (panel === null) {
      return null;
    }
    const clips = panel.scrollHeight > panel.clientHeight + 1;
    // Tried rather than read off a property: `scrollTopMax` is one engine's, and what the criterion
    // is about is whether the panel actually moves when something asks it to.
    const was = panel.scrollTop;
    panel.scrollTop = panel.scrollHeight;
    const moves = panel.scrollTop > 0;
    panel.scrollTop = was;
    return {
      clips,
      unreachable: clips && !moves,
      sideways: panel.scrollWidth > panel.clientWidth + 1,
    };
  });
}

/**
 * The three readings the narrow rule is about: a band that scrolls sideways instead of wrapping,
 * a panel drawn taller than the box the layout gives it, and a text box under one line of its own
 * type. Every one of them is a control drawn where a hand cannot reach it.
 */
function narrowFaults() {
  return browser.execute(() => {
    const panel = document.querySelector(".currentline");
    const box = document.querySelector(".currentline__text");
    const column = panel?.parentElement ?? null;
    if (panel === null || box === null || column === null) {
      return null;
    }
    const faults = [];
    for (const band of document.querySelectorAll(".currentline__band")) {
      if (band.scrollWidth > band.clientWidth + 1) {
        faults.push(`${band.className} scrolls sideways`);
      }
    }
    if (panel.scrollWidth > panel.clientWidth + 1) {
      faults.push(`the panel scrolls sideways`);
    }
    const panelBox = panel.getBoundingClientRect();
    const columnBox = column.getBoundingClientRect();
    if (panelBox.bottom > columnBox.bottom + 1 || panelBox.right > columnBox.right + 1) {
      faults.push(`the panel is drawn outside the column it sits in`);
    }
    // One line of the box's own type, which is what its floor is written in. Its border and its
    // padding are read off the box rather than restated, so the reading follows the interface size.
    const style = window.getComputedStyle(box);
    const px = (value) => Number.parseFloat(value) || 0;
    const oneLine =
      px(style.fontSize) * 1.15 +
      px(style.paddingTop) +
      px(style.paddingBottom) +
      px(style.borderTopWidth) +
      px(style.borderBottomWidth);
    const drawn = box.getBoundingClientRect().height;
    if (drawn + 1 < oneLine) {
      faults.push(
        `the text box is ${Math.round(drawn)} tall, under the ${Math.round(oneLine)} of one line`,
      );
    }
    return faults;
  });
}

/** Ask X for a window size and wait until the page has been laid out at it. */
async function resizeTo(id, width, height) {
  askForWindowSize(id, width, height);
  waitForWindowSize(id, width, height);
  await waitFor(
    async () => ((await browser.execute(() => window.innerWidth)) === width ? 1 : null),
    {
      timeout: 15000,
      message: `the page to be laid out ${width} CSS pixels wide`,
    },
  );
  const toplevel = findToplevel({ width, height });
  if (toplevel === null) {
    throw new Error(`no ${width}x${height} "Sublore" toplevel after the resize.\n${rootTree()}`);
  }
  return toplevel;
}

/** The narrowest the shell says the window may be, measured off the rows it cannot draw narrower. */
async function derivedFloor() {
  const said = await browser.execute(
    () => document.querySelector(".shell")?.dataset.minimumWidth ?? null,
  );
  const floor = Number(said);
  if (!Number.isInteger(floor) || floor <= 0) {
    throw new Error(
      `the shell says its smallest width is ${JSON.stringify(said)}, which is not a width.`,
    );
  }
  return floor;
}

/** Pick one of the View menu's sizes, through the menu, the way a person reaches it. */
async function pickSize(toplevel, percent) {
  const item = `.menubar__item--view-interface-scale-${percent}`;
  await clickElement(toplevel, ".menubar__title--view");
  await waitFor(() => present(item), {
    timeout: 5000,
    message: `the View menu to offer ${percent} per cent`,
  });
  await clickElement(toplevel, item);
  await waitFor(
    async () => (Math.abs((await interfaceScale()) - percent / 100) < 0.001 ? 1 : null),
    { timeout: 5000, message: `the interface to be drawn at ${percent} per cent` },
  );
  await browser.pause(250);
}

/** Open a subtitle fixture through the chooser, and wait for the grid to hold it. */
async function openSubtitle(toplevel, copy) {
  await clickElement(toplevel, ".toolbar__file-open-subtitle");
  const chooser = await waitForChooser("Choose a subtitle");
  await answerChooser(chooser, copy, "subtitle");
  focusWindow(toplevel.id);
  await waitFor(() => present(".cuelist__row"), {
    timeout: 20000,
    message: `the cue grid to fill from ${path.basename(copy)}`,
  });
}

/** Where the number cell of a row is, in physical pixels, or null when the row is not rendered. */
function rowCentre(position) {
  return browser.execute((wanted) => {
    const rows = Array.from(document.querySelectorAll(".cuelist__row"));
    const row = rows.find(
      (candidate) => candidate.querySelector(".cuelist__pos")?.textContent === wanted,
    );
    const cell = row?.querySelector(".cuelist__pos");
    if (!cell) {
      return null;
    }
    const rect = cell.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    return { x: (rect.x + rect.width / 2) * dpr, y: (rect.y + rect.height / 2) * dpr };
  }, String(position));
}

function rowIsActive(position) {
  return browser.execute((wanted) => {
    const rows = Array.from(document.querySelectorAll(".cuelist__row"));
    const row = rows.find(
      (candidate) => candidate.querySelector(".cuelist__pos")?.textContent === wanted,
    );
    return row?.classList.contains("cuelist__row--active") === true;
  }, String(position));
}

/** What the grid says about itself, for a click that did not do what it was aimed to do. */
function gridState() {
  return browser.execute(() => ({
    scrollTop: document.querySelector(".cuelist")?.scrollTop ?? null,
    active: document.querySelector(".cuelist__row--active .cuelist__pos")?.textContent ?? null,
  }));
}

/**
 * Put the cursor on a row by clicking its number cell, the way a person moves it.
 *
 * Twice if the first one does not take: the grid scrolls itself to keep the cursor in view, so a
 * rectangle read here can be stale by the time the button goes down on a loaded machine. The second
 * attempt prints what the first one saw, so a run that needed it still says so. See e2e/README.md.
 */
async function goToRow(toplevel, position) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const centre = await rowCentre(position);
    if (centre === null) {
      throw new Error(`row ${position} is not in the grid, so the cursor cannot be put on it`);
    }
    clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
    try {
      await waitFor(() => rowIsActive(position), {
        timeout: attempt === 1 ? 5000 : 15000,
        message: `the cursor to reach row ${position}`,
      });
      return;
    } catch (error) {
      if (attempt === 2) {
        throw error;
      }
      const state = await gridState();
      console.log(
        `goToRow: row ${position} was clicked at ${centre.x},${centre.y} and did not take. ` +
          `The grid is at scrollTop ${state.scrollTop} with row ${state.active} active. Clicking again.`,
      );
    }
  }
}

/** Walk every row of an open fixture and read the count off each one. */
async function countsDown(toplevel, rows) {
  const read = [];
  for (let position = 1; position <= rows; position += 1) {
    await goToRow(toplevel, position);
    // The panel follows the cursor, so the reading is taken once the box holds that row's text.
    const seen = await waitFor(
      async () => {
        const band = await bandOne();
        return band.characters === null ? null : band;
      },
      { timeout: 15000, message: `the first band to draw a count for row ${position}` },
    );
    read.push({ characters: seen.characters, over: seen.over });
  }
  return read;
}

async function attachToApp() {
  const toplevel = await waitFor(findToplevel, {
    timeout: 30000,
    message: `the ${windowWidth}x${windowHeight} "Sublore" toplevel to appear`,
  });
  focusWindow(toplevel.id);
  await waitFor(() => present(".toolbar__file-open-subtitle"), {
    timeout: 30000,
    message: "the app UI to render",
  });
  return toplevel;
}

describe("the current line's bands", () => {
  let toplevel = null;

  before(async () => {
    requireWaveformFixture();
    rmSync(storedLayout(), { force: true });
    await browser.reloadSession();
    toplevel = await attachToApp();
  });

  after(() => {
    rmSync(storedLayout(), { force: true });
    rmSync(path.join(dataHome(), "current-line-bands"), { recursive: true, force: true });
  });

  it("draws the two bands in the order the panel's table gives them", async () => {
    await openSubtitle(toplevel, workingCopy("ass/clean/basic.ass"));

    // Identity first with the two measures of the text at its right end, numbers under it. The
    // order is part of the criterion: a control in the right band and the wrong place is a defect.
    expect(await bandOrder()).toEqual([
      { band: "identity", parts: ["Comment", "Style", "Actor", "Effect", "Characters", "CPS"] },
      { band: "times", parts: ["Layer", "Start", "End", "Duration", "L", "R", "V"] },
      { band: "actions", parts: [] },
      // The reference's own row under the box: what the line was, two ways of emptying it, and the
      // source's line. Its buttons carry no label of their own, so the band reads as empty here.
      { band: "bottom", parts: [] },
    ]);
  });

  it("counts the longest line of the row the cursor is on, and takes the warning ink past 42", async () => {
    const rows = COUNTS["ass/clean/basic.ass"];
    expect(await countsDown(toplevel, rows.length)).toEqual(
      rows.map((characters) => ({ characters, over: characters > CHARACTER_LIMIT })),
    );
    // The middle row is the one over the limit, so the pair above is not two readings of one state.
    expect(rows.filter((count) => count > CHARACTER_LIMIT)).toEqual([45]);
  });

  it("counts what a reader sees and not what the field holds", async () => {
    for (const fixture of [
      "ass/clean/override-tags.ass",
      "ass/clean/text-with-commas.ass",
      "ass/clean/non-latin.ass",
      "srt/clean/basic-lf.srt",
    ]) {
      await openSubtitle(toplevel, workingCopy(fixture));
      const rows = COUNTS[fixture];
      expect({
        fixture,
        counts: (await countsDown(toplevel, rows.length)).map((r) => r.characters),
      }).toEqual({ fixture, counts: rows });
    }
  });

  it("moves the ink while the text is being typed, with nothing committed either way", async () => {
    const copy = workingCopy("ass/clean/basic.ass");
    const bytes = readFileSync(copy);
    await openSubtitle(toplevel, copy);
    await goToRow(toplevel, 1);
    await watchCommands();

    await clickElement(toplevel, ".currentline__text");
    await waitFor(
      () =>
        browser.execute(
          () => document.activeElement?.classList.contains("currentline__text") === true,
        ),
      { timeout: 15000, message: "the current-line box to take the keyboard" },
    );
    // 37 to start with, so eight more characters carry it to 45 and past the limit.
    typeText("12345678");
    const over = await waitFor(
      async () => {
        const band = await bandOne();
        return band.characters === 45 ? band : null;
      },
      { timeout: 15000, message: "the count to follow the typing up to 45" },
    );
    expect(over.over).toBe(true);

    backspace(4);
    const under = await waitFor(
      async () => {
        const band = await bandOne();
        return band.characters === 41 ? band : null;
      },
      { timeout: 15000, message: "the count to follow the typing back down to 41" },
    );
    expect(under.over).toBe(false);

    // Both readings above were taken before anything was sent: the count reads a field and writes
    // nothing, and the ink moved with no commit between the two.
    expect(await takeCommands()).toEqual([]);
    expect(readFileSync(copy).equals(bytes)).toBe(true);

    // And put the row back, so the panel is over the document again for the sweeps below.
    backspace(4);
    await waitFor(async () => ((await bandOne()).characters === 37 ? 1 : null), {
      timeout: 15000,
      message: "the box to hold the row it was opened with again",
    });
  });

  it("warns at forty-three and not at forty-two, which is where the limit sits", async () => {
    const copy = workingCopy("ass/clean/basic.ass");
    const bytes = readFileSync(copy);
    await openSubtitle(toplevel, copy);
    await goToRow(toplevel, 1);
    await watchCommands();

    await clickElement(toplevel, ".currentline__text");
    await waitFor(
      () =>
        browser.execute(
          () => document.activeElement?.classList.contains("currentline__text") === true,
        ),
      { timeout: 15000, message: "the current-line box to take the keyboard" },
    );
    // The row is 37, so five more characters is exactly the limit and six is one past it. Both
    // readings are needed: a check that only ever looks at 45 passes with the limit set anywhere
    // between 42 and 44, which is what moving it to 43 proved.
    typeText("12345");
    const at = await waitFor(
      async () => {
        const band = await bandOne();
        return band.characters === 42 ? band : null;
      },
      { timeout: 15000, message: "the count to reach 42" },
    );
    expect({ characters: at.characters, over: at.over }).toEqual({ characters: 42, over: false });

    typeText("6");
    const past = await waitFor(
      async () => {
        const band = await bandOne();
        return band.characters === 43 ? band : null;
      },
      { timeout: 15000, message: "the count to reach 43" },
    );
    expect({ characters: past.characters, over: past.over }).toEqual({
      characters: 43,
      over: true,
    });

    pressKey("Escape");
    expect(await takeCommands()).toEqual([]);
    expect(readFileSync(copy).equals(bytes)).toBe(true);
  });

  it("draws the speaker greyed and in its place on a document that cannot hold one", async () => {
    // Two formats that have no such field, and two ASS files whose own Format line declares none.
    // The last is the one that says the control reads the field list and not the format name.
    for (const fixture of [
      "srt/clean/basic-lf.srt",
      "vtt/clean/basic.vtt",
      "ass/clean/minimal-fields.ass",
      "ass/clean/field-after-text.ass",
    ]) {
      await openSubtitle(toplevel, workingCopy(fixture));
      await goToRow(toplevel, 1);
      expect({ fixture, ...(await speaker()) }).toEqual({
        fixture,
        drawn: true,
        value: "",
        disabled: true,
        openerDisabled: true,
        refusal: null,
      });
      // The band does not change shape around it, and the readings beside it still work.
      expect(await bandOrder()).toEqual([
        { band: "identity", parts: ["Comment", "Style", "Actor", "Effect", "Characters", "CPS"] },
        {
          band: "times",
          parts: ["Layer", "Start", "End", "Duration", "L", "R", "V"],
        },
        { band: "actions", parts: [] },
        { band: "bottom", parts: [] },
      ]);
    }

    // And it comes alive in place on a file that does declare the field, in the same session.
    await openSubtitle(toplevel, workingCopy("ass/clean/speakers.ass"));
    await goToRow(toplevel, 1);
    expect(await speaker()).toEqual({
      drawn: true,
      value: "Ingrid",
      disabled: false,
      openerDisabled: false,
      refusal: null,
    });
  });

  it("writes one speaker into the file and gives it back in one undo", async () => {
    const copy = workingCopy("ass/clean/speakers.ass");
    const before = readFileSync(copy);
    await openSubtitle(toplevel, copy);

    // The fifth row has no speaker, so this is a write into an empty field between two commas.
    await goToRow(toplevel, 5);
    expect((await speaker()).value).toBe("");
    await typeIntoActor(toplevel, "Bo");
    pressKey("Return");

    // The grid is the other view of the same row and follows the commit. A commit is not a save,
    // exactly as it is not one for the text, so the file is still untouched here.
    await waitFor(async () => ((await gridActor(5)) === "Bo" ? 1 : null), {
      timeout: 15000,
      message: "the grid's speaker column to follow the commit",
    });
    expect(readFileSync(copy).equals(before)).toBe(true);

    await clickElement(toplevel, ".toolbar__file-save");
    await waitFor(
      () =>
        readFileSync(copy, "utf8").includes(
          "Dialogue: 0,0:00:12.30,0:00:14.90,Default,Bo,0,0,0,,Nobody signed for the delivery.",
        )
          ? 1
          : null,
      { timeout: 20000, message: "the saved file to carry the speaker on its fifth event line" },
    );
    // Only that field moved: every other byte of the file is what it was opened as, the script
    // headers and the style line included.
    expect(readFileSync(copy, "utf8")).toBe(
      before.toString("utf8").replace(",Default,,0,0,0,,Nobody", ",Default,Bo,0,0,0,,Nobody"),
    );

    // One undo, not two: setting a field is a single step the way a text edit is.
    await runFromMenu((css) => clickElement(toplevel, css), "edit", "edit-undo");
    await waitFor(async () => ((await speaker()).value === "" ? 1 : null), {
      timeout: 15000,
      message: "one undo to empty the field again",
    });
    expect(await gridActor(5)).toBe("");
    await clickElement(toplevel, ".toolbar__file-save");
    await waitFor(() => (readFileSync(copy).equals(before) ? 1 : null), {
      timeout: 20000,
      message: "the saved file to be byte for byte what it was opened as",
    });
  });

  it("offers the names the document already uses, in the order it first uses them", async () => {
    // Marek, then Bo, then Ingrid, with Marek on two rows: first-appearance order and alphabetical
    // order differ at every position here, so this reddens if the list is ever sorted.
    await openSubtitle(toplevel, workingCopy("ass/clean/speakers-unsorted.ass"));
    await goToRow(toplevel, 5);
    await clickElement(toplevel, ".currentline__actor-open");
    await waitFor(() => present(".currentline__actor-list"), {
      timeout: 15000,
      message: "the speaker list to open",
    });
    expect(await offeredNames()).toEqual(["Marek", "Bo", "Ingrid"]);

    // Picking puts the name in the field and commits it in the one gesture.
    await clickElement(toplevel, ".currentline__actor-name");
    await waitFor(async () => ((await speaker()).value === "Marek" ? 1 : null), {
      timeout: 15000,
      message: "the picked name to reach the field",
    });
    // Saved before the next file is opened: a commit leaves the document dirty and an open with
    // unsaved work is refused, which would leave this document on screen and read its list again.
    await clickElement(toplevel, ".toolbar__file-save");

    // And the list follows the document rather than being built once at open.
    const copy = workingCopy("ass/clean/speakers.ass");
    await openSubtitle(toplevel, copy);
    await goToRow(toplevel, 5);
    await clickElement(toplevel, ".currentline__actor-open");
    await waitFor(() => present(".currentline__actor-list"), {
      timeout: 15000,
      message: "the speaker list to open on the second file",
    });
    expect(await offeredNames()).toEqual(["Ingrid", "Marek"]);

    await typeIntoActor(toplevel, "Bo");
    pressKey("Return");
    await waitFor(async () => ((await gridActor(5)) === "Bo" ? 1 : null), {
      timeout: 15000,
      message: "the new name to reach the document",
    });
    await clickElement(toplevel, ".currentline__actor-open");
    await waitFor(() => present(".currentline__actor-list"), {
      timeout: 15000,
      message: "the speaker list to open again",
    });
    expect(await offeredNames()).toEqual(["Ingrid", "Marek", "Bo"]);

    // Left clean for the check after this one, which opens a file of its own.
    await clickElement(toplevel, ".toolbar__file-save");
  });

  it("finds the speaker field by name and never by position", async () => {
    // This file's Format line spells the field Actor rather than Name. Same answer either way.
    await openSubtitle(toplevel, workingCopy("ass/clean/actor-spelling.ass"));
    await goToRow(toplevel, 1);
    expect((await speaker()).value).toBe("Ingrid");

    // And this one puts the name first and the style last before the text. Reading is one half of
    // it; the write below is the half that reddens the moment an index is treated as a position.
    const copy = workingCopy("ass/clean/speakers-shuffled.ass");
    const before = readFileSync(copy);
    await openSubtitle(toplevel, copy);
    await goToRow(toplevel, 5);
    expect((await speaker()).value).toBe("");

    await typeIntoActor(toplevel, "Bo");
    pressKey("Return");
    await waitFor(async () => ((await gridActor(5)) === "Bo" ? 1 : null), {
      timeout: 15000,
      message: "the grid's speaker column to follow the commit on the shuffled file",
    });
    await clickElement(toplevel, ".toolbar__file-save");

    // The name field took it and the layer beside it did not: a write by position would have put
    // Bo where the 0 is, and the style is last on this line rather than before the name.
    await waitFor(
      () =>
        readFileSync(copy, "utf8").includes(
          "Dialogue: Bo,0,0:00:12.30,0:00:14.90,0,0,0,,Default,Nobody signed for the delivery.",
        )
          ? 1
          : null,
      { timeout: 20000, message: "the shuffled file's name field to carry the speaker" },
    );
    expect(readFileSync(copy, "utf8")).toBe(
      before
        .toString("utf8")
        .replace(
          "Dialogue: ,0,0:00:12.30,0:00:14.90,0,0,0,,Default,Nobody",
          "Dialogue: Bo,0,0:00:12.30,0:00:14.90,0,0,0,,Default,Nobody",
        ),
    );
  });

  it("refuses a name holding a comma where the field stands, and sends nothing", async () => {
    const copy = workingCopy("ass/clean/speakers.ass");
    const before = readFileSync(copy);
    await openSubtitle(toplevel, copy);
    await goToRow(toplevel, 5);
    await watchCommands();

    // A comma separates the fields of the line, so accepting this would hand part of the line to
    // the text field. It is refused here, before anything is sent.
    await typeIntoActor(toplevel, "Ingrid, the elder");
    pressKey("Return");

    const said = await waitFor(
      async () => {
        const seen = await speaker();
        return seen.refusal === null ? null : seen;
      },
      { timeout: 15000, message: "the field to say why the name was refused" },
    );
    // The sentence names the comma, which is the whole point: the shared refusal talks about line
    // breaks, and a translator typing a name did not type one.
    expect(said.refusal).toContain("comma");
    // The refused value stays in the field so it can be corrected.
    expect(said.value).toBe("Ingrid, the elder");

    // Nothing reached the backend and the file did not move.
    expect(await takeCommands()).toEqual([]);
    expect(readFileSync(copy).equals(before)).toBe(true);
    // The grid never saw it either, so no route carried the comma into the document.
    expect(await gridActor(5)).toBe("");

    // Escape puts the field back to what the document holds, and the sentence goes with it.
    pressKey("Escape");
    await waitFor(async () => ((await speaker()).refusal === null ? 1 : null), {
      timeout: 15000,
      message: "Escape to put the field back and take the refusal down",
    });
  });

  it("counts a line whose brace was left open, without merging it with the next", async () => {
    const copy = workingCopy("ass/clean/text-with-commas.ass");
    const bytes = readFileSync(copy);
    await openSubtitle(toplevel, copy);
    await goToRow(toplevel, 1);
    await watchCommands();
    // Two lines of 48 and 51 divided by `\N`, so the count is 51 and their sum would be 99.
    expect((await bandOne()).characters).toBe(51);

    await clickElement(toplevel, ".currentline__text");
    await waitFor(
      () =>
        browser.execute(() => {
          const box = document.querySelector(".currentline__text");
          if (document.activeElement !== box) {
            return null;
          }
          box.setSelectionRange(0, 0);
          return 1;
        }),
      { timeout: 15000, message: "the box to take the keyboard with the caret at the head" },
    );
    // The first keystroke of an italic tag. Until its `}` arrives the brace is one character of
    // text on the line it sits on, and the `\N` after it still ends that line.
    typeText("{");
    const held = await waitFor(
      async () => {
        const band = await bandOne();
        return band.text?.startsWith("{") === true ? band : null;
      },
      { timeout: 15000, message: "the typed brace to reach the box" },
    );
    expect({ characters: held.characters, over: held.over }).toEqual({
      characters: 51,
      over: true,
    });

    pressKey("Escape");
    expect(await takeCommands()).toEqual([]);
    expect(readFileSync(copy).equals(bytes)).toBe(true);
  });

  it("keeps a typed speaker as unsaved work, and saves it without a blur first", async () => {
    const copy = workingCopy("ass/clean/speakers.ass");
    const before = readFileSync(copy);
    await openSubtitle(toplevel, copy);
    await goToRow(toplevel, 5);

    // Nothing typed yet: the file is as it was opened and there is nothing to save.
    expect(await saveEnabled()).toBe(false);
    await typeIntoActor(toplevel, "Bo");
    // Typed and not committed. A name sitting in the field is unsaved work the way a typed time is,
    // so Save is live; greyed here would mean the greying ruling refuses the save and the name is
    // lost with no message. See E4.8.
    await waitFor(async () => ((await saveEnabled()) ? 1 : null), {
      timeout: 15000,
      message: "Save to come alive on a speaker that is typed and not committed",
    });

    // Saved from the keyboard, so the field never loses focus and only the flush can carry it.
    pressKey("ctrl+s");
    await waitFor(
      () => (readFileSync(copy, "utf8").includes(",Default,Bo,0,0,0,,Nobody signed") ? 1 : null),
      { timeout: 20000, message: "the save to write the name the field was still holding" },
    );
    expect(readFileSync(copy, "utf8")).toBe(
      before.toString("utf8").replace(",Default,,0,0,0,,Nobody", ",Default,Bo,0,0,0,,Nobody"),
    );
  });

  it("writes nothing when the only change is padding the panel never shows", async () => {
    const copy = workingCopy("ass/clean/speakers.ass");
    const bytes = readFileSync(copy);
    await openSubtitle(toplevel, copy);
    await goToRow(toplevel, 1);
    expect((await speaker()).value).toBe("Ingrid");
    await watchCommands();

    // The document's own reader drops the padding around a field, so the panel draws `Ingrid` for
    // both `Ingrid` and `Ingrid `. A commit that sent the padded one would add a byte and an undo
    // step for a change the panel cannot show. See E4.7.
    await typeIntoActor(toplevel, "Ingrid ");
    pressKey("Return");
    await waitFor(async () => ((await speaker()).value === "Ingrid " ? 1 : null), {
      timeout: 15000,
      message: "the padded name to sit in the field",
    });
    expect(await takeCommands()).toEqual([]);
    expect(readFileSync(copy).equals(bytes)).toBe(true);
    // Unsaved work all the same, by the one rule the panel's fields share: what sits in a field the
    // document does not hold is unsaved whether or not it would write anything.
    expect(await saveEnabled()).toBe(true);
    pressKey("Escape");
    await waitFor(async () => ((await speaker()).value === "Ingrid" ? 1 : null), {
      timeout: 15000,
      message: "Escape to put the field back",
    });
  });

  it("says what an SRT cannot hold in its text without naming a comma", async () => {
    const copy = workingCopy("srt/clean/basic-lf.srt");
    await openSubtitle(toplevel, copy);
    await goToRow(toplevel, 1);

    await clickElement(toplevel, ".currentline__text");
    await waitFor(
      () =>
        browser.execute(() => {
          const box = document.querySelector(".currentline__text");
          if (document.activeElement !== box) {
            return null;
          }
          box.setSelectionRange(0, 0);
          return 1;
        }),
      { timeout: 15000, message: "the box to take the keyboard with the caret at the head" },
    );
    // An SRT breaks its blocks on a blank line, so a blank line inside cue text is the one thing
    // the format cannot hold. It is the only thing that produces this sentence, and a comma is
    // ordinary in subtitle text: a sentence telling a translator to remove one damages the work.
    typeText("a");
    pressKey("shift+Return");
    pressKey("shift+Return");
    pressKey("Return");
    const said = await waitFor(
      () => browser.execute(() => document.querySelector(".statusbar__error")?.textContent ?? null),
      { timeout: 15000, message: "the refusal to reach the status bar" },
    );
    expect(said).toContain("blank line");
    expect(said).not.toContain("comma");

    // Put the box and the document back, so the sweeps below measure the panel with every control
    // it draws rather than one an SRT greys.
    pressKey("Escape");
    await openSubtitle(toplevel, workingCopy("ass/clean/speakers.ass"));
    await goToRow(toplevel, 1);
  });

  it("goes to the next cue, and makes one when the cursor is on the last", async () => {
    const copy = workingCopy("ass/clean/speakers.ass");
    const before = readFileSync(copy);
    await openSubtitle(toplevel, copy);
    await goToRow(toplevel, 1);
    const rows = () => browser.execute(() => document.querySelectorAll(".cuelist__row").length);
    const counted = await rows();

    // On any row but the last it is navigation and nothing else: the cursor moves and the document
    // is not touched, so the file on disk is still what it was opened as.
    await clickElement(toplevel, ".currentline__subtitle-next-line");
    await waitFor(async () => ((await cursorRow()) === 2 ? 1 : null), {
      timeout: 15000,
      message: "the cursor to move to the second row",
    });
    expect(await rows()).toBe(counted);
    expect(readFileSync(copy).equals(before)).toBe(true);

    // On the last row it makes the row it moves to, starting where that one ended.
    await goToRow(toplevel, counted);
    const last = await currentTimes();
    await clickElement(toplevel, ".currentline__subtitle-next-line");
    await waitFor(async () => ((await rows()) === counted + 1 ? 1 : null), {
      timeout: 15000,
      message: "a cue to be made after the last one",
    });
    expect(await cursorRow()).toBe(counted + 1);
    expect((await currentTimes()).start).toBe(last.end);

    // One undo takes it back off, which is what an insert costs anywhere else.
    await runFromMenu((css) => clickElement(toplevel, css), "edit", "edit-undo");
    await waitFor(async () => ((await rows()) === counted ? 1 : null), {
      timeout: 15000,
      message: "one undo to remove the cue it made",
    });
  });

  it("wraps the selected words in a style tag, and takes it off again", async () => {
    const lineText = () =>
      browser.execute(() => document.querySelector(".currentline__text")?.value ?? null);
    const select = (word) =>
      browser.execute((wanted) => {
        const box = document.querySelector(".currentline__text");
        const at = box.value.indexOf(wanted);
        box.focus();
        box.setSelectionRange(at, at + wanted.length);
        box.dispatchEvent(new Event("select", { bubbles: true }));
        return at;
      }, word);

    const copy = workingCopy("ass/clean/speakers.ass");
    await openSubtitle(toplevel, copy);
    await goToRow(toplevel, 1);
    const before = await lineText();
    expect(before).toContain("harbour");

    await select("harbour");
    await clickElement(toplevel, ".currentline__edit-style-bold");
    await waitFor(async () => ((await lineText())?.includes("{\\b1}harbour{\\b0}") ? 1 : null), {
      timeout: 15000,
      message: "the selected word to be wrapped in a bold tag",
    });
    // Only that word moved: the rest of the line is what it was.
    expect(await lineText()).toBe(before.replace("harbour", "{\\b1}harbour{\\b0}"));

    await runFromMenu((css) => clickElement(toplevel, css), "edit", "edit-undo");
    await waitFor(async () => ((await lineText()) === before ? 1 : null), {
      timeout: 15000,
      message: "one undo to take the tag back off",
    });
  });

  it("writes the colour picked at the caret, and takes it off in one undo", async () => {
    const lineText = () =>
      browser.execute(() => document.querySelector(".currentline__text")?.value ?? null);
    const caretBefore = (word) =>
      browser.execute((wanted) => {
        const box = document.querySelector(".currentline__text");
        const at = box.value.indexOf(wanted);
        box.focus();
        box.setSelectionRange(at, at);
        box.dispatchEvent(new Event("select", { bubbles: true }));
        return at;
      }, word);
    const buttons = () =>
      browser.execute(() =>
        Array.from(document.querySelectorAll(".currentline__colour")).map((button) => ({
          name: button.getAttribute("aria-label"),
          disabled: button.disabled,
        })),
      );

    // An override tag is an ASS thing, so on a format that carries none all four are drawn and
    // greyed rather than absent, and greyed is what keeps a refusal from being reachable (24 A2).
    await openSubtitle(toplevel, workingCopy("srt/clean/basic-lf.srt"));
    await goToRow(toplevel, 1);
    expect(await buttons()).toEqual([
      { name: "Primary colour", disabled: true },
      { name: "Secondary colour", disabled: true },
      { name: "Outline colour", disabled: true },
      { name: "Shadow colour", disabled: true },
    ]);

    const copy = workingCopy("ass/clean/speakers.ass");
    await openSubtitle(toplevel, copy);
    await goToRow(toplevel, 1);
    const before = await lineText();
    expect(before).toContain("harbour");

    await caretBefore("harbour");
    await waitFor(async () => ((await buttons()).every((one) => !one.disabled) ? 1 : null), {
      timeout: 15000,
      message: "a caret in the box to ungrey the four colours",
    });

    await clickElement(toplevel, ".currentline__colour-outline");
    await waitFor(() => present(".currentline__picker"), {
      timeout: 15000,
      message: "the picker to open under the button",
    });
    await clickElement(toplevel, '.currentline__swatch[aria-label="#FF0000"]');
    // ASS writes a colour blue first, so red is `&H0000FF&`, and the outline is the third one.
    await waitFor(async () => ((await lineText())?.includes("{\\3c&H0000FF&}harbour") ? 1 : null), {
      timeout: 15000,
      message: "the outline colour to be written where the caret was",
    });
    expect(await lineText()).toBe(before.replace("harbour", "{\\3c&H0000FF&}harbour"));
    expect(await present(".currentline__picker")).toBe(false);

    await runFromMenu((css) => clickElement(toplevel, css), "edit", "edit-undo");
    await waitFor(async () => ((await lineText()) === before ? 1 : null), {
      timeout: 15000,
      message: "one undo to take the colour back off",
    });
  });

  it("moves the square, the slider and every notation together, and a grey keeps its hue", async () => {
    const caretBefore = (word) =>
      browser.execute((wanted) => {
        const box = document.querySelector(".currentline__text");
        const at = box.value.indexOf(wanted);
        box.focus();
        box.setSelectionRange(at, at);
        box.dispatchEvent(new Event("select", { bubbles: true }));
        return at;
      }, word);
    // The spectrum the picker did not have (N39). What is asserted is that the five ways of saying
    // one colour agree, because that is the whole claim: they are one state drawn five times.
    await caretBefore("harbour");
    await clickElement(toplevel, ".currentline__colour-primary");
    await waitFor(() => present(".currentline__picker"), {
      timeout: 15000,
      message: "the picker to open",
    });

    const spectrum = () =>
      browser.execute(() => ({
        squareLeft: document.querySelector(".currentline__square-thumb")?.style.left,
        squareTop: document.querySelector(".currentline__square-thumb")?.style.top,
        hueTop: document.querySelector(".currentline__hue-thumb")?.style.top,
        preview: document.querySelector(".currentline__preview")?.style.background,
        ass: document.querySelector(".currentline__ass dd")?.textContent,
        rgb: document.querySelector(".currentline__rgb dd")?.textContent,
        hsv: document.querySelector(".currentline__hsv dd")?.textContent,
        hsl: document.querySelector(".currentline__hsl dd")?.textContent,
      }));

    await typeHex("#00FF00");
    const green = await waitFor(
      async () => {
        const now = await spectrum();
        return now.rgb === "0, 255, 0" ? now : null;
      },
      { timeout: 15000, message: "pure green to reach the notations" },
    );
    // Green is hue 120 of 360, so the slider sits a third of the way down, and the square's mark is
    // in the corner where saturation is full and value is full. Read as numbers: how many digits a
    // browser spells a percentage with is its business, and pinning the string tests the browser.
    const percent = (value) => Number.parseFloat(value);
    expect(percent(green.hueTop)).toBeCloseTo(100 / 3, 3);
    expect(percent(green.squareLeft)).toBeCloseTo(100, 3);
    // The bottom, not the top: the reference draws value rising downward, black at the top, and a
    // full-value colour therefore sits at the foot of the square.
    expect(percent(green.squareTop)).toBeCloseTo(100, 3);
    expect(green.ass).toBe("&H00FF00&");
    expect(green.hsv).toBe("120, 100, 100");
    expect(green.hsl).toBe("120, 100, 50");

    // The case the picker is built around: a grey has no hue, so a picker that re-derived its state
    // would swing the slider to red. The mark stays where green left it.
    await typeHex("#808080");
    const grey = await waitFor(
      async () => {
        const now = await spectrum();
        return now.rgb === "128, 128, 128" ? now : null;
      },
      { timeout: 15000, message: "the grey to reach the notations" },
    );
    expect(percent(grey.hueTop)).toBeCloseTo(percent(green.hueTop), 3);
    expect(percent(grey.squareLeft)).toBeCloseTo(0, 3);
    // Half value is half way down, which is the other half of the axis being the way it is.
    expect(percent(grey.squareTop)).toBeCloseTo(50, 0);
    expect(grey.hsv).toBe("120, 0, 50");

    pressKey("Escape");
    await waitFor(async () => ((await present(".currentline__picker")) ? null : 1), {
      timeout: 15000,
      message: "the picker to close",
    });
  });

  it("offers the eyedropper, and says so where no portal answers", async () => {
    const caretBefore = (word) =>
      browser.execute((wanted) => {
        const box = document.querySelector(".currentline__text");
        const at = box.value.indexOf(wanted);
        box.focus();
        box.setSelectionRange(at, at);
        box.dispatchEvent(new Event("select", { bubbles: true }));
        return at;
      }, word);

    if (await present(".currentline__picker")) {
      pressKey("Escape");
      await waitFor(async () => ((await present(".currentline__picker")) ? null : 1), {
        timeout: 15000,
        message: "a picker left open by an earlier test to close",
      });
    }
    await caretBefore("harbour");
    await clickElement(toplevel, ".currentline__colour-primary");
    await waitFor(() => present(".currentline__picker"), {
      timeout: 15000,
      message: "the picker to open",
    });

    // Offered, not greyed: asking and being told no is an outcome, not a reason to withhold it.
    expect(await present(".currentline__dropper")).toBe(true);
    const before = await browser.execute(
      () => document.querySelector(".currentline__ass dd")?.textContent,
    );

    // There is no desktop portal under Xvfb, which is the case this can prove: the panel says so,
    // the colour does not move, and nothing reads the screen instead. What a real portal answers
    // is the owner's own run to see. See BACKLOG.md N54.
    await clickElement(toplevel, ".currentline__dropper");
    await waitFor(
      async () => {
        const said = await browser.execute(
          () => document.querySelector(".statusbar__notice")?.textContent ?? "",
        );
        return said.includes("desktop portal") ? said : null;
      },
      { timeout: 20000, message: "the panel to say the eyedropper has no portal" },
    );
    expect(
      await browser.execute(() => document.querySelector(".currentline__ass dd")?.textContent),
    ).toBe(before);

    pressKey("Escape");
    await waitFor(async () => ((await present(".currentline__picker")) ? null : 1), {
      timeout: 15000,
      message: "the picker to close",
    });
  });

  it("opens the outline colour's picker on the reference's own key", async () => {
    const caretBefore = (word) =>
      browser.execute((wanted) => {
        const box = document.querySelector(".currentline__text");
        const at = box.value.indexOf(wanted);
        box.focus();
        box.setSelectionRange(at, at);
        box.dispatchEvent(new Event("select", { bubbles: true }));
        return at;
      }, word);

    if (await present(".currentline__picker")) {
      pressKey("Escape");
      await waitFor(async () => ((await present(".currentline__picker")) ? null : 1), {
        timeout: 15000,
        message: "a picker left open by an earlier test to close",
      });
    }
    await caretBefore("harbour");
    // The precondition, said rather than assumed: a key that finds the command greyed does nothing,
    // and a check that could not tell that from a key that never arrived would name neither.
    const ready = await browser.execute(
      () => document.querySelector(".currentline__colour-outline")?.disabled,
    );
    expect(ready).toBe(false);
    // Alt+3 with the caret in the box, which is where the reference binds it: the four colours are
    // registry commands now and not buttons alone, so a key can reach them (N112).
    pressKey("alt+3");
    await waitFor(() => present(".currentline__picker"), {
      timeout: 15000,
      message: "alt+3 to open a picker",
    });
    // Which picker, and not merely that one opened: the button a picker is drawn over is the one
    // that reports itself expanded, so the outline's saying so is the outline's picker.
    const expanded = await browser.execute(() =>
      Array.from(document.querySelectorAll(".currentline__colour"))
        .filter((button) => button.getAttribute("aria-expanded") === "true")
        .map((button) =>
          Array.from(button.classList).find((name) => name.startsWith("currentline__colour-")),
        ),
    );
    expect(expanded).toEqual(["currentline__colour-outline"]);

    pressKey("Escape");
    await waitFor(async () => ((await present(".currentline__picker")) ? null : 1), {
      timeout: 15000,
      message: "the picker to close",
    });
  });

  it("puts each mode's quantities on the axes the reference gives them", async () => {
    const caretBefore = (word) =>
      browser.execute((wanted) => {
        const box = document.querySelector(".currentline__text");
        const at = box.value.indexOf(wanted);
        box.focus();
        box.setSelectionRange(at, at);
        box.dispatchEvent(new Event("select", { bubbles: true }));
        return at;
      }, word);

    if (await present(".currentline__picker")) {
      pressKey("Escape");
      await waitFor(async () => ((await present(".currentline__picker")) ? null : 1), {
        timeout: 15000,
        message: "a picker left open by an earlier test to close",
      });
    }
    await caretBefore("harbour");
    await clickElement(toplevel, ".currentline__colour-primary");
    await waitFor(() => present(".currentline__picker"), {
      timeout: 15000,
      message: "the picker to open",
    });

    await typeHex("#3366CC");
    const notations = () =>
      browser.execute(() => ({
        rgb: document.querySelector(".currentline__rgb dd")?.textContent,
        hsv: document.querySelector(".currentline__hsv dd")?.textContent,
        squareLeft: document.querySelector(".currentline__square-thumb")?.style.left,
        squareTop: document.querySelector(".currentline__square-thumb")?.style.top,
        hueTop: document.querySelector(".currentline__hue-thumb")?.style.top,
      }));
    const inHsv = await waitFor(
      async () => {
        const now = await notations();
        return now.rgb === "51, 102, 204" ? now : null;
      },
      { timeout: 15000, message: "the typed colour to reach the picker" },
    );

    // In HSV/H the square is saturation across and value down, so this colour sits three quarters
    // saturated and four fifths of the way down.
    const percent = (value) => Number.parseFloat(value);
    expect(percent(inHsv.squareLeft)).toBeCloseTo(75, 0);
    expect(percent(inHsv.squareTop)).toBeCloseTo(80, 0);

    // RGB/B: green across, red down, blue on the slider. The colour must not move an inch.
    await browser.execute(() => {
      const choice = document.querySelector(".currentline__mode-choice");
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value",
      ).set;
      setter.call(choice, "rgbB");
      choice.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const inRgb = await waitFor(
      async () => {
        const now = await notations();
        return now.squareLeft !== inHsv.squareLeft ? now : null;
      },
      { timeout: 15000, message: "the mode change to move the mark" },
    );
    expect(inRgb.rgb).toBe(inHsv.rgb);
    expect(inRgb.hsv).toBe(inHsv.hsv);
    // 102 of 255 across, 51 of 255 down, 204 of 255 along the slider.
    expect(percent(inRgb.squareLeft)).toBeCloseTo(40, 0);
    expect(percent(inRgb.squareTop)).toBeCloseTo(20, 0);
    expect(percent(inRgb.hueTop)).toBeCloseTo(80, 0);

    pressKey("Escape");
    await waitFor(async () => ((await present(".currentline__picker")) ? null : 1), {
      timeout: 15000,
      message: "the picker to close",
    });
  });

  it("writes what the square was clicked on, and stays open for the next adjustment", async () => {
    // Left open by a test that failed before its own Escape, a picker turns one red into two: the
    // click below would toggle it shut rather than open.
    if (await present(".currentline__picker")) {
      pressKey("Escape");
      await waitFor(async () => ((await present(".currentline__picker")) ? null : 1), {
        timeout: 15000,
        message: "a picker left open by an earlier test to close",
      });
    }
    const lineText = () =>
      browser.execute(() => document.querySelector(".currentline__text")?.value ?? null);
    const caretBefore = (word) =>
      browser.execute((wanted) => {
        const box = document.querySelector(".currentline__text");
        const at = box.value.indexOf(wanted);
        box.focus();
        box.setSelectionRange(at, at);
        box.dispatchEvent(new Event("select", { bubbles: true }));
        return at;
      }, word);
    const before = await lineText();
    await caretBefore("harbour");
    await clickElement(toplevel, ".currentline__colour-primary");
    await waitFor(() => present(".currentline__picker"), {
      timeout: 15000,
      message: "the picker to open",
    });
    // Not typed into the field: focusing it takes the caret out of the text box, and a colour
    // written at no caret is written nowhere. What the picker starts on is whatever it was left on.
    const notation = () =>
      browser.execute(() => document.querySelector(".currentline__ass dd")?.textContent);
    const started = await notation();

    // The top left of the square is white at any hue: saturation nil, value full.
    const corner = await browser.execute(() => {
      const box = document.querySelector(".currentline__square")?.getBoundingClientRect();
      const dpr = window.devicePixelRatio;
      return box === undefined ? null : { x: (box.x + 3) * dpr, y: (box.y + 3) * dpr };
    });
    expect(corner).not.toBe(null);
    clickAt(toplevel.absX + corner.x, toplevel.absY + corner.y);

    // What reached the line is what the picker says it picked. Tying the two together is the claim;
    // pinning a literal colour would pin where in the square three pixels land, which is the box's
    // size and not the behaviour.
    const picked = await waitFor(
      async () => {
        const said = await notation();
        return said !== null && said !== started ? said : null;
      },
      { timeout: 20000, message: "the square's click to move the picker" },
    );
    await waitFor(async () => ((await lineText())?.includes(`{\\c${picked}}`) ? 1 : null), {
      timeout: 20000,
      message: `the colour the square was clicked on (${picked}) to reach the line`,
    });
    // A gesture inside the picker leaves it up: the next adjustment is one more gesture, not a
    // reopen. A swatch still closes it, which the check above this one pins.
    expect(await present(".currentline__picker")).toBe(true);

    pressKey("Escape");
    await waitFor(async () => ((await present(".currentline__picker")) ? null : 1), {
      timeout: 15000,
      message: "the picker to close",
    });
    await runFromMenu((css) => clickElement(toplevel, css), "edit", "edit-undo");
    await waitFor(async () => ((await lineText()) === before ? 1 : null), {
      timeout: 20000,
      message: "one undo to take the colour back off",
    });
  });

  it("takes a colour typed into the picker, and writes nothing while it is half typed", async () => {
    const lineText = () =>
      browser.execute(() => document.querySelector(".currentline__text")?.value ?? null);
    const field = () =>
      browser.execute(() => {
        const box = document.querySelector(".currentline__hex");
        return box === null
          ? null
          : { value: box.value, invalid: box.getAttribute("aria-invalid") };
      });
    const typeHex = async (toplevel, typed) => {
      await clickElement(toplevel, ".currentline__hex");
      await waitFor(
        () =>
          browser.execute(
            () => document.activeElement?.classList.contains("currentline__hex") === true,
          ),
        { timeout: 15000, message: "the picker's field to take the keyboard" },
      );
      pressKey("ctrl+a");
      typeText(typed);
      await waitFor(async () => ((await field())?.value === typed ? 1 : null), {
        timeout: 15000,
        message: `the picker's field to hold exactly ${typed}`,
      });
    };

    const copy = workingCopy("ass/clean/speakers.ass");
    await openSubtitle(toplevel, copy);
    await goToRow(toplevel, 1);
    const before = await lineText();
    await browser.execute(() => {
      const box = document.querySelector(".currentline__text");
      box.focus();
      box.setSelectionRange(0, 0);
      box.dispatchEvent(new Event("select", { bubbles: true }));
    });
    await waitFor(
      async () =>
        (await browser.execute(
          () => document.querySelector(".currentline__colour-primary")?.disabled === false,
        ))
          ? 1
          : null,
      { timeout: 15000, message: "a caret at the start of the box" },
    );

    await clickElement(toplevel, ".currentline__colour-primary");
    await waitFor(() => present(".currentline__hex"), {
      timeout: 15000,
      message: "the picker's own field",
    });

    // Four digits is not a colour, so Enter writes nothing and the field says which it is.
    await typeHex(toplevel, "#12AB");
    expect((await field())?.invalid).toBe("true");
    pressKey("Return");
    expect(await lineText()).toBe(before);
    expect(await present(".currentline__hex")).toBe(true);

    await typeHex(toplevel, "#12AB34");
    // A transparency beside it, which ASS counts the other way from opacity: 128 is half see
    // through and it is written in hexadecimal. The two go in as one step. See B12.
    await clickElement(toplevel, ".currentline__alpha");
    pressKey("ctrl+a");
    typeText("128");
    await waitFor(
      async () =>
        (await browser.execute(
          () => document.querySelector(".currentline__alpha")?.value ?? null,
        )) === "128"
          ? 1
          : null,
      { timeout: 15000, message: "the transparency field to hold exactly 128" },
    );
    pressKey("Return");
    // `#12AB34` is red 12, green AB, blue 34, and ASS writes the three the other way round.
    await waitFor(
      async () => ((await lineText()) === `{\\c&H34AB12&\\1a&H80&}${before}` ? 1 : null),
      { timeout: 15000, message: "the typed colour and its transparency written at the caret" },
    );

    // One step, not two: a colour and how see-through it is are one thing a translator chose.
    await runFromMenu((css) => clickElement(toplevel, css), "edit", "edit-undo");
    await waitFor(async () => ((await lineText()) === before ? 1 : null), {
      timeout: 15000,
      message: "one undo to take the colour and its transparency back off together",
    });
  });

  /** Undo until the document is what it was on disk, so the next test's open is not refused. */
  async function undoEverything(toplevel) {
    for (let step = 0; step < 12; step += 1) {
      if (!(await present(".statusbar__dirty"))) {
        return;
      }
      await runFromMenu((css) => clickElement(toplevel, css), "edit", "edit-undo");
      await new Promise((settle) => setTimeout(settle, 150));
    }
    throw new Error("the document was still dirty after twelve undos");
  }

  it("writes the font and its size as one step, and takes both back in one undo", async () => {
    const lineText = () =>
      browser.execute(() => document.querySelector(".currentline__text")?.value ?? null);
    const fontButton = () =>
      browser.execute(() => document.querySelector(".currentline__font")?.disabled ?? null);
    const typeInto = async (selector, typed) => {
      await clickElement(toplevel, selector);
      pressKey("ctrl+a");
      typeText(typed);
      await waitFor(
        async () =>
          (await browser.execute((css) => document.querySelector(css)?.value ?? null, selector)) ===
          typed
            ? 1
            : null,
        { timeout: 15000, message: `${selector} to hold exactly ${typed}` },
      );
    };

    const copy = workingCopy("ass/clean/speakers.ass");
    await openSubtitle(toplevel, copy);
    await goToRow(toplevel, 1);
    const before = await lineText();

    // It greys on the same condition the four colours do, which the colour check above proves on a
    // format that carries no tags at all; what is asserted here is the other half of that rule.
    await clickElement(toplevel, ".currentline__text");
    pressKey("Home");
    await waitFor(async () => ((await fontButton()) === false ? 1 : null), {
      timeout: 15000,
      message: "a caret in the box to ungrey the font button",
    });

    await clickElement(toplevel, ".currentline__font");
    await waitFor(() => present(".currentline__families"), {
      timeout: 15000,
      message: "the font picker to open on its list of families",
    });

    // The family is typed rather than picked off the list, because which fonts a machine has is
    // not something a check may depend on: the runner and this machine do not agree.
    await typeInto(".currentline__family", "Gentium Book");
    await typeInto(".currentline__fontsize", "48");
    await clickElement(toplevel, ".currentline__font-apply");
    await waitFor(
      async () => ((await lineText()) === `{\\fnGentium Book\\fs48}${before}` ? 1 : null),
      { timeout: 15000, message: "the family and the size written at the caret, in that order" },
    );
    expect(await present(".currentline__families")).toBe(false);

    // One step, not two: choosing a font is one thing a translator did.
    await runFromMenu((css) => clickElement(toplevel, css), "edit", "edit-undo");
    await waitFor(async () => ((await lineText()) === before ? 1 : null), {
      timeout: 15000,
      message: "one undo to take back the family and the size together",
    });
    await undoEverything(toplevel);
  });

  it("empties a line two ways, one keeping the braced runs and one keeping nothing", async () => {
    const lineText = () =>
      browser.execute(() => document.querySelector(".currentline__text")?.value ?? null);

    const copy = workingCopy("ass/clean/speakers.ass");
    await openSubtitle(toplevel, copy);
    await goToRow(toplevel, 1);

    // A line with words and a braced run in it, so the two clears can be told apart at all.
    await clickElement(toplevel, ".currentline__text");
    await waitFor(
      () =>
        browser.execute(
          () => document.activeElement?.classList.contains("currentline__text") === true,
        ),
      { timeout: 15000, message: "the box to take the keyboard" },
    );
    pressKey("ctrl+a");
    typeText("{\\b1}bold{\\b0} and plain");
    await waitFor(async () => ((await lineText()) === "{\\b1}bold{\\b0} and plain" ? 1 : null), {
      timeout: 15000,
      message: "the box to hold the line the clears are about",
    });
    await clickElement(toplevel, ".currentline__comment");
    await clickElement(toplevel, ".currentline__comment");

    await clickElement(toplevel, ".currentline__edit-clear-text");
    await waitFor(async () => ((await lineText()) === "{\\b1}{\\b0}" ? 1 : null), {
      timeout: 15000,
      message: "the words to go and the braced runs to stay",
    });

    await clickElement(toplevel, ".currentline__edit-clear");
    await waitFor(async () => ((await lineText()) === "" ? 1 : null), {
      timeout: 15000,
      message: "the whole line to go",
    });

    // Two clears are two steps, so one undo puts back exactly what the first one left.
    await runFromMenu((css) => clickElement(toplevel, css), "edit", "edit-undo");
    await waitFor(async () => ((await lineText()) === "{\\b1}{\\b0}" ? 1 : null), {
      timeout: 15000,
      message: "one undo to take back the second clear and not the first",
    });
    await undoEverything(toplevel);
  });

  it("puts a line back to what it was when the cursor reached it, and greys until it moved", async () => {
    const lineText = () =>
      browser.execute(() => document.querySelector(".currentline__text")?.value ?? null);
    const revert = () =>
      browser.execute(() => document.querySelector(".currentline__edit-revert")?.disabled ?? null);

    const copy = workingCopy("ass/clean/speakers.ass");
    await openSubtitle(toplevel, copy);
    await goToRow(toplevel, 1);
    const before = await lineText();
    // Nothing has moved on this row, so there is nothing to put back.
    expect(await revert()).toBe(true);

    await clickElement(toplevel, ".currentline__text");
    await waitFor(
      () =>
        browser.execute(
          () => document.activeElement?.classList.contains("currentline__text") === true,
        ),
      { timeout: 15000, message: "the box to take the keyboard" },
    );
    pressKey("ctrl+a");
    typeText("Typed over the line");
    await clickElement(toplevel, ".currentline__comment");
    await clickElement(toplevel, ".currentline__comment");
    await waitFor(async () => ((await revert()) === false ? 1 : null), {
      timeout: 15000,
      message: "Revert to wake once the line differs from what it was",
    });

    await clickElement(toplevel, ".currentline__edit-revert");
    await waitFor(async () => ((await lineText()) === before ? 1 : null), {
      timeout: 15000,
      message: "the line to go back to what it was when the cursor reached it",
    });
    await undoEverything(toplevel);
  });

  it("turns a line into a comment and back, in one undo step each way", async () => {
    const flag = () =>
      browser.execute(() => {
        const box = document.querySelector(".currentline__comment");
        return box === null ? null : { checked: box.checked, disabled: box.disabled };
      });
    const drawn = () =>
      browser.execute(() => document.querySelector(".statusbar__document")?.textContent ?? "");

    const copy = workingCopy("ass/clean/speakers.ass");
    const before = readFileSync(copy);
    await openSubtitle(toplevel, copy);
    await goToRow(toplevel, 1);
    expect(await flag()).toEqual({ checked: false, disabled: false });
    const counted = await drawn();

    await clickElement(toplevel, ".currentline__comment");
    await waitFor(async () => ((await flag()).checked === true ? 1 : null), {
      timeout: 15000,
      message: "the line to become a comment",
    });
    // A commented line is still listed and still editable; it is one line fewer a player draws, and
    // the status line counts what a player draws.
    expect(await drawn()).not.toBe(counted);
    expect(readFileSync(copy).equals(before)).toBe(true);

    await clickElement(toplevel, ".toolbar__file-save");
    await waitFor(
      () =>
        readFileSync(copy, "utf8").includes(
          "Comment: 0,0:00:01.34,0:00:03.98,Default,Ingrid,0,0,0,,The harbour freezes over by December.",
        )
          ? 1
          : null,
      { timeout: 20000, message: "the saved file to carry the comment on its first event line" },
    );
    // Only the word before the colon moved.
    expect(readFileSync(copy, "utf8")).toBe(
      before.toString("utf8").replace("Dialogue: 0,0:00:01.34", "Comment: 0,0:00:01.34"),
    );

    await runFromMenu((css) => clickElement(toplevel, css), "edit", "edit-undo");
    await waitFor(async () => ((await flag()).checked === false ? 1 : null), {
      timeout: 15000,
      message: "one undo to make it a drawn line again",
    });
    await clickElement(toplevel, ".toolbar__file-save");
    await waitFor(() => (readFileSync(copy).equals(before) ? 1 : null), {
      timeout: 20000,
      message: "the saved file to be byte for byte what it was opened as",
    });

    // And greyed where the format has no such distinction at all.
    await openSubtitle(toplevel, workingCopy("srt/clean/basic-lf.srt"));
    await goToRow(toplevel, 1);
    expect((await flag()).disabled).toBe(true);
  });

  it("offers the styles the document declares, and shows one it does not define", async () => {
    const picker = () =>
      browser.execute(() => {
        const field = document.querySelector(".currentline__style");
        return field === null
          ? null
          : {
              value: field.value,
              disabled: field.disabled,
              options: Array.from(field.options).map((option) => option.value),
            };
      });

    // A file with a styles section: the list is what the section declares, in its own order.
    await openSubtitle(toplevel, workingCopy("ass/clean/speakers.ass"));
    await goToRow(toplevel, 1);
    expect(await picker()).toEqual({
      value: "Default",
      disabled: false,
      options: ["Default", "Sign"],
    });

    // A file that names a style nothing defines: the name is shown because the file holds it, and
    // it is the only thing the list can offer, because there is no styles section to offer from.
    await openSubtitle(toplevel, workingCopy("ass/clean/field-order-shuffled.ass"));
    await goToRow(toplevel, 1);
    const dangling = await picker();
    expect({ value: dangling.value, holds: dangling.options.includes(dangling.value) }).toEqual({
      value: "Default",
      holds: true,
    });

    // And greyed where a line cannot name one at all.
    await openSubtitle(toplevel, workingCopy("srt/clean/basic-lf.srt"));
    await goToRow(toplevel, 1);
    expect((await picker()).disabled).toBe(true);
  });

  it("draws the effect greyed where a line cannot hold one, and alive where it can", async () => {
    for (const fixture of ["srt/clean/basic-lf.srt", "ass/clean/minimal-fields.ass"]) {
      await openSubtitle(toplevel, workingCopy(fixture));
      await goToRow(toplevel, 1);
      expect({ fixture, ...(await effectCombo()) }).toEqual({
        fixture,
        drawn: true,
        value: "",
        disabled: true,
        openerDisabled: true,
      });
    }

    await openSubtitle(toplevel, workingCopy("ass/clean/speakers.ass"));
    await goToRow(toplevel, 1);
    // Alive and empty: this file declares the field and no row uses it, so there is nothing to
    // offer either and the opener stays greyed while the field does not.
    expect(await effectCombo()).toEqual({
      drawn: true,
      value: "",
      disabled: false,
      openerDisabled: true,
    });
  });

  it("writes one effect into the file and offers it on the next line", async () => {
    const copy = workingCopy("ass/clean/speakers.ass");
    const before = readFileSync(copy);
    await openSubtitle(toplevel, copy);
    await goToRow(toplevel, 1);

    await typeIntoEffect(toplevel, "Banner");
    pressKey("Return");
    await waitFor(async () => ((await effectCombo()).openerDisabled === false ? 1 : null), {
      timeout: 15000,
      message: "the opener to come alive once the document uses an effect",
    });
    expect(readFileSync(copy).equals(before)).toBe(true);

    await clickElement(toplevel, ".toolbar__file-save");
    await waitFor(
      () =>
        readFileSync(copy, "utf8").includes(
          "Dialogue: 0,0:00:01.34,0:00:03.98,Default,Ingrid,0,0,0,Banner,The harbour freezes over by December.",
        )
          ? 1
          : null,
      { timeout: 20000, message: "the saved file to carry the effect on its first event line" },
    );
    // Only that field moved.
    expect(readFileSync(copy, "utf8")).toBe(
      before.toString("utf8").replace("0,0,0,,The harbour", "0,0,0,Banner,The harbour"),
    );

    await runFromMenu((css) => clickElement(toplevel, css), "edit", "edit-undo");
    await waitFor(async () => ((await effectCombo()).value === "" ? 1 : null), {
      timeout: 15000,
      message: "one undo to empty the effect again",
    });
    await clickElement(toplevel, ".toolbar__file-save");
    await waitFor(() => (readFileSync(copy).equals(before) ? 1 : null), {
      timeout: 20000,
      message: "the saved file to be byte for byte what it was opened as",
    });
  });

  it("draws the drawing order and the three margins greyed where a line cannot hold them", async () => {
    const empty = { drawn: true, value: "", disabled: true, invalid: false };
    for (const fixture of ["srt/clean/basic-lf.srt", "vtt/clean/basic.vtt"]) {
      await openSubtitle(toplevel, workingCopy(fixture));
      await goToRow(toplevel, 1);
      expect({ fixture, ...(await numberFields()) }).toEqual({
        fixture,
        layer: empty,
        marginL: empty,
        marginR: empty,
        marginV: empty,
      });
    }

    // Field by field and not format by format: this fixture's own `Format:` line declares Layer and
    // no margin, so the one control is alive and the three beside it are greyed in the same panel.
    await openSubtitle(toplevel, workingCopy("ass/clean/minimal-fields.ass"));
    await goToRow(toplevel, 1);
    expect(await numberFields()).toEqual({
      layer: { drawn: true, value: "0", disabled: false, invalid: false },
      marginL: empty,
      marginR: empty,
      marginV: empty,
    });

    // And alive in place on a file whose Format line declares them, in the same session.
    await openSubtitle(toplevel, workingCopy("ass/clean/speakers.ass"));
    await goToRow(toplevel, 1);
    const zero = { drawn: true, value: "0", disabled: false, invalid: false };
    expect(await numberFields()).toEqual({
      layer: zero,
      marginL: zero,
      marginR: zero,
      marginV: zero,
    });
  });

  it("writes a layer into the file and gives it back in one undo", async () => {
    const copy = workingCopy("ass/clean/speakers.ass");
    const before = readFileSync(copy);
    await openSubtitle(toplevel, copy);
    await goToRow(toplevel, 1);

    await typeIntoNumber(toplevel, "layer", "7");
    pressKey("Return");
    await waitFor(async () => ((await numberFields()).layer.value === "7" ? 1 : null), {
      timeout: 15000,
      message: "the layer field to hold the committed value",
    });
    // A commit is not a save, exactly as it is not one for the speaker.
    expect(readFileSync(copy).equals(before)).toBe(true);

    await clickElement(toplevel, ".toolbar__file-save");
    await waitFor(
      () =>
        readFileSync(copy, "utf8").includes(
          "Dialogue: 7,0:00:01.34,0:00:03.98,Default,Ingrid,0,0,0,,The harbour freezes over by December.",
        )
          ? 1
          : null,
      { timeout: 20000, message: "the saved file to carry the layer on its first event line" },
    );
    // Only that field moved: every other byte is what the file was opened as.
    expect(readFileSync(copy, "utf8")).toBe(
      before.toString("utf8").replace("Dialogue: 0,0:00:01.34", "Dialogue: 7,0:00:01.34"),
    );

    // One undo, not two: setting a field is a single step the way a text edit is.
    await runFromMenu((css) => clickElement(toplevel, css), "edit", "edit-undo");
    await waitFor(async () => ((await numberFields()).layer.value === "0" ? 1 : null), {
      timeout: 15000,
      message: "one undo to put the layer back",
    });
    await clickElement(toplevel, ".toolbar__file-save");
    await waitFor(() => (readFileSync(copy).equals(before) ? 1 : null), {
      timeout: 20000,
      message: "the saved file to be byte for byte what it was opened as",
    });
  });

  it("clamps a number past its range, refuses one that is not a number, and reads an empty one as zero", async () => {
    const copy = workingCopy("ass/clean/speakers.ass");
    await openSubtitle(toplevel, copy);
    await goToRow(toplevel, 2);

    // Past the range the control has: the reference clamps rather than refusing, so 5000 lands on
    // the ceiling and the file never receives what the field showed while it was being typed.
    await typeIntoNumber(toplevel, "layer", "5000");
    pressKey("Return");
    await waitFor(async () => ((await numberFields()).layer.value === "999" ? 1 : null), {
      timeout: 15000,
      message: "the layer to be clamped to the top of its range",
    });

    // Not a number at all: the field says so where it stands and nothing is sent, which is what
    // the time fields already do.
    await typeIntoNumber(toplevel, "marginL", "12a");
    pressKey("Return");
    await waitFor(async () => ((await numberFields()).marginL.invalid === true ? 1 : null), {
      timeout: 15000,
      message: "the left margin to mark itself as holding something that is not a number",
    });

    // Emptied: the format's own default from style is zero, so clearing the field is an edit and
    // commits zero rather than leaving the field on nothing.
    await typeIntoNumber(toplevel, "marginV", "");
    // Left rather than confirmed: the document already holds zero, so there is nothing to send and
    // what the criterion asks is that the field goes back to what the file has. See C6.4.
    await clickElement(toplevel, ".currentline__layer");
    await waitFor(async () => ((await numberFields()).marginV.value === "0" ? 1 : null), {
      timeout: 15000,
      message: "the vertical margin to read zero after being cleared",
    });
  });

  it("answers a click on every control it draws, at each size and at both window widths", async () => {
    // Its own document and its own cursor: a panel with no row draws one sentence and no controls,
    // and a sweep over that would report five missing rather than a layout fault.
    await openSubtitle(toplevel, workingCopy("ass/clean/speakers.ass"));
    await goToRow(toplevel, 1);

    for (const percent of REACH_PERCENTS) {
      await pickSize(toplevel, percent);
      const floor = await derivedFloor();
      for (const size of [
        { width: floor, height: windowHeight },
        { width: WIDE_WIDTH, height: WIDE_HEIGHT },
      ]) {
        toplevel = await resizeTo(toplevel.id, size.width, size.height);
        const at = `at ${percent} per cent in ${size.width}x${size.height}`;
        // The count too: a sweep over a panel that drew nothing would pass with nothing to say.
        const bare = await panelOutOfReach(CONTROLS);
        expect({
          at,
          swept: bare.swept,
          missing: bare.missing,
          beyond: bare.outOfReach.filter((name) => !BARE_SHORTFALL[percent].includes(name)),
        }).toEqual({ at, swept: CONTROLS.length, missing: [], beyond: [] });
        expect({ at, faults: await narrowFaults() }).toEqual({ at, faults: [] });
        expect({ at, clipped: await clippedAtWindowEdge(SLOP_PX) }).toEqual({ at, clipped: [] });
        const across = await browser.execute(() => ({
          document: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
        }));
        expect({ at, sideways: across.document > across.client }).toEqual({ at, sideways: false });
      }
    }
    await pickSize(toplevel, 110);
    toplevel = await resizeTo(toplevel.id, windowWidth, windowHeight);
  });

  it("keeps every control reachable with the waveform above it, which is the least room there is", async () => {
    await runFromMenu((css) => clickElement(toplevel, css), "video", "video-open");
    const chooser = await waitForChooser("Choose a video");
    await answerChooser(chooser, requireWaveformFixture(), "video");
    focusWindow(toplevel.id);
    await waitFor(() => present(".waveform"), {
      timeout: 40000,
      message: "the waveform panel to appear above the current line",
    });

    for (const percent of REACH_PERCENTS) {
      await pickSize(toplevel, percent);
      const floor = await derivedFloor();
      for (const size of [
        { width: floor, height: windowHeight },
        { width: WIDE_WIDTH, height: WIDE_HEIGHT },
      ]) {
        toplevel = await resizeTo(toplevel.id, size.width, size.height);
        const at = `with a waveform, at ${percent} per cent in ${size.width}x${size.height}`;
        // Nothing clipped and nothing to scroll to. This used to pin a shortfall instead: with a
        // waveform above it the panel was given 84 pixels and the text box was out of reach at
        // every size, and at 150 per cent in the narrowest window the End field went with it. The
        // block now grows until the current line reaches its own floor rather than stopping at the
        // height it was stored at, so there is no shortfall left to pin. See E5.6.
        const wide = size.width === WIDE_WIDTH;
        const ceiling = SHORTFALL[percent][wide ? "wide" : "floor"];
        const swept = await panelOutOfReach(CONTROLS);
        expect({
          at,
          swept: swept.swept,
          missing: swept.missing,
          beyond: swept.outOfReach.filter((name) => !ceiling.includes(name)),
        }).toEqual({ at, swept: CONTROLS.length, missing: [], beyond: [] });
        // What the panel owes wherever it does not show everything: the scroll that reaches them,
        // and every control answering once it is scrolled to. Whether it clips at all is not
        // asserted: it depends on the size and the pin above is what says which controls it costs.
        const scroll = await panelScroll();
        expect({ at, unreachable: scroll.unreachable, sideways: scroll.sideways }).toEqual({
          at,
          unreachable: false,
          sideways: false,
        });
        expect({ at, outOfReach: await reachedByScrolling(CONTROLS) }).toEqual({
          at,
          outOfReach: [],
        });
        expect({ at, faults: await narrowFaults() }).toEqual({ at, faults: [] });
        expect({ at, clipped: await clippedAtWindowEdge(SLOP_PX) }).toEqual({ at, clipped: [] });
      }
    }
    await pickSize(toplevel, 110);
    toplevel = await resizeTo(toplevel.id, windowWidth, windowHeight);
  });
});
