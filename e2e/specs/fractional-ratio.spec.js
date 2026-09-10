/* global describe, it, before, after, document, window */
/**
 * N2c on Linux: the page's rectangle is resolved to native pixels exactly once, at a ratio that is
 * not a whole number.
 *
 * `e2e:scale` sets `GDK_SCALE` before the app starts, so GTK's own factor carries the ratio and GDK
 * re-applies it on the way to X. The fractional case is a different path: GTK's factor stays 1, the
 * ratio arrives as page zoom, and the page's own rectangle has to be multiplied by
 * `devicePixelRatio` before it crosses the IPC boundary. The regression that path nearly shipped put
 * the surface at the ratio squared.
 *
 * `scaled-surface-check.js` says this cannot be produced in the harness, and it is right about what
 * it names: `Xft.dpi` through `xrdb` does not reach WebKitGTK. Through an XSETTINGS manager it does.
 * `xsettingsd` owns the `_XSETTINGS_S0` selection, publishes `Xft/DPI`, and rereads its file on
 * SIGHUP, and a running app follows it. See BACKLOG.md N59.
 *
 * The assertion needs no knowledge of the layout: the surface's geometry in X is the stage's own
 * rectangle in CSS pixels times the ratio, at any ratio. A stale rectangle fails it and so does one
 * multiplied twice.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow } from "../lib/input.js";
import { requireTool, requireVideoFixture, videoFixture } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { allWindows, childWindows, isAppWindowName, rootTree } from "../lib/x11.js";

/** 96 dpi is a ratio of 1 and is what a display with no manager on it already reports. */
const BASE_DPI = 96;
/** 144 dpi is a ratio of 1.5, which is the size the owner's own display is set to. */
const SCALED_DPI = 144;
/** XSETTINGS carries DPI in 1024ths of a point. */
const DPI_UNIT = 1024;

/** The ratio each of those two is expected to produce in the page. */
const RATIOS = { [BASE_DPI]: 1, [SCALED_DPI]: 1.5 };

/**
 * How far the surface may land from the rectangle times the ratio.
 *
 * Each edge is rounded once on the way to X, so a width is out by up to one at each side. Three
 * covers that with room; the defect this exists for is off by a factor, not by a pixel.
 */
const SLOP_PX = 3;

