import { useLayoutEffect, useRef, useState } from "react";

import { useLayer } from "../hooks/useLayers";
import { en } from "../i18n/en";
import { type AssStyle, type AssStyleField } from "../types/subtitle";

type StyleEditorProps = {
  /** Which declared style is being edited, by its place in the document's own order. */
  index: number;
  style: AssStyle;
  /** The families installed on this machine, empty until the editor asks for them. */
  fonts: string[];
  onLoadFonts: () => void;
  /** Write one field. Each is its own undo step, which is what the reference's own dialog does. */
  onCommit: (index: number, field: AssStyleField, value: string) => Promise<void>;
  onClose: () => void;
};

/** The fields this editor writes, in the order the reference's own dialog puts them. */
const TEXT_FIELDS: { field: AssStyleField; label: string }[] = [
  { field: "fontname", label: en.subtitle.styleEditor.fontname },
  { field: "fontsize", label: en.subtitle.styleEditor.fontsize },
  { field: "primary", label: en.subtitle.styleEditor.primary },
  { field: "secondary", label: en.subtitle.styleEditor.secondary },
  { field: "outline", label: en.subtitle.styleEditor.outline },
  { field: "back", label: en.subtitle.styleEditor.back },
];

/** The four flags, which ASS writes as -1 for on and 0 for off. */
const FLAG_FIELDS: { field: AssStyleField; label: string; of: (style: AssStyle) => boolean }[] = [
  { field: "bold", label: en.subtitle.styleEditor.bold, of: (style) => style.bold },
  { field: "italic", label: en.subtitle.styleEditor.italic, of: (style) => style.italic },
  { field: "underline", label: en.subtitle.styleEditor.underline, of: (style) => style.underline },
  { field: "strikeout", label: en.subtitle.styleEditor.strikeout, of: (style) => style.strikeout },
];

function held(style: AssStyle, field: AssStyleField): string {
  switch (field) {
    case "fontname":
      return style.fontname;
    case "fontsize":
      return style.fontsize;
    case "primary":
      return style.primary;
    case "secondary":
      return style.secondary;
    case "outline":
      return style.outline;
    case "back":
      return style.back;
    default:
      return "";
  }
}

/**
 * What Edit beside the Style dropdown opens: one declared style, field by field.
 *
 * Each field is committed on its own, when it is left, and each is its own undo step. The name is
 * not among them: renaming a style means rewriting every event that names it, which is a different
 * operation. See edit-bar-tasks.md B10.
 */
export default function StyleEditor({
  index,
  style,
  fonts,
  onLoadFonts,
  onCommit,
  onClose,
}: StyleEditorProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  /** What each field holds while it is being typed into, before it is sent. */
  const [draft, setDraft] = useState<Partial<Record<AssStyleField, string>>>({});
  // Mounted only while the panel is open (decision 1, T8).
  useLayer(true);

  useLayoutEffect(() => {
    panelRef.current?.focus();
    onLoadFonts();
  }, [onLoadFonts]);

  const value = (field: AssStyleField) => draft[field] ?? held(style, field);

  async function commit(field: AssStyleField) {
    const typed = draft[field];
    setDraft((current) => ({ ...current, [field]: undefined }));
    if (typed === undefined || typed === held(style, field)) {
      return;
    }
    await onCommit(index, field, typed);
  }

  return (
    <div
      className="styleeditor"
      role="dialog"
      aria-modal="true"
      aria-label={en.subtitle.styleEditor.title}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="styleeditor__panel"
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <h2 className="styleeditor__title">{style.name}</h2>
        {TEXT_FIELDS.map(({ field, label }) => (
          <label className="styleeditor__field" key={field}>
            <span className="styleeditor__label">{label}</span>
            <input
              className={`styleeditor__value styleeditor__${field}`}
              data-document-editor=""
              value={value(field)}
              spellCheck={false}
              // Every field is drawn, and one the section's Format line does not declare is greyed
              // rather than absent: what a document cannot hold is said, not hidden (24 A2).
              disabled={held(style, field) === "" && field !== "fontname"}
              list={field === "fontname" ? "styleeditor-fonts" : undefined}
              onChange={(event) =>
                setDraft((current) => ({ ...current, [field]: event.target.value }))
              }
              onBlur={() => void commit(field)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void commit(field);
                }
              }}
            />
          </label>
        ))}
        {/* The families this machine has, offered to the font field and typed into anywhere else. */}
        <datalist id="styleeditor-fonts">
          {fonts.map((name) => (
            <option value={name} key={name} />
          ))}
        </datalist>
        <div className="styleeditor__flags">
          {FLAG_FIELDS.map(({ field, label, of }) => (
            <label className="styleeditor__flag" key={field}>
              <input
                type="checkbox"
                className={`styleeditor__${field}`}
                checked={of(style)}
                onChange={(event) => void onCommit(index, field, event.target.checked ? "-1" : "0")}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <button type="button" className="styleeditor__close" onClick={onClose}>
          {en.subtitle.styleEditor.close}
        </button>
      </div>
    </div>
  );
}
