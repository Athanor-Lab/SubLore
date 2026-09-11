/* global describe, it, before, document, window */
/**
 * F2: the find band, and plain text search.
 *
 * The band sits in the panel flow rather than over it, which is a decision with a consequence this
 * file asserts: a layer hides the native video surface (decision 1, T8), and searching while the
 * video is up is the point of having it there. So the surface staying visible is not a detail here,
 * it is the reason the band is a band.
 *
 * Nothing below reaches into the search itself. Every check drives the band the way a user does and
 * reads the grid cursor, which is the only thing a find has to move. See docs/find-replace-tasks.md.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { runFromMenu } from "../lib/menu.js";
import { clickAt, focusWindow, pressKey, resizeWindow, typeText } from "../lib/input.js";
import { repoRoot, requireVideoFixture, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { closeAnyOpenProject } from "../lib/rail.js";
import { childWindows, mapState, findToplevel } from "../lib/x11.js";

const OPEN_STATUS = "SRT · 3 cues · LF";
/**
 * Words from the fixture, each in exactly one cue, chosen so the checks read a cursor that moved
 * rather than one that happened to be right. "fog" is only in the third and "Nobody" only in the
 * second, which is also where the case check lives.
 */
const ONLY_IN_THIRD = "fog";
/** Only in the first cue, so it is the word a selection elsewhere must not find. */
const ONLY_IN_FIRST = "harbour";
/** In all three cues: twice, twice and three times, counted off the fixture rather than guessed. */
const IN_EVERY_CUE = "the";
const ONLY_IN_SECOND_CAPITALISED = "Nobody";
/** In no cue at all: the pattern that has to come back with nothing found. */
const IN_NO_CUE = "zzhardlylikely";

/**
 * In the second and third cues, once each, and in no other word of the file. Two matches over two
 * cues is the smallest shape that shows a replace all landing as one undo step rather than two.
 */
const IN_TWO_CUES = "had";
/**
 * Two replacements, and neither may contain the other check's pattern: the first check writes into
 * the third cue and the second then counts matches across the file, so a replacement carrying the
 * next pattern would be counted as a third hit. That is how this pair was first written and it read
 * as a defect in the count.
 */
/**
 * Carries the two sequences `String.replace` reads out of a string replacement. The app replaces
 * literally, through a function replacer, so these must land as typed; a string replacement would
 * expand `$&` into the match. The expectation below uses a function replacer for the same reason.
 */
const REPLACEMENT_ONE = "[$&]";
const REPLACEMENT_ALL = "H$&D";

/** Matches the third cue's word as an expression and nothing at all as literal text. */
const AS_EXPRESSION = "f.g";
/**
 * An expression the engine will not compile, and one it will never finish.
 *
 * The second was measured rather than assumed: `^(.+)+x$` against the first cue's own text was
 * still running when a five second timeout killed it, which is what makes it the right shape for
 * the check that the window survives one.
 */
const WILL_NOT_COMPILE = "[";
const WILL_NEVER_FINISH = "^(.+)+x$";

/**
 * The long fixture, and the arithmetic its shape allows: it repeats eight lines in order, so this
 * one sits on rows 7, 15, 23 and on, and the nth match is a row a check can name.
 */
const LONG_STATUS = "SRT · 2000 cues · LF";
const IN_EVERY_EIGHTH = "generator";
const EIGHTH_FIRST = 7;
const EIGHTH_STRIDE = 8;

/**
 * The fixture for the two skips (interface-spec 9.2), and what is where in it. Four cues: one with
 * nothing in it, a comment carrying the word, a line where an italic block splits the word in half,
 * and a line whose block sits outside it.
 */
/**
 * Four and not five: the status line counts the cues a player would draw, and an ASS comment is
 * not one of them (`summary.cue_count` is the document's `displayed_cue_count`). The grid draws all
 * five, which is why the rows below are numbered as they are.
 */
const SKIPS_STATUS = "ASS · 4 cues · LF";
const SKIPPED_WORD = "lantern";
const IN_THE_COMMENT = 2;
const SPLIT_BY_A_TAG = 3;
const TAG_OUTSIDE_IT = 4;
/** The word with a block immediately after it, which a replacement must leave where it is (N145). */
const TAG_AFTER_IT = 5;
const SKIPS_REPLACEMENT = "beacon";

function dataHome() {
  const home = process.env.SUBLORE_E2E_DATA_HOME;
  if (typeof home !== "string" || home === "") {
    throw new Error("SUBLORE_E2E_DATA_HOME is not set; e2e/wdio.conf.js sets it for every run.");
  }
  return home;
}

/** Writes go to the harness temp dir. The committed fixture is copied, never opened for editing. */
function workingCopy() {
  const source = path.join(repoRoot, "fixtures", "subtitles", "srt", "clean", "basic-lf.srt");
  if (!existsSync(source)) {
    throw new Error(
      `E2E prerequisite missing: ${source} does not exist. It is committed; restore it with ` +
        "`git checkout fixtures/subtitles`.",
    );
  }
  const directory = path.join(dataHome(), "find");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const copy = path.join(directory, "basic-lf.srt");
  copyFileSync(source, copy);
  return copy;
}

