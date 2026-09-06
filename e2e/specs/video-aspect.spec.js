/* global describe, it, before, afterEach, console, document, window */
/**
 * docs/video-aspect-tasks.md: the interface can ask how wide a box the picture would fill, and the
 * answer is the box mpv draws rather than the frame the file stores.
 *
 * Three of the fixtures below exist only to separate the properties that agree on an ordinary file
 * and disagree on an unusual one: an anamorphic media whose drawn box is twice its stored width,
 * a rotated one whose drawn box is its stored frame turned on its side, and one with no picture at
 * all. Nothing here builds the cap that will use the number, and nothing here changes a panel.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { browser, expect } from "@wdio/globals";

import { appLogSinceStart, dataHome } from "../lib/applog.js";
import { answerChooser, waitForChooser } from "../lib/chooser.js";
import { clickAt, focusWindow } from "../lib/input.js";
import {
  repoRoot,
  requireVideoFixture,
  videoFixture,
  windowHeight,
  windowWidth,
} from "../lib/paths.js";
import { waitFor } from "../lib/proc.js";
import { findToplevel } from "../lib/x11.js";

/** Generated, never committed, the way every other media fixture is. */
const anamorphicFixture = path.join(repoRoot, "fixtures", "video", "picture-anamorphic.mkv");
const rotatedFixture = path.join(repoRoot, "fixtures", "video", "picture-rotated.mkv");
const picturelessFixture = path.join(repoRoot, "fixtures", "video", "picture-none.mkv");

/** A missing prerequisite is a failure with an actionable message, never a skip. */
function requirePictureFixtures() {
  for (const file of [anamorphicFixture, rotatedFixture, picturelessFixture]) {
    if (!existsSync(file)) {
      throw new Error(
        `E2E prerequisite missing: ${file} does not exist. ` +
          "Run: sh fixtures/video/make-picture-fixtures.sh",
      );
    }
  }
}

function present(selector) {
  return browser.execute((css) => document.querySelector(css) !== null, selector);
}

function textOf(selector) {
  return browser.execute((css) => document.querySelector(css)?.textContent ?? null, selector);
}

function rectOf(selector) {
  return browser.execute((css) => {
    const element = document.querySelector(css);
    if (element === null) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    return { x: rect.x * dpr, y: rect.y * dpr, width: rect.width * dpr, height: rect.height * dpr };
  }, selector);
}

async function clickElement(toplevel, selector) {
  const rect = await rectOf(selector);
  clickAt(toplevel.absX + rect.x + rect.width / 2, toplevel.absY + rect.y + rect.height / 2);
}

async function openVideo(toplevel, fixture) {
  await clickElement(toplevel, ".toolbar__video-open");
  const chooser = await waitForChooser("Choose a video");
  await answerChooser(chooser, fixture, "video");
  focusWindow(toplevel.id);
}

/**
 * Record what the backend sends, from inside the page and with the page's own listeners left alone.
 *
 * The shell keeps the picture in React state, and no component draws it: this change is the
 * plumbing and the panels belong to another one. So the events themselves are what a check can
 * read, registered the way `@tauri-apps/api` registers them, through the `core:default` capability
 * the app already grants. Nothing test-only is added to the app for this.
 */
async function watchVideoEvents() {
  await browser.execute(() => {
    window.__subloreSeen = { picture: [], position: 0, state: 0, error: 0, lastState: null };
    window.__subloreListening = 0;
    const internals = window.__TAURI_INTERNALS__;
    const listen = (name, onEvent) =>
      internals
        .invoke("plugin:event|listen", {
          event: name,
          target: { kind: "Any" },
          handler: internals.transformCallback(onEvent),
        })
        .then(() => {
          window.__subloreListening += 1;
        });
    void listen("video://picture", (event) => {
      window.__subloreSeen.picture.push(event.payload.picture);
    });
    void listen("video://position", () => {
      window.__subloreSeen.position += 1;
    });
    void listen("video://state", (event) => {
      window.__subloreSeen.state += 1;
      window.__subloreSeen.lastState = event.payload;
    });
    void listen("video://error", () => {
      window.__subloreSeen.error += 1;
    });
  });
  await waitFor(() => browser.execute(() => window.__subloreListening === 4), {
    timeout: 20000,
    message: "this check's own listeners to be registered with the event plugin",
  });
}

