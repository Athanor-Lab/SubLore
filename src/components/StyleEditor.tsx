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

/** One group of the dialog, in the order the reference's own dialog lays them out. */
type Group = { heading: string; fields: { field: AssStyleField; label: string }[] };

const GROUPS: Group[] = [
  {
    heading: en.subtitle.styleEditor.font,
    fields: [
      { field: "fontname", label: en.subtitle.styleEditor.fontname },
      { field: "fontsize", label: en.subtitle.styleEditor.fontsize },
    ],
  },
  {
    heading: en.subtitle.styleEditor.colours,
    fields: [
      { field: "primary", label: en.subtitle.styleEditor.primary },
      { field: "secondary", label: en.subtitle.styleEditor.secondary },
      { field: "outline", label: en.subtitle.styleEditor.outline },
      { field: "back", label: en.subtitle.styleEditor.back },
    ],
  },
  {
    heading: en.subtitle.styleEditor.margins,
    fields: [
      { field: "marginL", label: en.subtitle.styleEditor.marginL },
      { field: "marginR", label: en.subtitle.styleEditor.marginR },
      { field: "marginV", label: en.subtitle.styleEditor.marginV },
    ],
  },
  {
    heading: en.subtitle.styleEditor.border,
    fields: [
      { field: "outlineWidth", label: en.subtitle.styleEditor.outlineWidth },
      { field: "shadow", label: en.subtitle.styleEditor.shadow },
    ],
  },
  {
    heading: en.subtitle.styleEditor.miscellaneous,
    fields: [
      { field: "scaleX", label: en.subtitle.styleEditor.scaleX },
      { field: "scaleY", label: en.subtitle.styleEditor.scaleY },
      { field: "angle", label: en.subtitle.styleEditor.angle },
      { field: "spacing", label: en.subtitle.styleEditor.spacing },
      { field: "encoding", label: en.subtitle.styleEditor.encoding },
    ],
  },
];

/** The four flags, which ASS writes as -1 for on and 0 for off. */
const FLAG_FIELDS: { field: AssStyleField; label: string; of: (style: AssStyle) => boolean }[] = [
  { field: "bold", label: en.subtitle.styleEditor.bold, of: (style) => style.bold },
  { field: "italic", label: en.subtitle.styleEditor.italic, of: (style) => style.italic },
  { field: "underline", label: en.subtitle.styleEditor.underline, of: (style) => style.underline },
  { field: "strikeout", label: en.subtitle.styleEditor.strikeout, of: (style) => style.strikeout },
];

/**
 * The nine places a line can sit, drawn as the grid the reference draws. ASS numbers them from the
 * bottom left, so the top row of the grid is 7, 8, 9 and the bottom row is 1, 2, 3.
 */
const ALIGNMENTS = [7, 8, 9, 4, 5, 6, 1, 2, 3];

/** The border style ASS calls opaque box, against the outline and shadow it calls 1. */
const OPAQUE_BOX = "3";
const OUTLINE_AND_SHADOW = "1";

function held(style: AssStyle, field: AssStyleField): string {
  const values: Partial<Record<AssStyleField, string>> = {
    fontname: style.fontname,
    fontsize: style.fontsize,
    primary: style.primary,
    secondary: style.secondary,
    outline: style.outline,
    back: style.back,
    scaleX: style.scaleX,
    scaleY: style.scaleY,
    spacing: style.spacing,
    angle: style.angle,
    borderStyle: style.borderStyle,
    outlineWidth: style.outlineWidth,
    shadow: style.shadow,
    alignment: style.alignment,
    marginL: style.marginL,
    marginR: style.marginR,
    marginV: style.marginV,
    encoding: style.encoding,
  };
  return values[field] ?? "";
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

  function textField(field: AssStyleField, label: string) {
    return (
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
          onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.value }))}
          onBlur={() => void commit(field)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commit(field);
            }
          }}
        />
      </label>
    );
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
        {GROUPS.map((group) => (
          <section className="styleeditor__group" key={group.heading}>
            <h3 className="styleeditor__heading">{group.heading}</h3>
            {group.fields.map(({ field, label }) => textField(field, label))}
            {group.heading === en.subtitle.styleEditor.font && (
              <div className="styleeditor__flags">
                {FLAG_FIELDS.map(({ field, label, of }) => (
                  <label className="styleeditor__flag" key={field}>
                    <input
                      type="checkbox"
                      className={`styleeditor__${field}`}
                      checked={of(style)}
                      onChange={(event) =>
                        void onCommit(index, field, event.target.checked ? "-1" : "0")
                      }
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            )}
            {/* An opaque box is a border style and not a flag, so it writes 3 or 1 and not -1. */}
            {group.heading === en.subtitle.styleEditor.border && (
              <label className="styleeditor__flag">
                <input
                  type="checkbox"
                  className="styleeditor__opaque"
                  checked={style.borderStyle.trim() === OPAQUE_BOX}
                  disabled={style.borderStyle === ""}
                  onChange={(event) =>
                    void onCommit(
                      index,
                      "borderStyle",
                      event.target.checked ? OPAQUE_BOX : OUTLINE_AND_SHADOW,
                    )
                  }
                />
                <span>{en.subtitle.styleEditor.opaqueBox}</span>
              </label>
            )}
          </section>
        ))}
        {/* The families this machine has, offered to the font field and typed into anywhere else. */}
        <datalist id="styleeditor-fonts">
          {fonts.map((name) => (
            <option value={name} key={name} />
          ))}
        </datalist>
        <section className="styleeditor__group">
          <h3 className="styleeditor__heading">{en.subtitle.styleEditor.alignment}</h3>
          <div className="styleeditor__alignment" role="radiogroup">
            {ALIGNMENTS.map((place) => (
              <button
                key={place}
                type="button"
                role="radio"
                aria-checked={style.alignment.trim() === String(place)}
                aria-label={String(place)}
                className={`styleeditor__place styleeditor__place-${place}`}
                disabled={style.alignment === ""}
                onClick={() => void onCommit(index, "alignment", String(place))}
              >
                {style.alignment.trim() === String(place) ? "•" : ""}
              </button>
            ))}
          </div>
        </section>
        <button type="button" className="styleeditor__close" onClick={onClose}>
          {en.subtitle.styleEditor.close}
        </button>
      </div>
    </div>
  );
}
