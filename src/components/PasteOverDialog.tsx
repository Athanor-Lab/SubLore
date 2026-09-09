import { useLayoutEffect, useRef, useState } from "react";

import { useLayer } from "../hooks/useLayers";
import { type PasteFields } from "../hooks/usePasteFields";
import { en } from "../i18n/en";

type PasteOverDialogProps = {
  fields: PasteFields;
  /** Which of the eleven this document and this selection can actually take. */
  available: ReadonlySet<keyof PasteFields>;
  onConfirm: (next: PasteFields) => void;
  onClose: () => void;
};

/** The eleven, in the order the reference's own dialog lists them. */
const FIELDS: readonly { key: keyof PasteFields; label: string }[] = [
  { key: "comment", label: en.pasteOver.comment },
  { key: "layer", label: en.pasteOver.layer },
  { key: "start", label: en.pasteOver.start },
  { key: "end", label: en.pasteOver.end },
  { key: "style", label: en.pasteOver.style },
  { key: "actor", label: en.pasteOver.actor },
  { key: "marginL", label: en.pasteOver.marginL },
  { key: "marginR", label: en.pasteOver.marginR },
  { key: "marginV", label: en.pasteOver.marginV },
  { key: "effect", label: en.pasteOver.effect },
  { key: "text", label: en.pasteOver.text },
];

const NONE: PasteFields = {
  comment: false,
  layer: false,
  start: false,
  end: false,
  style: false,
  actor: false,
  marginL: false,
  marginR: false,
  marginV: false,
  effect: false,
  text: false,
};

/**
 * What a paste over opens: which fields to take from the clipboard's line (N45).
 *
 * It opens on every paste over rather than once, which is the reference's own behaviour: the vector
 * of answers there is local to the command, so the dialog is asked again each time and only the
 * boxes it opens with are remembered. See docs/paste-over-tasks.md.
 *
 * A field this document does not declare is drawn greyed and cannot be ticked, under the rule the
 * cue view already follows: a control for a field the write would refuse does not ask.
 */
export default function PasteOverDialog({
  fields,
  available,
  onConfirm,
  onClose,
}: PasteOverDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Only what can be taken: a stored answer naming a field this document has not got must not
  // arrive pre-ticked and then be refused by the backend.
  const [ticked, setTicked] = useState<PasteFields>(() => {
    const start = { ...NONE };
    for (const { key } of FIELDS) {
      start[key] = fields[key] && available.has(key);
    }
    return start;
  });
  useLayer(true);

  useLayoutEffect(() => {
    panelRef.current?.focus();
  }, []);

  function only(...keys: (keyof PasteFields)[]) {
    const next = { ...NONE };
    for (const key of keys) {
      next[key] = available.has(key);
    }
    setTicked(next);
  }

  function all(on: boolean) {
    const next = { ...NONE };
    for (const { key } of FIELDS) {
      next[key] = on && available.has(key);
    }
    setTicked(next);
  }

  const words = en.pasteOver;
  const takesSomething = FIELDS.some(({ key }) => ticked[key]);

  return (
    <div
      className="pasteover"
      role="dialog"
      aria-modal="true"
      aria-label={words.title}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="pasteover__panel"
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <h2 className="pasteover__heading">{words.title}</h2>
        <p className="pasteover__lead">{words.lead}</p>
        <div className="pasteover__fields">
          {FIELDS.map((field) => (
            <label
              className={`pasteover__field pasteover__${field.key}`}
              key={field.key}
              aria-disabled={!available.has(field.key)}
            >
              <input
                type="checkbox"
                checked={ticked[field.key]}
                disabled={!available.has(field.key)}
                onChange={(event) =>
                  setTicked((current) => ({ ...current, [field.key]: event.target.checked }))
                }
              />
              <span>{field.label}</span>
            </label>
          ))}
        </div>
        <div className="pasteover__quick">
          <button type="button" className="pasteover__all" onClick={() => all(true)}>
            {words.all}
          </button>
          <button type="button" className="pasteover__none" onClick={() => all(false)}>
            {words.none}
          </button>
          <button type="button" className="pasteover__times" onClick={() => only("start", "end")}>
            {words.times}
          </button>
          <button type="button" className="pasteover__onlytext" onClick={() => only("text")}>
            {words.onlyText}
          </button>
        </div>
        <div className="pasteover__buttons">
          <button
            type="button"
            className="pasteover__confirm"
            // Nothing ticked is nothing to paste, and the backend refuses it anyway. Greyed rather
            // than refused after the press, so the dialog says so before it is asked.
            disabled={!takesSomething}
            onClick={() => onConfirm(ticked)}
          >
            {words.confirm}
          </button>
          <button type="button" className="pasteover__cancel" onClick={onClose}>
            {words.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}
