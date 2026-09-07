import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useLayer } from "../hooks/useLayers";
import {
  commandToken,
  runCommand,
  type Command,
  type CommandId,
  type CommandRegistry,
  type Menu,
} from "../types/chrome";

type MenuBarProps = {
  menus: Menu[];
  commands: CommandRegistry;
};

/**
 * One row of an open dropdown: a command the registry holds, or a submenu that opens a list of its
 * own. A submenu is not a command and never runs; what it holds are commands like any other.
 */
type Row =
  | { kind: "command"; command: Command }
  | { kind: "submenu"; id: string; label: string; items: Command[] };

/** A menu's entries resolved from ids to the registry's records (T3 C1). */
function resolve(menu: Menu, commands: CommandRegistry): Row[] {
  return menu.items.map((entry) =>
    typeof entry === "string"
      ? { kind: "command", command: commands[entry] }
      : {
          kind: "submenu",
          id: entry.id,
          label: entry.label,
          items: entry.items.map((id) => commands[id]),
        },
  );
}

/** Whether the cursor may sit on a row. A submenu is usable while it has anything to open. */
function usable(row: Row): boolean {
  return row.kind === "command" ? row.command.enabled : row.items.length > 0;
}

/** The row's own id, which is a command's token or the submenu's own name. */
function rowToken(row: Row): string {
  return row.kind === "command" ? commandToken(row.command.id) : row.id;
}

/** What the open dropdown says the keyboard is on, which is inside the submenu whenever one is. */
function activeItem(
  rows: Row[],
  cursor: number,
  subOpen: boolean,
  subCursor: number,
): string | undefined {
  if (cursor < 0) {
    return undefined;
  }
  const row = rows[cursor];
  if (subOpen && row.kind === "submenu" && subCursor >= 0) {
    return `menuitem-${commandToken(row.items[subCursor].id)}`;
  }
  return `menuitem-${rowToken(row)}`;
}

/** The first row the cursor may sit on, or -1 when every row in the menu is disabled. */
function firstEnabled(rows: Row[]): number {
  return rows.findIndex(usable);
}

/** Whether a title has anything to open. A menu with no items is greyed rather than dropped (C2). */
function opens(menu: Menu): boolean {
  return menu.items.length > 0;
}

/**
 * The next title in `direction` that has something to open, or -1 past the end of the bar. The
 * walk stops at the ends rather than wrapping, which is what the bar has always done.
 */
function stepTitle(menus: Menu[], from: number, direction: number): number {
  for (let index = from + direction; index >= 0 && index < menus.length; index += direction) {
    if (opens(menus[index])) {
      return index;
    }
  }
  return -1;
}

/**
 * The next enabled item in `direction`, wrapping at the ends, or the one we are on when the menu
 * holds no other enabled item. From -1, where a mouse-opened menu starts, down lands on the first
 * enabled item and up on the last.
 */
function stepOver(rows: Row[], from: number, direction: number): number {
  const count = rows.length;
  for (let step = 1; step <= count; step += 1) {
    const index = (((from + direction * step) % count) + count) % count;
    if (usable(rows[index])) {
      return index;
    }
  }
  return from;
}

/** The same walk over a submenu's own items, which are commands and nothing else. */
function stepInside(items: Command[], from: number, direction: number): number {
  const count = items.length;
  for (let step = 1; step <= count; step += 1) {
    const index = (((from + direction * step) % count) + count) % count;
    if (items[index].enabled) {
      return index;
    }
  }
  return from;
}

/** One command, drawn the same in a dropdown and in a submenu of one. */
function Item({
  command,
  cursor,
  onEnter,
  onRun,
}: {
  command: Command;
  cursor: boolean;
  onEnter: () => void;
  onRun: () => void;
}) {
  return (
    <button
      className={
        `menubar__item menubar__item--${commandToken(command.id)}` +
        (cursor ? " menubar__item--cursor" : "")
      }
      id={`menuitem-${commandToken(command.id)}`}
      type="button"
      // checked+group is one option of a radio set; checked alone is a plain toggle.
      role={
        command.checked === undefined
          ? "menuitem"
          : command.group === undefined
            ? "menuitemcheckbox"
            : "menuitemradio"
      }
      aria-checked={command.checked}
      tabIndex={-1}
      disabled={!command.enabled}
      onMouseEnter={onEnter}
      onClick={onRun}
    >
      <span className="menubar__item-main">
        <span className="menubar__mark" aria-hidden="true">
          {command.checked === true ? (command.group === undefined ? "✓" : "●") : ""}
        </span>
        <span className="menubar__label">{command.label}</span>
      </span>
      {command.accelerator !== undefined && (
        <span className="menubar__accelerator">{command.accelerator}</span>
      )}
    </button>
  );
}

