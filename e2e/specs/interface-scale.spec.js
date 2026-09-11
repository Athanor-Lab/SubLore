/* global describe, it, before, after, document, window */
/**
 * S1 and S2: the interface has a size the user picks, and the panel floors move with it.
 *
 * Written in the shape of `dividers.spec.js`, which owns two of the three edges dragged here: the
 * gestures are real presses, travels and releases through X11, because a synthetic pointer event
 * exercises React and proves nothing about whether a hand can place an edge.
 *
 * Nothing here reads the stored number or the custom property that carries it. A shell that stored
 * the size and never redrew would satisfy every one of those readings, so the size is asserted as
 * the thing the complaint was about: how tall the type and the controls come out. The video edge is
 * asserted at its floor while the button is still down, for the reason `pressAndTravel` exists.
 *
 * The one number this file does read off the shell is the smallest width the window may be, because
 * there is no number it could be compared against: it is measured off the rows the shell cannot
 * draw narrower than their contents, and those are a tenth wider under the runner's fonts than
 * under the ones this interface was drawn against. S1's criterion was written as 1024x700 and at
 * 150 per cent the window can no longer be that narrow, so it is asserted here at the narrowest
 * window there is, and the floor is proved to be one by asking for a pixel under it.
 */
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { runFromMenu } from "../lib/menu.js";
import { clippedAtWindowEdge } from "../lib/clipping.js";
import {
  askForWindowSize,
  clickAt,
  dragAt,
  focusWindow,
  pressAndTravel,
  releaseButton,
  waitForWindowSize,
} from "../lib/input.js";
import { repoRoot, requireWaveformFixture, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { interfaceScale } from "../lib/scale.js";
import { findToplevel, rootTree, windowSize } from "../lib/x11.js";

const VIDEO_SASH = ".sash--video";
const GRID_SASH = ".sash--grid";
const WAVEFORM_SASH = ".sash--waveform";

const SUBTITLE = path.join(repoRoot, "fixtures", "subtitles", "srt", "clean", "basic-lf.srt");

/**
 * The bounds `dividers.spec.js` and `waveform-sash.spec.js` mirror from `src/App.tsx`, each the
 * number at 100 per cent and each taken against the interface size before it is used.
 */
const MIN_TOOLS_WIDTH = 176;
const MIN_CURRENT_LINE = 72;
const MIN_WAVEFORM_HEIGHT = 64;

/** The size a launch with nothing stored opens at (S1). */
const DEFAULT_PERCENT = 110;
/** The reference's own five groups, counted off interface-spec 4.1 rather than off the strip. */
const TOOLBAR_BUTTONS = 14;

/** The three sizes S2 states its criterion at, all of them on the View menu. */
const FLOOR_PERCENTS = [90, 110, 150];

/** Percentage widths and scaled type both land on fractions of a pixel. */
const SLOP_PX = 1;

/** A share of the top row is a ratio, so it is compared with room for the pixel either end of it. */
const SHARE_SLOP = 0.01;

/**
 * How far a box holding type may land from the factor its type grew by. The line box is a
 * whole-pixel ascent on a whole-pixel descent, so it is out by up to half a pixel at each edge: one
 * at the larger size, and one and a half taken from the smaller one.
 */
const LINE_BOX_ROUNDING_PX = 2.5;

/** The second window size S1 states its criterion at. The run's screen is sized to hold it. */
const WIDE_WIDTH = 1920;
const WIDE_HEIGHT = 1080;

function rectOf(selector) {
  return browser.execute((css) => {
    const element = document.querySelector(css);
    if (element === null) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    return {
      cssWidth: rect.width,
      cssHeight: rect.height,
      midX: (rect.x + rect.width / 2) * dpr,
      midY: (rect.y + rect.height / 2) * dpr,
    };
  }, selector);
}

/**
 * How big the interface is drawn, in the terms the complaint was written in: the type on a label,
 * on a control and on a grid row, with the box each of them sits in.
 */
async function drawnSizes() {
  const drawn = await readDrawnSizes();
  const missing = Object.entries(drawn)
    .filter(([, part]) => part === null)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`these parts of the interface are missing from the DOM: ${missing.join(", ")}`);
  }
  return drawn;
}

