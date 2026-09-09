/**
 * An integer display scale is applied to the video surface exactly once.
 *
 * **This does not prove N2c, and saying so is the point.** N2c is a fractional-scale defect: there
 * GTK's own factor is 1 and the 1.5 arrives as page zoom, so the page's rectangle has to be
 * resolved to native pixels before it crosses the IPC boundary. Under `GDK_SCALE` the ratio comes
 * from GTK's factor instead, GDK re-applies it on the way to X, and the old code and the new one
 * produce the same geometry. A fractional ratio cannot be produced here at all: `Xft.dpi` through
 * `xrdb` does not reach WebKitGTK without an XSETTINGS manager, and neither does a `gtk-xft-dpi`
 * settings file — both measured, both leaving `devicePixelRatio` at 1. N2c's own criterion is met
 * on the owner's 1.5 display, and nowhere else.
 *
 * What this guards is the regression the N2c work nearly shipped: resolving in the page without
 * dividing GDK's factor back out made the surface land at four times its rectangle instead of two.
 * The assertion is relative and needs no knowledge of the layout — the same app twice, at ratio 1
 * and ratio 2, and the surface has to double, not quadruple and not stand still.
 */
import { execFileSync, spawn } from "node:child_process";
import console from "node:console";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { appEnv } from "../lib/env.js";
import {
  closeWindowTool,
  requireAppBinary,
  requireCloseWindowTool,
  requireDisplay,
  requireVideoFixture,
  videoFixture,
} from "../lib/paths.js";
import { describeProcesses, killGroup, processGroupMembers, waitFor } from "../lib/proc.js";
import { allWindows, childWindows, isAppWindowName, mapState, rootTree } from "../lib/x11.js";

/**
 * How long the app's own children get to finish leaving after it has exited.
 *
 * Sixty seconds and not the ten this used to be, because ten was picked before anyone knew who was
 * staying. Measured on 2026-09-09 over 34 runs: four survivors, every one of them WebKit's web
 * content process, and every one gone on its own. Three went within two seconds of the old limit
 * and one sat in uninterruptible sleep for another thirty-seven. A process that never leaves still
 * fails this, which is the point; it just is not asked to leave faster than it can. See N16.
 */
const GROUP_EMPTY_TIMEOUT_MS = 60000;

/** Gutting an assertion has to be as red as failing one, so the checks count themselves. */
const EXPECTED_CHECKS = 5;
let checksRun = 0;

function check(label, ok, detail = "") {
  checksRun += 1;
  if (!ok) {
    throw new Error(`scaled surface check failed: ${label}${detail === "" ? "" : `\n${detail}`}`);
  }
  console.log(`  ok  ${label}`);
}

/**
 * By name, not by size: `findToplevel` looks for the configured 1024x700 and at ratio 2 the window
 * is twice that, which is the very thing under test.
 *
 * Through `isAppWindowName`, because the window is named for the document it holds (N57). Matching
 * the app's name exactly still found a window here, but only in the moment between the window being
 * created and the page naming it, which is a race this check would eventually lose.
 */