/** The 2000 cue fixture, copied the same way: the grid windows it, which is the point of using it. */
function longWorkingCopy() {
  const source = path.join(repoRoot, "fixtures", "subtitles", "srt", "clean", "large-2000.srt");
  if (!existsSync(source)) {
    throw new Error(
      `E2E prerequisite missing: ${source} does not exist. It is committed; restore it with ` +
        "`git checkout fixtures/subtitles`.",
    );
  }
  const copy = path.join(dataHome(), "find", "large-2000.srt");
  copyFileSync(source, copy);
  return copy;
}

/** The four-cue ASS fixture the two skips are read on, copied the same way as the others. */
function skipsWorkingCopy() {
  const source = path.join(repoRoot, "fixtures", "subtitles", "ass", "clean", "skips.ass");
  if (!existsSync(source)) {
    throw new Error(
      `E2E prerequisite missing: ${source} does not exist. It is committed; restore it with ` +
        "`git checkout fixtures/subtitles`.",
    );
  }
  const copy = path.join(dataHome(), "find", "skips.ass");
  copyFileSync(source, copy);
  return copy;
}

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
    throw new Error(`${selector} is missing from the DOM`);
  }
  // No window manager under Xvfb, so the toplevel origin is also the viewport origin.
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
}

function textOf(selector) {
  return browser.execute((css) => document.querySelector(css)?.textContent ?? null, selector);
}

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

/** One row's text as the grid draws it, by its drawn number. Null when that row is not rendered. */
function rowText(position) {
  return browser.execute((wanted) => {
    const row = Array.from(document.querySelectorAll(".cuelist__row")).find(
      (candidate) => candidate.querySelector(".cuelist__pos")?.textContent === wanted,
    );
    return row?.querySelector(".cuelist__text")?.textContent ?? null;
  }, String(position));
}

/**
 * Put a checkbox in the state this check needs, rather than toggling whatever it inherited.
 *
 * A toggle reads the box's current state as an assumption, so one failed check upstream flips the
 * meaning of every click after it: a mutation once turned two checks red, and the second was only
 * the first one having failed before it could put the box back. Setting is what makes each check
 * independent of the one before it.
 */
async function setBox(toplevel, selector, wanted) {
  const now = await browser.execute(
    (css) => document.querySelector(css)?.checked ?? null,
    selector,
  );
  if (now === null) {
    throw new Error(`${selector} is missing from the DOM`);
  }
  if (now === wanted) {
    return;
  }
  await clickElement(toplevel, selector);
  await waitFor(
    () =>
      browser.execute(
        (css, want) => (document.querySelector(css)?.checked === want ? true : null),
        selector,
        wanted,
      ),
    { timeout: 10000, message: `${selector} to become ${wanted}` },
  );
}

/** How many rows the grid draws as selected, which a plain cursor move collapses to one. */
function selectedRows() {
  return browser.execute(() => document.querySelectorAll(".cuelist__row--selected").length);
}

/** Put the cursor on a row by clicking its number cell, which never opens an editor. */
async function cursorTo(toplevel, position) {
  const centre = await browser.execute((wanted) => {
    const row = Array.from(document.querySelectorAll(".cuelist__row")).find(
      (candidate) => candidate.querySelector(".cuelist__pos")?.textContent === wanted,
    );
    const cell = row?.querySelector(".cuelist__pos");
    if (!cell) {
      return null;
    }
    const rect = cell.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    return { x: (rect.x + rect.width / 2) * dpr, y: (rect.y + rect.height / 2) * dpr };
  }, String(position));
  if (centre === null) {
    throw new Error(`row ${position} is missing from the DOM`);
  }
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
  await waitForCursor(position);
}

/**
 * Open the grid's own editor on a row, by clicking its text cell, and wait until it holds the
 * keyboard. The wait is the point: a key pressed before the caret arrives lands somewhere else and
 * would make the check below pass for the wrong reason (F5).
 */
async function editRow(toplevel, position) {
  const centre = await browser.execute((wanted) => {
    const row = Array.from(document.querySelectorAll(".cuelist__row")).find(
      (candidate) => candidate.querySelector(".cuelist__pos")?.textContent === wanted,
    );
    const cell = row?.querySelector(".cuelist__text");
    if (!cell) {
      return null;
    }
    const rect = cell.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    return { x: (rect.x + rect.width / 2) * dpr, y: (rect.y + rect.height / 2) * dpr };
  }, String(position));
  if (centre === null) {
    throw new Error(`row ${position} is not drawn with a text cell to click`);
  }
  clickAt(toplevel.absX + centre.x, toplevel.absY + centre.y);
  await waitFor(
    () =>
      browser.execute(() => document.activeElement?.classList.contains("cuelist__editor") === true),
    { timeout: 15000, message: `the grid's editor on row ${position} to take the keyboard` },
  );
}

/** The row the cursor is on, one-based the way the grid numbers them, or null when there is none. */
function cursorRow() {
  return browser.execute(() => {
    const row = document.querySelector(".cuelist__row--active");
    const drawn = row?.querySelector(".cuelist__pos")?.textContent ?? null;
    return drawn === null ? null : Number(drawn);
  });
}

async function waitForCursor(row) {
  const reached = await waitFor(async () => ((await cursorRow()) === row ? row : null), {
    timeout: 15000,
    message: `the cursor to reach row ${row}`,
  });
  expect(reached).toBe(row);
}

