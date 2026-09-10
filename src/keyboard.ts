/**
 * The one place that decides whether a key press belongs to the shell, and which command it asks
 * for. Before this the answer lived in three window listeners that could not see each other, and
 * eight commands had no key because adding one meant choosing which of the three to grow. See
 * docs/keyboard-tasks.md.
 */
import { isDocumentEditor } from "./components/cueView";
import { type CommandId, type CommandRegistry } from "./types/chrome";

/** Input types that hold typed text, and so keep their own undo. A range slider holds none. */
const TEXT_INPUT_TYPES = ["text", "search", "url", "email", "tel", "password", "number"];

/**
 * The chords a text field owns natively: its own undo and redo, its own selection, its own
 * clipboard. A chord outside this set belongs to the shell even with the caret in a field, or
 * Ctrl+F could not be pressed twice from the find band and Ctrl+S could not save while a search box
 * had focus, which is what every editor does. See docs/keyboard-tasks.md.
 */
const FIELD_CHORDS: ReadonlySet<string> = new Set(["a", "c", "v", "x", "y", "z"]);

/**
 * The keys a text field keeps even under a modifier: moving the caret, selecting with it, and
 * taking out the word in front of it.
 *
 * Ctrl+Left is a word backwards in every text box there has ever been, and the grid's own context
 * puts the video's boundary and frame commands on the same chords. Which one gets it turns on where
 * the caret is, exactly as it does for Ctrl+A. Ctrl+Delete is here for the same reason: in a box it
 * takes out a word, and outside one it takes out the selected lines. See interface-spec 10.5.
 */
const FIELD_NAVIGATION: ReadonlySet<string> = new Set([
  "arrowleft",
  "arrowright",
  "arrowup",
  "arrowdown",
  "home",
  "end",
  "delete",
]);

/**
 * The two of those the document takes back inside its own editors: undo and redo there are the
 * document's history and not the field's, which is what a translator means by pressing them over a
 * line they are writing.
 *
 * The other four stay with the field even there. That matters from the moment the shell has a
 * command on one of them: Ctrl+A over the grid selects every cue, and over the box it selects the
 * words being typed, which is what the keyboard spec's two contexts say and what every editor does.
 */
const HISTORY_CHORDS: ReadonlySet<string> = new Set(["y", "z"]);

/**
 * F1 to F12, the only bare keys a text field has no use for.
 *
 * One definition, read twice: against an accelerator's token, and against a press's own `key`. The
 * two cannot be confused, because a function key's `key` is `F3` and the letter F's is `f`.
 */
const FUNCTION_KEY = /^f([1-9]|1[0-2])$/i;

/** Whether this element holds typed text. A checkbox, a slider and a button hold none. */
function isTextField(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.includes(target.type);
  }
  return target instanceof HTMLTextAreaElement || target.isContentEditable;
}

/**
 * Whether this press belongs to the field it landed in rather than to the shell.
 *
 * Two answers, and which one is given turns on whether a modifier was held.
 *
 * With no modifier a text field owns every key but a function key. The allowlist is written that
 * way round rather than as a test for printability, because Backspace, Delete, Enter, Tab, Home,
 * End and the arrows all mean something inside a field and not one of them is a character. F1 to
 * F12 are what is left over, which is why every editor puts its shell commands there and why F3 can
 * step the search on from inside the band's own query field and from inside a cue being edited.
 * The half exists because `parseAccelerator` now takes a bare token at all: a future accelerator on
 * a bare `n` must not fire while someone types `n` into a cue.
 *
 * A chord keeps the older answer, the set above inside a field that is not one of the document's
 * editors, because Ctrl+Z in those is the document's undo and never the webview's, which would fork
 * the two histories. See docs/keyboard-tasks.md and F5.
 */
export function ownsTheKeyboard(
  target: EventTarget | null,
  key: string,
  chorded: boolean,
): boolean {
  if (!isTextField(target)) {
    return false;
  }
  if (!chorded) {
    return !FUNCTION_KEY.test(key);
  }
  if (FIELD_NAVIGATION.has(key)) {
    return true;
  }
  return FIELD_CHORDS.has(key) && !(isDocumentEditor(target) && HISTORY_CHORDS.has(key));
}

