# Changelog

What changed, in the words of what a translator can do with it. Every entry describes what has been
run on Linux, which is the platform Sublore releases on.

## Unreleased

The first version has not been tagged. When it is, this section takes its number, and
`.github/scripts/draft-release.sh` reads it for the notes on the release page.

### Added

- **Preferences.** View > Preferences, or Alt+O, holds the three numbers the timing commands read:
  the lead-in, the lead-out, and how long a line you have just made lasts. They are remembered
  between launches.
- **A manual, and F1.** Help contents opens it, and so does F1 from anywhere, including with the
  caret in a line.
- **An event log window.** Help > Event log lists what Sublore has said since it started, stamped
  with the time and the part of the app that said it, which is the quickest way to answer what it
  just did.
- **A check for updates.** Help > Check for updates asks once, when you press it, and never on its
  own. A project with no releases reads as nothing newer rather than as a failure.
- **Paste over asks which fields to take.** The eleven an event has, with All, None, Times and Text
  above them. A field you did not choose is not written at all, so the line keeps it exactly.
- **A colour spectrum.** The picker has a square, a hue slider, a preview and four notations that
  are one colour written five ways, in the five spectrum modes, and the mode is remembered.
- **The window says what you are working on.** It carries the open file's name, a `*` in front of
  it while there is unsaved work, and `Untitled` before a file has been chosen. Three episodes open
  are three windows you can tell apart.

### Fixed

- Pressing Play the moment a video's transport appears now plays it and says so. The open could
  land afterwards and put the button back to Play while the video ran.
- A machine with no working audio device plays the video instead of stopping about a second in.

- The new cue length now follows the preference rather than a number fixed in the code.
- A battery no longer opens tabs in the developer's own browser.

### For people building Sublore

- A `v*` tag now creates a draft release with the three Linux packages on it. It did nothing before.
- The version is checked to be one number across the three files that carry it.
- The battery runs four spec files at once, which took the gate from nineteen minutes to under five.