/**
 * Replace whatever a text field holds. The ctrl+a lives here rather than in `e2e/lib/input.js`,
 * which is shared with the M0 and M1 specs and stays frozen, as editor.spec.js does the same.
 */
async function typeInto(toplevel, selector, text) {
  await clickElement(toplevel, selector);
  await waitFor(
    () => browser.execute((css) => document.activeElement?.matches(css) === true, selector),
    { timeout: 10000, message: `${selector} to take keyboard focus` },
  );
  pressKey("ctrl+a");
  typeText(text);
  await waitFor(
    () =>
      browser.execute((css, want) => document.querySelector(css)?.value === want, selector, text),
    { timeout: 15000, message: `${selector} to hold exactly ${text}` },
  );
}

/**
 * Open the four-cue skips fixture and leave the band open on it.
 *
 * Opened again by every check that uses it rather than once: a replace all rewrites the document,
 * and a check that read a row after another had rewritten it would be reading the wrong file.
 */
async function openSkips(toplevel, file) {
  await clickElement(toplevel, ".toolbar__file-open-subtitle");
  const chooser = await waitForChooser("Choose a subtitle");
  await answerChooser(chooser, file, "subtitle");
  focusWindow(toplevel.id);
  let said = null;
  await waitFor(
    async () => {
      said = await textOf(".statusbar__document");
      return said?.includes(SKIPS_STATUS) === true ? true : null;
    },
    {
      timeout: 20000,
      // The line it did say is in the message: a status that reads differently is a different
      // document or a different summary, and the two are not told apart by a bare timeout.
      message: () => `the status bar to report the four-cue fixture, and it says ${said}`,
    },
  );
  if (!(await present(".findbar"))) {
    pressKey("ctrl+f");
    await waitFor(() => present(".findbar"), { timeout: 15000, message: "the find band to open" });
  }
}

/** The terms the open list offers, top first, or null when no list is open. */
function offeredTerms() {
  return browser.execute(() => {
    const list = document.querySelector(".findbar__recent");
    return list === null
      ? null
      : {
          label: list.getAttribute("aria-label"),
          terms: Array.from(list.querySelectorAll(".findbar__term")).map((one) => one.textContent),
          on: Array.from(list.querySelectorAll(".findbar__term")).findIndex((one) =>
            one.classList.contains("findbar__term--on"),
          ),
        };
  });
}

/** Open a field's own list of remembered terms with its opener, and wait for it. */
async function openRecent(toplevel, which) {
  await clickElement(toplevel, `.findbar__${which}-open`);
  return waitFor(async () => (await offeredTerms()) ?? null, {
    timeout: 15000,
    message: `the ${which} field's remembered terms to open`,
  });
}

/** Put a fresh pattern in the field, so no check inherits the one before it. */
function search(toplevel, needle) {
  return typeInto(toplevel, ".findbar__needle", needle);
}

/**
 * Whether the native video surface is still on screen.
 *
 * Read off X, not off the DOM: the surface is an X11 child of the toplevel and the shell hides it
 * by unmapping it over IPC, so no class in the page says whether it is there. This is the check
 * that separates a band in the flow from a layer over it (decision 1, T8).
 */
function surfaceMapped(toplevel) {
  const large = childWindows(toplevel.id).filter((child) => child.width > 50 && child.height > 50);
  if (large.length !== 1) {
    throw new Error(`expected one native surface, found ${large.length}`);
  }
  return mapState(large[0].id);
}

