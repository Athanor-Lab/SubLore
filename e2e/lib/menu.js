/* global document */
/**
 * Walking a menu that has lists inside it.
 *
 * A command can sit on a menu or inside one of its lists, and a check that runs it should not have
 * to know which: the interface moves items between the two as it grows, and a helper that knew
 * would be a helper rewritten every time it does. See interface-spec 3.
 */
import { browser } from "@wdio/globals";

import { waitFor } from "./proc.js";

const present = (selector) =>
  browser.execute((css) => document.querySelector(css) !== null, selector);

/**
 * Open the list inside the open menu that holds `token`, if it is not on the menu itself.
 *
 * `click` is the caller's own clicker, taking a selector: the harness clicks through X11 at a
 * window's own coordinates, so only the caller knows which window it is pointing at.
 */
export async function intoList(click, token) {
  if (await present(`.menubar__item--${token}`)) {
    return;
  }
  const openers = await browser.execute(() =>
    Array.from(document.querySelectorAll(".menubar__menu .menubar__submenu")).map((row) =>
      row.id.replace("menuitem-", ""),
    ),
  );
  for (const opener of openers) {
    await click(`.menubar__submenu--${opener}`);
    if (await present(`.menubar__item--${token}`)) {
      return;
    }
  }
}

/**
 * Run a command from the menu that draws it, given the caller's own clicker.
 *
 * The suite reaches a good many commands through a toolbar button instead, and five of those
 * buttons are Sublore's own rather than the reference's, so they come off the strip when it is made
 * to match it (BACKLOG.md N120). A check that wants a command run should ask for the command, not
 * for the button that happens to carry it today.
 */
export async function runFromMenu(click, menu, token) {
  await click(`.menubar__title--${menu}`);
  await waitFor(() => present(".menubar__menu"), {
    timeout: 15000,
    message: `the ${menu} menu to open`,
  });
  await intoList(click, token);
  await click(`.menubar__item--${token}`);
  await waitFor(async () => ((await present(".menubar__menu")) ? null : 1), {
    timeout: 15000,
    message: `the menu to close after ${token}`,
  });
}

/**
 * Whether a command is greyed, read where it is drawn rather than off a button that may not be
 * there tomorrow. Opens the menu, reads the item, and closes it again, so it belongs outside a
 * polling loop: a wait that called this would open and close a menu on every turn (N121).
 */
export async function menuItemDisabled(click, menu, token) {
  await click(`.menubar__title--${menu}`);
  await waitFor(() => present(".menubar__menu"), {
    timeout: 15000,
    message: `the ${menu} menu to open`,
  });
  await intoList(click, token);
  const disabled = await browser.execute(
    (css) => document.querySelector(css)?.disabled ?? null,
    `#menuitem-${token}`,
  );
  await click(`.menubar__title--${menu}`);
  await waitFor(async () => ((await present(".menubar__menu")) ? null : 1), {
    timeout: 15000,
    message: `the ${menu} menu to close again`,
  });
  return disabled;
}
