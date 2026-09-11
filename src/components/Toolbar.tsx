import { Fragment } from "react";

import { commandToken, runCommand, type CommandId, type CommandRegistry } from "../types/chrome";

/** One button on the strip: a registry id, and the short word it is drawn with (N120). */
export type ToolbarButton = { id: CommandId; short: string };

type ToolbarProps = {
  /** Groups drawn in order with a divider between them, as ids into `commands` (T3 C1). */
  groups: ToolbarButton[][];
  commands: CommandRegistry;
};

/** The toolbar: ids into the same registry the menu bar draws from, so neither route can grow the other one. */
export default function Toolbar({ groups, commands }: ToolbarProps) {
  return (
    <div className="toolbar">
      {groups.map((group, index) => {
        return (
          <Fragment key={group.map((button) => button.id).join("-")}>
            {index > 0 && <span className="toolbar__divider" />}
            {group.map(({ id, short }) => {
              const command = commands[id];
              // An id with no record is a list naming a command that no longer exists; drawing
              // nothing is wrong either way, so it fails where it is written rather than here.
              if (command === undefined) {
                return null;
              }
              return (
                <button
                  className={`toolbar__button toolbar__${commandToken(command.id)}`}
                  key={command.id}
                  type="button"
                  // The word is short and the name is the command's own, so the record both routes
                  // read stays one record and only its drawing is shorter (N120).
                  title={command.label}
                  aria-label={command.label}
                  disabled={!command.enabled}
                  aria-pressed={command.checked}
                  onClick={() => runCommand(commands, command.id)}
                >
                  {short}
                </button>
              );
            })}
          </Fragment>
        );
      })}
    </div>
  );
}