describe("the find band", () => {
  let toplevel = null;
  let copy = null;
  let longCopy = null;
  let skipsCopy = null;

  before(async () => {
    copy = workingCopy();
    longCopy = longWorkingCopy();
    skipsCopy = skipsWorkingCopy();
    toplevel = await waitFor(findToplevel, {
      timeout: 30000,
      message: `the ${windowWidth}x${windowHeight} "Sublore" toplevel to appear`,
    });
    focusWindow(toplevel.id);
    await waitFor(
      () => browser.execute(() => document.querySelector(".toolbar__file-open-subtitle") !== null),
      { timeout: 30000, message: "the app UI to render" },
    );
    // One data home for the whole run, so the emptiest state is one this file makes. See N19.
    await closeAnyOpenProject(toplevel);
  });

  it("has nothing to search with no document open, and the band stays shut", async () => {
    expect(await present(".findbar")).toBe(false);
    pressKey("ctrl+f");
    await browser.pause(500);
    // The command is drawn and greyed, and a greyed command does not run whichever route asks it.
    expect(await present(".findbar")).toBe(false);
  });

  it("opens on ctrl+f once a document is open, and the video surface stays on screen", async () => {
    await clickElement(toplevel, ".toolbar__file-open-subtitle");
    const subtitle = await waitForChooser("Choose a subtitle");
    await answerChooser(subtitle, copy, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(
      async () => (await textOf(".statusbar__document"))?.includes(OPEN_STATUS) === true,
      { timeout: 20000, message: "the status bar to report the open subtitle" },
    );

    await runFromMenu((css) => clickElement(toplevel, css), "video", "video-open");
    const video = await waitForChooser("Choose a video");
    await answerChooser(video, requireVideoFixture(), "video");
    focusWindow(toplevel.id);
    await waitFor(
      () =>
        browser.execute(
          () =>
            document.querySelector(".stage__empty") === null &&
            document.querySelector(".controls__button")?.disabled === false,
        ),
      { timeout: 40000, message: "the video to be ready to play" },
    );
    expect(surfaceMapped(toplevel)).toBe("IsViewable");

    pressKey("ctrl+f");
    await waitFor(() => present(".findbar"), {
      timeout: 15000,
      message: "the find band to open",
    });
    // The band is in the flow, not a layer over it, and this is the difference between the two: a
    // layer unmaps the surface whether or not it overlaps the picture.
    await browser.pause(500);
    expect(surfaceMapped(toplevel)).toBe("IsViewable");
  });

  it("puts the cursor on the cue the pattern is in", async () => {
    await search(toplevel, ONLY_IN_THIRD);
    pressKey("Return");
    await waitForCursor(3);
  });

  it("wraps round the file rather than stopping at the last match", async () => {
    // Typing a new pattern restarts the search, so a wrap can only be shown by pressing again on
    // the same one. This word is in the third cue and nowhere else, so a second press that lands
    // back on it with the band still not saying "no match" is the file having been walked round.
    await search(toplevel, ONLY_IN_THIRD);
    pressKey("Return");
    await waitForCursor(3);

    pressKey("Return");
    await browser.pause(500);
    expect(await cursorRow()).toBe(3);
    expect(await present(".findbar__missing")).toBe(false);
  });

  it("ignores case until it is asked not to", async () => {
    await search(toplevel, ONLY_IN_SECOND_CAPITALISED.toLowerCase());
    pressKey("Return");
    await waitForCursor(2);

    // With Match case on, the lowercase pattern is in no cue, so the cursor must not move.
    await setBox(toplevel, ".findbar__case", true);
    await search(toplevel, ONLY_IN_SECOND_CAPITALISED.toLowerCase());
    await clickElement(toplevel, ".findbar__next");
    await waitFor(() => present(".findbar__missing"), {
      timeout: 15000,
      message: "the band to report no match",
    });
    expect(await cursorRow()).toBe(2);
    await setBox(toplevel, ".findbar__case", false);
  });

  it("says so when the pattern is in no cue, and leaves the cursor where it was", async () => {
    await search(toplevel, IN_NO_CUE);
    pressKey("Return");
    await waitFor(() => present(".findbar__missing"), {
      timeout: 15000,
      message: "the band to report no match",
    });
    expect(await cursorRow()).toBe(2);
  });

  it("closes on Escape and leaves the cursor where the search left it", async () => {
    pressKey("Escape");
    await waitFor(async () => ((await present(".findbar")) === false ? true : null), {
      timeout: 15000,
      message: "the find band to close",
    });
    expect(await cursorRow()).toBe(2);
  });

  it("keeps the cursor on screen while it walks down a long file", async () => {
    // A windowed grid does not render a row it has scrolled past, so a cursor that reads back at
    // all is a cursor the grid scrolled to. The fixture repeats eight lines, so the nth match of
    // this one sits at a row arithmetic can name and the check is not just "something moved".
    await clickElement(toplevel, ".toolbar__file-open-subtitle");
    const subtitle = await waitForChooser("Choose a subtitle");
    await answerChooser(subtitle, longCopy, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(
      async () => (await textOf(".statusbar__document"))?.includes(LONG_STATUS) === true,
      { timeout: 20000, message: "the status bar to report the long subtitle" },
    );

    pressKey("ctrl+f");
    await waitFor(() => present(".findbar"), { timeout: 15000, message: "the find band to open" });
    await search(toplevel, IN_EVERY_EIGHTH);
    for (let nth = 1; nth <= 8; nth += 1) {
      pressKey("Return");
      await waitForCursor(EIGHTH_STRIDE * (nth - 1) + EIGHTH_FIRST);
    }
  });

  it("opens the same band in its other mode on ctrl+h, and ctrl+f puts it back", async () => {
    // Back to the short file, opened here rather than inherited: the checks below count matches in
    // it, and the walk above left a different document on screen. See BACKLOG.md N19.
    await clickElement(toplevel, ".toolbar__file-open-subtitle");
    const subtitle = await waitForChooser("Choose a subtitle");
    await answerChooser(subtitle, copy, "subtitle");
    focusWindow(toplevel.id);
    await waitFor(
      async () => (await textOf(".statusbar__document"))?.includes(OPEN_STATUS) === true,
      { timeout: 20000, message: "the status bar to report the short subtitle again" },
    );

    pressKey("ctrl+h");
    await waitFor(() => present(".findbar__replacement"), {
      timeout: 15000,
      message: "the band to grow its replacement field",
    });
    expect(await present(".findbar__replace-all")).toBe(true);

    // One band, two modes, never both at once (interface-spec 9.2).
    pressKey("ctrl+f");
    await waitFor(async () => ((await present(".findbar__replacement")) === false ? true : null), {
      timeout: 15000,
      message: "the replacement field to go away again",
    });
    expect(await present(".findbar")).toBe(true);
    pressKey("ctrl+h");
    await waitFor(() => present(".findbar__replacement"), {
      timeout: 15000,
      message: "the band to come back in replace mode",
    });
  });

  it("finds on the first press of Replace and rewrites on the second", async () => {
    const before = await rowText(3);
    await search(toplevel, ONLY_IN_THIRD);
    await typeInto(toplevel, ".findbar__replacement", REPLACEMENT_ONE);

    // Nothing has been found yet, so this press may only find: a press must never rewrite a cue
    // the user has not been shown (interface-spec 9.2).
    await clickElement(toplevel, ".findbar__replace");
    await waitForCursor(3);
    expect(await rowText(3)).toBe(before);

    await clickElement(toplevel, ".findbar__replace");
    await waitFor(async () => ((await rowText(3)) === before ? null : true), {
      timeout: 20000,
      message: "the second press to rewrite the third row",
    });
    expect(await rowText(3)).toBe(before.replace(ONLY_IN_THIRD, () => REPLACEMENT_ONE));
  });

  it("rewrites every match in one step, and one undo takes them all back", async () => {
    const second = await rowText(2);
    const third = await rowText(3);
    await search(toplevel, IN_TWO_CUES);
    await typeInto(toplevel, ".findbar__replacement", REPLACEMENT_ALL);

    await clickElement(toplevel, ".findbar__replace-all");
    await waitFor(() => present(".findbar__replaced"), {
      timeout: 20000,
      message: "the band to report what it replaced",
    });
    // Two matches over two cues, counted rather than guessed at.
    expect(await textOf(".findbar__replaced")).toBe("2 replaced");
    expect(await rowText(2)).toBe(second.replace(IN_TWO_CUES, () => REPLACEMENT_ALL));
    expect(await rowText(3)).toBe(third.replace(IN_TWO_CUES, () => REPLACEMENT_ALL));

    // One step for the whole replace, which is the reason the many-cue edit exists (F1).
    await runFromMenu((css) => clickElement(toplevel, css), "edit", "edit-undo");
    await waitFor(async () => ((await rowText(2)) === second ? true : null), {
      timeout: 20000,
      message: "one undo to put the second row back",
    });
    expect(await rowText(3)).toBe(third);

    // And the single replace under it is its own step, so a second undo leaves the file as opened.
    await runFromMenu((css) => clickElement(toplevel, css), "edit", "edit-undo");
    await waitFor(async () => ((await present(".statusbar__dirty")) === false ? true : null), {
      timeout: 20000,
      message: "the document to come back to the bytes it was opened with",
    });
  });

  it("reads the pattern as an expression only when it is asked to", async () => {
    // Literal, so the dot is a dot and this is in no cue.
    await search(toplevel, AS_EXPRESSION);
    await clickElement(toplevel, ".findbar__next");
    await waitFor(() => present(".findbar__missing"), {
      timeout: 20000,
      message: "the band to report no match for the literal pattern",
    });

    await setBox(toplevel, ".findbar__regex", true);
    await clickElement(toplevel, ".findbar__next");
    await waitForCursor(3);
    expect(await present(".findbar__missing")).toBe(false);
  });

  it("writes what a group captured", async () => {
    const before = await rowText(3);
    await search(toplevel, "(f)(og)");
    await typeInto(toplevel, ".findbar__replacement", "[$2$1]");

    // Twice: the first press finds, the second rewrites (interface-spec 9.2).
    await clickElement(toplevel, ".findbar__replace");
    await waitForCursor(3);
    await clickElement(toplevel, ".findbar__replace");
    await waitFor(async () => ((await rowText(3)) === before ? null : true), {
      timeout: 20000,
      message: "the second press to rewrite the third row",
    });
    expect(await rowText(3)).toBe(before.replace("fog", () => "[ogf]"));

    await runFromMenu((css) => clickElement(toplevel, css), "edit", "edit-undo");
    await waitFor(async () => ((await present(".statusbar__dirty")) === false ? true : null), {
      timeout: 20000,
      message: "one undo to leave the file as it was opened",
    });
  });

  it("says so for an expression it cannot read, and changes nothing", async () => {
    await search(toplevel, WILL_NOT_COMPILE);
    await clickElement(toplevel, ".findbar__next");
    await waitFor(() => present(".findbar__refused"), {
      timeout: 20000,
      message: "the band to refuse the pattern",
    });
    expect(await present(".statusbar__dirty")).toBe(false);
  });

  it("refuses an expression that never finishes, keeps answering, and searches again after", async () => {
    await search(toplevel, WILL_NEVER_FINISH);
    await clickElement(toplevel, ".findbar__next");
    await waitFor(() => present(".findbar__refused"), {
      timeout: 20000,
      message: "the band to give up on the pattern",
    });
    expect(await present(".statusbar__dirty")).toBe(false);

    // The whole point of running it elsewhere: this window is still taking orders. A menu that
    // opens is something a frozen page could not do.
    await clickElement(toplevel, ".menubar__title--timing");
    await waitFor(() => present(".menubar__menu"), {
      timeout: 15000,
      message: "the Timing menu to open after the search was given up on",
    });
    pressKey("Escape");
    await waitFor(async () => ((await present(".menubar__menu")) === false ? true : null), {
      timeout: 15000,
      message: "the menu to close",
    });

    // And the search that was killed left a working one behind it.
    await search(toplevel, ONLY_IN_THIRD);
    await clickElement(toplevel, ".findbar__next");
    await waitForCursor(3);
    expect(await present(".findbar__refused")).toBe(false);
  });

  it("stays inside the selection, and one selected cue restricts too", async () => {
    // Regex was left on by the checks above, and these read plain words: say so rather than
    // inherit it. Then the cursor alone is the selection, which is the case the reference gets
    // wrong by searching the whole file anyway.
    await setBox(toplevel, ".findbar__regex", false);
    await cursorTo(toplevel, 3);
    expect(await selectedRows()).toBe(1);

    await setBox(toplevel, ".findbar__scope", true);
    await search(toplevel, ONLY_IN_FIRST);
    await clickElement(toplevel, ".findbar__next");
    await waitFor(() => present(".findbar__missing"), {
      timeout: 20000,
      message: "the band to find nothing outside the one selected cue",
    });
    expect(await cursorRow()).toBe(3);

    // The same word, the same press, the whole file: it is there and always was.
    await setBox(toplevel, ".findbar__scope", false);
    await clickElement(toplevel, ".findbar__next");
    await waitForCursor(1);
  });

  it("keeps the selection while it walks the matches inside it", async () => {
    await cursorTo(toplevel, 2);
    pressKey("shift+Down");
    await waitFor(async () => ((await selectedRows()) === 2 ? true : null), {
      timeout: 15000,
      message: "shift and the arrow to take the selection over two rows",
    });

    await setBox(toplevel, ".findbar__scope", true);
    await search(toplevel, IN_TWO_CUES);
    await clickElement(toplevel, ".findbar__next");
    await waitForCursor(2);
    await clickElement(toplevel, ".findbar__next");
    await waitForCursor(3);
    // Round the selection rather than on into the rest of the file.
    await clickElement(toplevel, ".findbar__next");
    await waitForCursor(2);

    // A plain cursor move would have collapsed this to one on the very first match.
    expect(await selectedRows()).toBe(2);
    await setBox(toplevel, ".findbar__scope", false);
  });

  it("replaces only inside the selection, and counts only what it rewrote", async () => {
    await cursorTo(toplevel, 2);
    expect(await selectedRows()).toBe(1);
    const second = await rowText(2);
    const third = await rowText(3);

    await setBox(toplevel, ".findbar__scope", true);
    await search(toplevel, IN_EVERY_CUE);
    await typeInto(toplevel, ".findbar__replacement", "THE");
    await clickElement(toplevel, ".findbar__replace-all");
    await waitFor(() => present(".findbar__replaced"), {
      timeout: 20000,
      message: "the band to report what it replaced",
    });

    // Two in the selected cue. Seven in the file, which is the number a leak would report.
    expect(await textOf(".findbar__replaced")).toBe("2 replaced");
    expect(await rowText(3)).toBe(third);
    expect(await rowText(2)).not.toBe(second);

    await setBox(toplevel, ".findbar__scope", false);
    await runFromMenu((css) => clickElement(toplevel, css), "edit", "edit-undo");
    await waitFor(async () => ((await present(".statusbar__dirty")) === false ? true : null), {
      timeout: 20000,
      message: "one undo to leave the file as it was opened",
    });
  });

  it("draws F3 beside Find next, and steps the search on that key", async () => {
    await clickElement(toplevel, ".menubar__title--edit");
    await waitFor(() => present(".menubar__menu"), {
      timeout: 15000,
      message: "the Edit menu to open",
    });
    // The key that is drawn is the key that fires. A new match kind in the parser is exactly the
    // thing that can draw a shortcut nothing answers on (F5, K1).
    expect(await textOf(".menubar__item--edit-find-next .menubar__accelerator")).toBe("F3");
    pressKey("Escape");
    await waitFor(async () => ((await present(".menubar__menu")) === false ? true : null), {
      timeout: 15000,
      message: "the Edit menu to close",
    });

    // A word in the third cue only, with the cursor parked on the first, so the key has somewhere
    // to move it and a key that does nothing cannot read as a pass.
    await search(toplevel, ONLY_IN_THIRD);
    await cursorTo(toplevel, 1);

    pressKey("F3");
    await waitForCursor(3);
  });

  it("steps the search from inside the grid's own cue editor", async () => {
    await search(toplevel, ONLY_IN_THIRD);
    await editRow(toplevel, 1);
    // The caret is in the document's own editor and the cursor is on the row it is open on, so a
    // press that reaches the shell is a press that moves the cursor off it.
    expect(await cursorRow()).toBe(1);

    pressKey("F3");
    await waitForCursor(3);

    // Escape leaves the editor without committing the row it was opened on.
    pressKey("Escape");
    await waitFor(async () => ((await present(".cuelist__editor")) === false ? true : null), {
      timeout: 15000,
      message: "the grid's editor to close",
    });
  });

  it("steps the search from inside the band's own query field", async () => {
    // Where a person actually presses it: the term has just been typed and the caret is still in
    // the field. A function key is the one bare key a text field has no use for (F5).
    await search(toplevel, ONLY_IN_FIRST);
    expect(await cursorRow()).toBe(3);

    pressKey("F3");
    await waitForCursor(1);
  });

  it("draws its controls in the order the reference draws them", async () => {
    // The order inside a panel is part of the replica, and this band had the expression before the
    // case and the scope in the middle of the two skips' place (interface-spec 9.2).
    pressKey("ctrl+h");
    await waitFor(
      () => browser.execute(() => document.querySelector(".findbar__replacement") !== null),
      { timeout: 15000, message: "the band to open in its replacing mode" },
    );

    const drawn = await browser.execute(() =>
      Array.from(document.querySelectorAll(".findbar input, .findbar button")).map((control) =>
        Array.from(control.classList).find((name) => name.startsWith("findbar__")),
      ),
    );
    expect(drawn).toEqual([
      "findbar__needle",
      "findbar__needle-open",
      "findbar__replacement",
      "findbar__replacement-open",
      "findbar__case",
      "findbar__regex",
      "findbar__skip-comments",
      "findbar__skip-tags",
      "findbar__scope",
      "findbar__next",
      "findbar__replace",
      "findbar__replace-all",
      "findbar__close",
    ]);
  });

  it("looks inside a comment cue until it is asked not to", async () => {
    await openSkips(toplevel, skipsCopy);
    await setBox(toplevel, ".findbar__skip-tags", false);
    await setBox(toplevel, ".findbar__skip-comments", false);
    // Typed last, and not only to put the pattern in: a changed query is a new search, so the walk
    // below starts at the top of the file, and the caret ends up where Return means find next.
    await search(toplevel, SKIPPED_WORD);

    // Three of the five cues carry the word where a plain search can see it, and the split one is
    // not among them: the comment, then the two whose blocks sit outside the word.
    pressKey("Return");
    await waitForCursor(IN_THE_COMMENT);
    pressKey("Return");
    await waitForCursor(TAG_OUTSIDE_IT);
    pressKey("Return");
    await waitForCursor(TAG_AFTER_IT);

    // Asked to skip them, the same walk starts past the comment and never lands on it again.
    await setBox(toplevel, ".findbar__skip-comments", true);
    await search(toplevel, SKIPPED_WORD);
    pressKey("Return");
    await waitForCursor(TAG_OUTSIDE_IT);
    pressKey("Return");
    await waitForCursor(TAG_AFTER_IT);
    pressKey("Return");
    // Wrapped, and onto the first line of the walk rather than onto the comment above it.
    await waitForCursor(TAG_OUTSIDE_IT);
  });

  it("finds a word a tag splits only when it is asked to skip the tags", async () => {
    await openSkips(toplevel, skipsCopy);
    await setBox(toplevel, ".findbar__skip-comments", true);
    await setBox(toplevel, ".findbar__skip-tags", false);
    await search(toplevel, SKIPPED_WORD);

    // With the tags in the way the split line is not a match at all: the walk is the other two.
    pressKey("Return");
    await waitForCursor(TAG_OUTSIDE_IT);
    pressKey("Return");
    await waitForCursor(TAG_AFTER_IT);

    // With them skipped the split line is the first match there is, and it comes before the others.
    await setBox(toplevel, ".findbar__skip-tags", true);
    await search(toplevel, SKIPPED_WORD);
    pressKey("Return");
    await waitForCursor(SPLIT_BY_A_TAG);
    pressKey("Return");
    await waitForCursor(TAG_OUTSIDE_IT);
  });

  it("remembers what it searched with, most recent first and each term once", async () => {
    await openSkips(toplevel, skipsCopy);
    // Three searches, the first one twice: a term searched again rises rather than appearing twice.
    for (const term of ["alpha", "beta", "alpha"]) {
      await search(toplevel, term);
      pressKey("Return");
      await browser.pause(200);
    }

    // The top of the list, not the whole of it: the band remembers across the checks in this file
    // and the ones before this have searched for things of their own.
    const offered = await openRecent(toplevel, "needle");
    expect(offered.terms.slice(0, 2)).toEqual(["alpha", "beta"]);
    expect(offered.terms.filter((term) => term === "alpha").length).toBe(1);

    // The list closes on Escape and the band stays open, which is the gesture Escape has here.
    pressKey("Escape");
    await waitFor(async () => ((await offeredTerms()) === null ? true : null), {
      timeout: 15000,
      message: "the list to close on Escape",
    });
    expect(await present(".findbar")).toBe(true);
  });

  it("offers no more than sixteen, and drops the oldest to stay there", async () => {
    await openSkips(toplevel, skipsCopy);
    // Seventeen, so the seventeenth is what pushes the first one out. The words are nonsense on
    // purpose: what is read is the list, not what any of them found.
    const terms = Array.from({ length: 17 }, (_, at) => `term${at}`);
    for (const term of terms) {
      await search(toplevel, term);
      pressKey("Return");
      await browser.pause(120);
    }

    const offered = await openRecent(toplevel, "needle");
    expect(offered.terms.length).toBe(16);
    expect(offered.terms[0]).toBe("term16");
    expect(offered.terms).not.toContain("term0");
    pressKey("Escape");
    await waitFor(async () => ((await offeredTerms()) === null ? true : null), {
      timeout: 15000,
      message: "the list to close again",
    });
  });

  it("walks the list with the arrows and puts the one it lands on in the field", async () => {
    await openSkips(toplevel, skipsCopy);
    for (const term of ["first", "second", "third"]) {
      await search(toplevel, term);
      pressKey("Return");
      await browser.pause(200);
    }

    // The arrow opens it from the field, so the hand never leaves the keyboard.
    await clickElement(toplevel, ".findbar__needle");
    pressKey("Down");
    const opened = await waitFor(async () => (await offeredTerms()) ?? null, {
      timeout: 15000,
      message: "the down arrow to open the remembered terms",
    });
    expect(opened.terms.slice(0, 3)).toEqual(["third", "second", "first"]);

    pressKey("Down");
    await waitFor(async () => ((await offeredTerms())?.on === 1 ? true : null), {
      timeout: 15000,
      message: "the arrow to walk onto the second term",
    });
    pressKey("Return");
    await waitFor(
      () => browser.execute(() => document.querySelector(".findbar__needle")?.value === "second"),
      { timeout: 15000, message: "the picked term to land in the field" },
    );
    expect(await offeredTerms()).toBe(null);
  });

  it("keeps the replacement field's own list apart from the search field's", async () => {
    await openSkips(toplevel, skipsCopy);
    pressKey("ctrl+h");
    await waitFor(
      () => browser.execute(() => document.querySelector(".findbar__replacement") !== null),
      { timeout: 15000, message: "the band to open in its replacing mode" },
    );
    await search(toplevel, SKIPPED_WORD);
    await typeInto(toplevel, ".findbar__replacement", SKIPS_REPLACEMENT);
    await clickElement(toplevel, ".findbar__replace-all");
    await waitFor(async () => ((await textOf(".findbar__replaced")) !== null ? true : null), {
      timeout: 15000,
      message: "the replace all to report what it did",
    });

    const written = await openRecent(toplevel, "replacement");
    expect(written.terms[0]).toBe(SKIPS_REPLACEMENT);
    pressKey("Escape");
    await waitFor(async () => ((await offeredTerms()) === null ? true : null), {
      timeout: 15000,
      message: "the replacement's list to close",
    });

    // The search field's own list has the word that was searched for and not the one written.
    const searched = await openRecent(toplevel, "needle");
    expect(searched.terms[0]).toBe(SKIPPED_WORD);
    expect(searched.terms).not.toContain(SKIPS_REPLACEMENT);
    pressKey("Escape");
    await waitFor(async () => ((await offeredTerms()) === null ? true : null), {
      timeout: 15000,
      message: "the search field's list to close",
    });

    // The document goes back to what it was: this check rewrote it, and the next one opens the
    // same file, which a document with unsaved work in it refuses.
    pressKey("ctrl+z");
    await waitFor(async () => ((await present(".statusbar__dirty")) === false ? true : null), {
      timeout: 20000,
      message: "the replace all to be undone",
    });
  });

  it("closes the list when the window moves the field under it", async () => {
    await openSkips(toplevel, skipsCopy);
    await search(toplevel, SKIPPED_WORD);
    pressKey("Return");
    await browser.pause(200);
    const opened = await openRecent(toplevel, "needle");
    expect(opened.terms.length).toBeGreaterThan(0);

    // The list is drawn at coordinates taken when it opened, outside the band's own flow, so a
    // window that changes shape under it would leave it where the field used to be.
    const narrower = windowWidth - 80;
    try {
      resizeWindow(toplevel.id, narrower, windowHeight, 15000);
      await waitFor(
        async () => ((await browser.execute(() => window.innerWidth)) === narrower ? 1 : null),
        { timeout: 15000, message: `the page to be laid out ${narrower} CSS pixels wide` },
      );
      expect(await offeredTerms()).toBe(null);
    } finally {
      resizeWindow(toplevel.id, windowWidth, windowHeight, 15000);
      await waitFor(
        async () => ((await browser.execute(() => window.innerWidth)) === windowWidth ? 1 : null),
        { timeout: 15000, message: "the window to come back to the width the run opened at" },
      );
    }
  });

  it("rewrites the real text under a skipped tag, and leaves a tag outside the match alone", async () => {
    await openSkips(toplevel, skipsCopy);
    const inComment = await rowText(IN_THE_COMMENT);

    pressKey("ctrl+h");
    await waitFor(
      () => browser.execute(() => document.querySelector(".findbar__replacement") !== null),
      { timeout: 15000, message: "the band to open in its replacing mode" },
    );
    await search(toplevel, SKIPPED_WORD);
    await setBox(toplevel, ".findbar__skip-comments", true);
    await setBox(toplevel, ".findbar__skip-tags", true);
    await typeInto(toplevel, ".findbar__replacement", SKIPS_REPLACEMENT);

    await clickElement(toplevel, ".findbar__replace-all");
    await waitFor(
      async () => ((await textOf(".findbar__replaced")) === "3 replaced" ? true : null),
      {
        timeout: 15000,
        message: "the band to report the three it rewrote",
      },
    );

    // The block that stood inside the match went with the match, which is what mapping the offsets
    // back into the real text means. The one before it is untouched.
    expect(await rowText(SPLIT_BY_A_TAG)).toBe(`The ${SKIPS_REPLACEMENT} was empty.`);
    expect(await rowText(TAG_OUTSIDE_IT)).toBe(`{\\b1}The ${SKIPS_REPLACEMENT} was loud.`);
    // And so is the one that sits immediately **after** the match, which is the difference between
    // mapping a match's end to its own last character and mapping it to the next kept one: the
    // second would have swallowed this block and deleted formatting nobody touched (N145).
    expect(await rowText(TAG_AFTER_IT)).toBe(`The ${SKIPS_REPLACEMENT}{\\i0} went out.`);
    // And the comment is the line it was: a skipped cue is skipped by the replace too.
    expect(await rowText(IN_THE_COMMENT)).toBe(inComment);
  });
});