function seen() {
  return browser.execute(() => window.__subloreSeen);
}

function forget() {
  return browser.execute(() => {
    window.__subloreSeen.picture = [];
    window.__subloreSeen.position = 0;
    window.__subloreSeen.state = 0;
    window.__subloreSeen.error = 0;
  });
}

/** The size the interface ends up holding, which is the last thing it was told. */
async function drawnSize(what) {
  return waitFor(
    async () => {
      const recorded = await seen();
      return recorded.picture.at(-1) ?? null;
    },
    { timeout: 30000, message: `the drawn size of ${what}` },
  );
}

/**
 * Wait until the media that has just been opened has been read and found to have no picture, and
 * answer with what the interface holds a beat later.
 *
 * The wait is on the app's log and not on a null payload, because a null payload arrives at the
 * start of every open, for a media with a picture as much as for one without: a check that took the
 * first null for the verdict would pass on all four fixtures. The line the wait is on is written
 * when mpv has loaded the file and found no video in it, and the beat after it is what makes a
 * size arriving late a failure rather than a thing the check ran past.
 */
async function waitForNoPicture(what, said) {
  await waitFor(() => countInLog(NO_PICTURE) === said + 1, {
    timeout: 30000,
    message: `the app to read ${what} and find no picture in it`,
  });
  await browser.pause(1000);
  return (await seen()).picture;
}

/**
 * How long the rate check plays for.
 *
 * Thirty, which is about as long a stretch as the harness allows: `e2e/wdio.conf.js` gives every
 * check sixty seconds in total, and the open and the two transport clicks come out of that same
 * budget, so a longer playback fails on the clock rather than on the app (measured: fifty-five
 * timed out on 2026-09-05). The criteria ask for ten and this is three times that. At the rate the
 * backend throttles the position to, thirty seconds is about three hundred position events, and
 * that comparison is the whole point of this check.
 */
const PLAYED_SECONDS = 30;

/** What the app writes once per media it loads and finds no video track in. */
const NO_PICTURE = /video: this media carries no picture/g;

/** What it writes once per drawn size it reports, which a media with no picture never has. */
const A_SIZE = /video: the picture is drawn /g;

function countInLog(pattern) {
  return [...appLogSinceStart(dataHome()).matchAll(pattern)].length;
}

async function openAndMeasure(toplevel, fixture, what) {
  await forget();
  await openVideo(toplevel, fixture);
  return drawnSize(what);
}

