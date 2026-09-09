/* global describe, it, before, afterEach, document, window */
/**
 * Help's update check (interface-spec 3.8): one request, made because the user pressed for it.
 *
 * The app is pointed at a stand-in for the whole run by `wdio.conf.js`, so nothing here reaches the
 * real network, and what the stand-in answers is a file this spec writes before each press. The
 * reference also checks on startup behind a preference; that half is not built, and the first test
 * is what says so.
 */
import { rmSync, writeFileSync } from "node:fs";

import { browser, expect } from "@wdio/globals";

import { appLog, dataHome } from "../lib/applog.js";
import { clickAt, focusWindow, pressKey } from "../lib/input.js";
import { windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { answerPath } from "../lib/updates.js";
import { findToplevel } from "../lib/x11.js";

const present = (selector) =>
  browser.execute((css) => document.querySelector(css) !== null, selector);

function textOf(selector) {
  return browser.execute((css) => document.querySelector(css)?.textContent ?? null, selector);
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
    throw new Error(`${selector} is missing from the DOM, so there is nothing to click`);
  }
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

/** What the stand-in will answer with next. No file at all is a 404, and so "nothing newer". */
function answerWith(body) {
  if (body === null) {
    rmSync(answerPath(dataHome()), { force: true });
    return;
  }
  writeFileSync(answerPath(dataHome()), JSON.stringify(body));
}

/** How many checks the app has made. The line is written before the request goes out. */
function checksMade() {
  return (appLog(dataHome()).match(/update: asking /g) ?? []).length;
}

async function runCheck(toplevel) {
  await clickElement(toplevel, ".menubar__title--help");
  await waitFor(() => present(".menubar__item--help-check-updates"), {
    timeout: 15000,
    message: "the Help menu to open",
  });
  await clickElement(toplevel, ".menubar__item--help-check-updates");
  await waitFor(() => present(".update"), {
    timeout: 15000,
    message: "the update panel to open",
  });
}

describe("checking for updates", () => {
  let toplevel = null;

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
  });

  afterEach(async () => {
    if (await present(".update")) {
      pressKey("Escape");
      await waitFor(async () => ((await present(".update")) ? null : 1), {
        timeout: 15000,
        message: "the update panel to close",
      });
    }
  });

  it("asks nothing until it is asked, and then reads no releases as nothing newer", async () => {
    // The app has been up since this file's `before`, with no check made: §1 allows the explicit
    // call and forbids the automatic one, and this is the observable half of that.
    expect(checksMade()).toBe(0);

    answerWith(null);
    await runCheck(toplevel);
    await waitFor(() => present(".update__current"), {
      timeout: 20000,
      message: "the panel to say this is the newest version",
    });
    expect(checksMade()).toBe(1);
    // Nothing to press: there is no release to go and look at.
    expect(await present(".update__open")).toBe(false);
  });

  it("names a newer release and opens its page in the browser", async () => {
    answerWith({ tag_name: "v9.9.9", html_url: "https://example.invalid/sublore/9.9.9" });
    await runCheck(toplevel);
    const said = await waitFor(
      async () => {
        const text = await textOf(".update__newer");
        return text === null ? null : text;
      },
      { timeout: 20000, message: "the panel to name the newer release" },
    );
    expect(said).toContain("9.9.9");

    // The page the backend found, opened through the same launcher the Help links use. No browser
    // opens under Xvfb, and the logged address is the whole of what a check can see.
    await clickElement(toplevel, ".update__open");
    await waitFor(
      () =>
        /update: opening https:\/\/example\.invalid\/sublore\/9\.9\.9 /.test(appLog(dataHome()))
          ? 1
          : null,
      { timeout: 20000, message: "the release page to reach the log" },
    );
  });

  it("says so when the check cannot be made, and the app carries on", async () => {
    answerWith({ closed: true });
    await runCheck(toplevel);
    await waitFor(() => present(".update__failed"), {
      timeout: 30000,
      message: "the panel to say the check could not be made",
    });

    pressKey("Escape");
    await waitFor(async () => ((await present(".update")) ? null : 1), {
      timeout: 15000,
      message: "the update panel to close",
    });
    // The window still answers, which is the half of U4 that is about the app rather than the check.
    await clickElement(toplevel, ".menubar__title--help");
    await waitFor(() => present(".menubar__item--help-about"), {
      timeout: 15000,
      message: "the Help menu to still open after a failed check",
    });
    pressKey("Escape");
  });
});
