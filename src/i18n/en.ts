/** English source strings. All user-facing copy lives here, never inline in components. */
export const en = {
  appName: "Sublore",
  /**
   * The menu bar and the toolbar. Every title here is always drawn, greyed when nothing behind it
   * can be used; Timing and Terms are absent because no command of theirs is registered yet, and
   * they arrive with the milestone that writes them (decision 24 A4).
   */
  menu: {
    file: {
      title: "File",
      new: "New",
      openSubtitle: "Open subtitle…",
      /** Opens the same picker, then a dialog naming the file's charset instead of guessing it. */
      openEncoding: "Open with encoding…",
      recent: "Recent projects",
      /** The one greyed row the recent list holds while nothing has been remembered yet. */
      recentEmpty: "Empty",
      /** The document to read from while translating. It is never written to. */
      openSource: "Open source subtitle…",
      closeSource: "Close source subtitle",
      /** Makes the document being written from the one being read: same lines, no words yet. */
      newTranslation: "New translation from source",
      openVideo: "Open video…",
      save: "Save",
      saveAs: "Save as…",
      export: "Export…",
      discard: "Discard changes",
      /** Opens the script's own metadata, read-only in v1 (interface-spec 3.1 item 11, 9.5). */
      properties: "Project properties",
      quit: "Quit",
    },
    edit: {
      title: "Edit",
      undo: "Undo",
      redo: "Redo",
      /** The four inline style flags, written into the line's own text as override tags. */
      bold: "Bold",
      italic: "Italic",
      underline: "Underline",
      /** The clipboard group, in the order the reference's own Edit menu puts it. */
      cut: "Cut cues",
      copy: "Copy cues",
      paste: "Paste cues",
      pasteOver: "Paste over cues",
      selectAll: "Select all cues",
      /** The four under the text box, in the order the reference's own row puts them. See B13. */
      revert: "Revert",
      clear: "Clear",
      clearText: "Clear text",
      insertOriginal: "Insert original",
      strikeout: "Strikeout",
      find: "Find…",
      findNext: "Find next",
      replace: "Replace…",
      /** Here until an Audio title of its own arrives with the milestone that registers it. */
      transcribe: "Transcribe…",
    },
    /**
     * The Video menu, fifth of the eight titles: File, Edit, Subtitle, Timing, Video, Audio, View,
     * Help. Its own items are the ones about the picture rather than about the document.
     */
    video: {
      title: "Video",
      /** The recent-videos submenu (interface-spec 3.5 item 3). */
      recent: "Recent videos",
      close: "Close video",
      details: "Video details",
      jumpTo: "Jump to time",
      play: "Play",
      playCue: "Play current cue",
      stop: "Stop",
      followSelection: "Follow selection",
      jumpCueStart: "Jump to cue start",
      jumpCueEnd: "Jump to cue end",
      stepPrevFrame: "Step back one frame",
      stepNextFrame: "Step forward one frame",
      jumpBack: "Jump back",
      jumpForward: "Jump forward",
      prevBoundary: "Previous boundary",
      nextBoundary: "Next boundary",
    },
    timing: {
      title: "Timing",
      prevCue: "Previous line",
      nextCue: "Next line",
      startToPlayhead: "Set start to playhead",
      endToPlayhead: "Set end to playhead",
      shift: "Shift times",
      shiftToPlayhead: "Shift selection to playhead",
      /** The submenu the two below sit in, which is where the interface puts them. */
      continuous: "Make times continuous",
      continuousStart: "Change start",
      continuousEnd: "Change end",
      selectAtPlayhead: "Select cue at playhead",
      /** The 500 ms is in the label on purpose: the key says what it will do before you press it. */
      playLine: "Play line",
      /** The pair differs only while a boundary is being dragged: this one plays where the hand has
       * put it, and Play line plays what the document still holds (interface-spec 5.9). */
      playSelection: "Play selection",
      stop: "Stop playing",
      playBefore: "Play 500 ms before line",
      playAfter: "Play 500 ms after line",
      playFirst: "Play first 500 ms of line",
      playLast: "Play last 500 ms of line",
      playToEnd: "Play from line start to the end",
      /** The three commits and the two toggles that decide what a commit does (interface-spec 5). */
      commit: "Commit timing",
      commitNext: "Commit and go to next",
      commitStay: "Commit and stay",
      leadIn: "Add lead-in",
      leadOut: "Add lead-out",
      startEarlier: "Start 10 ms earlier",
      startLater: "Start 10 ms later",
      endEarlier: "End 10 ms earlier",
      endLater: "End 10 ms later",
    },
    view: {
      layoutGridOnly: "Grid only",
      layoutVideoGrid: "Video and grid",
      layoutWaveformGrid: "Waveform and grid",
      layoutFull: "Full",
      title: "View",
      waveform: "Waveform",
      centreOnCue: "Centre the waveform on the current line",
      /** The keyboard-only pan pair, named for the accelerator table even with no menu row. */
      scrollLeft: "Scroll the waveform left",
      scrollRight: "Scroll the waveform right",
      followCue: "Follow the current line",
      /** The two toggles that decide what a commit does, beside their sibling above (5). */
      autoCommit: "Commit as the markers move",
      autoNext: "Go to next after a commit",
      subtitles: "Subtitles on video",
      /** The three ways the grid draws override tags, a radio set (interface-spec 3.5). */
      tagsShow: "Show tags",
      tagsSimplify: "Simplify tags",
      tagsHide: "Hide tags",
      /** The one button that steps the three above, on the toolbar and nowhere else (interface-spec 4.1). */
      tagsCycle: "Cycle tag display",
      /** Draws the document being read on the frame instead of the one being written. See S3. */
      sourceOnVideo: "Source on video",
      /** One of the five interface size radio items (S1). `{percent}` is a whole number. */
      scale: "{percent}%",
      language: "Language…",
      preferences: "Preferences…",
    },
    /** The four cue structure edits, interface-spec section 3 order (M2.7 E2, T3 C2). */
    subtitles: {
      title: "Subtitles",
      /** The submenu the four below sit in, which is where the interface puts them. */
      insert: "Insert cue",
      insertBefore: "Before current",
      insertAfter: "After current",
      insertBeforeAtPlayhead: "Before current, at the playhead",
      insertAfterAtPlayhead: "After current, at the playhead",
      /** Goes to the next cue, and makes one when the cursor is on the last. */
      nextLine: "Next line",
      duplicate: "Duplicate cues",
      /** The submenu the two below sit in, which is where the interface puts them. */
      join: "Join cues",
      joinConcat: "Concatenate",
      joinKeepFirst: "Keep first",
      delete: "Delete cues",
      split: "Split cue",
      /** Frame-accurate split at the video playhead, before or after the current frame (§3.9). */
      splitBeforePlayhead: "Split before the playhead",
      splitAfterPlayhead: "Split after the playhead",
      merge: "Merge with next",
      /** Move the selected cues one row up or down, past the neighbour above or below them. */
      moveUp: "Move cues up",
      moveDown: "Move cues down",
      /** The two sort submenus and the two keys each offers (interface-spec 3.3 items 16, 17). */
      sortAll: "Sort all cues",
      sortSelected: "Sort selected cues",
      byStart: "By start time",
      byEnd: "By end time",
    },
    audio: {
      title: "Audio",
      /** For a track the file gives neither a title nor a language, numbered as the file lists them. */
      useVideoTrack: "Use the video's audio",
      track: "Track",
    },
    help: {
      title: "Help",
      contents: "Help contents",
      website: "Project website",
      reportBug: "Report a bug",
      checkUpdates: "Check for updates",
      eventLog: "Event log",
      about: "About Sublore",
    },
    /** Drawn beside a menu item. Each key is handled by whichever component owns that command. */
    keys: {
      new: "Ctrl+N",
      cut: "Ctrl+X",
      copy: "Ctrl+C",
      deleteCues: "Ctrl+Delete",
      paste: "Ctrl+V",
      pasteOver: "Ctrl+Shift+V",
      selectAll: "Ctrl+A",
      openSubtitle: "Ctrl+O",
      openVideo: "Ctrl+Shift+O",
      save: "Ctrl+S",
      saveAs: "Ctrl+Shift+S",
      undo: "Ctrl+Z",
      redo: "Ctrl+Y",
      quit: "Ctrl+Q",
      /** Help contents, the one accelerator a text field never keeps (keyboard-tasks F5). */
      manual: "F1",
      preferences: "Alt+O",
      videoJumpTo: "Ctrl+G",
      videoPlay: "Ctrl+P",
      videoStepBack: "Left",
      videoStepForward: "Right",
      videoJumpBack: "Alt+Left",
      videoJumpForward: "Alt+Right",
      videoPrevBoundary: "Ctrl+Left",
      videoNextBoundary: "Ctrl+Right",
      videoToCueStart: "Ctrl+1",
      videoToCueEnd: "Ctrl+2",
      startToPlayhead: "Ctrl+3",
      endToPlayhead: "Ctrl+4",
      shift: "Ctrl+I",
      shiftToPlayhead: "Ctrl+6",
      find: "Ctrl+F",
      /** A function key, and the two leads below, are the accelerators with no modifier at all,
          which is why the field rule has two halves (interface-spec 3.4, 3.2). */
      findNext: "F3",
      replace: "Ctrl+H",
      /** Bare letters, run only outside a text field where they are not a character. */
      /** The reference's own timing keys, taken as they are. See BACKLOG.md N105. */
      playLine: "R",
      /** The reference puts these five on the numpad, which is its own tradeoff and stays
       *  its own: a laptop without one loses them. See BACKLOG.md N106. */
      /** The two splits at the current frame, on the reference's own keys. See BACKLOG.md N110. */
      splitBeforePlayhead: "Ctrl+D",
      splitAfterPlayhead: "Ctrl+Shift+D",
      /** Second keys, answered but not drawn: the reference gives these commands two, and the
       *  drawn one stays the one a machine without a numpad can press. See BACKLOG.md N109. */
      commitTiming: "G",
      commitTimingNumpad: "Num Enter",
      videoStepBackNumpad: "Ctrl+Num 4",
      videoStepForwardNumpad: "Ctrl+Num 6",
      /** The numpad half of the reference's `Always` set, which is the binding that works whatever
       *  has the focus there. Its Audio-only letters are not taken. See BACKLOG.md N107. */
      stopPlaying: "Num 8",
      startEarlier: "Num 4",
      startLater: "Num 6",
      endEarlier: "Num 7",
      endLater: "Num 9",
      playSelection: "Num 5",
      playBefore: "Num 1",
      playAfter: "Num 3",
      prevCue: "Ctrl+Num 8",
      nextCue: "Ctrl+Num 2",
      playFirst: "E",
      playLast: "D",
      playToEnd: "T",
      leadIn: "C",
      leadOut: "V",
      moveCuesUp: "Alt+Up",
      moveCuesDown: "Alt+Down",
    },
    errors: {
      quitFailed: "Sublore could not quit. Close the window instead.",
    },
  },
  /** The find band, in both its modes: replace adds a second field and two buttons to the same row. */
  find: {
    title: "Find",
    replaceTitle: "Find and replace",
    needleLabel: "Find",
    replaceLabel: "Replace with",
    matchCase: "Match case",
    regex: "Regular expression",
    /** The selection, whatever its size: one selected cue restricts too (F4b). */
    inSelection: "Selected cues only",
    findNext: "Find next",
    replace: "Replace",
    replaceAll: "Replace all",
    noMatch: "No match",
    badPattern: "That expression is not one this can read. Nothing was changed.",
    /** A pattern that backtracks for ever. The document is untouched and the window kept answering. */
    tooSlow: "That expression takes too long to run. Nothing was changed.",
    /** `{count}` is a whole number. Drawn after a replace all, so the count is never a guess. */
    replaced: {
      one: "1 replaced",
      other: "{count} replaced",
    },
    close: "Close",
  },
  /**
   * What a module file that would not load is reported as. The core never learns what a module is
   * for, so every one of these is about the file and the numbers and nothing else.
   */
  modules: {
    line: "Sublore found {file} but could not use it: {reason}",
    notAModule: "it is not a Sublore module.",
    versionDiffers:
      "it was built for interface version {theirs} and this build speaks version {ours}.",
    revisionTooNew: "it needs interface revision {theirs} and this build offers {ours}.",
    tableSize: "its interface table is {theirs} bytes and this build's is {ours}.",
    refused: "it would not start, and reported code {code}.",
    unopenable: "the file could not be opened.",
    /** In About, above the list. Absent entirely when nothing loaded and nothing was refused. */
    heading: "Modules",
    /** In About, for a module that loaded. */
    loaded: "{file}, loaded",
    /** In About, when the launch asked for none. */
    skipped: "Modules were not looked for: the app was started with --no-modules.",
    /**
     * While a module's own work runs. Every word here is about work and about stopping it: the
     * core has no name for what any module does, and none of these may acquire one.
     */
    work: {
      /** Shown until the module says something of its own, and never instead of what it says. */
      working: "Working…",
      stop: "Stop",
      count: "{done} of {total}",
    },
    /** The table a module fills. About tables, for the same reason. */
    panel: {
      /** A percent cell, whose number the module gave and the core does not check. */
      percent: "{value}%",
      close: "Close",
    },
  },
  about: {
    title: "About Sublore",
    tagline: "Translation memory for subtitles.",
    version: "Version {version}",
    licence: "GNU General Public License, version 3 or later.",
    close: "Close",
  },
  /** The four numbers a translator may change (interface-spec 9.6). */
  preferences: {
    title: "Preferences",
    leadIn: "Lead-in (ms)",
    leadOut: "Lead-out (ms)",
    newCue: "New cue length (ms)",
    cpsLimit: "Reading rate limit (characters a second)",
    refused: "Each of these is a whole number, and none of them is negative.",
    confirm: "Save",
    cancel: "Cancel",
  },
  /** The event log window (interface-spec 9.12). */
  eventLog: {
    title: "Event log",
    /** Before the app has said anything, which is a moment rather than a state. */
    empty: "Nothing has been logged yet.",
    close: "Close",
  },
  /** Help's update check (interface-spec 3.8), which runs once and only when it is asked for. */
  update: {
    title: "Check for updates",
    asking: "Asking whether there is a newer version.",
    upToDate: "This is the newest version of Sublore.",
    /** `{version}` is the release's own name, as the project tagged it. */
    newer: "Sublore {version} is available.",
    open: "Open the release page",
    /** The check, not the app: nothing about the running copy has gone wrong. */
    failed: "The check could not be made. Your copy of Sublore is unaffected.",
    close: "Close",
  },
  /** The audio track menu. See BACKLOG.md N27. */
  audio: {
    /** Said when a track switch is refused: a command that does nothing must not do it silently. */
    switchRefused: "That audio track could not be switched to. The panel is still on the last one.",
  },
  /** Paste over's field dialog (N45, docs/paste-over-tasks.md). The eleven in the reference's order. */
  pasteOver: {
    title: "Select fields to paste over",
    lead: "Take these from the clipboard, and leave the rest as they are:",
    comment: "Comment",
    layer: "Layer",
    start: "Start time",
    end: "End time",
    style: "Style",
    actor: "Actor",
    marginL: "Margin left",
    marginR: "Margin right",
    marginV: "Margin vertical",
    effect: "Effect",
    text: "Text",
    /** The four quick buttons above the list. They change the ticks and confirm nothing. */
    all: "All",
    none: "None",
    times: "Times",
    onlyText: "Text only",
    confirm: "Paste over",
    cancel: "Cancel",
  },
  /** The Language dialog (interface-spec 3.7 item 12). One language today, English. */
  language: {
    title: "Language",
    prompt: "Please choose a language:",
    ok: "OK",
    cancel: "Cancel",
  },
  /** The charset dialog Open with encoding raises after the file picker (interface-spec 9.8). */
  openEncoding: {
    title: "Charset",
    prompt: "Choose charset code:",
    open: "Open",
    cancel: "Cancel",
  },
  /** What a command reports on the status bar's timed slot (interface-spec 1.5). */
  notices: {
    /** Keyed by TagMode, worded as the reference words them. */
    tagMode: {
      show: "ASS Override Tag mode set to show full tags.",
      simplify: "ASS Override Tag mode set to simplify tags.",
      hide: "ASS Override Tag mode set to hide tags.",
    },
  },
  /** The draggable edges between the panels (D1). Read aloud where a separator is announced. */
  shell: {
    videoSash: "Video panel width",
    gridSash: "Top block height",
    errors: {
      windowFloor:
        "Sublore could not stop the window being made too narrow for its controls. Widen the window if part of a bar is cut off.",
    },
  },

  video: {
    jumpTo: {
      title: "Jump to time",
      label: "Time",
      go: "Jump",
      cancel: "Cancel",
      refused: "That is not a time inside this media.",
    },
    details: {
      title: "Video details",
      file: "File",
      resolution: "Resolution",
      aspect: "Aspect ratio",
      fps: "Frame rate",
      frames: "Frames",
      duration: "Duration",
      codec: "Decoder",
      /** What a field says when the container carries no answer for it. */
      unknown: "not reported",
      close: "Close",
    },
    play: "Play",
    pause: "Pause",
    position: "Position",
    noFile: "No video open.",
    errors: {
      playerUnavailable: "The video player is not running. Restart Sublore.",
      invalidPath: "That path is empty or is not a file Sublore can read.",
      openFailed:
        "Sublore could not open this video. The file may be unreadable or in a format libmpv does not support.",
      openTimeout: "Opening this video took too long, so Sublore stopped waiting.",
      notLoaded: "Open a video first.",
      commandFailed: "The video player rejected that action.",
      playbackStopped: "Playback stopped before the end of the file.",
    },
  },
  project: {
    /** Over the tree, so the rail says what it is listing before anything is open. */
    cap: "Project",
    noProject: "No project open.",
    noEpisodes: "No episodes yet.",
    episodePlaceholder: "Episode name",
    episode: "{ordinal}. {title}",
    noFiles: "No files attached.",
    /** A rail row is narrow, so the row carries the file's name and its tooltip the rest. */
    file: "{role} · {path}",
    missing: "missing",
    roles: {
      media: "Video",
      source: "Source",
      target: "Target",
    },
    /** What right-clicking the rail opens, for anyone reaching it without seeing it. */
    menuLabel: "Project actions",
    menu: {
      createProject: "Create project…",
      openProject: "Open project…",
      closeProject: "Close project",
      deleteProject: "Delete project…",
      addEpisode: "Add episode…",
      attach: "Attach {role}…",
      renameEpisode: "Rename episode…",
      deleteEpisode: "Delete episode…",
      openFile: "Open",
      locateFile: "Locate…",
      detachFile: "Detach",
    },
    /** Every one of these is asked once and answered before anything changes (decision 24, D2). */
    ask: {
      cancel: "Cancel",
      addEpisodeTitle: "Add episode",
      addEpisodeConfirm: "Add",
      renameEpisodeTitle: "Rename episode",
      renameEpisodeConfirm: "Rename",
      closeProjectTitle: "Close project",
      closeProjectMessage: "Close {title}? Nothing on disk is touched.",
      closeProjectConfirm: "Close",
      deleteProjectTitle: "Delete project",
      deleteProjectMessage:
        "Delete the project in {folder}? Sublore removes its own project file there and leaves your video and subtitle files exactly where they are.",
      deleteProjectConfirm: "Delete project",
      deleteEpisodeTitle: "Delete episode",
      deleteEpisodeMessage: "Delete {episode}? The files attached to it stay on disk.",
      deleteEpisodeConfirm: "Delete episode",
      detachFileTitle: "Detach file",
      detachFileMessage: "Detach {name} from {episode}? The file stays on disk.",
      detachFileConfirm: "Detach",
    },
    deleted: "Deleted the project in {folder}. Your own video and subtitle files were not touched.",
    errors: {
      invalidPath: "That is not a folder Sublore can use.",
      folderNotFound: "There is no folder at that path.",
      notADirectory: "That path is not a folder.",
      alreadyAProject: "There is already a Sublore project in that folder. Open it instead.",
      noProjectHere: "There is no Sublore project in that folder.",
      notASubloreProject: "That folder holds a project.sublore file Sublore did not write.",
      databaseCorrupt: "That project file is damaged. Sublore left it exactly as it is.",
      schemaTooNew:
        "That project was made by a newer Sublore, which writes version {found}; this one reads version {supported}. Update Sublore to open it.",
      migrationFailed:
        "Sublore could not bring that project file up to date, so it left it at the version it was.",
      pathNotAbsolute: "That path does not start from the top of the drive.",
      pathNotUtf8: "Sublore cannot store that path. Move the file somewhere with a plainer name.",
      fileNotFound: "There is no file at that path.",
      notAFile: "That path is not a file.",
      duplicateFile: "That file is already attached to this episode.",
      episodeNotFound: "That episode is not in the project any more.",
      fileNotAttached: "That file is not attached to this episode any more.",
      noProjectOpen: "Open a project first.",
      writeFailed: "Sublore could not write to the project file. Check that the disk has room.",
      deleteFailed:
        "Sublore could not remove the project file. Check that the folder is not read-only.",
      permissionDenied: "Sublore is not allowed to use that folder.",
      queryFailed: "Sublore could not read that project file.",
      commandFailed: "Sublore could not finish that action. Restart Sublore if it happens again.",
    },
  },
  /**
   * The words on the waveform panel's own strip. Short because the strip sits in a column that can
   * be dragged narrow; each button carries the command's full label as its title and its accessible
   * name, so nothing here is the only place a control is named.
   */
  wavebar: {
    prevCue: "Prev",
    nextCue: "Next",
    playSelection: "Sel",
    playLine: "Line",
    stop: "Stop",
    playBefore: "Before",
    playAfter: "After",
    playFirst: "First",
    playLast: "Last",
    playToEnd: "To end",
    leadIn: "Lead in",
    leadOut: "Lead out",
    centreOnCue: "Centre",
    followCue: "Follow",
  },

  waveform: {
    sash: "Waveform height",
    canvas: "Waveform, arrows to scroll, plus and minus to zoom",
    noAudio: "This video has no audio, so there is no waveform to draw.",
    label: "Waveform",
    /** Shown in the status bar when a peak job fails. The detail is technical and stays in the log. */
    failed: "The waveform could not be read for this file. The video is unaffected.",
  },

  preview: {
    /**
     * Shown in the status bar when the open document could not be put on the video frame. It says
     * what is safe as well as what failed: a preview never writes the user's file, so nothing of
     * theirs is at stake here.
     */
    failed:
      "The subtitles could not be shown on the video. Your subtitle file and video are unchanged.",
  },

  subtitle: {
    /** The Project properties dialog: the script's own metadata, read-only in v1 (interface-spec 9.5). */
    properties: {
      title: "Project properties",
      scriptTitle: "Title",
      resolution: "Script resolution",
      wrapStyle: "Wrap style",
      /** Shown when the open format carries no script-level metadata, as SRT and VTT do not. */
      empty: "This format carries no script metadata.",
      /** A field the open file does not name. */
      unset: "not set",
      close: "Close",
    },
    /** Appended to the status line while the document differs from the file on disk. */
    dirty: "Unsaved changes",
    /** The window's own name, which is what a task bar shows with three episodes open (N57). */
    windowTitle: "{mark}{document} - Sublore",
    /** Leads the window name while there is unsaved work, and is empty when there is none. */
    windowTitleDirty: "* ",
    /** The window name for a document that has never had a file: a transcription, or no file yet. */
    windowTitleUntitled: "Untitled",
    /** Shown once the undo bound has dropped its oldest entries. */
    truncated: "Undo history is full, so the oldest edits can no longer be undone.",
    noFile: "No subtitle file open.",
    /** Shown only when the file starts with a UTF-8 byte-order mark. */
    bom: "BOM",
    cues: {
      one: "{count} cue",
      other: "{count} cues",
    },
    newlines: {
      lf: "LF",
      crlf: "CRLF",
      mixed: "Mixed line endings",
      none: "No line endings",
    },
    saved: "Saved a copy to {path}.",
    savedWithBackup: "Saved a copy to {path}. The file that was there is kept at {backup}.",
    savedFile: "Saved {path}.",
    savedFileWithBackup: "Saved {path}. The file that was there is kept at {backup}.",
    lineDetail: "Line {line} — {reason}",
    errors: {
      invalidPath: "That is not a subtitle file Sublore can read.",
      notAFile: "There is no file at that path.",
      tooLarge: "That file is bigger than Sublore opens as a subtitle (16 MB).",
      readFailed: "Sublore could not read that file.",
      unsupportedEncoding:
        "Sublore reads UTF-8 subtitles. Convert this file to UTF-8 and open it again.",
      unknownFormat: "Sublore opens SRT, VTT and ASS subtitles. That file is none of them.",
      parseFailed:
        "Sublore could not read this subtitle file, so it will not open it rather than risk changing it.",
      writeFailed: "Sublore could not write the copy. Check that the folder exists and has room.",
      backupFailed:
        "Sublore could not keep a backup of the existing file, so it did not overwrite it.",
      permissionDenied: "Sublore is not allowed to use that file.",
      noDocument: "Open a subtitle file first.",
      staleRevision:
        "Sublore and this list no longer agree about the file. Open it again before editing.",
      invalidCue: "That line is not in this file any more.",
      unencodableCharacter:
        "The document holds a character the chosen charset cannot write. Nothing was exported.",
      unwritableText:
        "This format cannot hold that text. Remove the blank line or the line break and try again.",
      editRefused: "Sublore did not make that change, so the file is exactly as it was.",
      unsavedChanges: "This file has changes that are not saved. Save them, or discard them.",
      noPath: "This document has never been saved, so Sublore does not know where to write it.",
      transcriptionGone:
        "Those cues are gone: another transcription has started since. Run it again.",
      commandFailed: "Sublore could not finish that action. Restart Sublore if it happens again.",
    },
    /**
     * What Edit beside the Style dropdown opens. Every field is one write and one undo step, and
     * the name is not among them: renaming a style rewrites every line that names it. See B10.
     */
    shiftTimes: {
      title: "Shift times",
      amount: "Amount",
      direction: "Direction",
      forward: "Forward",
      backward: "Backward",
      affect: "Affect",
      allLines: "All lines",
      selectedLines: "Selected lines",
      onwardLines: "Selection onward",
      which: "Times",
      bothTimes: "Start and end",
      startOnly: "Start only",
      endOnly: "End only",
      go: "Shift",
      cancel: "Cancel",
      refused: "That is not an amount of time to shift by.",
    },
    styleEditor: {
      /** The button beside the Style dropdown, which is where the reference's own row puts it. */
      edit: "Edit",
      title: "Style",
      fontname: "Font",
      fontsize: "Size",
      primary: "Primary colour",
      secondary: "Secondary colour",
      outline: "Outline colour",
      back: "Shadow colour",
      bold: "Bold",
      italic: "Italic",
      underline: "Underline",
      strikeout: "Strikeout",
      /** The headings of the dialog's groups, in the order the reference's own dialog has them. */
      font: "Font",
      colours: "Colours",
      margins: "Margins",
      border: "Outline",
      alignment: "Alignment",
      miscellaneous: "Miscellaneous",
      /** The border's width and the shadow's depth, which are not the two colours above them. */
      outlineWidth: "Outline",
      shadow: "Shadow",
      /** A border style rather than a flag: it writes 3 for the box and 1 for outline and shadow. */
      opaqueBox: "Opaque box",
      marginL: "Left",
      marginR: "Right",
      marginV: "Vertical",
      scaleX: "Scale X",
      scaleY: "Scale Y",
      angle: "Rotation",
      spacing: "Spacing",
      encoding: "Encoding",
      close: "Close",
    },
    /** Said while a list the interface asked for has not come back yet. */
    reading: "Reading…",
    /** Said on the status bar while a second document is open to read from. See S1. */
    sourceOpen: "Source: {document}",
    cueList: {
      label: "Cues",
      empty: "This file has no cues.",
      position: "#",
      number: "No.",
      start: "Start",
      end: "End",
      text: "Text",
      /** The document being read from. Drawn only while one is open. See side-by-side-tasks S1. */
      source: "Source",
      /** The ASS style the event names. Drawn only when some cue in the list names one. */
      style: "Style",
      /** The ASS `Name` field, under the word every editor puts on the column. */
      actor: "Actor",
      /** Characters per second, the reading rate of decision 24 A8. */
      cps: "CPS",
      /** Marks an ASS Comment: event, which a player does not draw. */
      comment: "Comment",
      /** Named for a reader reaching the grid's context menu without seeing it (interface-spec 3.9). */
      contextMenu: "Cue actions",
    },
    /** The box in the tools column that edits whichever line the cursor is on (T5). */
    currentLine: {
      label: "Current line",
      none: "No line to edit.",
      start: "Start",
      end: "End",
      /** In seconds, which is the scale a line's length is judged against. */
      duration: "Duration",
      /** The longest line's length, beside the rate that measures the same text per second. */
      characters: "Characters",
      cps: "CPS",
      text: "Text",
      /** Whether the line is one a player draws. Greyed on a format with no such distinction. */
      comment: "Comment",
      /** The ASS style the line names. Greyed on a document whose lines cannot hold one. */
      style: "Style",
      /** The ASS speaker field. Greyed on a document whose lines cannot hold one. */
      actor: "Actor",
      /** Opens the list of speakers this document already names. */
      actorNames: "Names in this file",
      /** The ASS effect field. Greyed on a document whose lines cannot hold one. */
      effect: "Effect",
      /** Opens the list of effects this document already uses. */
      effectValues: "Effects in this file",
      /** The ASS drawing order. Greyed on a document whose lines cannot hold one. */
      layer: "Layer",
      /**
       * The three ASS margins, in the order the format declares them. One letter each: the
       * reference gives them no written label at all and Sublore's bands always carry one, so this
       * is the shortest label that still says which is which. The spoken name is the long one.
       */
      marginL: "L",
      marginR: "R",
      marginV: "V",
      marginLName: "Left margin",
      marginRName: "Right margin",
      marginVName: "Vertical margin",
      /**
       * The four colours a line can override, spoken in full. Row three of the reference draws them
       * as swatches with no words, and a button here says what it is.
       */
      colours: {
        primary: "Primary colour",
        secondary: "Secondary colour",
        outline: "Outline colour",
        shadow: "Shadow colour",
      },
      /** The picker's own field, which takes a colour written the way the web writes one. */
      /** The spectrum square, its hue slider and the swatch beside them (N39). */
      /** The dropdown above the square, and the five it offers in the reference's order (N53). */
      spectrumMode: "Spectrum mode",
      spectrumModes: {
        rgbR: "RGB/R",
        rgbG: "RGB/G",
        rgbB: "RGB/B",
        hslL: "HSL/L",
        hsvH: "HSV/H",
      },
      /** The eyedropper beside the preview, and what it says when no portal answers (N54). */
      eyedropper: "Pick a colour from the screen",
      eyedropperMark: "⊙",
      eyedropperUnavailable: "The eyedropper needs a desktop portal, and this desktop has none.",
      colourPreview: "The colour chosen",
      assNotation: "ASS",
      rgbNotation: "RGB",
      hsvNotation: "HSV",
      hslNotation: "HSL",
      colourValue: "Colour, as #RRGGBB",
      /**
       * How see-through the colour is. ASS counts transparency and not opacity, so 0 is solid and
       * 255 is invisible, and the field says the word rather than the number's direction.
       */
      transparency: "Clear",
      transparencyName: "Transparency, 0 solid to 255 invisible",
      /** The font this line is drawn in, over what the style says. See edit-bar-tasks.md B12. */
      font: "Font",
      fontFamily: "Font family",
      fontFamilies: "Families installed on this machine",
      fontSize: "Size",
      fontApply: "Use this font",
      /**
       * Said by the field itself, before anything is sent, so the sentence names what is wrong with
       * this value rather than the one shared refusal below. Keyed by `FieldRefusal`.
       */
      refusals: {
        comma: "A comma separates the fields of a line, so a name cannot hold one.",
        lineBreak: "A name is one line, so it cannot hold a line break.",
        control: "A name cannot hold an invisible control character.",
      },
    },
    reasons: {
      expectedTiming: "a timing line was expected here",
      badTimecode: "a timestamp is not valid",
      timecodeOutOfRange: "a timestamp is past the longest time Sublore can hold",
      missingVttHeader: "the file does not start with WEBVTT",
      missingFormatLine: "an event appears before its section's Format line",
      missingTimingFields: "the Format line declares no Start or End field",
      fieldCountMismatch: "this line has fewer fields than the Format line declares",
      badSectionHeader: "a section header has no closing bracket",
      unexpectedEndOfFile: "the file ends in the middle of a cue",
    },
  },
  asr: {
    /** Over the panel the menu opens, which is absent until it is asked for (T4). */
    panelTitle: "Transcription",
    close: "Close",
    modelLabel: "Model",
    /** `{size}` is whole megabytes; the separator is punctuation, not copy. */
    modelOption: "{id} · {size} MB · {state}",
    modelStates: {
      missing: "not downloaded",
      partial: "partly downloaded",
      ready: "ready",
      corrupt: "damaged",
    },
    download: "Download",
    cancelDownload: "Stop",
    downloading: "Downloading {id}… {percent}%",
    gpuLabel: "Use GPU when available",
    start: "Transcribe",
    cancel: "Cancel",
    /** Offered while a finished run's cues are not the open document: how a replacement the user
     * cancelled is asked for again. */
    use: "Use these cues",
    idle: "No transcription yet.",
    extracting: "Extracting audio…",
    transcribing: "Transcribing… {percent}%",
    cues: {
      one: "{count} cue",
      other: "{count} cues",
    },
    backends: {
      gpu: "GPU",
      cpu: "CPU",
    },
    /** Shown when the user asked for the GPU and the run happened on the processor anyway. */
    fellBackToCpu: "No graphics acceleration was available, so the processor did the work.",
    errors: {
      binaryMissing:
        "Sublore cannot find the transcription engine. Run scripts/build-whisper.sh, then restart Sublore.",
      binaryUnrunnable:
        "Sublore found the transcription engine but could not start it. Build it again with scripts/build-whisper.sh.",
      ffmpegMissing:
        "Sublore needs ffmpeg to read audio from a video. Install ffmpeg and try again.",
      mediaUnreadable: "Sublore could not read any audio from that file.",
      modelMissing: "That model is not on this computer yet. Download it first.",
      modelCorrupt: "That model file is damaged. Download it again.",
      modelRejected: "The transcription engine could not load that model. Download it again.",
      noInput: "The transcription engine could not open the audio Sublore extracted.",
      badArguments: "The transcription engine rejected how Sublore called it.",
      noOutput:
        "The transcription engine produced nothing Sublore could read. Try another model, or check the log.",
      emptyTranscript: "No speech was found in this audio.",
      stalled: "The transcription stopped responding, so Sublore ended it.",
      cancelled: "Transcription cancelled.",
      scratchFailed:
        "Sublore could not make room for the audio it extracts. Check the free space on this disk.",
      internal: "Sublore could not finish the transcription. Restart Sublore if it happens again.",
      networkFailed:
        "The download stopped. What arrived is kept, so downloading again carries on from there.",
      downloadWriteFailed:
        "Sublore could not write the model to disk. Check the free space and the permissions.",
      sizeMismatch: "The download was not the size Sublore expects, so it was refused.",
      checksumMismatch:
        "That model file failed its checksum, so Sublore refused it. Download it again.",
      busy: "Sublore is already working on that. Wait for it to finish, or stop it first.",
      commandFailed: "Sublore could not finish that action. Restart Sublore if it happens again.",
    },
  },
} as const;
