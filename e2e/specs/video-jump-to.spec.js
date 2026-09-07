/* global describe, it, before, document, window */
/**
 * Jump to time: the field Ctrl+G opens, and where the keyboard is left afterwards.
 *
 * The clock under the picture is what is read, because it is what a translator reads. The focus is
 * read too: the reference hands the keyboard to the seek slider once the jump is made, so the next
 * arrow key steps the picture rather than doing nothing.
 */
import { browser, expect } from "@wdio/globals";

import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow, pressKey, typeText } from "../lib/input.js";
import { requireVideoFixture, windowHeight, windowWidth } from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

/** Well inside the sixty second fixture, and not a second the picture would drift onto by itself. */
const TYPED = "00:00:30.000";
const READS = "0:30";

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

function textOf(selector) {
  return browser.execute((css) => document.querySelector(css)?.textContent ?? null, selector);
}

/** What the clock under the picture reads, without the duration after it. */
async function clock() {
  const text = await textOf(".controls__time");
  return text === null ? null : (text.split("/")[0]?.trim() ?? null);
}

/** Whether an item of the Video menu is drawn and greyed, without choosing it. */
async function videoItem(toplevel, token) {
  await clickElement(toplevel, ".menubar__title--video");
  await waitFor(() => present(`.menubar__item--${token}`), {
    timeout: 15000,
    message: `the Video menu to open on ${token}`,
  });
  const state = await browser.execute((css) => {
    const item = document.querySelector(css);
    return item === null
      ? null
      : { drawn: true, disabled: item.disabled === true, key: item.textContent };
  }, `.menubar__item--${token}`);
  pressKey("Escape");
  await waitFor(async () => ((await present(`.menubar__item--${token}`)) ? null : 1), {
    timeout: 15000,
    message: "the Video menu to close",
  });
  return state;
}

/** Empty the field however long what is in it is, then type. */
async function retype(text) {
  pressKey("ctrl+a");
  typeText(text);
  await waitFor(
    async () =>
      (await browser.execute(() => document.querySelector(".jumpto__value")?.value ?? null)) ===
      text
        ? 1
        : null,
    { timeout: 15000, message: `the field to hold exactly ${text}` },
  );
}

function panelGone() {
  return waitFor(async () => ((await present(".jumpto__panel")) ? null : 1), {
    timeout: 15000,
    message: "the jump panel to close",
  });
}

describe("jumping the picture to a typed time", () => {
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

  it("greys the item with nothing open, and draws the key beside it", async () => {
    const item = await videoItem(toplevel, "video-jump-to");
    expect(item?.disabled).toBe(true);
    // The key is on the item, so a translator learns it from the menu rather than from a document.
    expect(item?.key).toContain("Ctrl+G");

    await clickElement(toplevel, ".toolbar__video-open");
    const chooser = await waitForChooser("Choose a video");
    await answerChooser(chooser, requireVideoFixture(), "video");
    focusWindow(toplevel.id);
    await waitFor(
      () =>
        browser.execute(
          () =>
            document.querySelector(".stage__empty") === null &&
            document.querySelector(".controls__button")?.disabled === false,
        ),
      { timeout: 30000, message: "the video fixture to reach the ready state" },
    );
    expect((await videoItem(toplevel, "video-jump-to"))?.disabled).toBe(false);
  });

  it("opens on Ctrl+G, takes the picture to the typed time, and hands the keyboard to the slider", async () => {
    pressKey("ctrl+g");
    await waitFor(() => present(".jumpto__panel"), {
      timeout: 15000,
      message: "the jump panel to open on the key the menu draws",
    });

    await retype(TYPED);
    pressKey("Return");
    await panelGone();
    await waitFor(async () => ((await clock())?.startsWith(READS) === true ? 1 : null), {
      timeout: 20000,
      message: `the clock to read ${READS}`,
    });

    // Where the reference leaves it: the slider, so the next key steps the picture.
    await waitFor(
      async () =>
        (await browser.execute(() => document.activeElement?.className ?? null))?.includes(
          "controls__slider",
        ) === true
          ? 1
          : null,
      { timeout: 15000, message: "the keyboard to be left on the seek slider" },
    );
  });

  it("refuses what is not a time and what is past the end, and moves nothing", async () => {
    pressKey("ctrl+g");
    await waitFor(() => present(".jumpto__panel"), {
      timeout: 15000,
      message: "the jump panel to open again",
    });

    await retype("half past nine");
    pressKey("Return");
    await waitFor(() => present(".jumpto__refusal"), {
      timeout: 15000,
      message: "the field to say that is not a time",
    });
    expect(await present(".jumpto__panel")).toBe(true);

    // A time the media does not have is refused the same way, rather than landing on the last frame.
    await retype("00:10:00.000");
    pressKey("Return");
    expect(await present(".jumpto__refusal")).toBe(true);
    expect(await present(".jumpto__panel")).toBe(true);

    // Escape leaves, and the picture is where the jump before left it.
    pressKey("Escape");
    await panelGone();
    expect((await clock())?.startsWith(READS)).toBe(true);
  });
});
