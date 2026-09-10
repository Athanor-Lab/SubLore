import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { choosePath, type ChooseKind } from "./chooser";
import { openHelpLink } from "./help";
import AboutDialog from "./components/AboutDialog";
import UpdateDialog from "./components/UpdateDialog";
import EventLogDialog from "./components/EventLogDialog";
import StyleEditor from "./components/StyleEditor";
import CueList from "./components/CueList";
import { type TagMode } from "./components/cueView";
import CurrentLine, { type ColourSlot } from "./components/CurrentLine";
import FindBar, { type FindMode } from "./components/FindBar";
import MenuBar from "./components/MenuBar";
import ModulePanel from "./components/ModulePanel";
import ModuleWorkBand from "./components/ModuleWorkBand";
import ProjectRail from "./components/ProjectRail";
import Sash from "./components/Sash";
import StatusBar from "./components/StatusBar";
import Toolbar from "./components/Toolbar";
import WaveBar, { type WaveBarButton } from "./components/WaveBar";
import Waveform, { type LiveTimes } from "./components/Waveform";
import TranscribePanel from "./components/TranscribePanel";
import VideoControls, { transportReadings } from "./components/VideoControls";
import VideoDetailsPanel from "./components/VideoDetails";
import ScriptProperties from "./components/ScriptProperties";
import JumpToTime from "./components/JumpToTime";
import LanguageDialog from "./components/LanguageDialog";
import OpenEncoding from "./components/OpenEncoding";
import PasteOverDialog from "./components/PasteOverDialog";
import PreferencesDialog from "./components/PreferencesDialog";
import ShiftTimes, { type ShiftRequest } from "./components/ShiftTimes";
import VideoStage from "./components/VideoStage";
import { type VideoDetails } from "./types/video";
import { useAudioPeaks } from "./hooks/useAudioPeaks";
import { useCueSelection } from "./hooks/useCueSelection";
import { LayerContext, useLayerRegistry } from "./hooks/useLayers";
import { useAudioTracks } from "./hooks/useAudioTracks";
import { type PanelLayout, useLayout } from "./hooks/useLayout";
import { useWindowFloor } from "./hooks/useWindowFloor";
import { type PasteFields, usePasteFields } from "./hooks/usePasteFields";
import { usePreferences } from "./hooks/usePreferences";
import { usePreview } from "./hooks/usePreview";
import { useContributions, type Contribution } from "./hooks/useContributions";
import { useModulePanels } from "./hooks/useModulePanels";
import { useModuleWork } from "./hooks/useModuleWork";
import { useModules, refusalLine } from "./hooks/useModules";
import { useSearch, type SearchOutcome } from "./hooks/useSearch";
import { useFonts } from "./hooks/useFonts";
import { useSourceFile } from "./hooks/useSourceFile";
import { fileName, useProject } from "./hooks/useProject";
import { useStartupFiles } from "./hooks/useStartupFiles";
import { useSubtitleFile, type RowsMoved } from "./hooks/useSubtitleFile";
import { useTimedMessage } from "./hooks/useTimedMessage";
import { useTranscription } from "./hooks/useTranscription";
import { useVideoPlayer } from "./hooks/useVideoPlayer";
import { en } from "./i18n/en";
import { fill } from "./i18n/format";
import { setWindowTitle, windowTitle } from "./title";
import { commandFor, ownsTheKeyboard } from "./keyboard";
import { narrowest, scrollbarWidth, widestRow } from "./measure";
import { requestQuit } from "./quit";
import { replaceOne, type Match, type Query } from "./search";
import {
  runCommand,
  SEPARATOR,
  type Command,
  type CommandId,
  type CommandRegistry,
  type Menu,
  type Separator,
} from "./types/chrome";
import { type EpisodeFileView } from "./types/project";
import { type CueRow, type ScriptInfoView, type StyleFlagName } from "./types/subtitle";
import "./App.css";

/**
 * The registry key a contributed item gets: its module's position and the module's own id.
 *
 * Generated rather than written, which is what keeps the open repository free of any word a module
 * chose for itself (interface-spec 2.7, module-abi.md section 7).
 */
function moduleCommandId(item: Contribution): CommandId {
  return `module.${item.module}-${item.id}`;
}

/**
 * The panel a contributed item belongs to, or zero for one that belongs to none.
 *
 * A panel's own id is the primary row action, and an item whose parent is a panel is a secondary
 * one: both send that panel's id, and everything else sends zero (module-abi.md 4.1).
 */
function panelOf(item: Contribution, all: Contribution[]): number {
  if (item.kind === "panel") {
    return item.id;
  }
  const parent = all.find(
    (candidate) =>
      candidate.kind === "panel" &&
      candidate.module === item.module &&
      candidate.id === item.parent,
  );
  return parent?.id ?? 0;
}

/*
 * Every bound below was read off the rendered shell at 1024x700, never worked out on paper: W6 put
 * a ceiling under its own panel's default height that way and the panel could not be dragged back.
 *
 * Each is the number at 100 per cent, and each is taken against the interface size before it is
 * used (S2). Each was read again at 90 and at 150, in WebKitGTK because that is the engine the
 * app's webview is, and both ends are written beside it.
 *
 * Reading a bound once is not enough for a bound the fonts decide, which is why the video panel's
 * floor is no longer here: it is measured off the row it has to keep on one line, every time the
 * interface size or that row's copy changes. See `widestRow` in src/measure.ts.
 */

/**
 * A frozen contract with `MIN_WAVEFORM_HEIGHT` in src-tauri/src/layout.rs, which clamps the file.
 * The one bound with nothing to measure: it is the room the wave needs on either side of its middle
 * line, so it moves with the size to keep the panel's proportion, 58 at 90 and 96 at 150. Only at
 * 100 does it still equal the file guard, which does not scale, so a height left at 58 is stored as
 * 64 and opens there.
 */
const MIN_WAVEFORM_HEIGHT = 64;

/**
 * What the current line keeps: its times row and one line of text under it. Measured against the
 * layout at the smallest supported window, where the tools column is 216px and the default gives
 * the line 84 of them. A larger number here would put the ceiling under the default height and the
 * panel could never be dragged back to it.
 *
 * Read again: the line needs 60 at 90 per cent and 66 at 100, which the scaled bound covers. At 125
 * and 150 the times row wraps onto three rows in the column the default layout leaves and the line
 * needs 101 and 119, more than the bound. What is short there is the stored default height, which
 * is a pixel count that does not move with the interface; a floor tall enough to cover it would be
 * the W6 ceiling above.
 */
const MIN_CURRENT_LINE = 72;

/** The pan the two scroll commands make: 128 device px whatever the zoom (interface-spec 5). */
const WAVE_SCROLL_PX = 128;

/**
 * How many lines of its own type the current line's text box asks for. A translator writes one or
 * two and reads a third; past that the box is taking height nothing in it uses. Fixed here because
 * nobody has asked for it to move, which is a different reason from the one CPS had: that one was
 * fixed for want of a preferences surface, and question 42 put it in the one that now exists (N103).
 */
const TEXT_BOX_LINES = 3;

/** What the text box was given over the lines it asks for, which is height nothing is using. */
function textSlack(text: Element): number {
  const style = getComputedStyle(text);
  const line = Number.parseFloat(style.lineHeight);
  // A line height left at `normal` has no pixel count to multiply, so claim no slack rather than
  // claim the whole box: too little ceiling is a defect, too much is only the ceiling we had.
  if (!Number.isFinite(line) || line <= 0) {
    return 0;
  }
  // `clientHeight` counts the padding, so the height the box asks for has to count it too.
  const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
  const wanted = line * TEXT_BOX_LINES + (Number.isFinite(padding) ? padding : 0);
  return Math.max(0, text.clientHeight - wanted);
}

/**
 * The current line as the interface draws it, not as this document fills it: every field emptied of
 * its value and every control live.
 *
 * A field is as wide as it is whether or not anything is written in it, and whether or not the open
 * format can hold what it holds, but the engine reads a filled field a pixel wider than an empty
 * one. Measured as it stands, the column's floor would move when a file was opened, which is the
 * one thing it may not do (grid-columns-tasks.md G3).
 */
function asAnEmptyLine(panel: HTMLElement): void {
  for (const control of panel.querySelectorAll("input, select, textarea, button")) {
    if (control instanceof HTMLButtonElement) {
      control.disabled = false;
      continue;
    }
    if (
      control instanceof HTMLInputElement ||
      control instanceof HTMLSelectElement ||
      control instanceof HTMLTextAreaElement
    ) {
      control.disabled = false;
      control.value = "";
    }
  }
}

/**
 * The narrowest tools column whose current line still fits the height the column gives it: at 176
 * the times row wraps onto three rows and the line needs the 84px it has, at 160 it wraps onto four
 * and needs 94. The fourth row arrives at 157 at 90 per cent and at 258 at 150, and the scaled
 * bound stops above both.
 */
const MIN_TOOLS_WIDTH = 176;

/**
 * The video column's own floor: the transport measures 46px and the stage is never smaller than its
 * own transport. What the tools column needs is taller than this and is measured below, live. A
 * frozen contract with `MIN_TOP_HEIGHT` in src-tauri/src/layout.rs, which clamps the file, and one
 * that holds at 100 only: the guard does not scale.
 *
 * The transport measures 41.6 at 90 per cent and 67 at 150, so twice it is 83.1 and 133.9 against a
 * scaled 82.8 and 138. The third of a pixel it falls short by at 90 is the transport's 1px border,
 * which is a pixel at every size.
 */
const MIN_TOP_HEIGHT = 92;

/**
 * The grid's header measured 25px and a row 28, so this is the header and three rows. The one bound
 * that does not scale whole: `ROW_HEIGHT` in CueList.tsx is a fixed 28 at every interface size and
 * only the header moves, measuring 23.2 at 90 per cent and 36 at 150, which puts the floor at 107.2
 * and 120. A scaled 109 would give 98 and 164, and 98 clips the third row, so the header alone is
 * scaled and it is not scaled downwards: at 90 the bound stays 109, two pixels over what fits.
 */
const MIN_GRID_HEIGHT = 109;

/** The part of the bound above that moves with the interface size. */
const MIN_GRID_HEAD = 25;

/**
 * The four inline style flags, in the order row three of the panel draws them. Each writes its own
 * override tag into the line's text and is its own undo step. See edit-bar-tasks.md B11.
 */
/**
 * Put `inserted` into `text` at `at`, counting `at` in UTF-8 bytes the way the backend counts a
 * caret. A code-unit slice would land in the wrong place the moment a line carries a character
 * outside the Latin block, which a translation usually does. See edit-bar-tasks.md B13.
 */
function spliceUtf8(text: string, at: number, inserted: string): string {
  const bytes = new TextEncoder().encode(text);
  const cut = Math.min(Math.max(at, 0), bytes.length);
  const decoder = new TextDecoder();
  return decoder.decode(bytes.slice(0, cut)) + inserted + decoder.decode(bytes.slice(cut));
}

/**
 * The four panel sets the View menu offers, in the order it draws them, with what each one needs
 * before it can be picked. See interface-spec 3.7.
 */
const LAYOUTS: {
  panel: PanelLayout;
  /** The id's own spelling, hyphenated the way every other command id is. */
  token: string;
  label: string;
  needs: "none" | "video" | "audio" | "both";
}[] = [
  { panel: "gridOnly", token: "grid-only", label: en.menu.view.layoutGridOnly, needs: "none" },
  { panel: "videoGrid", token: "video-grid", label: en.menu.view.layoutVideoGrid, needs: "video" },
  {
    panel: "waveformGrid",
    token: "waveform-grid",
    label: en.menu.view.layoutWaveformGrid,
    needs: "audio",
  },
  { panel: "full", token: "full", label: en.menu.view.layoutFull, needs: "both" },
];

/** The three ways the grid draws override tags, in the order View lists them. */
const TAG_MODES: { mode: TagMode; label: string }[] = [
  { mode: "show", label: en.menu.view.tagsShow },
  { mode: "simplify", label: en.menu.view.tagsSimplify },
  { mode: "hide", label: en.menu.view.tagsHide },
];

const STYLE_FLAGS: { id: CommandId; flag: StyleFlagName; label: string }[] = [
  { id: "edit.style-bold", flag: "bold", label: en.menu.edit.bold },
  { id: "edit.style-italic", flag: "italic", label: en.menu.edit.italic },
  { id: "edit.style-underline", flag: "underline", label: en.menu.edit.underline },
  { id: "edit.style-strikeout", flag: "strikeout", label: en.menu.edit.strikeout },
];

/**
 * The four colours as registry commands, with the keys the reference gives them. They open the
 * picker the panel's own buttons open; the buttons stay, because a colour is picked with the mouse
 * more often than with a key.
 */
const COLOUR_COMMANDS: {
  id: CommandId;
  slot: ColourSlot;
  label: string;
  accelerator: string;
}[] = [
  {
    id: "edit.colour-primary",
    slot: "primary",
    label: en.menu.edit.colourPrimary,
    accelerator: en.menu.keys.colourPrimary,
  },
  {
    id: "edit.colour-secondary",
    slot: "secondary",
    label: en.menu.edit.colourSecondary,
    accelerator: en.menu.keys.colourSecondary,
  },
  {
    id: "edit.colour-outline",
    slot: "outline",
    label: en.menu.edit.colourOutline,
    accelerator: en.menu.keys.colourOutline,
  },
  {
    id: "edit.colour-shadow",
    slot: "shadow",
    label: en.menu.edit.colourShadow,
    accelerator: en.menu.keys.colourShadow,
  },
];

/** What a recent-video row shows: the file's own name, which is what a person recognises. A path
 * with no separator is its own name. */