function readDrawnSizes() {
  return browser.execute(() => {
    const read = (css) => {
      const element = document.querySelector(css);
      if (element === null) {
        return null;
      }
      const style = window.getComputedStyle(element);
      const px = (value) => {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : 0;
      };
      const height = element.getBoundingClientRect().height;
      const pad = px(style.paddingTop) + px(style.paddingBottom);
      return {
        type: px(style.fontSize),
        height,
        pad,
        // The box around the type, without the parts of the box that are not the type: the padding
        // is in rem and follows the size, the border is the same pixel at every size.
        content: height - pad - px(style.borderTopWidth) - px(style.borderBottomWidth),
      };
    };
    return {
      menuTitle: read(".menubar__title--view"),
      transportButton: read(".controls__button"),
      timesLabel: read(".currentline__label"),
      gridHeader: read(".cuelist__head"),
      gridRow: read(".cuelist__row"),
    };
  });
}

/** Every number the three edges trade, read in one round trip so they describe one layout. */
function shellSizes() {
  return browser.execute(() => {
    const width = (css) => document.querySelector(css)?.getBoundingClientRect().width ?? null;
    const height = (css) => document.querySelector(css)?.getBoundingClientRect().height ?? null;
    return {
      video: width(".shell__video"),
      tools: width(".shell__tools"),
      top: width(".shell__top"),
      block: height(".shell__body"),
      grid: height(".shell__grid"),
      line: height(".currentline"),
      waveform: height(".waveform"),
      transport: height(".controls"),
    };
  });
}

/**
 * The grid's header and the rows wholly inside its scrolling viewport: what "showing its header and
 * three rows" is, counted rather than inferred from a height.
 */
function readGridShows() {
  return browser.execute((slop) => {
    const header = document.querySelector(".cuelist__head");
    const list = document.querySelector(".cuelist");
    if (header === null || list === null) {
      return null;
    }
    const viewport = list.getBoundingClientRect();
    const whole = Array.from(document.querySelectorAll(".cuelist__row")).filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.top >= viewport.top - slop && rect.bottom <= viewport.bottom + slop;
    });
    return { header: header.getBoundingClientRect().height, rows: whole.length };
  }, SLOP_PX);
}

async function expectGridShows(rows) {
  const shown = await readGridShows();
  if (shown === null) {
    throw new Error("the cue grid's header or its list is missing from the DOM");
  }
  expect({ header: shown.header > 0, rows: shown.rows }).toEqual({ header: true, rows });
}

/**
 * No window manager under Xvfb, so the toplevel origin is also the viewport origin.
 *
 * The destination is kept inside the window: `xdotool` refuses a pointer off the screen, and a drag
 * that asks for one fails as an error rather than as an edge that stopped where it was told to.
 */
/**
 * Wait until a sash has stopped moving, and answer with where it is.
 *
 * A sleep after a drag is a guess at how long a layout takes, and this file reads exact sizes
 * afterwards. Two readings that agree is the settled one (N93).
 */
async function settledSash(selector) {
  let previous = null;
  return waitFor(
    async () => {
      const now = await rectOf(selector);
      const same =
        now !== null && previous !== null && JSON.stringify(now) === JSON.stringify(previous);
      previous = now;
      return same ? now : null;
    },
    {
      timeout: 15000,
      interval: 100,
      message: () => `${selector} to stop moving. The last reading was ${JSON.stringify(previous)}`,
    },
  );
}

async function dragSash(toplevel, selector, dx, dy) {
  const sash = await rectOf(selector);
  if (sash === null) {
    throw new Error(`${selector} is missing from the DOM, so there is nothing to drag`);
  }
  const inside = (value, span) => Math.min(Math.max(value, 1), span - 2);
  dragAt(
    toplevel.absX + sash.midX,
    toplevel.absY + sash.midY,
    toplevel.absX + inside(sash.midX + dx, toplevel.width),
    toplevel.absY + inside(sash.midY + dy, toplevel.height),
  );
  // The release is what stores the size, and the layout settles after it. Waited for rather than
  // slept through: 250 ms was a guess and this file reads exact sizes (N93).
  await settledSash(selector);
}

async function clickElement(toplevel, selector) {
  const rect = await rectOf(selector);
  if (rect === null) {
    throw new Error(`${selector} is missing from the DOM`);
  }
  clickAt(toplevel.absX + rect.midX, toplevel.absY + rect.midY);
}

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

