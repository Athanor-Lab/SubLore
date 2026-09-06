/* global describe, it, before, after, document, window */
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
  ".currentline__actor",
  ".currentline__actor-open",
  ".currentline__start",
  ".currentline__end",
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
 * The most the panel may fail to show at once, pinned so it cannot grow in silence. A ceiling and
 * not an identity: which controls fall outside a short panel depends on how the machine renders the
 * type, and this repository's own runner and the CI runner do not agree to the pixel. What must
 * hold everywhere is that the set never grows past what was measured before the panel gained the
 * effect, the drawing order and the three margins, which is what these entries are. Every control
 * is drawn and every control is reachable through the panel's scroll.
 */
const SHORTFALL = {
  90: { floor: [".currentline__text"], wide: [] },
  110: { floor: [".currentline__text"], wide: [] },
  150: { floor: [".currentline__end", ".currentline__text"], wide: [".currentline__text"] },
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

/** Put the cursor on a row by clicking its number cell, the way a person moves it. */
async function goToRow(toplevel, position) {
  const centre = await browser.execute((wanted) => {
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
  if (centre === null) {
    throw new Error(`row ${position} is not in the grid, so the cursor cannot be put on it`);
  }
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
  await waitFor(
    () =>
      browser.execute((wanted) => {
        const rows = Array.from(document.querySelectorAll(".cuelist__row"));
        const row = rows.find(
          (candidate) => candidate.querySelector(".cuelist__pos")?.textContent === wanted,
        );
        return row?.classList.contains("cuelist__row--active") === true;
      }, String(position)),
    { timeout: 15000, message: `the cursor to reach row ${position}` },
  );
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
      { band: "identity", parts: ["Actor", "Effect", "Characters", "CPS"] },
      { band: "times", parts: ["Layer", "Start", "End", "Duration", "L", "R", "V"] },
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
        { band: "identity", parts: ["Actor", "Effect", "Characters", "CPS"] },
        {
          band: "times",
          parts: ["Layer", "Start", "End", "Duration", "L", "R", "V"],
        },
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
    await clickElement(toplevel, ".toolbar__edit-undo");
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

    await clickElement(toplevel, ".toolbar__edit-undo");
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
    await clickElement(toplevel, ".toolbar__edit-undo");
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
        expect({ at, ...(await panelOutOfReach(CONTROLS)) }).toEqual({
          at,
          swept: CONTROLS.length,
          missing: [],
          outOfReach: [],
        });
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
    await clickElement(toplevel, ".toolbar__video-open");
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
