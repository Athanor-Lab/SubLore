import { mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { browserStubDir, openedPath } from "./browserstub.js";

/**
 * The environment the app is launched with, for every harness that spawns it.
 *
 * With `WAYLAND_DISPLAY` set, libmpv does not attach to the X11 surface it was handed: the surface
 * reports `IsViewable` with zero children, the stage keeps showing its placeholder, and every pixel
 * assertion measures the webview underneath while the transport happily reports playback. An N2
 * probe lost two runs to this before a screenshot gave it away.
 *
 * The first diagnosis blamed GTK and was wrong: `main.rs` already forces `GDK_BACKEND=x11` before
 * `gtk_init`, so GTK never had a choice to make. The component ignoring the `wid` is libmpv, which
 * is not pinned to an X11 output, and that is a product defect on the primary platform — the
 * owner's own session is Wayland. **BACKLOG N2b fixes it in the product.** What is left here is
 * determinism for the harness, not a cure: clearing the variable makes every run start from the
 * same place instead of from whatever the developer's shell exported.
 *
 * The mechanism is portable and every value in it is Linux's. On Windows all three are inert:
 * nothing reads `GDK_BACKEND` or `WAYLAND_DISPLAY`, and `main.rs` gates the webkit hatch behind
 * `cfg(target_os = "linux")`. So this stays as it is, MW.1b adds whatever the WebView2 launcher
 * needs beside it, and there is no guard here on purpose: a launcher needs a base environment.
 */
/**
 * A machine with no audio device at all, which is what a server, a container and a plain virtual
 * machine are.
 *
 * Every backend mpv would try is sent somewhere that does not answer: ALSA's configuration, the
 * runtime directory PipeWire's socket lives in, and PulseAudio's server. Measured on 2026-09-09,
 * this makes mpv report "Could not open/initialize audio device" and, without
 * `audio-fallback-to-null`, end the file about a second in. That is the defect this exists to
 * catch. See BACKLOG.md N13.
 *
 * @param {string} dataHome the spec's own data home, which the empty runtime directory goes under
 */
export function silentMachine(dataHome) {
  const runtime = path.join(dataHome, "no-audio-runtime");
  mkdirSync(runtime, { recursive: true });
  return {
    XDG_RUNTIME_DIR: runtime,
    ALSA_CONFIG_PATH: path.join(runtime, "there-is-no-asound.conf"),
    PULSE_SERVER: path.join(runtime, "there-is-no-pulse-server"),
  };
}

export function appEnv(overrides = {}) {
  const env = {
    ...process.env,
    GDK_BACKEND: "x11",
    // Disarmed here because the workarounds key on the driver being loaded, which is true on a
    // developer machine even under Xvfb, where llvmpipe renders and input reaches React late
    // enough to lose races. So every caller of `appEnv` tests
    // a configuration no user gets; the armed one is checked by `pnpm e2e:webview`.
    SUBLORE_WEBKIT_WORKAROUNDS: "0",
    ...overrides,
  };
  delete env.WAYLAND_DISPLAY;
  // The session bus goes nowhere. Xvfb contains a display, not a desktop: an app under test that
  // asks the session bus reaches the developer's own portals, and the eyedropper proved it by
  // asking the real one to read the real screen and getting a colour back. Pointed at a socket that
  // does not exist, the app meets a desktop with no portal, which is a state a user can be in and
  // the one this harness can honestly test. Same lesson as `browserstub.js`. See BACKLOG.md N54.
  env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/nonexistent/sublore-e2e-has-no-session-bus";
  // The peaks cache follows the data home it belongs to, so a run never writes into the developer's
  // own cache and two harnesses never share one. Only when there is a data home to follow: the
  // docstring above says a launcher needs a base environment, and that stays true.
  if (typeof env.XDG_DATA_HOME === "string" && env.XDG_DATA_HOME !== "") {
    env.XDG_CACHE_HOME = path.join(env.XDG_DATA_HOME, "cache");
    env.SUBLORE_E2E_OPENED = openedPath(env.XDG_DATA_HOME);
  }
  // In front of the real launchers, never instead of them: a URL the app asks the desktop to open
  // has to land in a file rather than in whoever's browser is running. See lib/browserstub.js.
  // Prepended once however often this is called, so a long-lived harness does not grow its PATH.
  const stubs = browserStubDir(env.XDG_DATA_HOME);
  const entries = (env.PATH ?? "").split(path.delimiter);
  if (entries[0] !== stubs) {
    env.PATH = [stubs, ...entries.filter((entry) => entry !== stubs)].join(path.delimiter);
  }
  return env;
}