/** The page's own reading of the stage and of the ratio, taken in one round trip. */
function pageReading() {
  return browser.execute(() => {
    const element = document.querySelector(".stage__surface");
    if (element === null) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    return {
      ratio: window.devicePixelRatio,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  });
}

/** The app's toplevel by its tail, because its geometry is one of the things that moves here. */
function appToplevel() {
  const named = allWindows().filter((window) => isAppWindowName(window.name) && window.width > 200);
  if (named.length > 1) {
    throw new Error(`expected one app toplevel, found ${named.length}\n${rootTree()}`);
  }
  return named.length === 1 ? named[0] : null;
}

/** The surface is the biggest child of the toplevel; mpv's own window lives inside it. */
function surfaceOf(toplevel) {
  return (
    childWindows(toplevel.id)
      .filter((child) => child.width > 50 && child.height > 50)
      .sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? null
  );
}

/**
 * The page's reading and the display's, once both have stopped moving at the wanted ratio.
 *
 * Two identical reads of the surface, for the reason `scaled-surface-check.js` gives: the page lays
 * out, the surface is sized from the page's rectangle, and a read between the two is an
 * intermediate.
 */
async function readingAt(ratio) {
  let previous = null;
  return waitFor(
    async () => {
      const page = await pageReading();
      if (page === null || Math.abs(page.ratio - ratio) > 0.001) {
        previous = null;
        return null;
      }
      const toplevel = appToplevel();
      const surface = toplevel === null ? null : surfaceOf(toplevel);
      if (surface === null) {
        previous = null;
        return null;
      }
      const now = {
        page,
        surface: {
          width: surface.width,
          height: surface.height,
          relX: surface.relX,
          relY: surface.relY,
        },
      };
      const same =
        previous !== null && JSON.stringify(previous.surface) === JSON.stringify(now.surface);
      previous = now;
      return same ? now : null;
    },
    {
      timeout: 40000,
      message: `the page to be drawn at a ratio of ${ratio} with its surface settled`,
    },
  );
}

/** What the surface should be if the rectangle was resolved to native pixels exactly once. */
function expectedFrom(page) {
  const x = Math.round(page.x * page.ratio);
  const y = Math.round(page.y * page.ratio);
  return {
    relX: x,
    relY: y,
    width: Math.round(page.right * page.ratio) - x,
    height: Math.round(page.bottom * page.ratio) - y,
  };
}

function withEdges(page) {
  return { ...page, right: page.x + page.width, bottom: page.y + page.height };
}

function closeEnough(got, want) {
  return (
    Math.abs(got.width - want.width) <= SLOP_PX &&
    Math.abs(got.height - want.height) <= SLOP_PX &&
    Math.abs(got.relX - want.relX) <= SLOP_PX &&
    Math.abs(got.relY - want.relY) <= SLOP_PX
  );
}

describe("a fractional display ratio", () => {
  let toplevel = null;
  let settings = null;
  let configFile = null;

  /** Publish a DPI and make the manager reread its file. */
  function publish(dpi) {
    writeFileSync(
      configFile,
      `Gdk/WindowScalingFactor 1\nXft/DPI ${dpi * DPI_UNIT}\nXft/Antialias 1\n`,
    );
    if (settings !== null && settings.pid !== undefined) {
      process.kill(settings.pid, "SIGHUP");
    }
  }

  before(async () => {
    requireVideoFixture();
    requireTool("xsettingsd", "publish the display ratio the way a desktop does");

    toplevel = await waitFor(appToplevel, {
      timeout: 30000,
      message: "the app's toplevel to appear",
    });
    focusWindow(toplevel.id);
    await waitFor(
      () => browser.execute(() => document.querySelector(".toolbar__video-open") !== null),
      { timeout: 30000, message: "the app UI to render" },
    );

    const open = await browser.execute(() => {
      const element = document.querySelector(".toolbar__video-open");
      const rect = element.getBoundingClientRect();
      const dpr = window.devicePixelRatio;
      return { x: (rect.x + rect.width / 2) * dpr, y: (rect.y + rect.height / 2) * dpr };
    });
    clickAt(toplevel.absX + open.x, toplevel.absY + open.y);
    const chooser = await waitForChooser("Choose a video");
    await answerChooser(chooser, videoFixture, "video");
    focusWindow(toplevel.id);

    // The manager starts holding the ratio the display already has, so nothing has moved yet.
    configFile = path.join(mkdtempSync(path.join(os.tmpdir(), "sublore-xsettings-")), "conf");
    writeFileSync(configFile, `Gdk/WindowScalingFactor 1\nXft/DPI ${BASE_DPI * DPI_UNIT}\n`);
    settings = spawn("xsettingsd", ["-c", configFile], { stdio: "ignore" });
  });

  /**
   * The display is this worker's, shared with every spec that runs after this one, so it goes back
   * to the ratio it was found at whatever happened above. Not a `before` hook: by then the app has
   * already been drawn once at whatever was left behind.
   */
  after(async () => {
    if (settings === null) {
      return;
    }
    publish(BASE_DPI);
    await waitFor(
      async () => {
        const page = await pageReading();
        return page !== null && Math.abs(page.ratio - 1) < 0.001 ? true : null;
      },
      { timeout: 30000, message: "the page to be back at a ratio of 1" },
    ).catch(() => {
      // Said, not swallowed: the next spec on this worker would otherwise fail for this one's
      // reasons with nothing pointing back here.
      throw new Error(
        "the display was left at a ratio this spec set, so every spec after it on this worker is " +
          `drawing at the wrong size\n${rootTree()}`,
      );
    });
    settings.kill();
  });

  it("places the surface at the stage's rectangle times the ratio, at a ratio of 1", async () => {
    const at1 = await readingAt(RATIOS[BASE_DPI]);
    const want = expectedFrom(withEdges(at1.page));
    // The invariant this file exists to check, first where it is easy: at a ratio of 1 the
    // rectangle and the geometry are the same numbers, so a failure here is the reading itself
    // being wrong and not the defect.
    expect({ surface: at1.surface, holds: closeEnough(at1.surface, want) }).toEqual({
      surface: at1.surface,
      holds: true,
    });
  });

  it("places it at the rectangle times the ratio when the ratio is not a whole number", async () => {
    publish(SCALED_DPI);
    const at15 = await readingAt(RATIOS[SCALED_DPI]);
    const want = expectedFrom(withEdges(at15.page));

    // The claim N2c is about. At 1.5 the rectangle and the geometry are different numbers, so this
    // fails three ways: a rectangle that never reached X unresolved (the surface stays where it
    // was), one resolved twice (the ratio squared), and one resolved by GDK as well as by the page.
    expect({
      surface: at15.surface,
      holds: closeEnough(at15.surface, want),
    }).toEqual({ surface: at15.surface, holds: true });

    // And the ratio really did move, so the check above is not the ratio-1 case wearing a label.
    expect(at15.page.ratio).toBe(1.5);
  });
});