/**
 * The seek bar as it is drawn, beside the width its own rule says it never goes under. The video
 * panel's floor is the transport with the bar at exactly that, so the bar is at its narrowest there
 * and wider everywhere else.
 */
async function seekBar() {
  const bar = await browser.execute(() => {
    const slider = document.querySelector(".controls__slider");
    if (slider === null) {
      return null;
    }
    return {
      width: slider.getBoundingClientRect().width,
      minimum: Number.parseFloat(window.getComputedStyle(slider).minWidth),
    };
  });
  if (bar === null || !Number.isFinite(bar.minimum)) {
    throw new Error(".controls__slider is missing, or its rule gives it no width to hold it at");
  }
  return bar;
}

/**
 * The transport read as rows and as fit, rather than as a height against another height: the
 * distinct tops its own four controls sit at, what the row asks for in width, and what it is given.
 * A height is only ever a comparison with a height taken under the same code, which is what left
 * the floor claim provable by nothing (N55).
 */
async function transportRow() {
  const row = await browser.execute((slop) => {
    const controls = document.querySelector(".controls");
    const slider = document.querySelector(".controls__slider");
    if (controls === null || slider === null) {
      return null;
    }
    // Rows as bands rather than as tops: the row centres what it holds, so four controls of four
    // heights sit at four tops on one row. Two controls on the same row overlap vertically; the gap
    // between two rows means the next one starts at or below the band the last one ended at.
    const boxes = Array.from(controls.children)
      .map((part) => part.getBoundingClientRect())
      .sort((a, b) => a.top - b.top);
    let rows = boxes.length === 0 ? 0 : 1;
    let bottom = boxes.length === 0 ? 0 : boxes[0].bottom;
    for (const box of boxes.slice(1)) {
      if (box.top >= bottom - slop) {
        rows += 1;
        bottom = box.bottom;
      } else {
        bottom = Math.max(bottom, box.bottom);
      }
    }
    return {
      rows,
      asks: controls.scrollWidth,
      has: controls.clientWidth,
      bar: slider.getBoundingClientRect().width,
      barMinimum: Number.parseFloat(window.getComputedStyle(slider).minWidth),
    };
  }, SLOP_PX);
  if (row === null || !Number.isFinite(row.barMinimum)) {
    throw new Error(".controls is missing, or its seek bar has no rule holding it at a width");
  }
  return row;
}

/** The three readings above as the one answer they make: the transport is usable where it stands. */
function transportHolds(row) {
  return {
    rows: row.rows,
    fits: row.asks <= row.has + SLOP_PX,
    bar: row.bar >= row.barMinimum - SLOP_PX,
  };
}

/**
 * The strip on its own two rows and no more: the seek bar has a row to itself and the band that
 * reads it sits beneath, which is how the reference stacks the same controls. It was one row until
 * N124, and the count is part of the claim rather than a detail of it: a strip that had wrapped
 * onto a third row would be a panel too narrow for what it holds, which is what the floor exists to
 * prevent.
 */
const TRANSPORT_ON_ITS_ROWS = { rows: 2, fits: true, bar: true };

/** Pick one of the View menu's five sizes, through the menu, the way a person reaches it. */
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
  // Picking is also what stores the size, and the checks below relaunch the app: a pause here is
  // the same one `dragSash` takes, for the same write.
  await browser.pause(250);
}

/** Resize the app window and wait until the page has been laid out at the new width. */
function resizeTo(id, width, height) {
  return settleAt(id, width, height, width);
}

/**
 * Ask X for one width and wait for the window to settle at another. The two are the same for every
 * width the shell can be drawn at; a request under the shell's own floor is the case they differ
 * in, and the window coming back to the floor is what a smallest window width means.
 */
async function settleAt(id, ask, height, took) {
  askForWindowSize(id, ask, height);
  waitForWindowSize(id, took, height);
  await waitFor(
    async () => ((await browser.execute(() => window.innerWidth)) === took ? 1 : null),
    {
      timeout: 15000,
      message: `the page to be laid out ${took} CSS pixels wide`,
    },
  );
  const toplevel = findToplevel({ width: took, height });
  if (toplevel === null) {
    throw new Error(`no ${took}x${height} "Sublore" toplevel after the resize.\n${rootTree()}`);
  }
  return toplevel;
}

