/* global describe, it, before, document, window */
/**
 * The event log window (interface-spec 9.12): what the app has been saying this run, read back
 * without leaving it. The owner verifies behaviour rather than code, so "open the log window and
 * read it back to me" has to be a step anyone can follow.
 *
 * What is asserted is that the window holds a line the app really wrote, and that the line was
 * written before the window existed: the buffer is the process's, not the panel's.
 */
import { browser, expect } from "@wdio/globals";

import { clickAt, focusWindow, pressKey } from "../lib/input.js";
import { windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
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

async function openHelp(toplevel) {
  await clickElement(toplevel, ".menubar__title--help");
  await waitFor(() => present(".menubar__item--help-event-log"), {
    timeout: 15000,
    message: "the Help menu to open",
  });
}

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

async function openEventLog(toplevel) {
  await openHelp(toplevel);
  await clickElement(toplevel, ".menubar__item--help-event-log");
  await waitFor(() => present(".eventlog"), {
    timeout: 15000,
    message: "the event log window to open",
  });
}

async function closeEventLog() {
  pressKey("Escape");
  await waitFor(async () => ((await present(".eventlog")) ? null : 1), {
    timeout: 15000,
    message: "the event log window to close",
  });
}

describe("the event log window", () => {
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

  it("is a command that runs, and opens on the lines the app has written", async () => {
    // Something the app is made to say, before the window that shows it exists. The website link
    // logs its address and needs no browser to have done so.
    await openHelp(toplevel);
    await clickElement(toplevel, ".menubar__item--help-website");
    await closeMenu();

    await openEventLog(toplevel);
    const shown = await waitFor(
      async () => {
        const text = await textOf(".eventlog__lines");
        return text !== null && text.includes("github.com/Athanor-Lab/SubLore") ? text : null;
      },
      { timeout: 20000, message: "the address the app logged to reach the window" },
    );
    // A real log line and not a rendering of one: the plugin's own stamp is on it.
    expect(shown).toMatch(/\[\d{4}-\d{2}-\d{2}]\[\d{2}:\d{2}:\d{2}]\[sublore/);
    await closeEventLog();
  });

  it("keeps the lines when it is shut and opened again", async () => {
    await openEventLog(toplevel);
    const again = await textOf(".eventlog__lines");
    expect(again).toContain("github.com/Athanor-Lab/SubLore");
    await closeEventLog();
  });

  it("closes on the backdrop and on its own button too", async () => {
    await openEventLog(toplevel);
    // The backdrop is the panel's own parent, so a click at the very top of the window is outside
    // the panel and inside the layer.
    clickAt(toplevel.absX + 8, toplevel.absY + 8);
    await waitFor(async () => ((await present(".eventlog")) ? null : 1), {
      timeout: 15000,
      message: "the backdrop click to close the window",
    });

    await openEventLog(toplevel);
    await clickElement(toplevel, ".eventlog__close");
    await waitFor(async () => ((await present(".eventlog")) ? null : 1), {
      timeout: 15000,
      message: "the Close button to close the window",
    });
  });
});
