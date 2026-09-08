/* global describe, it, before, afterEach, document, window */
/**
 * The Help menu: the six items interface-spec §3.8 keeps in v1, in the reference's order, and the
 * two that need nothing but the user's own browser to open. Contents, Check for updates and Event
 * log are drawn greyed because their providers (the manual, the update check, the log window) are
 * not built yet; each is a slice of its own, and a command that exists is drawn rather than absent
 * (2026-09-03 ruling). About works from its new place last.
 *
 * What is read is what the menu draws and what the app logs it asked to open. A browser cannot open
 * under Xvfb and this spec does not need one: the command logs the exact URL before it launches,
 * which is the only thing about the launch a check can see. See help-menu-tasks.md.
 */
import { browser, expect } from "@wdio/globals";

import { dataHome, waitForLog } from "../lib/applog.js";
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

  it("greys the three whose provider is not built, and enables the rest", async () => {
    await openHelp(toplevel);
    const greyed = Object.fromEntries(
      (await helpItems()).map((item) => [item.token, item.disabled]),
    );
    // Enabled: the two browser links and About, all of which can act right now.
    expect(greyed["help-website"]).toBe(false);
    expect(greyed["help-report-bug"]).toBe(false);
    expect(greyed["help-about"]).toBe(false);
    // Greyed: the manual, the update check and the log window are not built.
    expect(greyed["help-contents"]).toBe(true);
    expect(greyed["help-check-updates"]).toBe(true);
    expect(greyed["help-event-log"]).toBe(true);
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
