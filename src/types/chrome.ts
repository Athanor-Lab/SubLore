/**
 * The areas a command id may sit in. An id is `area.action`: lowercase, dot separated, hyphens
 * inside a segment, and a generated set adds a trailing segment of its own (`audio.track.3`).
 * See interface-spec 2.7 and 2.8.
 */
type CommandArea =
  | "app"
  | "asr"
  | "audio"
  | "edit"
  | "file"
  | "help"
  /**
   * A command a loaded module contributed. The core never writes one of these into its own source:
   * they are generated from what a module described, and the id after the dot is the module's index
   * and its own id. See docs/module-abi.md section 5.
   */
  | "module"
  | "project"
  | "subtitle"
  // Timing against the playhead and the waveform. Its own area rather than part of `subtitle`,
  // because interface-spec 3 gives it a menu title of its own and the two grow separately.
  | "time"
  | "video"
  | "view"
  // The waveform panel's own controls: what it plays, where its window is, and what it follows.
  // Its own area rather than part of `audio`, which is the open track and the tracks beside it.
  | "wave";

/** A command's registry key, and the only name any route ever holds it by. */
export type CommandId = `${CommandArea}.${string}`;

/**
 * The module's own handle for a panel row, carried back to it unread.
 *
 * A string, because the handle is a `u64` on the interface and one above 2^53 does not survive a
 * JSON number. Nothing on this side parses it (module-abi.md 5.3).
 */
export type RowRef = string;

/**
 * One command of the shell chrome. The menu bar and the toolbar draw the same records, so a command
 * that reaches one route reaches the other by construction. See docs T3.
 */
export type Command = {
  /** The registry key, turned into a class/id suffix by `commandToken` wherever one is drawn. */
  id: CommandId;
  label: string;
  /**
   * The keys that run this command. A list answers every one of them and draws the first, which is
   * how the reference gives commit both `Enter` and the numpad's own; the ones it leaves off a menu
   * it draws nowhere, so which to draw is Sublore's choice and the discoverable one wins (N109).
   */
  accelerator?: string | readonly string[];
  /** Set only on a command that turns something on and off, which is drawn with a mark. */
  checked?: boolean;
  /** With `checked`, names the radio set this is one option of (interface-spec 2.2). */
  group?: string;
  enabled: boolean;
  /**
   * What running it does, given the panel row it was run from.
   *
   * The argument is null everywhere but a panel: a menu item, a toolbar button and an accelerator
   * carry no row. It is a parameter rather than a second kind of command because a row's controls
   * have to reach the one gate below like everything else, and a gate that took no row would have
   * forced a second entry point for them (decision 4, H8).
   */
  run: (row: RowRef | null) => void;
};

/**
 * Every command the shell can run, filed under its own id. The draw routes take entries from here
 * and nothing else, so neither can grow an item the other has never heard of (interface-spec 2.1).
 */
export type CommandRegistry = Record<CommandId, Command>;

/**
 * A menu entry that opens a list of its own rather than running.
 *
 * Not a command and never in the registry: nothing runs it, it has no accelerator and no enabled
 * state of its own. The interface asks for eight of them, from the recent-file lists to the two
 * ways of making times continuous (interface-spec 3). Its `id` is drawn as a class suffix the way
 * a command's token is, and is spelled the same way to read beside them.
 */
export type Submenu = {
  id: string;
  label: string;
  items: CommandId[];
};

/**
 * A rule that groups the items around it. Not a command and not a submenu: nothing runs it, the
 * cursor steps over it the way it steps over a greyed item, and it holds no id the registry knows.
 * The reference groups every menu with these (interface-spec 3); Sublore draws the same rules.
 */
export type Separator = { readonly separator: true };

/** The one separator value, so a menu writes `SEPARATOR` rather than repeating the shape. */
export const SEPARATOR: Separator = { separator: true };

/** One entry of a menu: a command by id, a submenu holding more of them, or a grouping rule. */
export type MenuEntry = CommandId | Submenu | Separator;

/** Whether a menu entry is a grouping rule rather than something the cursor can land on. */
export function isSeparator(entry: MenuEntry): entry is Separator {
  return typeof entry === "object" && "separator" in entry;
}

/** A menu bar title and what it opens, as ids into a `CommandRegistry` (interface-spec 2.1, T3 C1). */
export type Menu = {
  id: string;
  title: string;
  items: MenuEntry[];
};

/** Every command a menu can reach, its submenus walked into, its separators skipped (T3 C1). */
export function commandsIn(menu: Menu): CommandId[] {
  return menu.items.flatMap((entry) =>
    typeof entry === "string" ? [entry] : isSeparator(entry) ? [] : entry.items,
  );
}

/**
 * A command id turned into a CSS-safe class/id suffix: dots become hyphens, so `file.save` draws
 * as `file-save`. The one conversion every draw route shares (interface-spec 2.8).
 */
export function commandToken(id: CommandId): string {
  return id.replace(/\./g, "-");
}

/**
 * The one way a command runs. Every route hands this an id and it re-reads `enabled` first, so a
 * greyed item is refused the same way from a click, a toolbar press and a shortcut. This is
 * `invoke(id)` of interface-spec 2.3, renamed because `invoke` is already Tauri's IPC call.
 */
export function runCommand(
  commands: CommandRegistry,
  id: CommandId,
  row: RowRef | null = null,
): void {
  const command: Command | undefined = commands[id];
  if (command === undefined || !command.enabled) {
    return;
  }
  command.run(row);
}
