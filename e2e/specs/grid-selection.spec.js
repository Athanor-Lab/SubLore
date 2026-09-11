/* global describe, it, before, document, window */
/**
 * The three selection gestures the reference's grid answers, pressed with the X server rather than
 * synthesised: a plain click takes the cursor and the selection to one row, Shift takes the run up
 * to the row it lands on, and Ctrl flips one row's membership (interface-spec 7.3).
 *
 * Two details of that table are what these checks are for. **Ctrl+click moves the cursor too**: the
 * spec's own review found the reference sets the active line before it reaches the toggle branch,
 * so only the scrolling is suppressed, and a check that read the membership alone would not tell
 * the two apart. And the selection never empties: Ctrl on the last row left in it is refused.
 *
 * The cursor is read from the list's `aria-activedescendant` and the selection from the rows that
 * carry `cuelist__row--selected`, which are the two states the grid draws from
 * (`src/hooks/useCueSelection.ts`).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, clickWith, focusWindow, pressKey } from "../lib/input.js";
import { repoRoot, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

/** Two thousand cues, of which these checks touch the first five. Read directly: never written. */
const FIXTURE = ["srt", "clean", "large-2000.srt"];

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

/** The centre of one cell of the row at a 1-based list position, in root coordinates. */
async function cellAt(toplevel, position, cell) {
  const centre = await browser.execute(
    (wanted, css) => {
      const row = Array.from(document.querySelectorAll(".cuelist__row")).find(
        (candidate) => candidate.querySelector(".cuelist__pos")?.textContent === wanted,
      );
      const rect = row?.querySelector(css)?.getBoundingClientRect();
      if (rect === undefined) {
        return null;
      }
      const dpr = window.devicePixelRatio;
      return { x: (rect.x + rect.width / 2) * dpr, y: (rect.y + rect.height / 2) * dpr };
    },
    String(position),
    cell,
  );
  if (centre === null) {
    throw new Error(`row ${position} has no ${cell} rendered`);
  }
  // No window manager under Xvfb, so the toplevel origin is also the viewport origin.
  return { x: toplevel.absX + centre.x, y: toplevel.absY + centre.y };
}

/** The number cell selects and never opens an editor, which is why every gesture below lands on it. */
async function clickRow(toplevel, position, modifier = null) {
  const at = await cellAt(toplevel, position, ".cuelist__pos");
  if (modifier === null) {
    clickAt(at.x, at.y);
    return;
  }
  clickWith(modifier, at.x, at.y);
}

/** The cursor's row and the selected rows, both as 1-based list positions. */
function selectionState() {
  return browser.execute(() => {
    const list = document.querySelector(".cuelist");
    if (list === null) {
      return null;
    }
    const at = (id) => {
      const found = /^cuelist-row-(\d+)$/.exec(id ?? "");
      return found === null ? null : Number(found[1]) + 1;
    };
    return {
      cursor: at(list.getAttribute("aria-activedescendant")),
      selected: Array.from(document.querySelectorAll(".cuelist__row--selected"))
        .map((row) => at(row.id))
        .sort((one, other) => one - other),
    };
  });
}

/** Wait for the grid to answer a gesture, and say what it answered with. */
function settlesAt(cursor, selected) {
  return waitFor(
    async () => {
      const state = await selectionState();
      if (state === null) {
        return null;
      }
      const same =
        state.cursor === cursor &&
        state.selected.length === selected.length &&
        state.selected.every((row, at) => row === selected[at]);
      return same ? state : null;
    },
    {
      timeout: 15000,
      message: `the cursor on row ${cursor} and rows ${selected.join(", ")} selected`,
    },
  );
}