/**
 * The menu bar: CSS chrome and not a native menu, so Windows and Linux draw the same thing
 * (decision 1). Alt opens the first title, arrows walk it skipping disabled items, Enter activates
 * and Escape closes and hands the keyboard back — the table in shell-layout.md.
 */
export default function MenuBar({ menus, commands }: MenuBarProps) {
  const [open, setOpen] = useState<number | null>(null);
  const [cursor, setCursor] = useState(-1);
  /** Whether the row under the cursor has its own list open, and where the cursor is inside it. */
  const [subOpen, setSubOpen] = useState(false);
  const [subCursor, setSubCursor] = useState(-1);
  const barRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  /** Where the keyboard was before Alt, so Escape can hand it back. */
  const restoreTo = useRef<HTMLElement | null>(null);
  /** Read by the window listeners, which are registered once and outlive every render. */
  const latest = useRef({ menus, commands, open, cursor, subOpen, subCursor });

  // The open dropdown is a layer and the bar itself is not, so the picture gets out of the way only
  // while one is down. Walking from one title to the next never lets it back (decision 1, T8).
  useLayer(open !== null);

  function openMenu(index: number, item: number) {
    if (restoreTo.current === null && document.activeElement instanceof HTMLElement) {
      restoreTo.current = document.activeElement;
    }
    setOpen(index);
    setCursor(item);
    setSubOpen(false);
    setSubCursor(-1);
  }

  /** Move within one dropdown, which always closes whatever list the row before it had open. */
  function moveCursor(item: number) {
    setCursor(item);
    setSubOpen(false);
    setSubCursor(-1);
  }

  function openSub(items: Command[]) {
    setSubOpen(true);
    setSubCursor(items.findIndex((item) => item.enabled));
  }

  function closeMenu(giveFocusBack: boolean) {
    const previous = restoreTo.current;
    restoreTo.current = null;
    setOpen(null);
    setCursor(-1);
    setSubOpen(false);
    setSubCursor(-1);
    if (giveFocusBack) {
      previous?.focus();
    }
  }

  /** The menu closes, then the one gated path decides whether anything runs (C3). */
  function activate(registry: CommandRegistry, id: CommandId) {
    closeMenu(true);
    runCommand(registry, id);
  }

  /**
   * Whether Alt has been held with nothing else pressed since. The bar opens when it is let go,
   * not when it goes down: a chord that holds Alt, and the picture's own jump keys are two of
   * them, would otherwise open a menu before its second key arrived. See interface-spec 10.5.
   */
  const altAlone = useRef(false);

  function onKeyDown(event: KeyboardEvent) {
    const state = latest.current;
    if (state.open === null) {
      const alone = !event.ctrlKey && !event.shiftKey && !event.metaKey;
      altAlone.current = event.key === "Alt" && alone;
      return;
    }
    altAlone.current = false;
    const rows = resolve(state.menus[state.open], state.commands);
    const row = state.cursor >= 0 ? rows[state.cursor] : undefined;
    // What the arrows walk: the list that is open, which is the submenu whenever one is.
    const inside = state.subOpen && row?.kind === "submenu" ? row.items : null;
    switch (event.key) {
      case "ArrowDown":
        if (inside === null) {
          moveCursor(stepOver(rows, state.cursor, 1));
        } else {
          setSubCursor(stepInside(inside, state.subCursor, 1));
        }
        break;
      case "ArrowUp":
        if (inside === null) {
          moveCursor(stepOver(rows, state.cursor, -1));
        } else {
          setSubCursor(stepInside(inside, state.subCursor, -1));
        }
        break;
      case "ArrowRight": {
        // Into the list the row under the cursor opens, and only past it to the next title when
        // there is none: a submenu is what Right is for wherever the reference draws one.
        if (inside === null && row?.kind === "submenu" && usable(row)) {
          openSub(row.items);
          break;
        }
        const next = stepTitle(state.menus, state.open, 1);
        if (next >= 0) {
          openMenu(next, firstEnabled(resolve(state.menus[next], state.commands)));
        }
        break;
      }
      case "ArrowLeft": {
        // Out of the open list first, back onto the row that opened it.
        if (inside !== null) {
          setSubOpen(false);
          setSubCursor(-1);
          break;
        }
        const previous = stepTitle(state.menus, state.open, -1);
        if (previous >= 0) {
          openMenu(previous, firstEnabled(resolve(state.menus[previous], state.commands)));
        }
        break;
      }
      case "Enter":
        // The cursor never sits on a greyed item; if the state moved under it, the menu stays open.
        if (inside !== null) {
          if (state.subCursor >= 0 && inside[state.subCursor].enabled) {
            activate(state.commands, inside[state.subCursor].id);
          }
          break;
        }
        if (row === undefined) {
          break;
        }
        if (row.kind === "submenu") {
          if (usable(row)) {
            openSub(row.items);
          }
          break;
        }
        if (row.command.enabled) {
          activate(state.commands, row.command.id);
        }
        break;
      case "Escape":
        // The open list first, then the menu: Escape gives back one level at a time.
        if (inside !== null) {
          setSubOpen(false);
          setSubCursor(-1);
          break;
        }
        closeMenu(true);
        break;
      default:
        return;
    }
    // The grid moves its own cursor on the same keys, so an open menu keeps them to itself.
    event.preventDefault();
    event.stopPropagation();
  }

  useEffect(() => {
    latest.current = { menus, commands, open, cursor, subOpen, subCursor };
  });

  /** Alt let go with nothing pressed since opens the bar on its first title that has items. */
  function onKeyUp(event: KeyboardEvent) {
    if (event.key !== "Alt" || !altAlone.current) {
      return;
    }
    altAlone.current = false;
    const state = latest.current;
    if (state.open !== null) {
      return;
    }
    // With no title that opens, the key is left to the window.
    const first = stepTitle(state.menus, -1, 1);
    if (first < 0) {
      return;
    }
    event.preventDefault();
    openMenu(first, firstEnabled(resolve(state.menus[first], state.commands)));
  }

  // Registered once: both handlers read `latest`, so a re-render never drops an event.
  useEffect(() => {
    const key = (event: KeyboardEvent) => onKeyDown(event);
    const release = (event: KeyboardEvent) => onKeyUp(event);
    const pointer = (event: MouseEvent) => {
      const inside =
        event.target instanceof Node && barRef.current?.contains(event.target) === true;
      if (!inside && latest.current.open !== null) {
        closeMenu(false);
      }
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("keyup", release, true);
    window.addEventListener("mousedown", pointer, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("keyup", release, true);
      window.removeEventListener("mousedown", pointer, true);
    };
  }, []);

  // The keyboard follows the open dropdown, which is what Escape then hands back.
  useLayoutEffect(() => {
    if (open !== null) {
      dropdownRef.current?.focus();
    }
  }, [open]);

  return (
    <div className="menubar" role="menubar" ref={barRef}>
      {menus.map((menu, index) => {
        const rows = resolve(menu, commands);
        return (
          <div className="menubar__group" key={menu.id}>
            <button
              className={`menubar__title menubar__title--${menu.id}`}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={open === index}
              // Drawn with nothing behind it too, greyed: a title never comes and goes (C2).
              disabled={!opens(menu)}
              onClick={() => (open === index ? closeMenu(false) : openMenu(index, -1))}
            >
              {menu.title}
            </button>
            {open === index && (
              <div
                className="menubar__menu"
                role="menu"
                tabIndex={-1}
                ref={dropdownRef}
                aria-label={menu.title}
                aria-activedescendant={activeItem(rows, cursor, subOpen, subCursor)}
              >
                {rows.map((row, position) =>
                  row.kind === "command" ? (
                    <Item
                      key={row.command.id}
                      command={row.command}
                      cursor={position === cursor}
                      onEnter={() => moveCursor(position)}
                      onRun={() => activate(commands, row.command.id)}
                    />
                  ) : (
                    <div className="menubar__nest" key={row.id}>
                      <button
                        className={
                          `menubar__submenu menubar__submenu--${row.id}` +
                          (position === cursor ? " menubar__submenu--cursor" : "")
                        }
                        id={`menuitem-${row.id}`}
                        type="button"
                        role="menuitem"
                        aria-haspopup="menu"
                        aria-expanded={position === cursor && subOpen}
                        tabIndex={-1}
                        // Drawn whatever its items say, greyed only when it opens nothing at all,
                        // which is the rule a title on the bar follows (decision 24 A2, C2).
                        disabled={!usable(row)}
                        onMouseEnter={() => {
                          setCursor(position);
                          setSubCursor(row.items.findIndex((item) => item.enabled));
                          setSubOpen(true);
                        }}
                        // Always open, never toggle: the pointer has already passed over the row
                        // to reach it, and the hover above opened the list, so a toggle here would
                        // shut on the way in.
                        onClick={() => {
                          setCursor(position);
                          openSub(row.items);
                        }}
                      >
                        <span className="menubar__item-main">
                          <span className="menubar__mark" aria-hidden="true" />
                          <span className="menubar__label">{row.label}</span>
                        </span>
                        <span className="menubar__arrow" aria-hidden="true">
                          ▸
                        </span>
                      </button>
                      {position === cursor && subOpen && (
                        <div
                          className="menubar__menu menubar__menu--sub"
                          role="menu"
                          aria-label={row.label}
                        >
                          {row.items.map((command, inner) => (
                            <Item
                              key={command.id}
                              command={command}
                              cursor={inner === subCursor}
                              onEnter={() => setSubCursor(inner)}
                              onRun={() => activate(commands, command.id)}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  ),
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