/**
 * A declared accelerator, in the shapes the strings use: `Ctrl+O`, `Ctrl+Shift+S`, `Ctrl+1`, `F3`.
 *
 * `on` is which property of the press the value is compared against, and the two are not
 * interchangeable. A letter is `key`, because on AZERTY Ctrl+A must be the key labelled A and that
 * key's `code` is `KeyQ`. A digit is `code`, because `key` carries the glyph the layout puts there:
 * measured, the same physical key reads `1` under `us`, `&` under `fr`, and `!` under Shift. A
 * function key is `code` as well: it is one physical key with no glyph to shift into (F5).
 */
type Chord = {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  on: "key" | "code";
  value: string;
};

/**
 * The keys an accelerator spells by name, and the `key` each one arrives as. `code` would be the
 * physical key, and these are the same key on every layout there is, so `key` says what it is.
 */
const NAMED_KEYS: Record<string, string> = {
  delete: "delete",
};

/** The arrow tokens an accelerator spells, and the `key` each one arrives as. */
const ARROWS: Record<string, string> = {
  left: "arrowleft",
  right: "arrowright",
  up: "arrowup",
  down: "arrowdown",
};

/** `Num 5` and `Num5` alike: the space is how the menu reads best, and it is one token either way. */
const NUMPAD_KEY = /^num\s*([0-9])$/i;

/** Anything this cannot express returns null: the menu draws the string and no key fires it. */
function parseAccelerator(text: string | undefined): Chord | null {
  if (text === undefined) {
    return null;
  }
  const parts = text.split("+").map((part) => part.trim());
  const token = parts.pop();
  const modifiers = parts.map((part) => part.toLowerCase());
  // Anything not one of these three is a modifier this cannot honour. Ctrl is not required: F3 has
  // no modifier at all.
  if (
    token === undefined ||
    modifiers.some((part) => part !== "ctrl" && part !== "shift" && part !== "alt")
  ) {
    return null;
  }
  const ctrl = modifiers.includes("ctrl");
  const shift = modifiers.includes("shift");
  const alt = modifiers.includes("alt");
  // AltGr arrives as ctrl and alt held together and what it produces is a character: a chord asking
  // for both is one nothing may match, or a command would eat someone's typing.
  if (ctrl && alt) {
    return null;
  }
  const arrow = ARROWS[token.toLowerCase()];
  if (arrow !== undefined) {
    return { ctrl, shift, alt, on: "key", value: arrow };
  }
  const named = NAMED_KEYS[token.toLowerCase()];
  if (named !== undefined) {
    return { ctrl, shift, alt, on: "key", value: named };
  }
  if (/^[0-9]$/.test(token)) {
    return { ctrl, shift, alt, on: "code", value: `Digit${token}` };
  }
  // The numpad, spelled `Num 5` because that is what the menu draws. `code` for the same reason
  // the digit row uses it, and the reason is stronger here: it is NumLock rather than the layout
  // that moves the glyph, and with NumLock off `Numpad5`'s `key` is not a digit at all. Measured
  // on 2026-09-10: a press arrives as `code` "Numpad5" whatever `key` says. See BACKLOG.md N106.
  const numpad = NUMPAD_KEY.exec(token);
  if (numpad !== null) {
    return { ctrl, shift, alt, on: "code", value: `Numpad${numpad[1]}` };
  }
  // The function keys, whose `code` is the name they are drawn with (F5).
  const functionKey = FUNCTION_KEY.exec(token);
  if (functionKey !== null) {
    return { ctrl, shift, alt, on: "code", value: `F${functionKey[1]}` };
  }
  if (/^[a-z]$/i.test(token)) {
    return { ctrl, shift, alt, on: "key", value: token.toLowerCase() };
  }
  return null;
}

/**
 * The command a key press asks for, read off the registry rather than off a list of letters, so a
 * command that declares a shortcut has one and the label cannot name a key that does nothing.
 */
export function commandFor(commands: CommandRegistry, event: KeyboardEvent): CommandId | null {
  // The Windows and Command keys carry no accelerator here: a press holding one is asking the
  // desktop for something, not the shell. AltGr needs nothing here, because it arrives as ctrl and
  // alt together and `parseAccelerator` refuses to build a chord out of that pair.
  if (event.metaKey) {
    return null;
  }
  const pressed = event.key.toLowerCase();
  for (const command of Object.values(commands)) {
    const chord = parseAccelerator(command.accelerator);
    if (
      chord === null ||
      chord.ctrl !== event.ctrlKey ||
      chord.shift !== event.shiftKey ||
      chord.alt !== event.altKey
    ) {
      continue;
    }
    if (chord.on === "code" ? chord.value === event.code : chord.value === pressed) {
      return command.id;
    }
  }
  return null;
}