function toplevelByName() {
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

/** Launch at one ratio, read the geometry, close. Returns the window and surface rectangles. */
async function measureAt(scale) {
  const dataHome = mkdtempSync(path.join(os.tmpdir(), `sublore-e2e-scale${scale}-`));
  const app = spawn(requireAppBinary(), [videoFixture], {
    detached: true,
    stdio: ["ignore", "ignore", "inherit"],
    env: appEnv({ XDG_DATA_HOME: dataHome, GDK_SCALE: String(scale) }),
  });
  const pgid = app.pid;
  let exit = null;
  app.on("exit", (code, signal) => {
    exit = { code, signal };
  });

  try {
    const toplevel = await waitFor(
      () => {
        if (exit !== null) {
          throw new Error(`the app exited before its window appeared (code ${exit.code})`);
        }
        return toplevelByName();
      },
      { timeout: 30000, message: `the app toplevel at GDK_SCALE=${scale}` },
    );
    // The first mapped geometry is not the settled one: the page lays out, the surface is sized
    // from the page's rectangle, and reading between the two gives an intermediate height. On CI
    // that read 163 where the settled value was 181 and the ratio-2 comparison failed on a layout
    // that was still moving. Wait for two identical reads instead.
    let previous = null;
    const surface = await waitFor(
      () => {
        const now = surfaceOf(toplevel);
        const settled =
          now !== null &&
          previous !== null &&
          now.width === previous.width &&
          now.height === previous.height &&
          now.relX === previous.relX &&
          now.relY === previous.relY;
        previous = now;
        return settled ? now : null;
      },
      {
        timeout: 30000,
        message: `a settled native surface at GDK_SCALE=${scale}\n${rootTree()}`,
      },
    );
    // Captured before the window closes: mapState needs a live window, and it is a fact
    // `surfaceOf` does not establish (a child can be in the tree unmapped).
    const surfaceMapState = mapState(surface.id);

    execFileSync("python3", [closeWindowTool, toplevel.id], { stdio: "ignore", timeout: 15000 });
    await waitFor(() => exit !== null, { timeout: 20000, message: "the app to exit" });
    const waitedFrom = Date.now();
    const survivors = await waitFor(() => (processGroupMembers(pgid).length === 0 ? [] : null), {
      timeout: GROUP_EMPTY_TIMEOUT_MS,
      message: `process group ${pgid} to be empty`,
    }).catch(() => processGroupMembers(pgid));
    // How long the wait actually took, on the failure path as well as the happy one: a survivor
    // reported after a fifth of a second is a different fault from one reported after the whole
    // timeout, and without this the message cannot tell them apart. See N16.
    const waitedMs = Date.now() - waitedFrom;

    return { toplevel, surface, exit, survivors, surfaceMapState, waitedMs };
  } finally {
    try {
      if (processGroupMembers(pgid).length > 0) {
        killGroup(pgid);
      }
    } catch {
      // Teardown must not mask the failure that got us here.
    }
  }
}

/**
 * Three pixels of slack for the rounding, and a twentieth for the layout. The page rounds each edge
 * once per ratio, and at ratio 2 the Linux backend divides the result by two and rounds again:
 * `round(b*2) - round(t*2)` is within one of `2h`, halving leaves half a pixel, and rounding that
 * leaves one, which the doubling turns into two, three once the ratio-1 rounding is counted too.
 *
 * The fiftieth of the window is for something the three cannot cover, and it was measured rather
 * than guessed. The page lays itself out in CSS pixels and a different device scale rounds a few of
 * them differently: on the runner the surface came back eight pixels wider and ten taller than
 * twice, and its corner twenty and ten away, on runs whose heights differed by sixty-four, so the
 * shortfall is the layout's and not the ratio's. See BACKLOG N37.
 *
 * It is a share of the window rather than of the number being checked, because the corner is a
 * small number that a fixed layout difference moves by a large fraction while the window it sits in
 * has not moved at all. What this check exists to catch is off by a factor: a surface that applied
 * the ratio twice would read 1384 where 692 is wanted, and one that ignored it would read 346. Both
 * are more than twenty pixels out of a thousand and neither could hide inside it.
 */
function doubles(one, two, span) {
  return Math.abs(two - one * 2) <= Math.max(3, span * 0.02);
}

async function main() {
  requireDisplay();
  requireAppBinary();
  requireCloseWindowTool();
  requireVideoFixture();

  const single = await measureAt(1);
  const double = await measureAt(2);

  console.log(
    `  ratio 1: toplevel ${single.toplevel.width}x${single.toplevel.height}, ` +
      `surface ${single.surface.width}x${single.surface.height}+${single.surface.relX}+${single.surface.relY}`,
  );
  console.log(
    `  ratio 2: toplevel ${double.toplevel.width}x${double.toplevel.height}, ` +
      `surface ${double.surface.width}x${double.surface.height}+${double.surface.relX}+${double.surface.relY}`,
  );

  // waitFor throws rather than resolving falsy, so `surface !== null` is guaranteed here; map
  // state is the first fact about the surfaces that is not (see gate2 register, L3).
  check(
    "the surface was mapped at both ratios",
    single.surfaceMapState === "IsViewable" && double.surfaceMapState === "IsViewable",
    `map state was ${single.surfaceMapState} at ratio 1, ${double.surfaceMapState} at ratio 2`,
  );

  // Without this the whole check could pass by comparing two identical runs, if GDK_SCALE were
  // ignored: the assertion below would then compare a rectangle with twice itself and fail, but it
  // would fail for a reason nobody could read.
  check(
    "GDK_SCALE reached the window: the toplevel doubled",
    doubles(single.toplevel.width, double.toplevel.width, single.toplevel.width) &&
      doubles(single.toplevel.height, double.toplevel.height, single.toplevel.height),
    `toplevel was ${single.toplevel.width}x${single.toplevel.height} at ratio 1 and ` +
      `${double.toplevel.width}x${double.toplevel.height} at ratio 2. If those are the same, the ` +
      `ratio never changed and this check proves nothing.`,
  );

  check(
    "the surface doubled in size with the ratio",
    doubles(single.surface.width, double.surface.width, single.toplevel.width) &&
      doubles(single.surface.height, double.surface.height, single.toplevel.height),
    `surface was ${single.surface.width}x${single.surface.height} then ` +
      `${double.surface.width}x${double.surface.height}. Unchanged means the page's rectangle ` +
      `reached X without being resolved to native pixels, which is BACKLOG N2c.`,
  );

  check(
    "the surface doubled in position with the ratio",
    doubles(single.surface.relX, double.surface.relX, single.toplevel.width) &&
      doubles(single.surface.relY, double.surface.relY, single.toplevel.height),
    `surface sat at ${single.surface.relX},${single.surface.relY} then ` +
      `${double.surface.relX},${double.surface.relY}`,
  );

  check(
    "both runs closed with status 0 and left nothing running",
    single.exit.code === 0 &&
      double.exit.code === 0 &&
      single.survivors.length === 0 &&
      double.survivors.length === 0,
    `exits ${JSON.stringify([single.exit, double.exit])}\n` +
      `survivors at ratio 1, after waiting ${single.waitedMs}ms:\n` +
      `${describeProcesses(single.survivors)}\n` +
      `survivors at ratio 2, after waiting ${double.waitedMs}ms:\n` +
      `${describeProcesses(double.survivors)}`,
  );

  if (checksRun < EXPECTED_CHECKS) {
    throw new Error(
      `scaled surface guard: expected ${EXPECTED_CHECKS} checks, only ${checksRun} ran. ` +
        "Removing an assertion here is a CI failure. See e2e/README.md.",
    );
  }
  console.log(`scaled surface check passed (${checksRun}/${EXPECTED_CHECKS} checks)`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
