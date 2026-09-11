/* global describe, it, before, document, window */
/**
 * The menus draw the rules that group their items, which the reference uses in every menu
 * (interface-spec 3). A rule is drawn where a group ends, it carries a separator role for a reader
 * that cannot see it, and the keyboard steps over it the way it steps over a greyed item.
 *
 * File is the menu read in full here: its items are always drawn whatever the state, so its shape
 * is fixed and can be asserted whole. The keyboard walk is proved on the same menu, because a walk
 * that landed on a rule would stall on a row that has no cursor at all.
 */
import { browser, expect } from "@wdio/globals";

import { clickAt, focusWindow, pressKey } from "../lib/input.js";
import { windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

/** The centre of an element in device pixels, or null when it is not in the DOM. */
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

async function openFile(toplevel) {
  await clickElement(toplevel, ".menubar__title--file");
  await waitFor(() => present(".menubar__menu"), {
    timeout: 15000,
    message: "the File menu to open",
  });
}

/** The open dropdown's rows in order: a rule, or a command by its token and greying. */
function rowsOfOpenMenu() {
  return browser.execute(() =>
    Array.from(document.querySelector(".menubar__menu")?.children ?? []).map((row) => {
      if (row.classList.contains("menubar__separator")) {
        return { kind: "separator", role: row.getAttribute("role") };
      }
      // A row that opens a list of its own: its button carries the id and the greying.
      const opener = row.querySelector(".menubar__submenu");
      if (opener !== null) {
        return {
          kind: "item",
          token: opener.id.replace("menuitem-", ""),
          disabled: opener.disabled === true,
        };
      }
      return {
        kind: "item",
        token: row.id.replace("menuitem-", ""),
        disabled: row.disabled === true,
      };
    }),
  );
}

/** The token of the item the cursor is on, or null when the cursor is on nothing. */
function cursorToken() {
  return browser.execute(() => {
    const element = document.querySelector(".menubar__item--cursor, .menubar__submenu--cursor");
    return element === null ? null : element.id.replace("menuitem-", "");
  });
}

describe("the rules that group a menu", () => {
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

  it("draws File as the reference groups it: opening, then saving, then quit", async () => {
    await openFile(toplevel);
    const rows = await rowsOfOpenMenu();
    // The tokens in order, with a rule where the reference rules off a group (interface-spec 3.1
    // separators 6 and 14; the properties and font groups between are not built and fold in).
    expect(rows.map((row) => (row.kind === "separator" ? "---" : row.token))).toEqual([
      "file-new",
      "file-open-subtitle",
      "file-open-encoding",
      "file-open-from-video",
      "file-recent",
      "file-open-source",
      "file-close-source",
      "file-new-translation",
      "---",
      "file-save",
      "file-save-as",
      "file-export",
      "file-discard",
      "---",
      "file-properties",
      "---",
      "app-quit",
    ]);
    // A rule carries the role a screen reader reads, and never the empty id a menuitem walk counts.
    for (const rule of rows.filter((row) => row.kind === "separator")) {
      expect(rule.role).toBe("separator");
    }

    await waitFor(
      async () => {
        if (!(await present(".menubar__menu"))) {
          return 1;
        }
        pressKey("Escape");
        return null;
      },
      { timeout: 15000, message: "the File menu to close" },
    );
  });

  it("walks past a rule the way it walks past a greyed item", async () => {
    await openFile(toplevel);
    const rows = await rowsOfOpenMenu();
    // What the cursor may land on: the items that are not greyed, in the order they are drawn. The
    // rules and the greyed items are the rows the walk owes nothing to.
    const reachable = rows
      .filter((row) => row.kind === "item" && !row.disabled)
      .map((row) => row.token);
    expect(reachable.length).toBeGreaterThan(1);

    // From the mouse-opened menu the cursor is on nothing; each Down lands on the next reachable
    // item and never on a rule, so the sequence it visits is exactly the reachable list.
    for (const token of reachable) {
      pressKey("Down");
      await waitFor(async () => ((await cursorToken()) === token ? 1 : null), {
        timeout: 15000,
        message: `the cursor to reach ${token}, stepping over any rule between`,
      });
    }

    await waitFor(
      async () => {
        if (!(await present(".menubar__menu"))) {
          return 1;
        }
        pressKey("Escape");
        return null;
      },
      { timeout: 15000, message: "the File menu to close" },
    );
  });
});