describe("how wide a box the picture would fill", () => {
  let toplevel = null;

  before(async () => {
    requireVideoFixture();
    requirePictureFixtures();
    toplevel = await waitFor(findToplevel, {
      timeout: 30000,
      message: `the ${windowWidth}x${windowHeight} "Sublore" toplevel to appear`,
    });
    focusWindow(toplevel.id);
    await waitFor(() => present(".toolbar__video-open"), {
      timeout: 30000,
      message: "the app UI to render",
    });
    await watchVideoEvents();
  });

  // The battery does not put the application's log on its own output, but a spec can read it out of
  // the data home. A failure here that is the app dying and one that is the app disagreeing look
  // identical from the driver, which answers `WebDriverError: 1` to both, so the difference is
  // printed rather than guessed at.
  afterEach(function afterEachCheck() {
    if (this.currentTest?.state !== "failed") {
      return;
    }
    const alive = findToplevel() !== null;
    const lines = appLogSinceStart(dataHome()).split("\n");
    // The waveform talks far more than anything else here, so the chosen files and what the player
    // made of them are pulled out beside the raw tail: an open that never happened is an absence,
    // and an absence is invisible in a tail the peaks have filled.
    const mine = lines.filter((line) => /chooser:|video:|preview:/.test(line)).slice(-20);
    console.log(
      `the window is ${alive ? "still there" : "GONE"}\n` +
        `what it opened and drew:\n${mine.join("\n")}\n` +
        `its last lines:\n${lines.slice(-12).join("\n")}`,
    );
  });

  it("reports a square picture at its own size, and says so once in the log", async () => {
    const said = countInLog(/video: the picture is drawn 640 by 360/g);
    expect(await openAndMeasure(toplevel, videoFixture, "the square fixture")).toEqual({
      width: 640,
      height: 360,
    });
    expect(countInLog(/video: the picture is drawn 640 by 360/g)).toBe(said + 1);
  });

  it("reports an anamorphic picture as the box it fills, not as the frame it stores", async () => {
    // Stored 640x360 with a pixel aspect of 2:1. A reader of the storage size answers 640 here and
    // is wrong by a factor of two, which is why the fixture uses 2:1 and not a television aspect.
    expect(await openAndMeasure(toplevel, anamorphicFixture, "the anamorphic fixture")).toEqual({
      width: 1280,
      height: 360,
    });
  });

  it("reports a rotated picture as the box it fills, turned the way mpv draws it", async () => {
    // The check no other fixture makes: with the output the app builds, mpv leaves the turn to the
    // renderer and `dwidth` stays 640x360, so a build that reports it raw is wrong here alone.
    expect(await openAndMeasure(toplevel, rotatedFixture, "the rotated fixture")).toEqual({
      width: 360,
      height: 640,
    });
  });

  it("says a media with no picture has none, and is as quiet about it as about no audio", async () => {
    expect(await openAndMeasure(toplevel, videoFixture, "the square fixture")).toEqual({
      width: 640,
      height: 360,
    });

    const said = countInLog(NO_PICTURE);
    const sized = countInLog(A_SIZE);
    await forget();
    await openVideo(toplevel, picturelessFixture);
    const told = await waitForNoPicture("a media with no video track", said);

    // One null and nothing else. Not the file before it, not a zero, and no size arriving late:
    // those are the three answers a build could give here instead of none.
    expect(told).toEqual([null]);
    expect((await seen()).error).toBe(0);
    // And the log said it once and said nothing else: no size line for a media that has no size.
    expect(countInLog(NO_PICTURE)).toBe(said + 1);
    expect(countInLog(A_SIZE)).toBe(sized);

    // Each alert with the class it carries, so a failure names which line said it rather than
    // leaving the reader to work it out from the sentence. See BACKLOG.md N40.
    const alarming = await browser.execute(() =>
      Array.from(document.querySelectorAll('[role="alert"]')).map((node) => ({
        said: node.textContent,
        drawnAs: node.className,
      })),
    );
    // A sentence on screen and the refusals the app logged, read as one object: a refusal is what
    // puts a sentence there, and the log is the only place that says which command was refused.
    // Only the sentences are asserted; the refusals are carried so a failure names its cause.
    const refusals = appLogSinceStart(dataHome())
      .split("\n")
      .filter((line) => line.includes("was refused as"));
    expect({ alarming, refusals }).toEqual({ alarming: [], refusals });
    expect(await present(".statusbar__video-error")).toBe(false);
  });

  it("holds no number before the first frame, and never a wrong one", async () => {
    // The square fixture first, so the interface is holding 640x360 when the anamorphic open
    // starts: what this check is for is that 640x360 does not survive into the next file, and it
    // can only see that if it was there.
    expect(await openAndMeasure(toplevel, videoFixture, "the square fixture")).toEqual({
      width: 640,
      height: 360,
    });

    await forget();
    await openVideo(toplevel, anamorphicFixture);
    await drawnSize("the anamorphic fixture");
    await browser.pause(1000);

    const recorded = await seen();
    // A build that answers early from the container's storage size corrects itself after the first
    // frame, and shows up here as an intermediate 640x360.
    expect(recorded.picture).toEqual([null, { width: 1280, height: 360 }]);
  });

  it("fires about as often as the shape changes, while the position keeps its own rate", async () => {
    await forget();
    await openVideo(toplevel, videoFixture);
    await drawnSize("the square fixture");

    const playing = await textOf(".controls__button");
    await clickElement(toplevel, ".controls__button");
    await waitFor(async () => (await textOf(".controls__button")) !== playing, {
      timeout: 10000,
      message: "the transport button to show its other word, which is playback starting",
    });
    // Well inside the sixty second fixture, so mpv's own pause at the end of the file is nowhere
    // near the counts and the question stays about playback.
    await waitFor(
      () =>
        // Passed in, never closed over: `execute` serialises the function to the page, where a
        // constant that lives in this file does not exist.
        browser.execute(
          (seconds) => Number(document.querySelector(".controls__slider")?.value ?? 0) >= seconds,
          PLAYED_SECONDS,
        ),
      { timeout: 45000, message: `the playhead to reach ${PLAYED_SECONDS} seconds` },
    );
    await clickElement(toplevel, ".controls__button");
    await waitFor(async () => (await textOf(".controls__button")) === playing, {
      timeout: 10000,
      message: "the transport button to go back to the word it showed before this check played it",
    });

    const recorded = await seen();
    console.log(
      `MEASURED over one open and ${PLAYED_SECONDS} s of playback: ` +
        `video://picture ${recorded.picture.length}, video://position ${recorded.position}, ` +
        `video://state ${recorded.state}; the picture payloads were ` +
        JSON.stringify(recorded.picture),
    );
    // At most a null as the open starts and the size once the first frame is decoded, and nothing
    // during playback. The position over the same stretch is what the comparison is for: it is
    // throttled to ten a second, so this floor is half of what the stretch should produce.
    expect(recorded.picture).toEqual([null, { width: 640, height: 360 }]);
    expect(recorded.position).toBeGreaterThan(PLAYED_SECONDS * 5);
    // The state payload did not grow a field, so its own rate is untouched: the picture is its own
    // event precisely so this one keeps firing on open, on idle and on a pause and nothing else.
    expect(Object.keys(recorded.lastState ?? {}).sort()).toEqual([
      "duration",
      "path",
      "paused",
      "status",
    ]);
    // Four by construction: loading and ready from the open, then the play and the pause. Measured
    // at four, and the margin is for an idle the transport may add, not for a payload that grew.
    expect(recorded.state).toBeLessThanOrEqual(6);
  });

  it("answers for five files in a row and leaves playback working", async () => {
    const sizes = [];
    const said = countInLog(NO_PICTURE);
    for (const [fixture, what] of [
      [videoFixture, "the square fixture"],
      [anamorphicFixture, "the anamorphic fixture"],
      [rotatedFixture, "the rotated fixture"],
      [picturelessFixture, "the media with no picture"],
      [videoFixture, "the square fixture again"],
    ]) {
      await forget();
      await openVideo(toplevel, fixture);
      if (fixture === picturelessFixture) {
        expect(await waitForNoPicture(what, said)).toEqual([null]);
        sizes.push(null);
      } else {
        sizes.push(await drawnSize(what));
      }
    }
    expect(sizes).toEqual([
      { width: 640, height: 360 },
      { width: 1280, height: 360 },
      { width: 360, height: 640 },
      null,
      { width: 640, height: 360 },
    ]);

    // The coarse check on the locking: an emit made under a lock the event thread needs stops the
    // file after it, and position events are the first thing that would go quiet.
    await forget();
    const playing = await textOf(".controls__button");
    await clickElement(toplevel, ".controls__button");
    await waitFor(
      () =>
        browser.execute(() => Number(document.querySelector(".controls__slider")?.value ?? 0) >= 2),
      { timeout: 30000, message: "the playhead to move after five files were opened" },
    );
    await clickElement(toplevel, ".controls__button");
    await waitFor(async () => (await textOf(".controls__button")) === playing, {
      timeout: 10000,
      message: "playback to stop again",
    });
    expect((await seen()).position).toBeGreaterThan(0);
  });
});