describe("the grid's selection gestures", () => {
  let toplevel = null;

  before(async () => {
    const from = path.join(repoRoot, "fixtures", "subtitles", ...FIXTURE);
    if (!existsSync(from)) {
      throw new Error(`E2E prerequisite missing: ${from} does not exist. Restore it with git.`);
    }
    if (typeof process.env.SUBLORE_E2E_DATA_HOME !== "string") {
      throw new Error("SUBLORE_E2E_DATA_HOME is not set; e2e/wdio.conf.js sets it for every run.");
    }
    toplevel = await waitFor(findToplevel, {
      timeout: 30000,
      message: `the ${windowWidth}x${windowHeight} "Sublore" toplevel to appear`,
    });
    focusWindow(toplevel.id);
    await waitFor(() => present(".toolbar__file-open-subtitle"), {
      timeout: 30000,
      message: "the app UI to render",
    });
    const open = await browser.execute(() => {
      const rect = document.querySelector(".toolbar__file-open-subtitle")?.getBoundingClientRect();
      if (rect === undefined) {
        return null;
      }
      const dpr = window.devicePixelRatio;
      return { x: (rect.x + rect.width / 2) * dpr, y: (rect.y + rect.height / 2) * dpr };
    });
    clickAt(toplevel.absX + open.x, toplevel.absY + open.y);
    const chooser = await waitForChooser("Choose a subtitle");
    // The committed fixture is opened read-only; nothing writes it back, so no working copy.
    await answerChooser(chooser, from, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(() => present(".cuelist__row"), {
      timeout: 20000,
      message: "the fixture to open",
    });
  });

  it("takes the cursor and the whole selection to the row a plain click lands on", async () => {
    await clickRow(toplevel, 3);
    await settlesAt(3, [3]);

    // And again somewhere else: the selection is replaced, not added to.
    await clickRow(toplevel, 1);
    await settlesAt(1, [1]);
  });

  it("takes the run up to the row a shift-click lands on", async () => {
    await clickRow(toplevel, 2);
    await settlesAt(2, [2]);

    await clickRow(toplevel, 5, "shift");
    await settlesAt(5, [2, 3, 4, 5]);

    // The anchor is where the plain click was, so shrinking is the same gesture backwards.
    await clickRow(toplevel, 3, "shift");
    await settlesAt(3, [2, 3]);
  });

  it("flips one row with ctrl, and takes the cursor to it", async () => {
    await clickRow(toplevel, 2);
    await clickRow(toplevel, 4, "shift");
    await settlesAt(4, [2, 3, 4]);

    // Out: the row leaves the selection and the cursor still lands on it, which is the half of this
    // gesture the spec's review corrected.
    await clickRow(toplevel, 3, "ctrl");
    await settlesAt(3, [2, 4]);

    // And back in, by the same gesture.
    await clickRow(toplevel, 3, "ctrl");
    await settlesAt(3, [2, 3, 4]);
  });

  it("refuses to take the last row out of the selection", async () => {
    await clickRow(toplevel, 2);
    await settlesAt(2, [2]);

    await clickRow(toplevel, 2, "ctrl");
    await settlesAt(2, [2]);

    // Not a stuck row: with another one in, it comes out.
    await clickRow(toplevel, 4, "ctrl");
    await settlesAt(4, [2, 4]);
    await clickRow(toplevel, 2, "ctrl");
    await settlesAt(2, [4]);
  });

  it("opens the editor on a plain click on the text, and on no modified one", async () => {
    await clickRow(toplevel, 2);
    await settlesAt(2, [2]);

    const third = await cellAt(toplevel, 3, ".cuelist__text");
    clickWith("ctrl", third.x, third.y);
    await settlesAt(3, [2, 3]);
    expect(await present(".cuelist__editor")).toBe(false);

    // A different row, so a shift that did nothing at all could not pass this: ctrl left the anchor
    // on row 3, and the run from there to row 4 is a selection neither gesture before it drew.
    const fourth = await cellAt(toplevel, 4, ".cuelist__text");
    clickWith("shift", fourth.x, fourth.y);
    await settlesAt(4, [3, 4]);
    expect(await present(".cuelist__editor")).toBe(false);

    // The same cell, pressed with nothing held: this is what the two above are told apart from.
    clickAt(fourth.x, fourth.y);
    await waitFor(() => present(".cuelist__editor"), {
      timeout: 15000,
      message: "the inline editor to open on a plain click on the text",
    });
    // Escape and not a blur: a blur commits, and this check has nothing to write.
    pressKey("Escape");
    await waitFor(async () => ((await present(".cuelist__editor")) === false ? true : null), {
      timeout: 15000,
      message: "the editor to close again",
    });
    expect(await present(".statusbar__dirty")).toBe(false);
  });
});
