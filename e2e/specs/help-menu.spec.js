/* global describe, it, before, afterEach, document, window */
/**
 * The Help menu: the six items interface-spec §3.8 keeps in v1, in the reference's order, and the
 * three that open in the user's own browser. Every one of the six can act: the manual, the event
 * log and the update check each closed a slice of their own, and none of them is drawn greyed any
 * more. About works from its new place last.
 *
 * What is read is what the menu draws and what the app logs it asked to open. This used to say a
 * browser cannot open under Xvfb, which was wrong and cost the owner a browser full of tabs: a
 * second Firefox hands its URL to the instance already running, through the profile lock, which has
 * nothing to do with DISPLAY. The harness now puts a launcher that goes nowhere in front of the real
 * ones for every app it starts, so a run records the URL instead of opening it. See
 * `lib/browserstub.js` and help-menu-tasks.md.
 */
import { browser, expect } from "@wdio/globals";

import { appLog, dataHome, waitForLog } from "../lib/applog.js";
import { clickAt, focusWindow, pressKey } from "../lib/input.js";
import { windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

const present = (selector) =>
  browser.execute((css) => document.querySelector(css) !== null, selector);

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

async function openHelp(toplevel) {
  await clickElement(toplevel, ".menubar__title--help");
  await waitFor(() => present(".menubar__item--help-about"), {
    timeout: 15000,
    message: "the Help menu to open",
  });
}

/** Escape closes the menu; loop until nothing is open, so a test never leaves one for the next. */
async function closeMenu() {
  await waitFor(
    async () => {
      if (!(await present(".menubar__menu"))) {
        return 1;
      }
      pressKey("Escape");
      return null;
    },
    { timeout: 15000, message: "the Help menu to close" },
  );
}

/** Every Help item in the order the menu draws it: its token, its label, and whether it is greyed. */
function helpItems() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".menubar__menu .menubar__item")).map((item) => ({
      token:
        Array.from(item.classList)
          .find((name) => name.startsWith("menubar__item--"))
          ?.replace("menubar__item--", "") ?? "",
      label: item.querySelector(".menubar__label")?.textContent ?? null,
      disabled: item.disabled,
    })),
  );
}

/**
 * The menu's rows in the order it draws them, a rule being its own row: what the items alone cannot
 * say is where the groups begin and end, and the groups are part of the layout (N119).
 */
function helpRows() {
  return browser.execute(() =>
    Array.from(document.querySelector(".menubar__menu")?.children ?? []).map((row) =>
      row.classList.contains("menubar__separator")
        ? "----"
        : (Array.from(row.classList)
            .find((name) => name.startsWith("menubar__item--"))
            ?.replace("menubar__item--", "") ?? ""),
    ),
  );
}

/** The manual's address, as the app logs it before handing it to the browser. */
const MANUAL_LOGGED =
  /help: opening https:\/\/github\.com\/Athanor-Lab\/SubLore\/blob\/main\/docs\/manual\.md /g;

/**
 * How many times that address is already in the log. Both routes to the manual write the same line,
 * so the second one is proved by the count going up and never by the line being there: matching the
 * whole file would let the menu's own line pass for the accelerator's.
 */
function timesLogged() {
  return (appLog(dataHome()).match(MANUAL_LOGGED) ?? []).length;
}

describe("the Help menu", () => {
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

  // A test that fails before its own cleanup would leave the menu or the About dialog open, and the
  // next test's click on the title would toggle the menu shut rather than open. This keeps one red
  // from turning into many that are not.
  afterEach(async () => {
    if (await present(".about")) {
      await clickElement(toplevel, ".about__close");
    }
    await closeMenu();
  });

  it("draws the six v1 items in the reference's order, About last", async () => {
    await openHelp(toplevel);
    const items = await helpItems();
    // The reference's order (interface-spec §3.8), minus Community chat, which is scoped later.
    expect(items.map((item) => item.token)).toEqual([
      "help-contents",
      "help-website",
      "help-report-bug",
      "help-check-updates",
      "help-event-log",
      "help-about",
    ]);
    // Three blocks, which is how the reference divides this menu: the manual, then the web, then
    // what the build says about itself (N119).
    expect(await helpRows()).toEqual([
      "help-contents",
      "----",
      "help-website",
      "help-report-bug",
      "----",
      "help-check-updates",
      "help-event-log",
      "help-about",
    ]);
    expect(items.map((item) => item.label)).toEqual([
      "Help contents",
      "Project website",
      "Report a bug",
      "Check for updates",
      "Event log",
      "About Sublore",
    ]);
    await closeMenu();
  });

  it("draws all six enabled, now that every provider is built", async () => {
    await openHelp(toplevel);
    const greyed = Object.fromEntries(
      (await helpItems()).map((item) => [item.token, item.disabled]),
    );
    // Every one of the six can act now, so none of them is drawn greyed.
    expect(Object.values(greyed)).toEqual([false, false, false, false, false, false]);
    await closeMenu();
  });

  it("opens the bug tracker in the browser, logging the exact URL", async () => {
    await openHelp(toplevel);
    await clickElement(toplevel, ".menubar__item--help-report-bug");
    await waitForLog(
      dataHome(),
      /help: opening https:\/\/github\.com\/Athanor-Lab\/SubLore\/issues /,
      { timeout: 20000, what: "the bug tracker URL" },
    );
  });

  it("opens the project website in the browser, logging the exact URL", async () => {
    await openHelp(toplevel);
    await clickElement(toplevel, ".menubar__item--help-website");
    await waitForLog(dataHome(), /help: opening https:\/\/github\.com\/Athanor-Lab\/SubLore /, {
      timeout: 20000,
      what: "the project website URL",
    });
  });

  it("opens the manual in the browser, logging the exact URL", async () => {
    const before = timesLogged();
    await openHelp(toplevel);
    await clickElement(toplevel, ".menubar__item--help-contents");
    await waitFor(() => (timesLogged() > before ? 1 : null), {
      timeout: 20000,
      message: "the manual URL to reach the log from the menu",
    });
  });

  it("opens the manual from F1 as well, with no menu in the way", async () => {
    // A function key is the one bare press a text field never keeps, so this fires wherever the
    // caret is (keyboard-tasks F5). The menu is shut: the accelerator is the whole route.
    await closeMenu();
    focusWindow(toplevel.id);
    const before = timesLogged();
    pressKey("F1");
    await waitFor(() => (timesLogged() > before ? 1 : null), {
      timeout: 20000,
      message: "the manual URL to reach the log from F1",
    });
  });

  it("still opens the About dialog, from its new place last", async () => {
    await openHelp(toplevel);
    await clickElement(toplevel, ".menubar__item--help-about");
    await waitFor(() => present(".about"), {
      timeout: 15000,
      message: "the About dialog to open",
    });
    // Leave nothing open for the next spec: the close button, not Escape, which needs the panel
    // focused.
    await clickElement(toplevel, ".about__close");
    await waitFor(async () => ((await present(".about")) ? null : 1), {
      timeout: 15000,
      message: "the About dialog to close",
    });
  });
});