/**
 * The narrowest the shell says the window may be. There is no number here to check it against: it
 * is measured off the rows that cannot be drawn narrower than what is in them, and every width in
 * those is a width the machine's fonts decide.
 */
async function derivedFloor() {
  const said = await browser.execute(
    () => document.querySelector(".shell")?.dataset.minimumWidth ?? null,
  );
  const floor = Number(said);
  if (!Number.isInteger(floor) || floor <= 0) {
    throw new Error(
      `the shell says its smallest width is ${JSON.stringify(said)}, which is not a width. ` +
        "Nothing measured a floor, so there is nothing the window could have been held at.",
    );
  }
  return floor;
}

/**
 * What the strip does not show at once at the narrowest window there is, per interface size.
 *
 * A ceiling and not an identity: how many rows seventeen words wrap onto is what the machine's own
 * fonts decide, and this repository's runner and the CI runner do not agree to the pixel. What
 * holds everywhere is that every button is drawn and every one is reachable through the strip's
 * own scroll, which is asserted below whatever the fonts do. The entry is the last button of the
 * strip, and it appeared when the toolbar lost a word and took the window's floor down with it.
 */
const STRIP_SHORTFALL = {
  90: [],
  110: ["wavebar__wave-toggle-autoscroll"],
};

/**
 * Every button on the waveform's strip that does not answer where it is drawn: the element under
 * its own centre, when that element is not the button. A strip taller than the panel scrolls
 * inside it, and a button on a row the panel is not showing is under the current line instead.
 */
function stripOutOfReach() {
  return browser.execute(() => {
    const buttons = Array.from(document.querySelectorAll(".wavebar__button"));
    const out = buttons
      .filter((button) => {
        const rect = button.getBoundingClientRect();
        const under = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return under === null || !(under === button || button.contains(under));
      })
      .map((button) => button.className.replace("wavebar__button ", ""));
    return { buttons: buttons.length, outOfReach: out };
  });
}

/**
 * The named buttons a scroll of the strip reaches: each one scrolled to and asked again where it
 * lands. The strip scrolling is the panel's own answer to a row it cannot hold, so what must hold
 * on every machine is that the scroll reaches them.
 */
async function stripReachedByScrolling(names) {
  const out = [];
  for (const name of names) {
    const reached = await browser.execute((css) => {
      const button = document.querySelector(`.${css}`);
      if (button === null) {
        return false;
      }
      button.scrollIntoView({ block: "nearest" });
      const rect = button.getBoundingClientRect();
      const under = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return under !== null && (under === button || button.contains(under));
    }, name);
    if (!reached) {
      out.push(name);
    }
  }
  return out;
}

async function attachToApp() {
  const toplevel = await waitFor(findToplevel, {
    timeout: 30000,
    message: `the ${windowWidth}x${windowHeight} "Sublore" toplevel to appear`,
  });
  focusWindow(toplevel.id);
  await waitFor(
    () => browser.execute(() => document.querySelector(".toolbar__file-open-subtitle") !== null),
    { timeout: 30000, message: "the app UI to render" },
  );
  return toplevel;
}

/** A document in the grid and a video on the stage: all three edges sit between panels holding both. */
async function openTheFixtures(toplevel) {
  await clickElement(toplevel, ".toolbar__file-open-subtitle");
  const subtitleChooser = await waitForChooser("Choose a subtitle");
  await answerChooser(subtitleChooser, SUBTITLE, "subtitle");
  focusWindow(toplevel.id);
  await waitFor(() => present(".cuelist__row"), {
    timeout: 20000,
    message: "the cue grid to fill",
  });

  await runFromMenu((css) => clickElement(toplevel, css), "video", "video-open");
  const videoChooser = await waitForChooser("Choose a video");
  await answerChooser(videoChooser, requireWaveformFixture(), "video");
  focusWindow(toplevel.id);
  await waitFor(() => present(".waveform"), {
    timeout: 40000,
    message: "the waveform panel to appear",
  });
}

const storedLayout = () =>
  path.join(process.env.SUBLORE_E2E_DATA_HOME, "com.sublore.app", "layout.json");

