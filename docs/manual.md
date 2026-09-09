# Sublore manual

Sublore is a subtitle editor for people who translate. You open a subtitle file and the video it
belongs to, and you work through the lines with the picture and the sound in front of you.

This manual covers the free core, and describes what has been run and verified on Linux.

## Opening things

Three separate things can be open at once, and none of them needs the others.

- **A subtitle file**, with `Ctrl+O` or File > Open subtitle. SRT, ASS and VTT are read and written.
  A file Sublore has opened before is offered again under File > Recent projects. File > Open with
  encoding opens the same picker and then asks which character set the file is in, instead of
  guessing.
- **A video**, with `Ctrl+Shift+O` or File > Open video. The sound comes from the same file, and the
  waveform is drawn from it.
- **A source subtitle**, with File > Open source subtitle: the document you translate from. It is
  read and never written to. File > New translation from source starts a document with the same
  lines and none of the words yet.

`Ctrl+S` saves over the file you opened. `Ctrl+Shift+S` writes a new one. Both write a temporary
file and rename it into place, so the destination is always either the old file or the new one, and
whatever was there before is kept as a timestamped backup in Sublore's own folder. Your video and
audio files are only ever read.

## The window

- **The grid** lists every line: its number, its start, its end, and its text. A column with nothing
  in it for any line is not drawn at all, so the style and the speaker appear when the file has them
  and take no room when it does not. The line the cursor is on is the one every timing command acts
  on. Click a row to move the cursor, and `Ctrl`-click or `Shift`-click to select more.
- **The line box** under the grid holds the text of the line the cursor is on, with the styling
  controls and the margins around it. What you type reaches the document when you commit it or when
  you move to another line.
- **The video panel** shows the picture with the subtitles drawn over it, and the transport under it.
- **The waveform panel** draws the sound around the playhead, with the current line's start and end
  marked on it. Drag either marker to retime the line, then commit.

Every panel can be resized by the divider beside it and hidden from the View menu. A panel with
nothing to show takes no room: no video means no picture, no sound means no waveform.

## Working through a line

These keys run outside a text field, where a bare letter is a command rather than a character.

| Key                       | What it does                                                            |
| ------------------------- | ----------------------------------------------------------------------- |
| `C`                       | Pulls the current line's start earlier by the lead-in                   |
| `V`                       | Pushes the current line's end later by the lead-out                     |
| `G`                       | Commits the times you dragged and moves on                              |
| `Shift+G`                 | Commits and moves on, making a new line if there is none after this one |
| `Alt+G`                   | Commits and stays where it is                                           |
| `Ctrl+1`, `Ctrl+2`        | Sends the picture to the current line's start or end                    |
| `Ctrl+3`, `Ctrl+4`        | Sets the current line's start or end to where the picture is            |
| `Ctrl+Left`, `Ctrl+Right` | Sends the picture to the previous or next line boundary                 |
| `Left`, `Right`           | Steps the picture one frame                                             |
| `Alt+Left`, `Alt+Right`   | Jumps the picture by a larger step                                      |
| `Ctrl+P`                  | Plays and pauses                                                        |
| `Ctrl+G`                  | Jumps the picture to a time you type                                    |
| `Ctrl+I`                  | Shifts times, over the selection or over the whole file                 |
| `Alt+Up`, `Alt+Down`      | Moves the selected lines up or down                                     |

Every one of these is a single undo step, and `Ctrl+Z` takes back the last one whatever it was.

## Finding and replacing

`Ctrl+F` opens the find band under the grid, and `Ctrl+H` opens it with a replacement field. `F3`
repeats the last search. A search can match case, read its pattern as a regular expression, and stay
inside the selection. Replace all is one undo step, however many lines it changed.

## Transcription

Sublore can write a first draft of the lines and their timings from the sound, using a Whisper model
you download once. The model runs on your machine and nothing is sent anywhere. The accuracy is
Whisper's, and we say so; what Sublore adds is the editing around it.

The work happens beside the app rather than inside it, so the window keeps answering while it runs,
shows how far it has got, and can be stopped. Stopping it kills the process and clears the scratch
audio it extracted.

## Preferences

View > Preferences, or `Alt+O`, holds the three numbers the timing commands read: the lead-in, the
lead-out, and how long a line you have just made lasts. They are remembered between launches.

View > Language holds the interface language, and View > Interface size holds how large everything is
drawn.

## What Sublore does not do

- It does not typeset. Bold, italic, underline, colour and font are here, and positioning, rotation,
  clipping and drawing are not.
- It does not do karaoke or animation.
- It does not tell anyone what you are working on. Sublore reaches the network only when you press
  something that asks it to, and today that is downloading a Whisper model.

## Where Sublore keeps things

- Backups of files it has written over: `~/.local/share/com.sublore.app/backups/`, ten per file.
  Nothing deletes them but you.
- Whisper models you have downloaded: `~/.local/share/com.sublore.app/models/`
- Its own log: `~/.local/share/com.sublore.app/logs/`, capped at 2 MB with two older files kept
  beside it. If Sublore ever crashes, the report lands in the same folder.