function recentLabel(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

/**
 * The new order a move up or down gives, the way the reference's `move_one` does it: each selected
 * cue trades places with the nearest unselected cue on the side it moves toward, walked top to
 * bottom, and a cue with nothing unselected to trade with stays put. Down is the same walk over the
 * reversed list, which is how the reference reuses one routine for both.
 *
 * Returns the contiguous run that changed, its new order (a permutation of `from..from + length`),
 * and where the selected cues landed, or null when nothing moves because the whole selection is
 * already against the edge. See docs/reorder-tasks.md.
 */
type ReorderRun = { from: number; order: number[]; after: number[] };

/**
 * From a full permutation `arr` (`arr[position]` is the original index now at that position), the
 * contiguous run that actually changed, its order, and where the selected cues landed so the
 * selection can follow them. Null when nothing moved. Shared by move and sort: the backend edit
 * takes one run, and the unchanged prefix and suffix are not worth rewriting.
 */
function runFromPermutation(arr: number[], selected: ReadonlySet<number>): ReorderRun | null {
  const count = arr.length;
  let from = 0;
  while (from < count && arr[from] === from) {
    from += 1;
  }
  if (from === count) {
    return null;
  }
  let to = count - 1;
  while (to > from && arr[to] === to) {
    to -= 1;
  }
  const order = arr.slice(from, to + 1);
  const after: number[] = [];
  for (let position = 0; position < count; position += 1) {
    if (selected.has(arr[position])) {
      after.push(position);
    }
  }
  return { from, order, after };
}

function reorderForMove(
  count: number,
  selected: ReadonlySet<number>,
  down: boolean,
): ReorderRun | null {
  const arr = Array.from({ length: count }, (_, index) => index);
  if (down) {
    arr.reverse();
  }
  let prev = -1;
  let moved = 0;
  for (let at = 0; at < count && moved < selected.size; at += 1) {
    if (!selected.has(arr[at])) {
      prev = at;
    } else if (prev !== -1) {
      [arr[at], arr[prev]] = [arr[prev], arr[at]];
      prev = at;
      moved += 1;
    }
  }
  if (down) {
    arr.reverse();
  }
  return runFromPermutation(arr, selected);
}

/**
 * The permutation a sort gives: the whole document by `key`, or the selected cues among the
 * positions they occupy, others left where they are. Stable, so equal keys keep the order they had.
 * Null when it is already in that order, or the selected sort has fewer than two to sort. Mirrors
 * the reference's grid/sort. See docs/reorder-tasks.md.
 */
function reorderForSort(
  cues: readonly { startMs: number; endMs: number }[],
  selected: ReadonlySet<number>,
  key: "start" | "end",
  selectedOnly: boolean,
): ReorderRun | null {
  const count = cues.length;
  const keyOf = (index: number) => (key === "start" ? cues[index].startMs : cues[index].endMs);
  const arr = Array.from({ length: count }, (_, index) => index);
  if (selectedOnly) {
    const positions = [...selected].filter((index) => index < count).sort((one, two) => one - two);
    if (positions.length < 2) {
      return null;
    }
    const sorted = [...positions].sort((one, two) => keyOf(one) - keyOf(two));
    positions.forEach((position, rank) => {
      arr[position] = sorted[rank];
    });
  } else {
    if (count < 2) {
      return null;
    }
    arr.sort((one, two) => keyOf(one) - keyOf(two));
  }
  return runFromPermutation(arr, selected);
}

export default function App() {
  // Every HTML layer registers here while it is open, and the video surface hides for as long as
  // the set is not empty (decision 1, T8).
  const layers = useLayerRegistry();
  // The document being read from while translating, held apart from the one being written so that
  // no edit can reach it. See side-by-side-tasks.md S1.
  const source = useSourceFile();
  // Read once and only when the font picker asks, because it costs a few hundred file reads (B12).
  const fonts = useFonts();
  // The user's own expression never runs on this thread: it runs where it can be killed (F4a).
  const search = useSearch();
  // Read once at startup; the scan itself ran before this window existed (module-abi.md 3.5).
  const modules = useModules();
  const contributions = useContributions();
  const peaks = useAudioPeaks();
  const { layout, changeLayout, storeLayout } = useLayout();
  // The root declaration in shell.css reads this custom property; nothing else may set it (S1).
  // Before the paint, and before the effect below it, which measures type this size decides.
  useLayoutEffect(() => {
    if (layout !== null) {
      document.documentElement.style.setProperty(
        "--interface-scale",
        String(layout.interfaceScale),
      );
    }
  }, [layout?.interfaceScale]);
  // Decision 24 A4: View arrives with the first panel worth hiding. The choice lasts the session;
  // only the height outlives it (W6).
  /** Which panels the window draws, stored rather than remembered for this session alone (3.7). */
  const panels: PanelLayout = layout?.panels ?? "full";
  const videoShown = panels === "videoGrid" || panels === "full";
  const waveformShown = panels === "waveformGrid" || panels === "full";
  // The audio region: the panel, its strip and the edge under them, drawn only when there are peaks
  // to draw and View has not turned them off. A panel with no provider takes no space. Declared
  // here because the effect that resolves the column's bounds is keyed on it.
  const audioPanelShown = waveformShown && peaks.filled > 0;
  const toolsRef = useRef<HTMLElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLElement>(null);
  // Null until the transport has been measured, which is before the first paint: a floor of zero
  // would be no floor at all, and a number here would be a floor read on one machine's fonts.
  const [transportFloor, setTransportFloor] = useState<number | null>(null);
  /** What the current line cannot be drawn narrower than, which is the column's floor. Null until read. */
  const [lineFieldFloor, setLineFieldFloor] = useState<number | null>(null);
  const [frame, setFrame] = useState({
    videoWidth: 0,
    videoHeight: 0,
    sashWidth: 0,
    stageWidth: 0,
    stageHeight: 0,
    toolsWidth: 0,
    toolsHeight: 0,
    lineHeight: 0,
    lineContent: 0,
    topWidth: 0,
    railWidth: 0,
    gridHeight: 0,
  });
  /** The panel's own centring, filled in by the panel: only it knows where its window is. */
  const centreOnCue = useRef<() => void>(() => {});
  /** The waveform's own pan, filled by the panel, for the two scroll commands (A and F). */
  const scrollWave = useRef<(pixels: number) => void>(() => {});
  /** The pair a hand is holding on the panel, so playing the selection plays where it is now. */
  const liveTimes = useRef<LiveTimes>(null);
  const {
    state,
    position,
    picture,
    errorCode,
    open,
    close: closeVideo,
    togglePlayback,
    play: playVideo,
    pause: pauseVideo,
    seek,
    playRange,
    details: readVideoDetails,
    step: stepVideo,
    setRegion,
  } = useVideoPlayer(layers.covered);
  // Above the hooks that need it: a hook that says something has to be able to say it.
  const [notice, say] = useTimedMessage();
  const audio = useAudioTracks(state.path, state.status === "ready", say);
  // The videos opened lately: read once, drawn as the Video menu's recent list, and remembered on
  // every open however it happens, so the list is right whether a video came from the chooser, the
  // command line or the list itself. See recent.rs and interface-spec 3.5 item 3.
  const [recents, setRecents] = useState<string[]>([]);
  useEffect(() => {
    void invoke<{ videos: string[] }>("recent_read").then((recent) => setRecents(recent.videos));
  }, []);
  useEffect(() => {
    if (state.status === "ready" && state.path !== null) {
      void invoke<{ videos: string[] }>("recent_remember", { path: state.path }).then((recent) =>
        setRecents(recent.videos),
      );
    }
  }, [state.status, state.path]);
  // The two states the grid indexes by row live below, so the patch that moves rows reaches them
  // through a box rather than directly: the document is read before the selection exists.
  const rowsMovedRef = useRef<RowsMoved>(() => {});
  const selectRunRef = useRef<(from: number, to: number) => void>(() => {});
  const selectRowsRef = useRef<(rows: number[]) => void>(() => {});
  /**
   * What the next patch is to leave selected, set by the command that asks for it and read by the
   * patch it causes: the rows a paste, an insert or a duplicate lands are the rows the translator
   * carries on from. Read from the patch rather than after the call, so an edit that was refused,
   * and made no patch, moves no cursor onto a row that was never written.
   */
  const landing = useRef<{ rows: number[] } | "inserted" | null>(null);
  const onRowsMoved = useCallback<RowsMoved>((at, removed, inserted) => {
    rowsMovedRef.current(at, removed, inserted);
    const wanted = landing.current;
    landing.current = null;
    if (wanted === null) {
      return;
    }
    if (wanted === "inserted") {
      if (removed === 0 && inserted > 0) {
        selectRunRef.current(at, at + inserted - 1);
      }
      return;
    }
    selectRowsRef.current(wanted.rows);
  }, []);
  // What a module's activation puts on screen, and how far it has got while it runs. Two states,
  // because a module may publish a table without doing anything long, and the reverse.
  const modulePanels = useModulePanels();
  const moduleWork = useModuleWork();
  const subtitle = useSubtitleFile(onRowsMoved, modulePanels.publish);
  const preview = usePreview();
  const project = useProject();
  // Every module panel goes whenever the open project changes, including to nothing and from
  // nothing. One derivation rather than two call sites, because the swap has no close in it from
  // this side: `useProject.open` replaces the project view and never passes through `close`, so a
  // rule written as "clear on close and also on open" is a rule the next project command forgets.
  // See docs/module-lifecycle-tasks.md §5.
  const openProjectFolder = project.project?.folder ?? null;
  const clearModulePanels = modulePanels.clear;
  useEffect(() => {
    clearModulePanels();
  }, [openProjectFolder, clearModulePanels]);
  // A finished transcription becomes the open document, and the backend asks about unsaved work on
  // the way there. See BACKLOG.md M3.5.
  const transcription = useTranscription((runId) => void adoptTranscription(runId));
  const ready = state.status === "ready";
  useStartupFiles(open, subtitle.open);
  // The cursor and the selection belong to the shell, not to the grid: the tools column edits
  // whichever row carries the cursor (decision 5, T5).
  const selection = useCueSelection(subtitle.cues.length, subtitle.openId);
  useEffect(() => {
    rowsMovedRef.current = selection.rowsMoved;
    selectRunRef.current = (from, to) => {
      // Plain first, which is also what sets the anchor the extension runs from.
      selection.move(from, "plain");
      selection.move(to, "extend");
    };
    selectRowsRef.current = (rows) => {
      const [head, ...rest] = rows;
      if (head === undefined) {
        return;
      }
      selection.move(head, "plain");
      for (const row of rest) {
        selection.toggle(row);
      }
      // The cursor goes back to the first of them: a toggle takes it, and what a translator carries
      // on from is the first line that landed, not the last.
      if (rest.length > 0) {
        selection.move(head, "cursorOnly");
      }
    };
  }, [selection.rowsMoved, selection.move]);

  // Every bound a sash is given comes from here rather than from a number: a fixed maximum would
  // clip a panel on a small window and waste room on a large one (W6). The current line is
  // re-resolved because the grid's document key remounts it.
  useEffect(() => {
    const column = toolsRef.current;
    const top = topRef.current;
    const grid = gridRef.current;
    if (column === null || top === null || grid === null) {
      return;
    }
    const line = column.querySelector(".currentline");
    const video = top.querySelector(".shell__video");
    // The picture's own box inside the video panel, so the panel's chrome can be told from the
    // part a picture can grow into.
    const stage = top.querySelector(".stage");
    // The edge between the two panels, read as itself: the width left over between a row and the
    // panels in it is three rounded readings subtracted from each other, and lands a pixel either
    // side of the edge depending on where the split falls. A floor is asked of the window every
    // time it moves, so a pixel of noise in it is a floor that will not hold still.
    const sash = top.querySelector<HTMLElement>(".sash--video");
    // The one box in the column that grows to fill what it is given, so the only one whose own
    // content has to be asked for separately.
    const text = column.querySelector(".currentline__text");
    // The one panel in the block whose width is fixed rather than dragged, and the one the window's
    // own floor has to leave room for beside the two that are.
    const rail = top.parentElement?.querySelector(".shell__rail") ?? null;
    // One snapshot, so the pairs a bound is worked out from always describe the same layout: a
    // width read a frame after its neighbour would let a drag walk past its own ceiling.
    const measure = () =>
      setFrame({
        videoWidth: video === null ? 0 : video.clientWidth,
        videoHeight: video === null ? 0 : video.clientHeight,
        sashWidth: sash === null ? 0 : sash.getBoundingClientRect().width,
        stageWidth: stage === null ? 0 : stage.clientWidth,
        stageHeight: stage === null ? 0 : stage.clientHeight,
        toolsWidth: column.clientWidth,
        toolsHeight: column.clientHeight,
        lineHeight: line === null ? 0 : line.clientHeight,
        // What the current line would take if nothing stretched it: its own content, with the text
        // box at the few lines a translator writes into rather than at whatever it was given.
        // `scrollHeight` so that a panel with more controls than room says how much more it wants,
        // and the text box's slack taken off so that a panel with room to spare does not report the
        // room as content, which would make this rise every time it was answered.
        lineContent: line === null || text === null ? 0 : line.scrollHeight - textSlack(text),
        topWidth: top.clientWidth,
        railWidth: rail === null ? 0 : rail.getBoundingClientRect().width,
        gridHeight: grid.clientHeight,
      });
    const observer = new ResizeObserver(measure);
    for (const element of [column, top, grid, line, text, video, stage, rail, sash]) {
      if (element !== null) {
        observer.observe(element);
      }
    }
    measure();
    return () => observer.disconnect();
    // The video panel is one of the boxes watched here and it comes and goes with the layout, so
    // the set has to be built again when it does.
  }, [subtitle.openId, videoShown]);

  // Every bound above is a number at 100 per cent, so each is taken against the size the user
  // picked; 1 is what the fallback in tokens.css draws at, before the layout has been read (S2).
  const scale = layout?.interfaceScale ?? 1;
  const duration = state.duration ?? 0;

  // The video panel's floor: what the transport under it asks for on one row, taken off that row
  // rather than written down, because every width in it is one the machine's fonts decide (S2).
  // Before the paint, so the edge below is never drawn against a floor that has not been read yet.
  useLayoutEffect(() => {
    const controls = topRef.current?.querySelector<HTMLElement>(".controls") ?? null;
    if (controls === null) {
      return;
    }
    let live = true;
    const measure = () => {
      const width = widestRow(controls, transportReadings(duration));
      // Up to the whole pixel: the sum is in fractions of one, and the engine breaks a line in
      // sixty-fourths of one.
      if (live && width !== null) {
        setTransportFloor(Math.ceil(width));
      }
    };
    measure();
    // Type can arrive after the first paint, and every width above is the width of some type. The
    // promise has no failure: a page whose fonts never settle keeps the reading taken above.
    void document.fonts.ready.then(measure, () => {});
    return () => {
      live = false;
    };
  }, [scale, duration]);

  // The same reading for the column beside it, and before the paint for the same reason. Keyed on
  // the size and on nothing else: every field the line has is drawn whatever the open document
  // declares, greyed where the format cannot hold it, so what the column has to hold is the same
  // before and after a file is opened. Read again per document it would be a floor that moves when
  // one is opened, by the fraction of a pixel a different style name costs (grid-columns-tasks G3).
  useLayoutEffect(() => {
    const column = toolsRef.current;
    if (column === null) {
      return;
    }
    let live = true;
    const measure = () => {
      const panel = column.querySelector<HTMLElement>(".currentline");
      if (panel === null) {
        return;
      }
      const needed = narrowest(panel, asAnEmptyLine);
      if (needed === null || needed <= 0) {
        return;
      }
      // What the column spends around the panel: its own edge, and the bar the panel's scroll takes
      // out of the width the bands are laid out in. Both read off the styles rather than off the
      // boxes as they stand, so the floor is not a number about the window it is measuring: a bar
      // the panel is not spending yet is one the sash can ask for at any moment.
      const edge = window.getComputedStyle(column);
      const border =
        Number.parseFloat(edge.borderLeftWidth) + Number.parseFloat(edge.borderRightWidth);
      const around = (Number.isFinite(border) ? border : 0) + scrollbarWidth(panel);
      if (live) {
        setLineFieldFloor(Math.ceil(needed + around));
      }
    };
    measure();
    void document.fonts.ready.then(measure, () => {});
    return () => {
      live = false;
    };
  }, [scale]);

  const minVideoWidth = transportFloor ?? 0;
  /**
   * The narrowest the tools column may be: what the current line panel cannot be drawn under, which
   * is its padding around the widest field the bands hold. The bands wrap, so what refuses to be
   * made narrower is one field and never the row.
   *
   * Measured rather than named, for the reason the transport's floor is: a field is a label beside
   * a box, and both are as wide as the machine's own fonts draw them. The constant below it is the
   * height rule the column also has to keep. See S1 and grid-columns-tasks G3.
   */
  const minToolsWidth = Math.max(MIN_TOOLS_WIDTH * scale, lineFieldFloor ?? 0);
  const minCurrentLine = MIN_CURRENT_LINE * scale;
  const minWaveformHeight = MIN_WAVEFORM_HEIGHT * scale;
  // The grid's three rows are a fixed 28px at every size, so only its header is scaled, and never
  // downwards: a floor short of a whole row clips it.
  const minGridHeight = MIN_GRID_HEIGHT + MIN_GRID_HEAD * Math.max(0, scale - 1);

  // The video panel is stored as a share of the row, so it keeps its proportion when the window
  // changes width; the sash works in pixels, which is what the row measures. Never under the floor:
  // a share stored at a wider window, or at a smaller interface size, opens below it.
  const videoWidth =
    layout === null ? 0 : Math.max(minVideoWidth, layout.videoFraction * frame.topWidth);
  const maxVideoWidth = Math.max(
    minVideoWidth,
    frame.videoWidth + frame.toolsWidth - minToolsWidth,
  );
  const asFraction = (width: number) =>
    frame.topWidth > 0 ? width / frame.topWidth : (layout?.videoFraction ?? 0);

  // What the block under the chrome asks for, which is one of the widths the window's own floor is
  // the widest of: the rail, the two panels at their floors, and the edge between them, each read
  // off the box that draws it. Null until the video panel's floor is known, because a block floor
  // short of it is not one.
  const minBlockWidth =
    transportFloor === null
      ? null
      : frame.railWidth + transportFloor + frame.sashWidth + minToolsWidth;

  // How far the block may shrink before the column stops shrinking the current line and starts
  // pushing it out: the slack the line has over its own minimum, read off the rendered line.
  const minTopHeight = Math.max(
    MIN_TOP_HEIGHT * scale,
    frame.toolsHeight - Math.max(0, frame.lineHeight - minCurrentLine),
  );
  // What the tools column can use: itself, less the slack the current line has over the height its
  // own content asks for. A block taller than this makes the text box taller and nothing else.
  const usableTools = frame.toolsHeight - Math.max(0, frame.lineHeight - frame.lineContent);
  // What the stage can use: at this width the picture fills a box of exactly this height, and every
  // pixel of block above it is a band beside the picture rather than more picture. Null while
  // nothing is decoded and for a media with no picture, where there is no shape to ask about.
  const usableStage =
    picture === null || picture.width <= 0 || picture.height <= 0 || frame.stageWidth <= 0
      ? null
      : (frame.stageWidth * picture.height) / picture.width +
        Math.max(0, frame.videoHeight - frame.stageHeight);
  // The grid keeps its own minimum whatever else is true, and inside that the block stops where
  // the last thing that could use the height stops using it. See grid-columns-tasks.md, answer D.
  const maxTopHeight = Math.max(
    minTopHeight,
    Math.min(
      frame.toolsHeight + frame.gridHeight - minGridHeight,
      Math.max(usableTools, usableStage ?? 0),
    ),
  );
  const activeCue: CueRow | null =
    selection.active === null ? null : (subtitle.cues[selection.active] ?? null);
  /**
   * Marker changes a hand has made and no commit has written yet (interface-spec 5). Null with
   * auto-commit on, where the drag writes as it lands, and null again the moment a commit or a
   * line change writes it.
   */
  const [pending, setPending] = useState<{ cue: number; startMs: number; endMs: number } | null>(
    null,
  );
  // What the wave draws: the document's line, with the uncommitted markers over it. Only the wave
  // sees them; the grid and the current line show what the document holds until a commit.
  const waveCue: CueRow | null =
    activeCue === null || pending === null || pending.cue !== selection.active
      ? activeCue
      : { ...activeCue, startMs: pending.startMs, endMs: pending.endMs };
  // Saving writes the document, so it has to include the text sitting in either editor, and text
  // in an editor is unsaved work whether or not it has reached the document yet.
  const flushGrid = useRef<() => Promise<void>>(() => Promise.resolve());
  const flushLine = useRef<() => Promise<void>>(() => Promise.resolve());
  /** Filled by the current line's panel: how the four colour commands reach its picker (N112). */
  const openColour = useRef<(slot: ColourSlot) => void>(() => {});
  const [editorOpen, setEditorOpen] = useState(false);
  const [lineEdited, setLineEdited] = useState(false);
  /**
   * Where the caret last was in the current line's editor, and the row it was in. It outlives the
   * blur a menu click causes, which is why the split can still read it; a cursor on another row
   * leaves it unmatched and the split greyed.
   */
  const [caret, setCaret] = useState<{ index: number; offset: number; to: number } | null>(null);
  /**
   * Whether there is a caret in the line's own editor, on the row the cursor is on. Two commands
   * want it: writing an override tag, which additionally wants ASS because no other format carries
   * one, and putting the source's line where the caret is, which every format can hold.
   */
  /**
   * The active row's text as it was when the cursor arrived on it, which is what Revert puts back.
   * Tracked here rather than in the panel because an undo elsewhere re-seeds the panel's own copy
   * and this one must survive that: it changes when the cursor moves and at no other time. B13.
   */
  const [arrived, setArrived] = useState<{ open: number; index: number; text: string } | null>(
    null,
  );
  if (
    selection.active !== null &&
    activeCue !== null &&
    (arrived?.index !== selection.active || arrived.open !== subtitle.openId)
  ) {
    setArrived({ open: subtitle.openId, index: selection.active, text: activeCue.text });
  }
  if (selection.active === null && arrived !== null) {
    setArrived(null);
  }

  const hasCaret = activeCue !== null && caret !== null && caret.index === selection.active;
  const writesAtCaret = subtitle.summary?.format === "ass" && hasCaret;
  // The chooser is modal and answers on its own thread, so a second one asked for while it is up
  // would sit behind the first. Every chooser the chrome raises is raised here, so one flag covers
  // them all.
  const [choosing, setChoosing] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [eventLogOpen, setEventLogOpen] = useState(false);
  /** How the grid draws override tags. Shown as the file spells them until told otherwise. */
  const [tagMode, setTagMode] = useState<TagMode>("show");
  // The status bar's timed slot: a sentence a command pushes, cleared by its own clock (1.5).
  /** Which declared style the editor is open over, or null while it is closed. See B10. */
  const [editingStyle, setEditingStyle] = useState<number | null>(null);
  /** What Video details is showing, and nothing on screen while it is null. */
  const [videoDetails, setVideoDetails] = useState<VideoDetails | null>(null);
  /** What Project properties is showing, and nothing on screen while it is null (interface-spec 9.5). */
  const [scriptInfo, setScriptInfo] = useState<ScriptInfoView | null>(null);
  const [jumpToOpen, setJumpToOpen] = useState(false);
  // The file the user picked for Open with encoding, waiting on the charset dialog. Null when no
  // such open is in flight. See interface-spec 9.8.
  const [encodingPath, setEncodingPath] = useState<string | null>(null);
  // Whether the export charset dialog is up; the reference's order is dialog first, then the
  // destination chooser (interface-spec 3.1 item 9).
  const [exportOpen, setExportOpen] = useState(false);
  // Whether the Language dialog is up (interface-spec 3.7 item 12).
  const [languageOpen, setLanguageOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  /** The rows and the clipboard a paste over is waiting on an answer about, if one is open. */
  const [pasteOverAsk, setPasteOverAsk] = useState<{ rows: number[]; text: string } | null>(null);
  const { pasteFields, store: storePasteFields } = usePasteFields();
  // The three numbers the commands below read, the reference's own until the store says otherwise.
  const { preferences, store: storePreferences } = usePreferences();
  const [shiftOpen, setShiftOpen] = useState(false);
  // Absent until the menu asks for it, and gone again on Close: T4 takes the band off the screen.
  const [transcribeOpen, setTranscribeOpen] = useState(false);
  // The find band, and what it is looking for. The query outlives a close so reopening the band
  // offers the last search back, which is the cheap half of the reference's remembered list (F2).
  const [findMode, setFindMode] = useState<FindMode | null>(null);
  const [query, setQuery] = useState<Query>({ needle: "", matchCase: false, regex: false });
  const [replacement, setReplacement] = useState("");
  const [found, setFound] = useState<Match | null>(null);
  const [searched, setSearched] = useState(false);
  const [replaced, setReplaced] = useState<number | null>(null);
  /** What the last search refused, drawn in the band: a pattern that will not compile, or one the
   * engine never finished. Cleared by the next search. */
  const [refusal, setRefusal] = useState<"bad-pattern" | "slow" | null>(null);
  /** Whether the band stays inside the grid's selection. Off is the whole document (F4b). */
  const [inSelection, setInSelection] = useState(false);
  const [quitError, setQuitError] = useState<string | null>(null);

  async function pick(
    kind: ChooseKind,
    suggested: string | undefined,
    act: (path: string) => void,
  ) {
    if (choosing) {
      return;
    }
    setChoosing(true);
    try {
      const path = await choosePath(kind, suggested);
      // Cancelled is an outcome, not a failure: nothing opens, nothing is written, nothing is said.
      if (path !== null) {
        act(path);
      }
    } finally {
      setChoosing(false);
    }
  }

  /** Send whatever is sitting in either editor. Both are views of the document, so an operation
   * that reads the document flushes both or acts on one the user cannot see. See T5. */
  async function flushEditors() {
    await flushGrid.current();
    await flushLine.current();
  }

  /**
   * Save the document where it belongs. One that has never had a file is asked where that is, and
   * points at the path it is given from then on, so the next save writes there (decision 24, B2).
   */
  /**
   * The selected cues, as the file writes them, onto the system clipboard.
   *
   * The page cannot reach the clipboard itself: WebKitGTK answers both `writeText` and `readText`
   * with `NotAllowedError` inside the app's own page, measured on 2026-09-07, so it goes through
   * the backend and GTK's own clipboard.
   */
  async function copyCues() {
    const rows = [...selection.selected].sort((one, two) => one - two);
    if (rows.length === 0) {
      return;
    }
    const lines = await subtitle.copyCues(rows);
    if (lines === "") {
      return;
    }
    await invoke("clipboard_write", { text: lines }).catch(() => undefined);
  }

  /**
   * The selected cues onto the clipboard and then out of the document, as one undo step.
   *
   * The copy goes first and the rows go only once it has been written: a cut whose clipboard write
   * failed would have taken the lines away with nothing to paste back.
   */
  async function cutCues() {
    await flushEditors();
    const rows = [...selection.selected].sort((one, two) => one - two);
    if (rows.length === 0) {
      return;
    }
    const lines = await subtitle.copyCues(rows);
    if (lines === "") {
      return;
    }
    const written = await invoke("clipboard_write", { text: lines }).then(
      () => true,
      () => false,
    );
    if (!written) {
      return;
    }
    await subtitle.deleteCues(rows);
  }

  /**
   * Every selected line written again after itself, as one undo step, with the copies left selected.
   *
   * Where each copy lands is worked out here rather than read back: a run of n rows is followed by
   * its own n copies, and every run after it has moved down by the copies made before it.
   */
  async function duplicateCues() {
    await flushEditors();
    const rows = [...selection.selected]
      .filter((row) => row < subtitle.cues.length)
      .sort((one, two) => one - two);
    if (rows.length === 0) {
      return;
    }
    const copies: number[] = [];
    let shift = 0;
    let at = 0;
    while (at < rows.length) {
      let end = at;
      while (end + 1 < rows.length && rows[end + 1] === rows[end] + 1) {
        end += 1;
      }
      const length = end - at + 1;
      const first = rows[end] + 1 + shift;
      for (let step = 0; step < length; step += 1) {
        copies.push(first + step);
      }
      shift += length;
      at = end + 1;
    }
    landing.current = { rows: copies };
    try {
      await subtitle.duplicateCues(rows);
    } finally {
      landing.current = null;
    }
  }

  /**
   * Two or more selected lines joined into the first of them, as one undo step, with the line that
   * stays left selected.
   *
   * `keepFirstText` drops the others' words and keeps their time, which is what a translator wants
   * where two lines carry one sentence twice, once as a stub.
   */
  async function joinCues(keepFirstText: boolean) {
    await flushEditors();
    const rows = [...selection.selected]
      .filter((row) => row < subtitle.cues.length)
      .sort((one, two) => one - two);
    if (rows.length < 2) {
      return;
    }
    landing.current = { rows: [rows[0]] };
    try {
      await subtitle.joinCues(rows, keepFirstText);
    } finally {
      landing.current = null;
    }
  }

  /**
   * The clipboard's cues in before the row the cursor is on, as one undo step, and the rows that
   * land are the ones left selected. With no row to go before they go at the end.
   */
  /**
   * The selected cues moved one row up or down, as one undo step, with the selection following them.
   *
   * The whole permutation is worked out here and trimmed to the run that changed, so an SRT index
   * rides along with its block and the backend is asked for a reorder only when one is real: a move
   * with the selection already against the edge does nothing and adds no undo step.
   */
  async function moveSelection(down: boolean) {
    await flushEditors();
    const count = subtitle.cues.length;
    const selected = new Set([...selection.selected].filter((row) => row < count));
    if (selected.size === 0) {
      return;
    }
    const move = reorderForMove(count, selected, down);
    if (move === null) {
      return;
    }
    landing.current = { rows: move.after };
    try {
      await subtitle.reorderCues(move.from, move.order);
    } finally {
      landing.current = null;
    }
  }

  /**
   * The whole document, or the selected cues among the positions they occupy, put in order by start
   * or by end as one undo step, with the selection following. A sort that changes nothing does
   * nothing and adds no undo step. See docs/reorder-tasks.md.
   */
  async function sortSelection(key: "start" | "end", selectedOnly: boolean) {
    await flushEditors();
    const selected = new Set([...selection.selected].filter((row) => row < subtitle.cues.length));
    const run = reorderForSort(subtitle.cues, selected, key, selectedOnly);
    if (run === null) {
      return;
    }
    landing.current = { rows: run.after };
    try {
      await subtitle.reorderCues(run.from, run.order);
    } finally {
      landing.current = null;
    }
  }

  async function pasteCues() {
    await flushEditors();
    const text = await invoke<string>("clipboard_read").catch(() => "");
    if (text === "") {
      return;
    }
    landing.current = "inserted";
    try {
      await subtitle.pasteCues(selection.active ?? subtitle.cues.length, text);
    } finally {
      landing.current = null;
    }
  }

  /** The clipboard's lines over the selected rows, in order, as one undo step. */
  /**
   * Ask which fields to take, then take them. The dialog opens on every paste over, which is the
   * reference's own behaviour: only the boxes it opens with are remembered (paste-over-tasks.md).
   */
  async function pasteOverCues() {
    const rows = [...selection.selected].sort((one, two) => one - two);
    if (rows.length === 0) {
      return;
    }
    const text = await invoke<string>("clipboard_read").catch(() => "");
    if (text === "") {
      return;
    }
    setPasteOverAsk({ rows, text });
  }

  /** Which of the eleven this document and this selection can take. See paste-over-tasks.md P5. */
  function pasteableFields(rows: number[]): ReadonlySet<keyof PasteFields> {
    // The three every format has. A row's own text and timings are always writable.
    const can = new Set<keyof PasteFields>(["start", "end", "text"]);
    if (subtitle.summary?.format === "ass") {
      can.add("comment");
    }
    // A declared field, and only where every row in the selection declares it: a paste is one edit,
    // and one row refusing would refuse the whole of it.
    const declared = rows.map((row) => new Set(subtitle.cues[row]?.declaredFields ?? []));
    for (const field of [
      "layer",
      "style",
      "actor",
      "marginL",
      "marginR",
      "marginV",
      "effect",
    ] as const) {
      if (declared.length > 0 && declared.every((row) => row.has(field))) {
        can.add(field);
      }
    }
    return can;
  }

  async function saveDocument() {
    await flushEditors();
    if (subtitle.summary === null) {
      return;
    }
    if (subtitle.summary.path === null) {
      await pick("subtitle-first-save", undefined, (path) => void subtitle.saveAs(path));
      return;
    }
    await subtitle.save();
  }

  /**
   * Write the document somewhere else and go on editing it there, which is what Save as means: the
   * file it had keeps the bytes it had. See interface-spec 3.1, item 8.
   */
  async function saveAs() {
    await flushEditors();
    // The chooser opens on the open file's own name; a document that has never had a file has no
    // name to offer.
    await pick("subtitle-save", subtitle.summary?.path ?? undefined, (path) => {
      void subtitle.saveAs(path);
    });
  }

  /**
   * Activating a file in the rail opens it, through the same commands the chooser route uses: a
   * video in the player, a subtitle as the document. See BACKLOG.md M4.5.
   */
  function openAttachedFile(file: EpisodeFileView) {
    if (file.role === "media") {
      void open(file.path);
      return;
    }
    void subtitle.open(file.path);
  }

  async function adoptTranscription(runId: number) {
    // Text sitting in an open editor is unsaved work too, so it reaches the document before
    // anything asks whether the document may be replaced.
    await flushEditors();
    await subtitle.adoptTranscription(runId);
  }

  /** Undo and redo take a step off the stack the user can see, so the text sitting in an editor
   * reaches the document first, exactly as a save does. See T5. */
  async function undoDocument() {
    await flushEditors();
    await subtitle.undo();
  }

  async function redoDocument() {
    await flushEditors();
    await subtitle.redo();
  }

  /**
   * A cue beside the cursor's, and the four ways of asking for one (interface-spec 3.3 item 1).
   *
   * `after` is which side of the current line it goes on. `atPlayhead` times it from where the
   * picture is instead of from the line beside it, and takes no room from anything: the translator
   * has said where it goes by putting the playhead there.
   *
   * Where it is not timed from the playhead the new cue takes the room between its neighbour and
   * whatever is on the other side of it, never overlapping what is already written: after the
   * current line it runs to the next line that starts, before it it starts at the last line that
   * ended. An empty document takes its first cue at zero. See BACKLOG.md M2.7 E2.
   */
  async function insertCue(after: boolean, atPlayhead: boolean) {
    await flushEditors();
    if (subtitle.summary === null) {
      return;
    }
    const at = selection.active;
    const current = at === null ? null : (subtitle.cues[at] ?? null);
    if (at === null || current === null) {
      // Nothing to sit beside: the first cue of an empty document, which only "after" offers.
      if (!after || atPlayhead) {
        return;
      }
      landing.current = "inserted";
      try {
        await subtitle.insertCue(subtitle.cues.length, 0, preferences.newCueMs, "");
      } finally {
        landing.current = null;
      }
      return;
    }

    const before = after ? at + 1 : at;
    let startMs: number;
    let endMs: number;
    if (atPlayhead) {
      startMs = Math.round(position * 1000);
      endMs = startMs + preferences.newCueMs;
    } else if (after) {
      startMs = current.endMs;
      endMs = subtitle.cues.reduce(
        (soonest, cue) => (cue.startMs >= startMs ? Math.min(soonest, cue.startMs) : soonest),
        startMs + preferences.newCueMs,
      );
    } else {
      endMs = current.startMs;
      startMs = subtitle.cues.reduce(
        (latest, cue) => (cue.endMs <= endMs ? Math.max(latest, cue.endMs) : latest),
        Math.max(0, endMs - preferences.newCueMs),
      );
    }
    if (endMs <= startMs) {
      // No room between the two: a cue that started where it ended would be one no player draws.
      return;
    }
    landing.current = "inserted";
    try {
      await subtitle.insertCue(before, startMs, endMs, "");
    } finally {
      landing.current = null;
    }
  }

  /**
   * The next cue, and on the last one the cue that becomes the next. The reference's own timing
   * key: it is a navigation command everywhere else and an insert only at the end, so a translator
   * working down a file never has to reach for a second control. See edit-bar-tasks.md C3.
   */
  async function nextLine() {
    await flushEditors();
    if (subtitle.summary === null) {
      return;
    }
    const at = selection.active;
    const last = subtitle.cues.length - 1;
    if (at !== null && at < last) {
      selection.move(at + 1, "plain");
      return;
    }
    const previous = at === null ? null : (subtitle.cues[at] ?? null);
    const before = at === null || previous === null ? subtitle.cues.length : at + 1;
    const startMs = previous === null ? 0 : previous.endMs;
    await subtitle.insertCue(before, startMs, startMs + preferences.newCueMs, "");
    selection.move(before, "plain");
  }

  /** Every selected line, as one undo step. The cursor lands on the row that takes their place. */
  async function deleteCues() {
    await flushEditors();
    const rows = [...selection.selected]
      .filter((row) => row < subtitle.cues.length)
      .sort((one, two) => one - two);
    if (rows.length === 0) {
      return;
    }
    await subtitle.deleteCues(rows);
  }

  /**
   * Split at the caret in the current line's editor, at the playhead when the playhead is inside
   * the cue and at the cue's midpoint otherwise. Both halves are choices, not derivations: that
   * box holds the only caret in cue text there is, and a cue the playhead is not in has no moment
   * of its own to divide at. See BACKLOG.md M2.7 E3.
   */
  async function splitCue() {
    await flushEditors();
    const at = selection.active;
    const cue = at === null ? null : (subtitle.cues[at] ?? null);
    if (at === null || cue === null || caret === null || caret.index !== at) {
      return;
    }
    const playheadMs = Math.round(position * 1000);
    const inside = ready && playheadMs >= cue.startMs && playheadMs <= cue.endMs;
    await subtitle.splitCue(
      at,
      caret.offset,
      inside ? playheadMs : Math.floor((cue.startMs + cue.endMs) / 2),
    );
  }

  /**
   * Split the selected cue in two at the playhead's frame, the whole text kept in both halves, and
   * the two halves left selected. `before` cuts on the near edge of the current frame, otherwise the
   * far edge. With the playhead outside the cue nothing happens: the reference duplicates to a
   * one-frame cue there and this does not copy that quirk. See docs/split-at-playhead-tasks.md.
   */
  async function splitAtPlayhead(before: boolean) {
    await flushEditors();
    const at = selection.active;
    const cue = at === null ? null : (subtitle.cues[at] ?? null);
    if (at === null || cue === null || !ready) {
      return;
    }
    const playheadMs = Math.round(position * 1000);
    if (playheadMs < cue.startMs || playheadMs > cue.endMs) {
      return;
    }
    const details = await readVideoDetails();
    const fps = details?.fps ?? null;
    if (fps === null || fps <= 0) {
      return;
    }
    landing.current = { rows: [at, at + 1] };
    try {
      await subtitle.splitAtPlayhead(at, cue.startMs, cue.endMs, playheadMs, fps, before);
    } finally {
      landing.current = null;
    }
  }

  async function mergeCue() {
    await flushEditors();
    const at = selection.active;
    if (at === null || at + 1 >= subtitle.cues.length) {
      return;
    }
    await subtitle.mergeCue(at);
  }

  /**
   * The next match, from wherever the last one left off, with the cursor following it onto the cue
   * it lands in. A pattern in no cue moves nothing and says so on the band. See F2.
   */
  /**
   * The cues a search may look in: the selection when the band is held to it, and null for the
   * whole document. In file order, because the search walks it and wraps round it.
   */
  function scope(): number[] | null {
    return inSelection ? [...selection.selected].sort((first, second) => first - second) : null;
  }

  /** What every search reports back, wherever it was asked from. A refusal moves nothing. */
  function report(outcome: SearchOutcome): void {
    setReplaced(null);
    if (outcome.kind !== "found") {
      setRefusal(outcome.kind === "slow" ? "slow" : "bad-pattern");
      setSearched(false);
      setFound(null);
      return;
    }
    setRefusal(null);
    setSearched(true);
    setFound(outcome.match);
    if (outcome.match !== null) {
      // Inside the selection the cursor moves without collapsing it, or the next search would be
      // held to whatever this one landed on. It is the mode Ctrl and the arrows already use.
      selection.move(outcome.match.cue, inSelection ? "cursorOnly" : "plain");
    }
  }

  async function findFrom(at: Match | null): Promise<void> {
    report(await search.find(subtitle.cues, scope(), query, at));
  }

  function findNext() {
    void findFrom(found);
  }

  /**
   * Replace the match the band is standing on, then move to the next one. With no match in hand the
   * first press only finds, so a press never rewrites a cue the user has not been shown. That is
   * the two-press rule of interface-spec 9.2, expressed against the match this band holds rather
   * than against a text selection the grid does not have.
   */
  async function replaceCurrent() {
    const at = found;
    const cue = at === null ? null : (subtitle.cues[at.cue] ?? null);
    if (at === null || cue === null) {
      await findFrom(found);
      return;
    }
    const text = replaceOne(cue.text, at, query, replacement);
    await subtitle.setTexts([{ cue: at.cue, text }]);
    // Resume past what was just written, so a replacement containing the pattern is not re-found.
    // The length is the written one, which with regex on is not the replacement's own.
    const wrote = text.length - cue.text.length + (at.end - at.start);
    await findFrom({ cue: at.cue, start: at.start, end: at.start + wrote, found: at.found });
  }

  /** Every match in the document, in one edit and so in one undo step. See F1. */
  async function replaceAll() {
    const outcome = await search.replaceAll(subtitle.cues, scope(), query, replacement);
    if (outcome.kind !== "replaced") {
      report(outcome);
      return;
    }
    if (outcome.edits.length === 0) {
      setRefusal(null);
      setSearched(true);
      setFound(null);
      setReplaced(null);
      return;
    }
    await subtitle.setTexts(outcome.edits);
    setRefusal(null);
    setFound(null);
    setSearched(false);
    setReplaced(outcome.count);
  }

  /** Where the video is, to the millisecond the product reasons in (decision 11). */
  function playheadMs(): number {
    return Math.round(position * 1000);
  }

  /**
   * The cursor's cue takes the playhead as one of its boundaries. A start past its own end is
   * refused by the backend and the refusal reaches the status bar: a silent clamp would leave a cue
   * whose length nobody chose. See docs/playhead-tasks.md.
   */
  async function boundaryToPlayhead(which: "start" | "end") {
    await flushEditors();
    const at = selection.active;
    const cue = at === null ? null : (subtitle.cues[at] ?? null);
    if (at === null || cue === null) {
      return;
    }
    const now = playheadMs();
    await subtitle.setTimes(
      at,
      which === "start" ? now : cue.startMs,
      which === "end" ? now : cue.endMs,
    );
  }

  /** How much of the neighbourhood the two context commands play. The reference's own number. */
  const CONTEXT_MS = 500;

  /**
   * Play a stretch of the cursor's cue. mpv has no primitive for this, so the player holds a stop
   * target and the event thread pauses at it. See docs/play-range-tasks.md.
   */
  async function playCue(what: "line" | "before" | "after" | "first" | "last" | "to-end") {
    const at = selection.active;
    const cue = at === null ? null : (subtitle.cues[at] ?? null);
    if (cue === null) {
      return;
    }
    const start = cue.startMs / 1000;
    const end = cue.endMs / 1000;
    const context = CONTEXT_MS / 1000;
    // The player clamps into the file, so a cue near either edge asks for what it wants and gets
    // what exists rather than being special-cased twice.
    const range = {
      line: [start, end],
      before: [start - context, start],
      after: [end, end + context],
      // A line shorter than half a second is played whole rather than clipped to a window it does
      // not fill, which is what the reference does (`src/command/audio.cpp:306-320`).
      first: [start, Math.min(end, start + context)],
      last: [Math.max(start, end - context), end],
      "to-end": [start, state.duration ?? end],
    }[what];
    await playRange(range[0], range[1]);
  }

  /**
   * Play the selection, which is the current line's range as the panel has it right now: a boundary
   * a hand is dragging is played where the hand has put it, and Play line plays what the document
   * still holds. That difference is the whole reason the reference keeps both (interface-spec 5.9).
   */
  async function playSelection() {
    const at = selection.active;
    const cue = at === null ? null : (subtitle.cues[at] ?? null);
    if (cue === null) {
      return;
    }
    const live = liveTimes.current;
    await playRange((live?.startMs ?? cue.startMs) / 1000, (live?.endMs ?? cue.endMs) / 1000);
  }

  /**
   * The next place the picture stops when walking a line's own edges: the nearer of the current
   * line's start and end on that side of the playhead, and the next line's own edge once the
   * playhead is past both. The cursor moves with it, which is what makes the walk continue.
   * See interface-spec 10.5.
   */
  async function toBoundary(forward: boolean) {
    if (state.status !== "ready") {
      return;
    }
    const at = selection.active;
    const cue = at === null ? null : (subtitle.cues[at] ?? null);
    const now = position * 1000;
    if (cue !== null) {
      // A millisecond of margin, or a playhead sitting on a boundary would stop there for ever: the
      // clock is a float and a seek lands near where it was asked, not on it.
      const edges = [cue.startMs, cue.endMs].filter((ms) =>
        forward ? ms > now + 1 : ms < now - 1,
      );
      if (edges.length > 0) {
        await seek((forward ? Math.min(...edges) : Math.max(...edges)) / 1000);
        return;
      }
    }
    // Past both edges: the line the cursor is on becomes the next one, and the picture goes to the
    // edge of that one the walk was heading for.
    const next = at === null ? (forward ? 0 : subtitle.cues.length - 1) : at + (forward ? 1 : -1);
    const landing = subtitle.cues[next];
    if (landing === undefined) {
      return;
    }
    // The walk moves the cursor itself and then takes the picture to the edge it was heading for,
    // so the follow is told this row is already followed: without that it would drag the picture to
    // that line's start a moment later and undo the walk.
    followedRow.current = next;
    selection.move(next, "plain");
    await seek((forward ? landing.startMs : landing.endMs) / 1000);
  }

  /**
   * How many frames the picture jumps by. Ten, which is what the reference opens at; it makes the
   * number a preference and Sublore will when it has a preferences dialog to put it in.
   */
  const JUMP_FRAMES = 10;

  /** The selected rows in file order. The set is what a command reads; the order is what it needs. */
  const selectedRows = Array.from(selection.selected).sort((one, other) => one - other);

  /**
   * Whether the selection is one run with no gap in it, which is what making times continuous
   * needs: one cue, a stretch, or the whole file. A scattered selection has no "previous line" to
   * join to (interface-spec 3.4, item 9).
   */
  const selectionIsContiguous =
    selectedRows.length > 0 &&
    selectedRows[selectedRows.length - 1] - selectedRows[0] === selectedRows.length - 1;

  /**
   * Move every selected line so the cursor's line starts where the picture is, keeping every
   * duration and every gap. One undo step, whatever the count.
   */
  async function shiftSelectionToPlayhead() {
    await flushEditors();
    const anchor = selection.active === null ? null : (subtitle.cues[selection.active] ?? null);
    if (anchor === null || selectedRows.length === 0) {
      return;
    }
    const by = Math.round(position * 1000) - anchor.startMs;
    if (by === 0) {
      return;
    }
    const edits = selectedRows.flatMap((row) => {
      const cue = subtitle.cues[row];
      return cue === undefined
        ? []
        : [{ cue: row, startMs: cue.startMs + by, endMs: cue.endMs + by }];
    });
    await subtitle.setManyTimes(edits);
  }

  /**
   * Move some or all of the lines by a fixed amount. One undo step, whatever the count.
   *
   * A time is never taken below zero: the reference clamps each timestamp at the start of the media
   * and so does this. A shift that would leave a line ending before it starts is sent as it stands
   * and refused by the backend, so the refusal reaches the status bar. See interface-spec 9.1.
   */
  async function shiftTimes(request: ShiftRequest) {
    await flushEditors();
    const first = selectedRows[0];
    const rows =
      request.affect === "all" || first === undefined
        ? subtitle.cues.map((_, index) => index)
        : request.affect === "selected"
          ? selectedRows
          : // Selection onward: the run the selection starts at, and every line after it.
            Array.from(
              { length: Math.max(0, subtitle.cues.length - first) },
              (_, step) => first + step,
            );
    const by = request.backward ? -request.amountMs : request.amountMs;
    const edits = rows.flatMap((row) => {
      const cue = subtitle.cues[row];
      if (cue === undefined) {
        return [];
      }
      const startMs = request.times === "end" ? cue.startMs : Math.max(0, cue.startMs + by);
      const endMs = request.times === "start" ? cue.endMs : Math.max(0, cue.endMs + by);
      return startMs === cue.startMs && endMs === cue.endMs ? [] : [{ cue: row, startMs, endMs }];
    });
    if (edits.length > 0) {
      await subtitle.setManyTimes(edits);
    }
  }

  /**
   * Close the gaps inside the selection: every line's start onto the line before it, or every
   * line's end onto the line after it. A single selected line acts as if its neighbour were
   * selected too, which is what the reference does.
   *
   * A pair that would leave a line ending before it starts is not repaired here: the whole edit is
   * sent as it stands and the backend refuses it, so the refusal reaches the status bar instead of
   * a half-done change reaching the file.
   */
  async function makeTimesContinuous(which: "start" | "end") {
    await flushEditors();
    if (!selectionIsContiguous) {
      return;
    }
    const alone = selectedRows.length === 1;
    const edits: { cue: number; startMs: number; endMs: number }[] = [];
    for (const row of selectedRows) {
      const cue = subtitle.cues[row];
      const neighbour = subtitle.cues[which === "start" ? row - 1 : row + 1];
      if (cue === undefined || neighbour === undefined) {
        continue;
      }
      // Every line of the run but the one at its far end, unless the run is a single line: then
      // the neighbour outside the selection is the one it joins to.
      const joins = alone || selection.selected.has(which === "start" ? row - 1 : row + 1);
      if (!joins) {
        continue;
      }
      const startMs = which === "start" ? neighbour.endMs : cue.startMs;
      const endMs = which === "start" ? cue.endMs : neighbour.startMs;
      if (startMs !== cue.startMs || endMs !== cue.endMs) {
        edits.push({ cue: row, startMs, endMs });
      }
    }
    if (edits.length > 0) {
      await subtitle.setManyTimes(edits);
    }
  }

  /** The step the boundaries move by. One size, no larger variant under Shift (owner ruling 23). */
  const NUDGE_MS = 10;

  /**
   * Move one boundary of the cursor's cue. A start pushed past its own end is refused by the
   * backend and the refusal reaches the status bar, the same as typing one in.
   */
  async function nudge(which: "start" | "end", by: number) {
    await flushEditors();
    const at = selection.active;
    const cue = at === null ? null : (subtitle.cues[at] ?? null);
    if (at === null || cue === null) {
      return;
    }
    // Never below zero: a boundary dragged off the front of the media is not a time.
    const moved = Math.max(0, (which === "start" ? cue.startMs : cue.endMs) + by);
    await subtitle.setTimes(
      at,
      which === "start" ? moved : cue.startMs,
      which === "end" ? moved : cue.endMs,
    );
  }

  /**
   * A boundary let go on the waveform. The pair travels in the one command that takes both, so a
   * whole drag is a single history entry. See docs/waveform-timing-tasks.md.
   */
  async function dragTimes(cue: number, startMs: number, endMs: number) {
    // Auto-commit writes where the hand let go; otherwise the pair waits for a commit (5).
    if (!waveAutocommit) {
      setPending({ cue, startMs, endMs });
      return;
    }
    await flushEditors();
    await subtitle.setTimes(cue, startMs, endMs);
  }

  /**
   * Write the markers a hand has left and go where the variant says: `auto` follows auto-advance,
   * `always` moves on whatever it says, `never` stays. With nothing pending the write is skipped
   * and the move still happens, which is how a translator walks a file committing as they go.
   */
  async function commitTimes(advance: "auto" | "always" | "never") {
    const at = selection.active;
    if (at === null) {
      return;
    }
    const held = pending !== null && pending.cue === at ? pending : null;
    if (held !== null) {
      setPending(null);
      await flushEditors();
      await subtitle.setTimes(held.cue, held.startMs, held.endMs);
    }
    if (advance === "never" || (advance === "auto" && !waveAutonext)) {
      return;
    }
    const last = subtitle.cues.length - 1;
    if (at < last) {
      selection.move(at + 1, "plain");
      return;
    }
    // On the last line the reference makes one to move on to (5, time.commit-next). The cursor
    // follows it through the same landing the insert commands use.
    if (advance === "always" && subtitle.summary !== null) {
      const end = subtitle.cues[last]?.endMs ?? 0;
      landing.current = "inserted";
      try {
        await subtitle.insertCue(subtitle.cues.length, end, end + preferences.newCueMs, "");
      } finally {
        landing.current = null;
      }
    }
  }

  /**
   * The cursor goes to the cue the video is inside. In a gap it goes to the one that starts next,
   * because timing runs forwards, and past the last cue it does nothing.
   */
  function selectAtPlayhead() {
    const now = playheadMs();
    const covering = subtitle.cues.findIndex((cue) => now >= cue.startMs && now < cue.endMs);
    const target = covering >= 0 ? covering : subtitle.cues.findIndex((cue) => cue.startMs >= now);
    if (target >= 0) {
      selection.move(target, "plain");
    }
  }

  /** The open document's script-level metadata, or null when there is nothing to read it off. The
   * command that opens the dialog only runs with a document, so the null is a defensive one. */
  async function readScriptInfo(): Promise<ScriptInfoView | null> {
    return invoke<ScriptInfoView>("subtitle_script_info").catch(() => null);
  }

  /** Quit through the one route the close gate guards, with the open editor flushed into the
   * document first so the gate is asked about it. See BACKLOG.md N6. */
  async function quit() {
    setQuitError(null);
    await flushEditors();
    try {
      await requestQuit();
    } catch {
      setQuitError(en.menu.errors.quitFailed);
    }
  }

  /**
   * The line changed with markers still uncommitted: they are written, as a commit, one undo step.
   *
   * The reference discards them outright here (question 29). CLAUDE.md §3 forbids losing a user's
   * work in silence, so this commits instead: the same narrow departure the charset decode and the
   * export take, identical to the reference everywhere except where it destroys work.
   */
  useEffect(() => {
    if (pending === null || pending.cue === selection.active) {
      return;
    }
    const held = pending;
    setPending(null);
    void subtitle.setTimes(held.cue, held.startMs, held.endMs);
  }, [pending, selection.active, subtitle]);

  /** Whether the open media has audio to draw, which is what two of the four layouts need. */
  const hasAudio = audio.tracks.length > 0;
  const dirty = subtitle.dirty || editorOpen || lineEdited;
  // The window's own name, rewritten whenever either half of it changes (N57). Not a layout effect:
  // the title is chrome outside the page and nothing on screen is measured against it.
  const documentPath = subtitle.summary?.path ?? null;
  useEffect(() => {
    void setWindowTitle(windowTitle(documentPath, dirty));
  }, [documentPath, dirty]);
  const blocked = subtitle.blockedPath !== null || subtitle.blockedNew;
  // Whatever the stored layout says, and following until it says otherwise: the panel is decoration
  // on any file longer than its own window if it does not follow the line.
  const waveAutoscroll = layout?.waveAutoscroll ?? true;
  // The reference's own defaults: markers wait for a commit, and a commit moves on (5).
  const waveAutocommit = layout?.waveAutocommit ?? false;
  const waveAutonext = layout?.waveAutonext ?? true;
  // The same default the reference opens at: the picture goes where the cursor goes (3.5, item 10).
  const videoFollowSelection = layout?.videoFollowSelection ?? true;
  // Which row the picture was last taken to, so an edit on the row the cursor is already on does
  // not seek: the reference follows a change of line and nothing else.
  const followedRow = useRef<number | null>(null);
  useEffect(() => {
    const at = selection.active;
    if (followedRow.current === at) {
      return;
    }
    followedRow.current = at;
    const cue = at === null ? undefined : subtitle.cues[at];
    if (!videoFollowSelection || !ready || cue === undefined) {
      return;
    }
    void (async () => {
      // Stopped first and then moved, which is the order the reference uses: a seek under a running
      // picture is a jump the playback walks straight back off.
      await pauseVideo();
      await seek(cue.startMs / 1000);
    })();
  }, [selection.active, subtitle.cues, videoFollowSelection, ready, pauseVideo, seek]);

  // S1: the View menu's five interface sizes, matching the Rust bounds in layout.rs.
  const interfaceScales = [
    { percent: 90, scale: 0.9 },
    { percent: 100, scale: 1 },
    { percent: 110, scale: 1.1 },
    { percent: 125, scale: 1.25 },
    { percent: 150, scale: 1.5 },
  ];
  /*
   * Every command the shell owns, written down once. `enabled` and `checked` are worked out here,
   * from the state this render already holds, so nothing polls them and no route can draw a stale
   * one (interface-spec 2.3). A generated set is entries like any other (interface-spec 2.7).
   */
  const declared: Command[] = [
    {
      id: "file.new",
      label: en.menu.file.new,
      accelerator: en.menu.keys.new,
      enabled: true,
      run: () => void subtitle.newDocument(),
    },
    {
      id: "file.open-subtitle",
      label: en.menu.file.openSubtitle,
      accelerator: en.menu.keys.openSubtitle,
      enabled: !choosing,
      run: () => void pick("subtitle", undefined, (path) => void subtitle.open(path)),
    },
    {
      id: "file.open-encoding",
      label: en.menu.file.openEncoding,
      // The reference's order: the file picker first, then the charset dialog the picked path opens
      // (interface-spec 9.8). Greyed only while a chooser is up, the same as Open.
      enabled: !choosing,
      run: () => void pick("subtitle", undefined, (path) => setEncodingPath(path)),
    },
    // One row per remembered project, newest first, numbered the way the reference numbers them
    // (3.1 item 5). Data like the audio tracks; with none remembered, one greyed placeholder row.
    ...(project.recent.length === 0
      ? [
          {
            id: "file.recent.empty" as CommandId,
            label: en.menu.file.recentEmpty,
            enabled: false,
            run: () => undefined,
          },
        ]
      : project.recent.map((folder, index): Command => ({
          id: `file.recent.${index}`,
          label: `${index + 1} ${fileName(folder)}`,
          enabled: true,
          run: () => void project.open(folder),
        }))),
    {
      id: "file.open-source",
      label: en.menu.file.openSource,
      // No target needed: a translation is begun from a source, so the source is opened first and
      // the target is made from it. See side-by-side-tasks.md S2.
      enabled: !choosing,
      run: () => void pick("subtitle", undefined, (path) => void source.open(path)),
    },
    {
      id: "file.new-translation",
      label: en.menu.file.newTranslation,
      // There has to be something to translate from, and a document being written can be replaced
      // only once its own edits are on disk, which the command says for itself when they are not.
      enabled: source.summary !== null,
      run: () => void subtitle.newTranslation(),
    },
    {
      id: "file.close-source",
      label: en.menu.file.closeSource,
      enabled: source.summary !== null,
      run: () => void source.close(),
    },
    {
      id: "video.open",
      label: en.menu.file.openVideo,
      accelerator: en.menu.keys.openVideo,
      enabled: !choosing && state.status !== "loading",
      run: () => void pick("video", undefined, (path) => void open(path)),
    },
    {
      id: "file.save",
      label: en.menu.file.save,
      accelerator: en.menu.keys.save,
      enabled: subtitle.summary !== null && dirty && !choosing,
      run: () => void saveDocument(),
    },
    {
      id: "file.save-as",
      label: en.menu.file.saveAs,
      accelerator: en.menu.keys.saveAs,
      enabled: subtitle.summary !== null && !choosing,
      run: () => void saveAs(),
    },
    {
      id: "file.export",
      label: en.menu.file.export,
      // A copy in a charset the user names: nothing to write without a document (3.1 item 9).
      enabled: subtitle.summary !== null && !choosing,
      run: () => setExportOpen(true),
    },
    {
      id: "file.discard",
      label: en.menu.file.discard,
      // Drawn always, usable only while an open was refused for unsaved edits: there is nothing to
      // discard the rest of the time, and `discardAndOpen` no-ops then anyway.
      enabled: blocked,
      run: () => void subtitle.discardAndOpen(),
    },
    {
      id: "file.properties",
      label: en.menu.file.properties,
      // The reference marks it always usable because a document is always open there; Sublore greys
      // it with none, so it is never a clickable item that opens on nothing (interface-spec 3.1, 3.4).
      enabled: subtitle.summary !== null,
      run: () =>
        void readScriptInfo().then((info) => {
          if (info !== null) {
            setScriptInfo(info);
          }
        }),
    },
    {
      id: "app.quit",
      label: en.menu.file.quit,
      accelerator: en.menu.keys.quit,
      enabled: true,
      run: () => void quit(),
    },
    {
      id: "asr.transcribe",
      label: en.menu.edit.transcribe,
      enabled: !transcribeOpen,
      run: () => setTranscribeOpen(true),
    },
    {
      id: "edit.undo",
      label: en.menu.edit.undo,
      accelerator: en.menu.keys.undo,
      enabled: subtitle.canUndo,
      run: () => void undoDocument(),
    },
    {
      id: "edit.redo",
      label: en.menu.edit.redo,
      accelerator: en.menu.keys.redo,
      enabled: subtitle.canRedo,
      run: () => void redoDocument(),
    },
    {
      id: "edit.find",
      label: en.menu.edit.find,
      accelerator: en.menu.keys.find,
      // Nothing to search until a document is open, and the band is drawn greyed until then.
      enabled: subtitle.summary !== null,
      run: () => setFindMode("find"),
    },
    {
      id: "edit.find-next",
      label: en.menu.edit.findNext,
      accelerator: en.menu.keys.findNext,
      // Greyed with no pattern to step through: a find with nothing to find would put "No match"
      // under a field nobody has typed in yet, which is the accusation F2 refuses to make.
      enabled: subtitle.summary !== null && query.needle !== "",
      run: () => findNext(),
    },
    {
      id: "edit.replace",
      label: en.menu.edit.replace,
      accelerator: en.menu.keys.replace,
      // The same band in its other mode: the two are never open at once (interface-spec 9.2).
      enabled: subtitle.summary !== null,
      run: () => setFindMode("replace"),
    },
    {
      id: "time.start-to-playhead",
      label: en.menu.timing.startToPlayhead,
      accelerator: en.menu.keys.startToPlayhead,
      enabled: subtitle.summary !== null && selection.active !== null && ready,
      run: () => void boundaryToPlayhead("start"),
    },
    {
      id: "time.end-to-playhead",
      label: en.menu.timing.endToPlayhead,
      accelerator: en.menu.keys.endToPlayhead,
      enabled: subtitle.summary !== null && selection.active !== null && ready,
      run: () => void boundaryToPlayhead("end"),
    },
    {
      id: "time.shift",
      label: en.menu.timing.shift,
      accelerator: en.menu.keys.shift,
      // Always, which is what the reference does and what the interface spec's own table says: the
      // form opens on a document that is not there yet and shifts nothing.
      enabled: true,
      run: () => setShiftOpen(true),
    },
    {
      id: "time.shift-to-playhead",
      label: en.menu.timing.shiftToPlayhead,
      accelerator: en.menu.keys.shiftToPlayhead,
      // A video to read the playhead off and a line to move: the reference leaves this item alive
      // with nothing selected and does nothing when it is used, which the spec corrects here.
      enabled: ready && selection.active !== null && selection.selected.size > 0,
      run: () => void shiftSelectionToPlayhead(),
    },
    {
      id: "time.continuous-start",
      label: en.menu.timing.continuousStart,
      enabled: subtitle.summary !== null && selectionIsContiguous,
      run: () => void makeTimesContinuous("start"),
    },
    {
      id: "time.continuous-end",
      label: en.menu.timing.continuousEnd,
      enabled: subtitle.summary !== null && selectionIsContiguous,
      run: () => void makeTimesContinuous("end"),
    },
    {
      id: "time.start-earlier",
      label: en.menu.timing.startEarlier,
      accelerator: en.menu.keys.startEarlier,
      enabled: subtitle.summary !== null && selection.active !== null,
      run: () => void nudge("start", -NUDGE_MS),
    },
    {
      id: "time.start-later",
      label: en.menu.timing.startLater,
      accelerator: en.menu.keys.startLater,
      enabled: subtitle.summary !== null && selection.active !== null,
      run: () => void nudge("start", NUDGE_MS),
    },
    {
      id: "time.end-earlier",
      label: en.menu.timing.endEarlier,
      accelerator: en.menu.keys.endEarlier,
      enabled: subtitle.summary !== null && selection.active !== null,
      run: () => void nudge("end", -NUDGE_MS),
    },
    {
      id: "time.end-later",
      label: en.menu.timing.endLater,
      accelerator: en.menu.keys.endLater,
      enabled: subtitle.summary !== null && selection.active !== null,
      run: () => void nudge("end", NUDGE_MS),
    },
    {
      id: "time.prev-cue",
      label: en.menu.timing.prevCue,
      accelerator: en.menu.keys.prevCue,
      enabled: selection.active !== null && selection.active > 0,
      run: () => selection.move((selection.active ?? 0) - 1, "plain"),
    },
    {
      id: "time.next-cue",
      label: en.menu.timing.nextCue,
      accelerator: en.menu.keys.nextCue,
      enabled: selection.active !== null && selection.active < subtitle.cues.length - 1,
      run: () => selection.move((selection.active ?? 0) + 1, "plain"),
    },
    {
      id: "wave.play-selection",
      label: en.menu.timing.playSelection,
      accelerator: en.menu.keys.playSelection,
      enabled: subtitle.summary !== null && selection.active !== null && ready,
      run: () => void playSelection(),
    },
    {
      id: "time.play-line",
      label: en.menu.timing.playLine,
      accelerator: en.menu.keys.playLine,
      enabled: subtitle.summary !== null && selection.active !== null && ready,
      run: () => void playCue("line"),
    },
    {
      id: "wave.stop",
      label: en.menu.timing.stop,
      accelerator: en.menu.keys.stopPlaying,
      // Greyed unless something is playing, which is what the reference greys it on.
      enabled: ready && !state.paused,
      run: () => void togglePlayback(),
    },
    {
      id: "time.play-before",
      label: en.menu.timing.playBefore,
      accelerator: en.menu.keys.playBefore,
      enabled: subtitle.summary !== null && selection.active !== null && ready,
      run: () => void playCue("before"),
    },
    {
      id: "time.play-after",
      label: en.menu.timing.playAfter,
      accelerator: en.menu.keys.playAfter,
      enabled: subtitle.summary !== null && selection.active !== null && ready,
      run: () => void playCue("after"),
    },
    {
      id: "wave.play-first",
      label: en.menu.timing.playFirst,
      accelerator: en.menu.keys.playFirst,
      enabled: subtitle.summary !== null && selection.active !== null && ready,
      run: () => void playCue("first"),
    },
    {
      id: "wave.play-last",
      label: en.menu.timing.playLast,
      accelerator: en.menu.keys.playLast,
      enabled: subtitle.summary !== null && selection.active !== null && ready,
      run: () => void playCue("last"),
    },
    {
      id: "time.play-to-end",
      label: en.menu.timing.playToEnd,
      accelerator: en.menu.keys.playToEnd,
      enabled: subtitle.summary !== null && selection.active !== null && ready,
      run: () => void playCue("to-end"),
    },
    {
      id: "time.commit",
      label: en.menu.timing.commit,
      // Both the keys the reference binds it to: the letter in the audio context, and the numpad's
      // own Enter, which answers there whatever has the focus. Its two variants carry neither, and
      // are reached from the panel's own strip.
      accelerator: [en.menu.keys.commitTiming, en.menu.keys.commitTimingNumpad],
      // Nothing to commit into without a line; the markers belong to the cursor's cue (5).
      enabled: subtitle.summary !== null && selection.active !== null,
      run: () => void commitTimes("auto"),
    },
    {
      id: "time.commit-next",
      label: en.menu.timing.commitNext,
      // The reference draws neither variant anywhere: they are keyboard commands, as its own
      // toolbar and menu files show. Shift+G and Ctrl+G here, beside plain G.
      accelerator: "Shift+G",
      enabled: subtitle.summary !== null && selection.active !== null,
      run: () => void commitTimes("always"),
    },
    {
      id: "time.commit-stay",
      label: en.menu.timing.commitStay,
      // Not Ctrl+G: that is Jump to time (9.7). Alt+G, beside plain G and Shift+G.
      accelerator: "Alt+G",
      enabled: subtitle.summary !== null && selection.active !== null,
      run: () => void commitTimes("never"),
    },
    {
      id: "time.lead-in",
      label: en.menu.timing.leadIn,
      accelerator: en.menu.keys.leadIn,
      enabled: subtitle.summary !== null && selection.active !== null,
      run: () => void nudge("start", -preferences.leadInMs),
    },
    {
      id: "time.lead-out",
      label: en.menu.timing.leadOut,
      accelerator: en.menu.keys.leadOut,
      enabled: subtitle.summary !== null && selection.active !== null,
      run: () => void nudge("end", preferences.leadOutMs),
    },
    {
      // No cursor needed: finding the cue at the playhead is what gives it one.
      id: "edit.select-at-playhead",
      label: en.menu.timing.selectAtPlayhead,
      enabled: subtitle.summary !== null && subtitle.cues.length > 0 && ready,
      run: () => selectAtPlayhead(),
    },
    ...STYLE_FLAGS.map(({ id, flag, label }): Command => ({
      id,
      label,
      enabled: writesAtCaret,
      run: () => {
        if (caret !== null && selection.active !== null) {
          void subtitle.toggleStyle(selection.active, flag, caret.offset, caret.to);
        }
      },
    })),
    // The four colours, on the same gate as the four styles above: both write a tag at the caret,
    // so both need one. The reference has them as commands too, on these keys (N112).
    ...COLOUR_COMMANDS.map(({ id, slot, label, accelerator }): Command => ({
      id,
      label,
      accelerator,
      enabled: writesAtCaret,
      run: () => openColour.current(slot),
    })),
    {
      id: "video.close",
      label: en.menu.video.close,
      enabled: state.status === "ready",
      run: () => void closeVideo(),
    },
    {
      id: "video.details",
      label: en.menu.video.details,
      enabled: state.status === "ready",
      // A media that will not answer leaves the dialog shut, and the refusal reaches the status
      // bar the way every other video refusal does.
      run: () =>
        void readVideoDetails().then((found) => {
          if (found !== null) {
            setVideoDetails(found);
          }
        }),
    },
    {
      id: "video.play",
      label: en.menu.video.play,
      accelerator: en.menu.keys.videoPlay,
      enabled: state.status === "ready",
      run: () => void playVideo(),
    },
    {
      id: "video.play-cue",
      label: en.menu.video.playCue,
      enabled: state.status === "ready" && activeCue !== null,
      run: () => void playCue("line"),
    },
    {
      id: "video.stop",
      label: en.menu.video.stop,
      enabled: state.status === "ready",
      run: () => void pauseVideo(),
    },
    {
      id: "video.toggle-follow-selection",
      label: en.menu.video.followSelection,
      checked: videoFollowSelection,
      // Alive with no video too, for the reason the waveform's own follow is (24 A2).
      enabled: true,
      run: () => storeLayout({ videoFollowSelection: !videoFollowSelection }),
    },
    {
      id: "video.jump-to",
      label: en.menu.video.jumpTo,
      accelerator: en.menu.keys.videoJumpTo,
      enabled: state.status === "ready",
      run: () => setJumpToOpen(true),
    },
    {
      id: "video.jump-cue-start",
      label: en.menu.video.jumpCueStart,
      accelerator: en.menu.keys.videoToCueStart,
      // A place on the picture to jump to and a line to take it from: both, or there is nothing.
      enabled: state.status === "ready" && activeCue !== null,
      run: () => {
        if (activeCue !== null) {
          void seek(activeCue.startMs / 1000);
        }
      },
    },
    {
      id: "video.jump-cue-end",
      label: en.menu.video.jumpCueEnd,
      accelerator: en.menu.keys.videoToCueEnd,
      enabled: state.status === "ready" && activeCue !== null,
      run: () => {
        if (activeCue !== null) {
          void seek(activeCue.endMs / 1000);
        }
      },
    },
    {
      id: "video.step-prev-frame",
      label: en.menu.video.stepPrevFrame,
      accelerator: [en.menu.keys.videoStepBack, en.menu.keys.videoStepBackNumpad],
      enabled: state.status === "ready",
      run: () => void stepVideo(-1),
    },
    {
      id: "video.step-next-frame",
      label: en.menu.video.stepNextFrame,
      accelerator: [en.menu.keys.videoStepForward, en.menu.keys.videoStepForwardNumpad],
      enabled: state.status === "ready",
      run: () => void stepVideo(1),
    },
    {
      id: "video.jump-back",
      label: en.menu.video.jumpBack,
      accelerator: en.menu.keys.videoJumpBack,
      enabled: state.status === "ready",
      run: () => void stepVideo(-JUMP_FRAMES),
    },
    {
      id: "video.jump-forward",
      label: en.menu.video.jumpForward,
      accelerator: en.menu.keys.videoJumpForward,
      enabled: state.status === "ready",
      run: () => void stepVideo(JUMP_FRAMES),
    },
    {
      id: "video.prev-boundary",
      label: en.menu.video.prevBoundary,
      accelerator: en.menu.keys.videoPrevBoundary,
      enabled: state.status === "ready" && subtitle.cues.length > 0,
      run: () => void toBoundary(false),
    },
    {
      id: "video.next-boundary",
      label: en.menu.video.nextBoundary,
      accelerator: en.menu.keys.videoNextBoundary,
      enabled: state.status === "ready" && subtitle.cues.length > 0,
      run: () => void toBoundary(true),
    },
    {
      id: "edit.cut",
      label: en.menu.edit.cut,
      accelerator: en.menu.keys.cut,
      enabled: selection.selected.size > 0,
      run: () => void cutCues(),
    },
    {
      id: "edit.copy",
      label: en.menu.edit.copy,
      accelerator: en.menu.keys.copy,
      enabled: selection.selected.size > 0,
      run: () => void copyCues(),
    },
    {
      id: "edit.paste",
      label: en.menu.edit.paste,
      accelerator: en.menu.keys.paste,
      // The clipboard is not read to answer this: asking it on every render would put a GTK call
      // behind every keystroke. A paste with nothing to paste does nothing, and says so by doing
      // nothing rather than by being greyed.
      enabled: subtitle.summary !== null,
      run: () => void pasteCues(),
    },
    {
      id: "edit.paste-over",
      label: en.menu.edit.pasteOver,
      accelerator: en.menu.keys.pasteOver,
      enabled: selection.selected.size > 0,
      run: () => void pasteOverCues(),
    },
    {
      id: "edit.select-all",
      label: en.menu.edit.selectAll,
      accelerator: en.menu.keys.selectAll,
      enabled: subtitle.cues.length > 0,
      run: () => selection.selectAll(),
    },
    {
      id: "edit.revert",
      label: en.menu.edit.revert,
      // Nothing to put back until the line has moved from what it was when the cursor reached it.
      enabled: activeCue !== null && arrived !== null && arrived.text !== activeCue.text,
      run: () => {
        if (selection.active !== null && arrived !== null) {
          void subtitle.setText(selection.active, arrived.text);
        }
      },
    },
    {
      id: "edit.clear",
      label: en.menu.edit.clear,
      enabled: activeCue !== null && activeCue.text !== "",
      run: () => {
        if (selection.active !== null) {
          void subtitle.clearText(selection.active, false);
        }
      },
    },
    {
      id: "edit.clear-text",
      label: en.menu.edit.clearText,
      enabled: activeCue !== null && activeCue.text !== "",
      run: () => {
        if (selection.active !== null) {
          void subtitle.clearText(selection.active, true);
        }
      },
    },
    {
      id: "edit.insert-original",
      label: en.menu.edit.insertOriginal,
      // The source's line for this row, put where the caret is. Both are needed, and a row the
      // source does not reach has nothing to insert. See side-by-side-tasks.md S4 and B13.
      enabled:
        hasCaret && selection.active !== null && (source.cues[selection.active]?.text ?? "") !== "",
      run: () => {
        if (caret === null || selection.active === null || activeCue === null) {
          return;
        }
        const original = source.cues[selection.active]?.text ?? "";
        if (original === "") {
          return;
        }
        void subtitle.setText(selection.active, spliceUtf8(activeCue.text, caret.offset, original));
      },
    },
    {
      id: "subtitle.insert-after",
      label: en.menu.subtitles.insertAfter,
      // A document with no rows can still take its first one, so the cursor is not required here.
      // The interface asks for a selected line; Sublore keeps the looser rule on this one alone,
      // because a document that has just been made has no line to select and no other way in.
      enabled: subtitle.summary !== null,
      run: () => void insertCue(true, false),
    },
    {
      id: "subtitle.insert-before",
      label: en.menu.subtitles.insertBefore,
      enabled: activeCue !== null,
      run: () => void insertCue(false, false),
    },
    {
      id: "subtitle.insert-after-at-playhead",
      label: en.menu.subtitles.insertAfterAtPlayhead,
      enabled: activeCue !== null && state.status === "ready",
      run: () => void insertCue(true, true),
    },
    {
      id: "subtitle.insert-before-at-playhead",
      label: en.menu.subtitles.insertBeforeAtPlayhead,
      enabled: activeCue !== null && state.status === "ready",
      run: () => void insertCue(false, true),
    },
    {
      id: "subtitle.duplicate",
      label: en.menu.subtitles.duplicate,
      enabled: selection.selected.size > 0,
      run: () => void duplicateCues(),
    },
    {
      id: "subtitle.next-line",
      label: en.menu.subtitles.nextLine,
      // A document with no rows can still take its first one, exactly as the insert above can.
      enabled: subtitle.summary !== null,
      run: () => void nextLine(),
    },
    {
      id: "subtitle.delete",
      label: en.menu.subtitles.delete,
      accelerator: en.menu.keys.deleteCues,
      enabled: selection.selected.size > 0,
      run: () => void deleteCues(),
    },
    {
      id: "subtitle.split",
      label: en.menu.subtitles.split,
      // Only where a caret has been put, and only while the cursor is still on that row.
      enabled: activeCue !== null && caret !== null && caret.index === selection.active,
      run: () => void splitCue(),
    },
    {
      id: "subtitle.split-before-playhead",
      label: en.menu.subtitles.splitBeforePlayhead,
      accelerator: en.menu.keys.splitBeforePlayhead,
      enabled: ready && activeCue !== null,
      run: () => void splitAtPlayhead(true),
    },
    {
      id: "subtitle.split-after-playhead",
      label: en.menu.subtitles.splitAfterPlayhead,
      accelerator: en.menu.keys.splitAfterPlayhead,
      enabled: ready && activeCue !== null,
      run: () => void splitAtPlayhead(false),
    },
    {
      id: "subtitle.join-concat",
      label: en.menu.subtitles.joinConcat,
      enabled: selection.selected.size > 1,
      run: () => void joinCues(false),
    },
    {
      id: "subtitle.join-keep-first",
      label: en.menu.subtitles.joinKeepFirst,
      enabled: selection.selected.size > 1,
      run: () => void joinCues(true),
    },
    {
      id: "subtitle.merge",
      label: en.menu.subtitles.merge,
      // The last row has nothing after it to join, which is the greying M2.7 E3 names.
      enabled: selection.active !== null && selection.active < subtitle.cues.length - 1,
      run: () => void mergeCue(),
    },
    {
      id: "help.contents",
      label: en.menu.help.contents,
      accelerator: en.menu.keys.manual,
      enabled: true,
      run: () => void openHelpLink("manual"),
    },
    {
      id: "help.website",
      label: en.menu.help.website,
      enabled: true,
      run: () => void openHelpLink("website"),
    },
    {
      id: "help.report-bug",
      label: en.menu.help.reportBug,
      enabled: true,
      run: () => void openHelpLink("bugs"),
    },
    {
      id: "help.check-updates",
      label: en.menu.help.checkUpdates,
      enabled: true,
      run: () => setUpdateOpen(true),
    },
    {
      id: "help.event-log",
      label: en.menu.help.eventLog,
      enabled: true,
      run: () => setEventLogOpen(true),
    },
    {
      id: "subtitle.move-up",
      label: en.menu.subtitles.moveUp,
      accelerator: en.menu.keys.moveCuesUp,
      enabled: selection.selected.size > 0,
      run: () => void moveSelection(false),
    },
    {
      id: "subtitle.move-down",
      label: en.menu.subtitles.moveDown,
      accelerator: en.menu.keys.moveCuesDown,
      enabled: selection.selected.size > 0,
      run: () => void moveSelection(true),
    },
    {
      id: "subtitle.sort-all-start",
      label: en.menu.subtitles.byStart,
      enabled: subtitle.cues.length > 0,
      run: () => void sortSelection("start", false),
    },
    {
      id: "subtitle.sort-all-end",
      label: en.menu.subtitles.byEnd,
      enabled: subtitle.cues.length > 0,
      run: () => void sortSelection("end", false),
    },
    {
      id: "subtitle.sort-selected-start",
      label: en.menu.subtitles.byStart,
      enabled: selection.selected.size > 1,
      run: () => void sortSelection("start", true),
    },
    {
      id: "subtitle.sort-selected-end",
      label: en.menu.subtitles.byEnd,
      enabled: selection.selected.size > 1,
      run: () => void sortSelection("end", true),
    },
    {
      id: "help.about",
      label: en.menu.help.about,
      enabled: true,
      run: () => setAboutOpen(true),
    },
    {
      id: "video.toggle-subtitle-overlay",
      label: en.menu.view.subtitles,
      checked: preview.shown,
      // Enabled with no video and no document too, for the reason the waveform's toggle is: a
      // command that disappears when there is nothing to show reads as a command that is gone.
      enabled: true,
      run: () => preview.toggle(),
    },
    {
      id: "video.show-source-on-video",
      label: en.menu.view.sourceOnVideo,
      checked: preview.source,
      // Greyed with no source open, because there would be nothing else to draw. It is the one
      // toggle here that names a second document rather than a way of drawing the one (S3).
      enabled: source.summary !== null,
      run: () => preview.toggleSource(),
    },
    ...LAYOUTS.map(({ panel, token, label, needs }): Command => ({
      id: `view.layout-${token}`,
      label,
      checked: panels === panel,
      group: "layout",
      // Greyed by what is loaded and not by what is drawn: picking a layout for a picture that is
      // not open would be picking a panel with nothing in it (3.7).
      enabled:
        needs === "none" ||
        (needs === "video" && ready) ||
        (needs === "audio" && hasAudio) ||
        (needs === "both" && ready && hasAudio),
      run: () => storeLayout({ panels: panel }),
    })),
    {
      id: "view.waveform-panel",
      label: en.menu.view.waveform,
      checked: waveformShown,
      // Enabled with no audio too: a toggle that disables itself when the thing it toggles is
      // absent tells the user the command is gone rather than that the panel has nothing to show.
      enabled: true,
      // The same setting the four radios write, so the toggle and the radios can never disagree:
      // turning the wave off is picking the layout beside this one without it.
      run: () =>
        storeLayout({
          panels: waveformShown
            ? videoShown
              ? "videoGrid"
              : "gridOnly"
            : videoShown
              ? "full"
              : "waveformGrid",
        }),
    },
    {
      id: "wave.center-on-cue",
      label: en.menu.view.centreOnCue,
      // There is nothing to centre until the panel is on screen with a line drawn on it.
      enabled: audioPanelShown && activeCue !== null,
      run: () => centreOnCue.current(),
    },
    // The pan pair, 128 device px whatever the zoom, keys A and F. Keyboard-only like the
    // reference keeps them: no menu row and no button, just the registry and its accelerators.
    {
      id: "wave.scroll-left",
      label: en.menu.view.scrollLeft,
      accelerator: "A",
      enabled: audioPanelShown,
      run: () => scrollWave.current(-WAVE_SCROLL_PX),
    },
    {
      id: "wave.scroll-right",
      label: en.menu.view.scrollRight,
      accelerator: "F",
      enabled: audioPanelShown,
      run: () => scrollWave.current(WAVE_SCROLL_PX),
    },
    {
      id: "wave.toggle-autocommit",
      label: en.menu.view.autoCommit,
      checked: waveAutocommit,
      // Usable with no audio, like the other two wave toggles: a command that greys itself when
      // there is nothing to show reads as a command that is gone.
      enabled: true,
      run: () => storeLayout({ waveAutocommit: !waveAutocommit }),
    },
    {
      id: "wave.toggle-autonext",
      label: en.menu.view.autoNext,
      checked: waveAutonext,
      enabled: true,
      run: () => storeLayout({ waveAutonext: !waveAutonext }),
    },
    {
      id: "wave.toggle-autoscroll",
      label: en.menu.view.followCue,
      checked: waveAutoscroll,
      // Enabled with no audio too, for the reason the waveform's own toggle is: a command that
      // greys itself when there is nothing to show reads as a command that is gone.
      enabled: true,
      run: () => storeLayout({ waveAutoscroll: !waveAutoscroll }),
    },
    // The three ways the grid draws override tags, a radio set like the sizes below (7.4).
    ...TAG_MODES.map(({ mode, label }): Command => ({
      id: `view.tags-${mode}`,
      label,
      checked: tagMode === mode,
      group: "tags",
      enabled: true,
      run: () => setTagMode(mode),
    })),
    // One button that steps the three modes above, which the reference draws on the toolbar and
    // gives no menu of its own (interface-spec 4.1). A registry command like any other, not a fourth
    // face of the setting.
    {
      id: "view.tags-cycle",
      label: en.menu.view.tagsCycle,
      enabled: true,
      run: () => {
        const order = TAG_MODES.map((each) => each.mode);
        const next = order[(order.indexOf(tagMode) + 1) % order.length];
        setTagMode(next);
        // The reference reports the cycle's landing on the status bar for ten seconds (1.5).
        say(en.notices.tagMode[next]);
      },
    },
    // Radio items, drawn the way the Audio menu draws its track list.
    ...interfaceScales.map(({ percent, scale }): Command => ({
      id: `view.interface-scale-${percent}`,
      label: fill(en.menu.view.scale, { percent }),
      checked: layout !== null && layout.interfaceScale === scale,
      group: "interface-scale",
      enabled: true,
      run: () => storeLayout({ interfaceScale: scale }),
    })),
    {
      id: "audio.use-video-track",
      label: en.menu.audio.useVideoTrack,
      // Back to the video's own default: the first track in file order, which is what the
      // container opens on (interface-spec 3.6 item 1).
      enabled: ready && audio.tracks.length > 0,
      run: () => {
        const first = audio.tracks[0];
        if (first !== undefined) {
          void audio.switchTo(first.id);
        }
      },
    },
    ...recents.map((path, index): Command => ({
      // Drawn always (interface-spec 3.5): an empty list greys its own submenu by having no items.
      id: `video.recent.${index}`,
      label: recentLabel(path),
      enabled: true,
      run: () => void open(path),
    })),
    {
      id: "view.language",
      label: en.menu.view.language,
      // The interface language, chosen and remembered; drawn always (3.7 item 12).
      enabled: true,
      run: () => setLanguageOpen(true),
    },
    {
      id: "view.preferences",
      label: en.menu.view.preferences,
      accelerator: en.menu.keys.preferences,
      // The small set 9.6 keeps for v1; drawn always, like the language beside it.
      enabled: true,
      run: () => setPreferencesOpen(true),
    },
    ...audio.tracks.map((track, index): Command => ({
      id: `audio.track.${track.id}`,
      label: track.title ?? track.lang ?? `${en.menu.audio.track} ${index + 1}`,
      checked: track.id === audio.currentId,
      group: "audio-track",
      // A single track is listed and cannot be switched away from: there is nowhere to go, and an
      // item that does nothing when clicked is worse than one that says so.
      enabled: audio.tracks.length > 1,
      run: () => audio.switchTo(track.id),
    })),
  ];
  /** The one map both draw routes read, so an item drawn anywhere has an entry here (T3 C1). */
  /**
   * A contributed item, as a command like any other.
   *
   * The core answers "is a document open", never "is this the module's thing", so `enableWhen` is
   * the whole of what it knows (module-abi.md 5.2). Running one carries the item's own id back to
   * the module that contributed it, with the cursor's row and nothing else.
   */
  function contributed(item: Contribution): Command {
    const enabled = (() => {
      switch (item.enableWhen) {
        case "always":
          return true;
        case "documentOpen":
          return subtitle.summary !== null;
        case "projectOpen":
          return project.project !== null;
        case "selectionNonEmpty":
          return selection.selected.size > 0;
      }
    })();
    const panelId = panelOf(item, contributions);
    return {
      id: moduleCommandId(item),
      label: item.label,
      enabled,
      // The module's own id and the state the gesture carried, and nothing about what it does.
      // The band comes down when this settles, which is the second of its two reasons to.
      run: (row) =>
        void subtitle
          .invokeModule(item.module, item.id, selection.active, panelId, row)
          .finally(moduleWork.clear),
    };
  }

  // A panel is a command too, because activating one of its rows activates the panel: it is the
  // primary row action, and it needs a registry record to be greyed and gated like any other.
  const contributedCommands = contributions
    .filter(
      (item) => item.kind === "menuItem" || item.kind === "menuTitle" || item.kind === "panel",
    )
    .map(contributed);

  const commands: CommandRegistry = Object.fromEntries(
    [...declared, ...contributedCommands].map((command) => [command.id, command]),
  );

  // What right-clicking a grid row opens, drawn from the same registry as the menu bar and grouped
  // with the reference's own rules (interface-spec 3.9). Split before and after playhead are not
  // built yet, so the split slot holds the one split command that is.
  const gridContextItems: (CommandId | Separator)[] = [
    "subtitle.insert-before",
    "subtitle.insert-after",
    "subtitle.insert-before-at-playhead",
    "subtitle.insert-after-at-playhead",
    SEPARATOR,
    "subtitle.duplicate",
    "subtitle.split",
    SEPARATOR,
    "subtitle.join-concat",
    "subtitle.join-keep-first",
    SEPARATOR,
    "time.continuous-start",
    "time.continuous-end",
    SEPARATOR,
    "edit.cut",
    "edit.copy",
    "edit.paste",
    "edit.paste-over",
    SEPARATOR,
    "subtitle.delete",
  ];

  /*
   * The layout lists: ids only, one per route, and neither list changes with the state. What the
   * state moves is the greying inside the records above (CLAUDE.md, owner ruling 2026-09-03).
   */
  const menus: Menu[] = [
    {
      id: "file",
      title: en.menu.file.title,
      // Grouped the way the reference groups File: opening, then saving, then quit
      // (interface-spec 3.1 separators 6, 10 and 14). The properties and font groups it puts
      // between are not built, so their rules fold into the one before Quit.
      items: [
        "file.new",
        "file.open-subtitle",
        "file.open-encoding",
        {
          // The remembered projects, after the opens (3.1 item 5). Its rows are generated; with
          // none remembered it holds the one greyed placeholder instead of greying itself.
          id: "file-recent",
          label: en.menu.file.recent,
          items:
            project.recent.length === 0
              ? ["file.recent.empty" as CommandId]
              : project.recent.map((_, index): CommandId => `file.recent.${index}`),
        },
        "file.open-source",
        "file.close-source",
        "file.new-translation",
        SEPARATOR,
        "file.save",
        "file.save-as",
        "file.export",
        "file.discard",
        // Properties is a group of its own between the saves and quit (3.1 separators 10 and 14).
        SEPARATOR,
        "file.properties",
        SEPARATOR,
        "app.quit",
      ],
    },
    // Transcribe waits in Edit for an Audio title of its own, which arrives with the milestone that
    // registers those commands. File has no room: two keyboard routes pin its walk and its last item.
    {
      id: "edit",
      title: en.menu.edit.title,
      // The reference groups Edit undo/redo, clipboard, find (interface-spec 3.2 separators 3, 8,
      // 12). Sublore's own line commands (revert, clear, insert-original) and the inline-styling
      // set have no reference home, so they take groups of their own by what they do; transcribe
      // trails alone until it moves to an Audio title of its own.
      items: [
        "edit.undo",
        "edit.redo",
        SEPARATOR,
        "edit.cut",
        "edit.copy",
        "edit.paste",
        "edit.paste-over",
        SEPARATOR,
        "edit.select-all",
        "edit.revert",
        "edit.clear",
        "edit.clear-text",
        "edit.insert-original",
        SEPARATOR,
        "edit.style-bold",
        "edit.style-italic",
        "edit.style-underline",
        "edit.style-strikeout",
        "edit.colour-primary",
        "edit.colour-secondary",
        "edit.colour-outline",
        "edit.colour-shadow",
        SEPARATOR,
        "edit.find",
        "edit.find-next",
        "edit.replace",
        SEPARATOR,
        "asr.transcribe",
      ],
    },
    // Interface-spec 3 order: Subtitle sits right after Edit. Its fifth backend command,
    // subtitle_set_times, is not here: it is a field commit on the current line (T5), not an
    // action a menu item runs. See BACKLOG.md M2.7.
    {
      id: "subtitle",
      title: en.menu.subtitles.title,
      items: [
        // The four ways of asking for a cue sit in a list of their own, which is where the
        // interface puts them (interface-spec 3.3 item 1).
        {
          id: "subtitle-insert",
          label: en.menu.subtitles.insert,
          items: [
            "subtitle.insert-before",
            "subtitle.insert-after",
            "subtitle.insert-before-at-playhead",
            "subtitle.insert-after-at-playhead",
          ],
        },
        "subtitle.next-line",
        "subtitle.duplicate",
        // Delete after the three splits, which is where the reference draws it and where the
        // interface spec's table has it: the group runs insert, duplicate, split, split, split,
        // delete. It was before them, which is the order class the 2026-09-05 ruling calls a
        // defect rather than a taste (N115).
        "subtitle.split",
        "subtitle.split-before-playhead",
        "subtitle.split-after-playhead",
        "subtitle.delete",
        // The reference rules off the insert-and-split family before the join family
        // (interface-spec 3.3 separator 7). Its move and sort groups are not on this branch yet.
        SEPARATOR,
        // The two ways of joining lines sit in a list of their own, which is where the interface
        // puts them (interface-spec 3.3 item 8).
        {
          id: "subtitle-join",
          label: en.menu.subtitles.join,
          items: ["subtitle.join-concat", "subtitle.join-keep-first"],
        },
        "subtitle.merge",
        "subtitle.move-up",
        "subtitle.move-down",
        {
          // The two sorts sit in lists of their own, which is where the interface puts them
          // (interface-spec 3.3 items 16 and 17).
          id: "subtitle-sort-all",
          label: en.menu.subtitles.sortAll,
          items: ["subtitle.sort-all-start", "subtitle.sort-all-end"],
        },
        {
          id: "subtitle-sort-selected",
          label: en.menu.subtitles.sortSelected,
          items: ["subtitle.sort-selected-start", "subtitle.sort-selected-end"],
        },
      ],
    },
    {
      id: "timing",
      title: en.menu.timing.title,
      // The order the panel's own strip runs in, so a translator who learns one has learned the
      // other (owner ruling 2026-09-05). The four nudges keep the end, where they have always been.
      // Runs in the panel strip's order, so the rules mark its functional blocks rather than the
      // reference's own Timing groups (interface-spec 3.4), which this strip reorders: cue
      // navigation, then setting times, then playing them back, then the fine adjustments.
      items: [
        "time.prev-cue",
        "time.next-cue",
        SEPARATOR,
        "time.start-to-playhead",
        "time.end-to-playhead",
        "time.shift",
        "time.shift-to-playhead",
        // The two ways of making times continuous sit in a list of their own, which is where the
        // interface puts them and the first submenu the bar draws (interface-spec 3.4 item 9).
        {
          id: "time-continuous",
          label: en.menu.timing.continuous,
          items: ["time.continuous-start", "time.continuous-end"],
        },
        "edit.select-at-playhead",
        SEPARATOR,
        "wave.play-selection",
        "time.play-line",
        "wave.stop",
        "time.play-before",
        "time.play-after",
        "wave.play-first",
        "wave.play-last",
        "time.play-to-end",
        SEPARATOR,
        "time.lead-in",
        "time.lead-out",
        "time.start-earlier",
        "time.start-later",
        "time.end-earlier",
        "time.end-later",
      ],
    },
    // Fifth of the eight titles, which is where the reference's own bar puts it: what is about the
    // picture lives here and what is about the document lives in the four before it (3.4).
    {
      id: "video",
      title: en.menu.video.title,
      items: [
        "video.open",
        "video.close",
        {
          // The recent-videos list, where the reference puts it: after Close, before Details
          // (interface-spec 3.5 item 3). Its items are generated; with none it greys itself.
          id: "video-recent",
          label: en.menu.video.recent,
          items: recents.map((_, index): CommandId => `video.recent.${index}`),
        },
        "video.details",
        // The reference groups Video into the file, transport, jump and overlay blocks
        // (interface-spec 3.5 separators 6, 11, 15). Sublore's frame-step and boundary navigation
        // ride with the jump block, where the rest of the picture's navigation belongs.
        SEPARATOR,
        "video.play",
        "video.play-cue",
        "video.stop",
        "video.toggle-follow-selection",
        SEPARATOR,
        "video.jump-to",
        "video.jump-cue-start",
        "video.jump-cue-end",
        // The reference reaches these four from the keyboard alone. They are drawn because every
        // command in the registry is drawn (command-registry-tasks C1), and this is where the rest
        // of the picture's navigation belongs.
        "video.step-prev-frame",
        "video.step-next-frame",
        "video.jump-back",
        "video.jump-forward",
        "video.prev-boundary",
        "video.next-boundary",
        SEPARATOR,
        "video.toggle-subtitle-overlay",
        "video.show-source-on-video",
      ],
    },
    // A media with no audio, or no media at all, leaves this with no items: the title is still on
    // the bar, greyed, because a title that comes and goes reads as a title that is gone.
    {
      id: "audio",
      title: en.menu.audio.title,
      items: [
        "audio.use-video-track",
        ...audio.tracks.map((track): CommandId => `audio.track.${track.id}`),
      ],
    },
    {
      id: "view",
      title: en.menu.view.title,
      // The reference rules off the layout radios from the tag radios (interface-spec 3.7
      // separators 5 and 9). Sublore's own waveform toggles and interface-scale radios take the
      // groups after, where the reference keeps the toolbar toggle and the preferences.
      items: [
        "view.layout-grid-only",
        "view.layout-video-grid",
        "view.layout-waveform-grid",
        "view.layout-full",
        SEPARATOR,
        "view.tags-show",
        "view.tags-simplify",
        "view.tags-hide",
        SEPARATOR,
        "view.waveform-panel",
        "wave.center-on-cue",
        "wave.toggle-autoscroll",
        "wave.toggle-autocommit",
        "wave.toggle-autonext",
        SEPARATOR,
        ...interfaceScales.map(({ percent }): CommandId => `view.interface-scale-${percent}`),
        "view.language",
        "view.preferences",
      ],
    },
    {
      // Interface-spec §3.8 order, minus Community chat (scoped later, question 11) and the two
      // separators (no menu draws one yet; filed as its own task). See help-menu-tasks.md.
      id: "help",
      title: en.menu.help.title,
      items: [
        "help.contents",
        "help.website",
        "help.report-bug",
        "help.check-updates",
        "help.event-log",
        "help.about",
      ],
    },
    // A module's own titles, after the core's. A title exists exactly when a module pushed one with
    // children under it, so there is no branch anywhere that says a module is installed (5.1).
    ...contributions
      .filter((item) => item.kind === "menuTitle")
      .map((title) => ({
        id: `module-${title.module}-${title.id}`,
        title: title.label,
        items: contributions
          .filter(
            (item) =>
              item.kind === "menuItem" && item.module === title.module && item.parent === title.id,
          )
          .map(moduleCommandId),
      })),
  ];
  const toolbar: CommandId[][] = [
    ["file.open-subtitle", "video.open", "file.save", "file.save-as", "file.discard"],
    ["edit.undo", "edit.redo"],
    // The tag-cycle button, which the reference keeps on the toolbar and nowhere else (4.1).
    ["view.tags-cycle"],
  ];

  /*
   * The waveform panel's own strip, left to right, with a divider between each group: the order the
   * reference draws it in, minus the positions §1's non-goals and decision 3 take out. Every entry
   * is a registry id, so a button here greys with the record the menu bar draws (T3 C1).
   */
  const waveBar: WaveBarButton[][] = [
    [
      { id: "time.prev-cue", short: en.wavebar.prevCue },
      { id: "time.next-cue", short: en.wavebar.nextCue },
      { id: "wave.play-selection", short: en.wavebar.playSelection },
      { id: "time.play-line", short: en.wavebar.playLine },
      { id: "wave.stop", short: en.wavebar.stop },
    ],
    [
      { id: "time.play-before", short: en.wavebar.playBefore },
      { id: "time.play-after", short: en.wavebar.playAfter },
      { id: "wave.play-first", short: en.wavebar.playFirst },
      { id: "wave.play-last", short: en.wavebar.playLast },
      { id: "time.play-to-end", short: en.wavebar.playToEnd },
    ],
    [
      { id: "time.lead-in", short: en.wavebar.leadIn },
      { id: "time.lead-out", short: en.wavebar.leadOut },
    ],
    [{ id: "wave.center-on-cue", short: en.wavebar.centreOnCue }],
    [{ id: "wave.toggle-autoscroll", short: en.wavebar.followCue }],
  ];

  // How narrow the window may be made, measured off the shell and carried to the window (S1). The
  // titles are what a module can add to, and the only part of either bar whose width is not the
  // same in every state: a greyed command is drawn, so nothing else here comes or goes.
  const windowFloor = useWindowFloor(
    scale,
    menus.map((menu) => menu.title).join("\n"),
    minBlockWidth,
  );

  // Read by the accelerator listener, which is registered once and outlives every render.
  const latest = useRef(commands);
  useEffect(() => {
    latest.current = commands;
  });

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      // A field keeps the chords a field owns, and every bare key but a function key. This is the
      // only listener that asks: the grid used to answer the same question again, for three keys.
      // Shift alone is not a modifier here, because Shift+A is still typing (F5).
      const chorded = event.ctrlKey || event.altKey || event.metaKey;
      if (ownsTheKeyboard(event.target, event.key.toLowerCase(), chorded)) {
        return;
      }
      const id = commandFor(latest.current, event);
      if (id === null) {
        return;
      }
      // The key is ours either way, so it never reaches the page; whether it runs is the gate's.
      event.preventDefault();
      runCommand(latest.current, id);
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, []);

  return (
    <LayerContext.Provider value={layers.registrar}>
      {/* The floor, published where it can be read back: it is a measurement and not a number, so
        nothing outside the app could work out what the window was told. */}
      <div
        className="shell"
        data-minimum-width={windowFloor.width ?? undefined}
        data-floor-seen={windowFloor.seen ?? undefined}
      >
        <header className="shell__chrome">
          <MenuBar menus={menus} commands={commands} />
          <Toolbar groups={toolbar} commands={commands} />
        </header>
        <div
          className="shell__body"
          style={layout === null ? undefined : { height: layout.topHeight }}
        >
          <aside className="shell__rail">
            <ProjectRail project={project} onOpenFile={openAttachedFile} />
          </aside>
          <div className="shell__top" ref={topRef}>
            {/* The picture and the wave are drawn by the layout the View menu holds, not by what is
              loaded: a stage with nothing on it is still where a video would go (3.7). */}
            {videoShown && (
              <section
                className="shell__video"
                style={
                  layout === null
                    ? undefined
                    : {
                        width: `${layout.videoFraction * 100}%`,
                        // The floor holds where the panel is drawn, not only where it may be dragged:
                        // a stored share opens the panel without a gesture anywhere near it.
                        minWidth: transportFloor ?? undefined,
                      }
                }
              >
                <VideoStage hasVideo={ready} onRegionChange={setRegion} />
                <VideoControls
                  enabled={ready}
                  paused={state.paused}
                  duration={state.duration ?? 0}
                  position={position}
                  onToggle={() => void togglePlayback()}
                  onSeek={(target) => void seek(target)}
                />
              </section>
            )}
            {/* The edge the owner asked for: the video gets bigger by dragging it (D1). It waits
              for the floor the same way it waits for the layout: an edge with no floor under it
              could be dragged to a width that has no transport, and it is not drawn at all when
              there is no picture beside the tools to divide from them. */}
            {videoShown && layout !== null && transportFloor !== null && (
              <Sash
                axis="x"
                edge="video"
                size={videoWidth}
                min={minVideoWidth}
                max={maxVideoWidth}
                label={en.shell.videoSash}
                onResize={(width) => changeLayout({ videoFraction: asFraction(width) })}
                onRelease={(width) => storeLayout({ videoFraction: asFraction(width) })}
              />
            )}
            {/* The current line, with the waveform above it when there is one to draw (T5, W5). */}
            <section className="shell__tools" ref={toolsRef}>
              {/* Absent until the first chunk arrives, never an empty panel waiting for one, and
                absent again while View has it turned off. */}
              {/* Decision 24 E3: a media with no audio says so where the panel would be, in one
                line and not as a failure. */}
              {waveformShown && peaks.silent && (
                <p className="tools__silent">{en.waveform.noAudio}</p>
              )}
              {audioPanelShown && (
                <>
                  <Waveform
                    peaks={peaks}
                    positionMs={Math.round(position * 1000)}
                    durationMs={Math.round((state.duration ?? 0) * 1000)}
                    height={layout?.waveformHeight}
                    scale={scale}
                    paused={state.paused}
                    cueIndex={selection.active}
                    cue={waveCue}
                    cues={subtitle.cues}
                    selected={selection.selected}
                    autoscroll={waveAutoscroll}
                    centreRef={centreOnCue}
                    scrollRef={scrollWave}
                    liveRef={liveTimes}
                    onDragTimes={(cue, startMs, endMs) => void dragTimes(cue, startMs, endMs)}
                    onSeek={(target) => void seek(target)}
                  >
                    {/* Inside the panel, under the wave: the stored height is the whole panel's,
                      the way the reference's is, so the strip moves with the edge. */}
                    <WaveBar groups={waveBar} commands={commands} />
                  </Waveform>
                  {layout !== null && (
                    <Sash
                      axis="y"
                      edge="waveform"
                      size={layout.waveformHeight}
                      min={minWaveformHeight}
                      max={Math.max(minWaveformHeight, frame.toolsHeight - minCurrentLine)}
                      label={en.waveform.sash}
                      onResize={(height) => changeLayout({ waveformHeight: height })}
                      onRelease={(height) => storeLayout({ waveformHeight: height })}
                    />
                  )}
                </>
              )}
              <CurrentLine
                key={subtitle.openId}
                spectrumMode={layout?.spectrumMode ?? "hsvH"}
                cpsLimit={preferences.cpsLimit}
                onNotice={say}
                onSpectrumMode={(mode) => storeLayout({ spectrumMode: mode })}
                index={selection.active}
                cue={activeCue}
                multiline={subtitle.summary?.format !== "ass"}
                flushRef={flushLine}
                openColourRef={openColour}
                onDraftChange={setLineEdited}
                onCaret={(offset, to) =>
                  setCaret(
                    selection.active === null ? null : { index: selection.active, offset, to },
                  )
                }
                onCommit={subtitle.setText}
                onCommitTimes={subtitle.setTimes}
                cues={subtitle.cues}
                onCommitField={(cue, field, value) => subtitle.setField(cue, field, value)}
                commands={commands}
                styles={subtitle.summary?.styles.map((style) => style.name) ?? []}
                canComment={subtitle.summary?.format === "ass"}
                onCommitComment={(cue, comment) => subtitle.setComment(cue, comment)}
                onEditStyle={() => {
                  const at = (subtitle.summary?.styles ?? []).findIndex(
                    (style) => style.name === activeCue?.style,
                  );
                  if (at >= 0) {
                    setEditingStyle(at);
                  }
                }}
                canWriteTag={writesAtCaret}
                caretAt={writesAtCaret && caret !== null ? caret.offset : null}
                fonts={fonts.families}
                fontsLoading={fonts.loading}
                onLoadFonts={fonts.load}
                onSetOverrideTags={async (tags, at) => {
                  // The same rule the buttons grey on, read again here: a greyed control must not
                  // run, and a picker left open on a row the cursor has left must not write to it.
                  if (writesAtCaret && selection.active !== null) {
                    await subtitle.setOverrideTags(selection.active, tags, at);
                  }
                }}
              />
            </section>
          </div>
        </div>
        {/* The edge between the whole top row and the grid below it (D1). */}
        {layout !== null && (
          <Sash
            axis="y"
            edge="grid"
            size={layout.topHeight}
            min={minTopHeight}
            max={maxTopHeight}
            label={en.shell.gridSash}
            onResize={(height) => changeLayout({ topHeight: height })}
            onRelease={(height) => storeLayout({ topHeight: height })}
          />
        )}
        {/* Full width, crossing under the rail: the layout drawing, the M2.0 criterion and T2 all
          say the grid takes everything below. Owner ruling 2026-09-02. */}
        <section className="shell__grid" ref={gridRef}>
          <CueList
            key={subtitle.openId}
            cues={subtitle.cues}
            cpsLimit={preferences.cpsLimit}
            sourceCues={source.cues}
            tagMode={tagMode}
            selection={selection}
            multiline={subtitle.summary?.format !== "ass"}
            flushRef={flushGrid}
            onEditingChange={setEditorOpen}
            onCommit={subtitle.setText}
            commands={commands}
            contextItems={gridContextItems}
          />
        </section>
        {/* Under the grid, which is the one region that gives up space when it opens, so the top
          block keeps the height its sash left it at and the video surface does not move. See T4. */}
        {findMode !== null && (
          <FindBar
            mode={findMode}
            query={query}
            replacement={replacement}
            outcome={!searched ? "idle" : found === null ? "missing" : "found"}
            refusal={refusal}
            replaced={replaced}
            inSelection={inSelection}
            onInSelectionChange={(next) => {
              setInSelection(next);
              // The scope changed, so the match in hand is no longer where a search resumes from.
              setFound(null);
              setSearched(false);
              setReplaced(null);
              setRefusal(null);
            }}
            onQueryChange={(next) => {
              setQuery(next);
              // A changed pattern is a new search: resuming from the old match would skip the
              // first hit of the new one, and the last count is no longer about this pattern.
              setFound(null);
              setSearched(false);
              setReplaced(null);
              setRefusal(null);
            }}
            onReplacementChange={setReplacement}
            onFindNext={findNext}
            onReplace={() => void replaceCurrent()}
            onReplaceAll={() => void replaceAll()}
            onClose={() => setFindMode(null)}
          />
        )}
        {/* Beside the find band and the transcription one, in the region that gives up the
          space: a panel a module filled, and the line its work draws while it runs. */}
        {modulePanels.panels.map((panel) => {
          const contribution = contributions.find(
            (item) =>
              item.kind === "panel" && item.module === panel.module && item.id === panel.panelId,
          );
          if (contribution === undefined) {
            return null;
          }
          return (
            <ModulePanel
              key={`${panel.module}-${panel.panelId}`}
              panel={panel}
              title={contribution.label}
              primary={moduleCommandId(contribution)}
              actions={contributions
                .filter(
                  (item) =>
                    item.kind === "menuItem" &&
                    item.module === panel.module &&
                    item.parent === panel.panelId,
                )
                .map(moduleCommandId)}
              commands={commands}
              onClose={() => modulePanels.close(panel.module, panel.panelId)}
            />
          );
        })}
        {moduleWork.running && <ModuleWorkBand work={moduleWork} />}
        {transcribeOpen && (
          <TranscribePanel
            mediaPath={state.path}
            transcription={transcription}
            adoptedRunId={subtitle.adoptedRunId}
            onUse={(runId) => void adoptTranscription(runId)}
            onClose={() => setTranscribeOpen(false)}
          />
        )}
        <StatusBar
          summary={subtitle.summary}
          sourceSummary={source.summary}
          dirty={dirty}
          truncated={subtitle.truncated}
          saved={subtitle.saved}
          savedInPlace={subtitle.savedInPlace}
          // One sink for both documents: a source that could not be read is refused for the same
          // reasons a target is, and the bar already says each of them in the user's words.
          subtitleError={subtitle.error ?? source.error}
          videoErrorCode={errorCode}
          projectDeleted={project.deleted}
          projectError={project.error}
          chromeError={quitError ?? (windowFloor.failed ? en.shell.errors.windowFloor : null)}
          waveformFailed={peaks.error !== null}
          notice={notice}
          previewFailed={preview.failed}
          moduleRefusals={modules.refused.map((refused) => refusalLine(refused, en.modules))}
        />
        {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
        {updateOpen && <UpdateDialog onClose={() => setUpdateOpen(false)} />}
        {eventLogOpen && <EventLogDialog onClose={() => setEventLogOpen(false)} />}
        {encodingPath !== null && (
          <OpenEncoding
            onChoose={(label) => {
              const path = encodingPath;
              setEncodingPath(null);
              void subtitle.openWithEncoding(path, label);
            }}
            onClose={() => setEncodingPath(null)}
          />
        )}
        {languageOpen && <LanguageDialog onClose={() => setLanguageOpen(false)} />}
        {pasteOverAsk !== null && (
          <PasteOverDialog
            fields={pasteFields}
            available={pasteableFields(pasteOverAsk.rows)}
            onConfirm={(next) => {
              const asked = pasteOverAsk;
              setPasteOverAsk(null);
              void storePasteFields(next);
              void subtitle.pasteOver(asked.rows, asked.text, next);
            }}
            onClose={() => setPasteOverAsk(null)}
          />
        )}
        {preferencesOpen && (
          <PreferencesDialog
            preferences={preferences}
            onConfirm={(next) => {
              setPreferencesOpen(false);
              void storePreferences(next);
            }}
            onClose={() => setPreferencesOpen(false)}
          />
        )}
        {exportOpen && (
          <OpenEncoding
            writable
            confirm={en.menu.file.export}
            onChoose={(label) => {
              setExportOpen(false);
              void pick(
                "subtitle-save",
                subtitle.summary?.path ?? undefined,
                (path) => void subtitle.exportCopy(path, label),
              );
            }}
            onClose={() => setExportOpen(false)}
          />
        )}
        {shiftOpen && (
          <ShiftTimes
            hasSelection={selection.selected.size > 0}
            onShift={(request) => {
              setShiftOpen(false);
              void shiftTimes(request);
            }}
            onClose={() => setShiftOpen(false)}
          />
        )}
        {jumpToOpen && (
          <JumpToTime
            position={position}
            duration={state.duration ?? 0}
            onJump={(seconds) => {
              void seek(seconds);
              setJumpToOpen(false);
              // The reference leaves the keyboard on the seek slider, so the next arrow key steps
              // the picture. Focused after the panel has gone, or its unmount takes it back.
              requestAnimationFrame(() => {
                document.querySelector<HTMLInputElement>(".controls__slider")?.focus();
              });
            }}
            onClose={() => setJumpToOpen(false)}
          />
        )}
        {videoDetails !== null && (
          <VideoDetailsPanel details={videoDetails} onClose={() => setVideoDetails(null)} />
        )}
        {scriptInfo !== null && (
          <ScriptProperties info={scriptInfo} onClose={() => setScriptInfo(null)} />
        )}
        {/* The style the editor was opened over may go with an undo or a reopen, so the panel is
          drawn only while the document still declares one at that place. */}
        {editingStyle !== null && subtitle.summary?.styles[editingStyle] !== undefined && (
          <StyleEditor
            index={editingStyle}
            style={subtitle.summary.styles[editingStyle]}
            fonts={fonts.families}
            onLoadFonts={fonts.load}
            onCommit={(index, field, value) => subtitle.setStyleField(index, field, value)}
            onClose={() => setEditingStyle(null)}
          />
        )}
      </div>
    </LayerContext.Provider>
  );
}
