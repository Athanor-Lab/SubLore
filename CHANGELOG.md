# Changelog

What changed, in the words of what a translator can do with it. Every entry describes what has been
run on Linux, which is the platform Sublore releases on.

## Unreleased

The first version has not been tagged. When it is, **this heading becomes the tag, spelled exactly
as the tag is**, `## v1.0.0` and not `## 1.0.0`: `.github/scripts/draft-release.sh` matches the line
against `## ` plus the tag it was given, and a heading that misses the `v` gives it nothing to read.
It then refuses, after the whole matrix has already run.

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
- **Open the subtitles a video carries inside it.** File > Open subtitles from video takes the text
  track out of the video already open, with no file to find. It is greyed on a video that carries
  none, and on one whose subtitles are pictures rather than text.
- **A field writes to every line you have selected.** Pick a style with forty lines selected and all
  forty take it, in one step you can undo with one Ctrl+Z. The same for the speaker, the effect, the
  layer, the margins and the comment mark. The text and the two times stay on the line you are in.
- **Undo and redo say what they would undo.** The Edit menu reads "Undo typing" or "Undo style"
  rather than "Undo", so you can tell what the next Ctrl+Z takes back before you press it.
- **A double-click in the text box takes the whole tag.** Double-clicking inside `{\an8\pos(320,50)}`
  selects the whole block rather than the three letters under the pointer. On ordinary words it
  still takes the word.
- **The keyboard is laid out the way a timer expects.** Every default key is in place, including the
  nine timing commands that had none, the five on the numpad, and the two splits at the current
  frame. A command can answer two keys, so the numpad works beside the main keys.
- **Return commits the line and moves on**, making the next one when you are on the last.
- **The four colours are commands**, so they answer from the menu and the keyboard and not only from
  their buttons.
- **The find band remembers what you searched for**, the last sixteen terms, and it skips comments
  and override tags when you ask it to, so a replace does not rewrite the formatting around a word.
- **The wheel does what the panel under it expects.** Three rows a notch over the grid, a page with
  Shift, and one frame a notch over the seek slider.
- **The transport reads what a timer needs.** It stacks on two rows, the clock under the picture
  reads a full timecode instead of whole seconds, and the strip beside it says how far the playhead
  is from the current line's start and end.
- **The toolbar and the waveform strip draw every button they are meant to**, seventeen on the wave
  strip where fourteen were drawn before.
- **The grid answers the three selection gestures**, plain, shift and control, from the mouse and
  from the keys.

### Fixed

- Pressing Play the moment a video's transport appears now plays it and says so. The open could
  land afterwards and put the button back to Play while the video ran.
- A machine with no working audio device plays the video instead of stopping about a second in.

- The new cue length now follows the preference rather than a number fixed in the code.
- A battery no longer opens tabs in the developer's own browser.
- A replace no longer eats the formatting after the word it replaced. A match now ends at its own
  last character instead of at the next character outside a tag.
- Discard now opens the file you asked for. After a refused New and then a refused open, it was
  making an empty document and losing the file you had chosen.
- The part of a frame a wheel gesture had left over no longer follows the next video in, so the
  first notch on a new picture moves one frame and not two.
- The grid keeps its rows when a band opens under it, and the window no longer opens wider than the
  size it is drawn for.
- The Help menu draws its dividers, and Delete sits where the menu's own order puts it.

### For people building Sublore

- A `v*` tag now creates a draft release with the three Linux packages on it. It did nothing before.
- The version is checked to be one number across the three files that carry it.
- The battery runs four spec files at once, which took the gate from nineteen minutes to under five.
