/* global describe, it, before, after, document, window */
/**
 * The View menu's four panel layouts: the grid alone, with the picture, with the wave, or with both.
 *
 * What is read is which panels are on screen, not which item is ticked: a radio that marks itself
 * and draws nothing would pass a check that only read the menu. The last check relaunches the app,
 * because a layout that does not outlive the session is a setting that does not settle.
 */
import { rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { runFromMenu } from "../lib/menu.js";
import { clickAt, focusWindow, pressKey } from "../lib/input.js";
import { requireVideoFixture, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { childWindows, findToplevel, mapState } from "../lib/x11.js";

const storedLayout = () =>
  path.join(process.env.SUBLORE_E2E_DATA_HOME, "com.sublore.app", "layout.json");

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

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

/** Which of the two panels the shell is drawing, which is the whole claim of this file. */
function panelsDrawn() {
  return browser.execute(() => ({
    video: document.querySelector(".shell__video") !== null,
    waveform: document.querySelector(".waveform") !== null,
    // The grid is in every one of the four, so a layout that lost it would be a defect no radio
    // could ask for.
    grid: document.querySelector(".cuelist") !== null,
  }));
}

async function attachToApp() {
  const toplevel = await waitFor(findToplevel, {
    timeout: 30000,
    message: `the ${windowWidth}x${windowHeight} "Sublore" toplevel to appear`,
  });
  focusWindow(toplevel.id);
  await waitFor(
    () => browser.execute(() => document.querySelector(".toolbar__file-open-subtitle") !== null),
    {
      timeout: 30000,
      message: "the app UI to render",
    },
  );
  return toplevel;
}

/** Every layout item as the View menu draws it: greyed or not, marked or not. */
async function layoutItems(toplevel) {
  await clickElement(toplevel, ".menubar__title--view");
  await waitFor(() => present(".menubar__item--view-layout-full"), {
    timeout: 15000,
    message: "the View menu to open on its layout items",
  });
  const drawn = await browser.execute(() =>
    ["grid-only", "video-grid", "waveform-grid", "full"].map((token) => {
      const item = document.querySelector(`.menubar__item--view-layout-${token}`);
      return {
        token,
        drawn: item !== null,
        disabled: item?.disabled === true,
        checked: item?.getAttribute("aria-checked") === "true",
      };
    }),
  );
  pressKey("Escape");
  await waitFor(async () => ((await present(".menubar__item--view-layout-full")) ? null : 1), {
    timeout: 15000,
    message: "the View menu to close",
  });
  return drawn;
}

/** Pick one of the four and wait for the panels to answer. */
async function pickLayout(toplevel, token, expected) {
  await clickElement(toplevel, ".menubar__title--view");
  await waitFor(() => present(`.menubar__item--view-layout-${token}`), {
    timeout: 15000,
    message: `the View menu to open on ${token}`,
  });
  await clickElement(toplevel, `.menubar__item--view-layout-${token}`);
  await waitFor(
    async () => {
      const drawn = await panelsDrawn();
      return drawn.video === expected.video && drawn.waveform === expected.waveform ? 1 : null;
    },
    { timeout: 20000, message: `the panels ${token} draws: ${JSON.stringify(expected)}` },
  );
}

describe("the four panel layouts", () => {
  let toplevel = null;

  before(async () => {
    // The store is shared with every spec in the run, and this file reads what the app opens at.
    rmSync(storedLayout(), { force: true });
    await browser.reloadSession();
    toplevel = await attachToApp();
  });

  // The store is shared with every other spec in the run, and this file leaves the window on the
  // grid alone. With no media open that is the only layout that can be picked, so the way back is
  // the store itself: deleted, the next app opens at everything, which is what every other spec
  // expects to find.
  after(() => {
    rmSync(storedLayout(), { force: true });
  });

  it("opens on everything, and greys the three that need something that is not open", async () => {
    expect(await panelsDrawn()).toEqual({ video: true, waveform: false, grid: true });

    // The wave is absent because no media is open, not because the layout says so: Full is the
    // layout, and Full is what is marked.
    expect(await layoutItems(toplevel)).toEqual([
      { token: "grid-only", drawn: true, disabled: false, checked: false },
      { token: "video-grid", drawn: true, disabled: true, checked: false },
      { token: "waveform-grid", drawn: true, disabled: true, checked: false },
      { token: "full", drawn: true, disabled: true, checked: true },
    ]);
  });

  it("takes the picture away for the grid alone, and gives it back", async () => {
    await pickLayout(toplevel, "grid-only", { video: false, waveform: false });
    expect((await panelsDrawn()).grid).toBe(true);

    // Marked in place: the item that was ticked is not the one that is ticked now.
    const items = await layoutItems(toplevel);
    expect(items.map((item) => item.checked)).toEqual([true, false, false, false]);
  });

  it("wakes the other three once a video with audio is open", async () => {
    await runFromMenu((css) => clickElement(toplevel, css), "video", "video-open");
    const chooser = await waitForChooser("Choose a video");
    await answerChooser(chooser, requireVideoFixture(), "video");
    focusWindow(toplevel.id);
    // The layout is the grid alone, so there is no transport to wait on: the app's own log says
    // the media is open.
    await waitFor(
      async () => {
        const items = await layoutItems(toplevel);
        return items.every((item) => !item.disabled) ? 1 : null;
      },
      { timeout: 40000, message: "every layout to be pickable once the media is open" },
    );
  });

  it("draws the picture without the wave, and the wave without the picture", async () => {
    await pickLayout(toplevel, "video-grid", { video: true, waveform: false });
    await pickLayout(toplevel, "waveform-grid", { video: false, waveform: true });
    await pickLayout(toplevel, "full", { video: true, waveform: true });
  });

  it("takes the native picture off the screen with the panel that held it", async () => {
    // The panel is a DOM box and the picture is an X window over it: a layout that removed the box
    // and left the window would draw the picture over the grid. Nothing else in the suite asks.
    const surface = () =>
      childWindows(toplevel.id).filter((child) => child.width > 50 && child.height > 50)[0] ?? null;
    expect(surface()).not.toBe(null);
    expect(mapState(surface().id)).toBe("IsViewable");

    await pickLayout(toplevel, "grid-only", { video: false, waveform: false });
    await waitFor(
      () => {
        const window_ = surface();
        return window_ === null || mapState(window_.id) === "IsUnMapped" ? 1 : null;
      },
      { timeout: 20000, message: "the native picture to go with the panel" },
    );

    await pickLayout(toplevel, "full", { video: true, waveform: true });
    await waitFor(
      () => {
        const window_ = surface();
        return window_ !== null && mapState(window_.id) === "IsViewable" ? 1 : null;
      },
      { timeout: 20000, message: "the native picture to come back with the panel" },
    );
  });

  it("keeps the old waveform toggle agreeing with the four", async () => {
    // Turning the wave off from Full is picking the layout beside it without the wave, so the
    // radios move with it rather than saying something the panels do not.
    await clickElement(toplevel, ".menubar__title--view");
    await waitFor(() => present(".menubar__item--view-waveform-panel"), {
      timeout: 15000,
      message: "the View menu to open on the waveform toggle",
    });
    await clickElement(toplevel, ".menubar__item--view-waveform-panel");
    await waitFor(
      async () => {
        const drawn = await panelsDrawn();
        return drawn.video && !drawn.waveform ? 1 : null;
      },
      { timeout: 20000, message: "the wave to go and the picture to stay" },
    );
    const items = await layoutItems(toplevel);
    expect(items.map((item) => item.checked)).toEqual([false, true, false, false]);
  });

  it("opens at the layout that was picked", async () => {
    await pickLayout(toplevel, "grid-only", { video: false, waveform: false });

    await browser.execute(() => {
      window.name = "before-the-relaunch";
    });
    await browser.reloadSession();
    toplevel = await attachToApp();
    expect(await browser.execute(() => window.name)).not.toBe("before-the-relaunch");

    // No media is open after a relaunch, so what is read is the picture: the grid alone is a
    // layout the window opened at rather than a state the media left behind.
    expect(await panelsDrawn()).toEqual({ video: false, waveform: false, grid: true });
    const items = await layoutItems(toplevel);
    expect(items.map((item) => item.checked)).toEqual([true, false, false, false]);
  });
});