describe("the interface size", () => {
  let toplevel = null;

  // The store is shared with every other spec in the run, and the first check below reads the size
  // a launch with nothing stored opens at, so this one starts from no file rather than from
  // whatever the spec before it left.
  before(async () => {
    requireWaveformFixture();
    rmSync(storedLayout(), { force: true });
    await browser.reloadSession();
    toplevel = await attachToApp();
    await openTheFixtures(toplevel);
  });

  after(() => {
    rmSync(storedLayout(), { force: true });
  });

  it("opens at 110 per cent, which is a tenth larger than the size the interface used to be", async () => {
    const opened = await drawnSizes();

    await pickSize(toplevel, 100);

    // Against the size the menu itself offers, not against a number: 110 per cent means this and
    // nothing else, and the ratio holds whatever the browser's own root size turns out to be.
    const at100 = await drawnSizes();
    for (const [part, drawn] of Object.entries(opened)) {
      expect({ part, ratio: Number((drawn.type / at100[part].type).toFixed(3)) }).toEqual({
        part,
        ratio: DEFAULT_PERCENT / 100,
      });
    }
    expect(opened.menuTitle.height).toBeGreaterThan(at100.menuTitle.height);
  });

  it("keeps the whole interface inside the window at both ends of the range, at the narrowest window it may be and at the wide one", async () => {
    for (const percent of [90, 150]) {
      await pickSize(toplevel, percent);
      // S1 states its criterion at 1024x700, and at 150 per cent the window may no longer be that
      // narrow: the toolbar's own row is wider than 1024 under the runner's fonts. So the criterion
      // is asserted at the narrowest window that exists at this size, which is the width S1 named
      // whenever the shell still fits in it.
      const floor = await derivedFloor();
      const narrow = Math.max(windowWidth, floor);
      for (const size of [
        { width: narrow, height: windowHeight },
        { width: WIDE_WIDTH, height: WIDE_HEIGHT },
      ]) {
        toplevel = await resizeTo(toplevel.id, size.width, size.height);
        const at = `at ${percent} per cent in ${size.width}x${size.height}`;
        expect({ at, clipped: await clippedAtWindowEdge(SLOP_PX) }).toEqual({ at, clipped: [] });
        const across = await browser.execute(() => ({
          document: document.documentElement.scrollWidth,
          body: document.body.scrollWidth,
          client: document.documentElement.clientWidth,
        }));
        const sideways = across.document > across.client || across.body > across.client;
        expect({ at, sideways }).toEqual({ at, sideways: false });
      }

      // And the floor is a floor. Asked for one pixel under it, the window comes back to the floor
      // and to no other width, which is also what says the width above was not just a wide enough
      // guess. A pixel, so the ask is derived from the shell's own number and from nothing else.
      const at = `at ${percent} per cent, asked for ${floor - 1}`;
      toplevel = await settleAt(toplevel.id, floor - 1, windowHeight, floor);
      expect({ at, took: windowSize(toplevel.id)?.width ?? null }).toEqual({ at, took: floor });
      expect({ at, clipped: await clippedAtWindowEdge(SLOP_PX) }).toEqual({ at, clipped: [] });

      toplevel = await resizeTo(toplevel.id, narrow, windowHeight);
    }
  });

  /**
   * The floor the shell declares has to fit inside the window the app opens, or the window opens
   * wider than it was asked for and every reading taken at that width is a reading of another
   * window. It is not a hypothetical: the strip's fourteen words asked for 1017 px of 1024 here,
   * six pixels of margin, and under fonts a tenth wider the app opened 1067 px wide on CI and
   * seven spec files went red at once. See BACKLOG.md N132.
   */
  it("asks for a window no wider than the one it opens, and keeps the whole strip inside it", async () => {
    await pickSize(toplevel, DEFAULT_PERCENT);
    const floor = await derivedFloor();
    expect({ floor, opens: windowWidth, fits: floor <= windowWidth }).toEqual({
      floor,
      opens: windowWidth,
      fits: true,
    });

    toplevel = await resizeTo(toplevel.id, windowWidth, windowHeight);
    // How many rows the fourteen wrap onto is what the machine's fonts decide, so what is read is
    // that they are all drawn, all inside the window, and that the page has not started scrolling.
    const strip = await browser.execute(() => {
      const buttons = Array.from(document.querySelectorAll(".toolbar__button"));
      return {
        buttons: buttons.length,
        outside: buttons
          .filter((button) => {
            const box = button.getBoundingClientRect();
            return box.right > window.innerWidth + 1 || box.left < -1;
          })
          .map((button) => button.className),
        sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    expect(strip).toEqual({ buttons: TOOLBAR_BUTTONS, outside: [], sideways: false });
  });

  /**
   * The half of S1 the window-edge sweep has no arm for: a box cut by a panel's own edge is inside
   * the window, so the sweep is right to pass it and something else has to ask. The strip is the
   * one row in the shell that cannot always fit, because it is fourteen words where the reference
   * is fourteen icons.
   *
   * Asserted at the two sizes whose panel can hold every row. At 150 per cent in a window under
   * about 1090 px the three rows want 122 px inside a 128 px panel and no arrangement holds them,
   * so the last rows scroll there; that limit is written beside the rule in `src/styles/tools.css`
   * and it is why 150 is not swept here.
   */
  it("answers a click on every button of the waveform's strip, at the sizes the panel holds it", async () => {
    for (const percent of [90, DEFAULT_PERCENT]) {
      await pickSize(toplevel, percent);
      const floor = await derivedFloor();
      const narrow = Math.max(windowWidth, floor);
      for (const size of [
        { width: floor, height: windowHeight },
        { width: narrow, height: windowHeight },
        { width: WIDE_WIDTH, height: WIDE_HEIGHT },
      ]) {
        toplevel = await resizeTo(toplevel.id, size.width, size.height);
        const at = `at ${percent} per cent in ${size.width}x${size.height}`;
        // The count too: a sweep over a strip that drew nothing would pass with nothing to say.
        const swept = await stripOutOfReach();
        const ceiling = size.width === floor ? STRIP_SHORTFALL[percent] : [];
        expect({
          at,
          buttons: swept.buttons,
          beyond: swept.outOfReach.filter((name) => !ceiling.includes(name)),
        }).toEqual({ at, buttons: 17, beyond: [] });
        expect({ at, unreached: await stripReachedByScrolling(swept.outOfReach) }).toEqual({
          at,
          unreached: [],
        });
      }
      toplevel = await resizeTo(toplevel.id, narrow, windowHeight);
    }
  });

  it("draws the type half again as tall at 150 per cent, and the controls with it", async () => {
    await pickSize(toplevel, 100);
    const at100 = await drawnSizes();

    await pickSize(toplevel, 150);

    const at150 = await drawnSizes();
    for (const [part, drawn] of Object.entries(at150)) {
      expect({ part, ratio: Number((drawn.type / at100[part].type).toFixed(3)) }).toEqual({
        part,
        ratio: 1.5,
      });
    }
    // The boxes follow the type, read without the parts of a box that are not the type. The whole
    // height cannot be asked for half again: a border is the same pixel at both sizes, and the line
    // box the type sits in is a whole-pixel ascent on a whole-pixel descent, which rounds up as
    // readily as down. Asking for a ratio of at most 1.5 asked that no box ever round up, and
    // `.menubar__title` has no border to lose the rounding into, so it was the one that could not.
    for (const part of ["menuTitle", "transportButton", "gridHeader"]) {
      const off = Number(Math.abs(at150[part].content - 1.5 * at100[part].content).toFixed(3));
      expect({ part, off, follows: off <= LINE_BOX_ROUNDING_PX }).toEqual({
        part,
        off,
        follows: true,
      });
      // The other half of the box, and the half with no rounding to hide in: the padding is in rem,
      // so it is half again over. A padding written in pixels stops here.
      const padGrew = Number((at150[part].pad / at100[part].pad).toFixed(2));
      expect({ part, padGrew }).toEqual({ part, padGrew: 1.5 });
    }
    // The one part that does not follow, said here rather than left for a reader to notice: a cue
    // row's box is the fixed 28px `ROW_HEIGHT` in CueList.tsx at every size, so its type grows and
    // its box does not. S1 asks for the row as well as the type, and this is the half it gets.
    expect(at150.gridRow.height).toBe(at100.gridRow.height);
  });

  it("leaves the three panels at the proportions the sashes were left at when the size changes", async () => {
    await pickSize(toplevel, 100);
    await dragSash(toplevel, VIDEO_SASH, 120, 0);
    await dragSash(toplevel, GRID_SASH, 0, 40);
    await dragSash(toplevel, WAVEFORM_SASH, 0, 30);
    const left = await shellSizes();

    await pickSize(toplevel, 150);

    const bigger = await shellSizes();
    // The video is stored as a share of a row that is itself narrower at 150, because the rail beside
    // it is in rem too, so the share is what has to survive and not the width.
    expect(bigger.video / bigger.top).toBeCloseTo(left.video / left.top, 2);
    expect(bigger.video).toBeLessThan(left.video);
    // The waveform's own measurements stay in device pixels: a peak bucket is one millisecond and a
    // fraction of a pixel has nothing to draw.
    expect(bigger.waveform).toBe(left.waveform);
    expect(bigger.block).toBe(left.block);
  });

  it("holds the video edge at its floor with the transport on its two rows, at 150 per cent, while the pointer is still travelling", async () => {
    await pickSize(toplevel, 150);
    // Room to travel first: at 150 the panel opens within a pixel of its own floor, so a drag from
    // there would prove the floor by not moving at all.
    await dragSash(toplevel, VIDEO_SASH, 2000, 0);
    const wide = await shellSizes();

    await dragSash(toplevel, VIDEO_SASH, -2000, 0);

    const settled = await shellSizes();
    expect(settled.video).toBeLessThan(wide.video);
    // The claim the floor was measured for, counted off the controls rather than read off a height:
    // the strip is on its two rows, neither asks for more width than the panel gives it, and the
    // seek bar is still the width its own rule holds it at. See N55 and N124.
    expect(transportHolds(await transportRow())).toEqual(TRANSPORT_ON_ITS_ROWS);

    // The same reading taken during the gesture. Everything above is equally true of a panel that
    // ignores the pointer and jumps once it is let go, which is the mutation that left every
    // divider assertion green.
    await dragSash(toplevel, VIDEO_SASH, 2000, 0);
    const sash = await rectOf(VIDEO_SASH);
    if (sash === null) {
      throw new Error(`${VIDEO_SASH} is missing from the DOM, so there is nothing to drag`);
    }
    const fromX = toplevel.absX + sash.midX;
    const fromY = toplevel.absY + sash.midY;
    try {
      // To the far side of the window: the width the pointer is asking for is past zero, so a panel
      // still following it is not at a floor.
      pressAndTravel(fromX, fromY, toplevel.absX + 1, fromY);
      const held = await waitFor(
        async () => {
          const now = await shellSizes();
          return now.video <= settled.video + SLOP_PX ? now : null;
        },
        {
          timeout: 5000,
          message:
            `the video panel to follow the pointer from ${Math.round(wide.video)} down to ` +
            `${Math.round(settled.video)} while the button is still down`,
        },
      );
      // It stopped there rather than carrying on: the pointer is asking for a width past zero.
      expect(held.video).toBeGreaterThanOrEqual(settled.video - SLOP_PX);
      // The reading that carries the claim, taken with the button still down. Nothing here is
      // compared against a number this run measured, so a panel with no floor cannot satisfy it.
      expect(transportHolds(await transportRow())).toEqual(TRANSPORT_ON_ITS_ROWS);
    } finally {
      // Never leave the button down: it lands on whatever the next check clicks.
      releaseButton();
    }
    await browser.pause(250);
  });

  for (const percent of FLOOR_PERCENTS) {
    it(`leaves both panels usable at each edge's floor, at ${percent} per cent`, async () => {
      const scale = percent / 100;
      await pickSize(toplevel, percent);
      // The block is opened up first, so each edge has a range to be driven across: the stored
      // default block height is a pixel count that does not move with the interface, so at 150 it
      // opens already at its own floor and no drag of the grid edge would happen at all.
      await dragSash(toplevel, GRID_SASH, 0, 2000);

      // The video edge, both ends. The transport's unwrapped height is measured at the ceiling and
      // the floor is asked to match it, rather than a number standing in for one row.
      await dragSash(toplevel, VIDEO_SASH, 2000, 0);
      const atCeiling = await shellSizes();
      const barWithRoom = await seekBar();
      expect(atCeiling.tools).toBeGreaterThanOrEqual(MIN_TOOLS_WIDTH * scale - SLOP_PX);

      await dragSash(toplevel, VIDEO_SASH, -2000, 0);
      const atVideoFloor = await shellSizes();
      expect(atVideoFloor.video).toBeLessThan(atCeiling.video);
      expect(atVideoFloor.transport).toBe(atCeiling.transport);
      // The seek bar gave the panel its slack and stopped at the width its own rule holds it at,
      // which is the width the floor keeps room for: a floor measured without it would leave a
      // transport on one row with nothing in it to drag.
      const barAtFloor = await seekBar();
      expect(barAtFloor.width).toBeLessThan(barWithRoom.width);
      expect(barAtFloor.width).toBeGreaterThanOrEqual(barAtFloor.minimum);
      expect(atVideoFloor.line).toBeGreaterThanOrEqual(MIN_CURRENT_LINE * scale - SLOP_PX);

      // The grid edge, both ends: the current line at one, the header and three rows at the other.
      await dragSash(toplevel, GRID_SASH, 0, -2000);
      const atGridFloor = await shellSizes();
      expect(atGridFloor.block).toBeLessThan(atCeiling.block);
      expect(atGridFloor.line).toBeGreaterThanOrEqual(MIN_CURRENT_LINE * scale - SLOP_PX);
      expect(atGridFloor.transport).toBe(atCeiling.transport);

      await dragSash(toplevel, GRID_SASH, 0, 2000);
      await expectGridShows(3);

      // The waveform edge's floor, the one the criterion names that `dividers.spec.js` does not own.
      await dragSash(toplevel, WAVEFORM_SASH, 0, -2000);
      const atWaveFloor = await shellSizes();
      expect(Math.round(atWaveFloor.waveform)).toBe(Math.round(MIN_WAVEFORM_HEIGHT * scale));
      expect(atWaveFloor.line).toBeGreaterThanOrEqual(MIN_CURRENT_LINE * scale - SLOP_PX);
    });
  }

  it("opens at the size that was picked", async () => {
    await pickSize(toplevel, 125);
    const picked = await drawnSizes();

    await browser.execute(() => {
      window.name = "before-the-relaunch";
    });
    await browser.reloadSession();
    toplevel = await attachToApp();
    expect(await browser.execute(() => window.name)).not.toBe("before-the-relaunch");
    await openTheFixtures(toplevel);

    const reopened = await drawnSizes();
    expect(reopened).toEqual(picked);
  });

  it("opens at 110 per cent again once the stored layout is gone", async () => {
    // The other half of the claim above: a deleted store is a first launch, and 125 was picked by
    // hand, so a size that survives this is one nothing is reading.
    const picked = await drawnSizes();
    rmSync(storedLayout(), { force: true });

    await browser.reloadSession();
    toplevel = await attachToApp();
    await openTheFixtures(toplevel);
    const opened = await drawnSizes();
    expect(opened).not.toEqual(picked);

    await pickSize(toplevel, 100);
    const at100 = await drawnSizes();
    expect(Number((opened.gridRow.type / at100.gridRow.type).toFixed(3))).toBe(
      DEFAULT_PERCENT / 100,
    );
  });

  it("opens the video panel at its floor when the stored share is under it, at 150 per cent", async () => {
    // The floor the panel is drawn at, which is not the one the sash refuses to drag past: every
    // other check here reaches the floor by dragging, so the sash's own bound gets there first and
    // the drawn one is never the thing under test (N56). The share written is the smallest the
    // store keeps, a panel far narrower than the transport at this window, and 150 is where the
    // transport is widest.
    writeFileSync(storedLayout(), JSON.stringify({ videoFraction: 0.1, interfaceScale: 1.5 }));

    await browser.reloadSession();
    toplevel = await attachToApp();
    await openTheFixtures(toplevel);

    // Raised: what is drawn is a wider share than the one that was stored.
    const opened = await shellSizes();
    expect(opened.video / opened.top).toBeGreaterThan(0.1 + SHARE_SLOP);
    // And raised to a width the transport is usable at, read with no pointer anywhere near it.
    expect(transportHolds(await transportRow())).toEqual(TRANSPORT_ON_ITS_ROWS);
  });
});
