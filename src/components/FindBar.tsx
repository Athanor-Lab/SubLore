import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { en } from "../i18n/en";
import { fill } from "../i18n/format";
import { type Query } from "../search";

/** Find hides the replacement field and its two buttons; the two modes are one band (spec 9.2). */
export type FindMode = "find" | "replace";

/** The two fields that remember what has been searched with them (spec 9.2). */
type Remembering = "needle" | "replacement";

const LIST_ID = "findbar-recent-list";
const OPTION_ID = "findbar-recent-value-";

type FindBarProps = {
  mode: FindMode;
  query: Query;
  replacement: string;
  /** What the last search said: it found something, it found nothing, or nothing has run yet. */
  outcome: "idle" | "found" | "missing";
  /** Why the last search refused: a pattern that will not compile, or one that never finished. */
  refusal: "bad-pattern" | "slow" | null;
  /** How many a replace all rewrote, drawn until the next search. Null before any has run. */
  replaced: number | null;
  /** Whether the band stays inside the grid's selection rather than searching the whole file. */
  inSelection: boolean;
  /** What has been searched for and written with, most recent first (spec 9.2). */
  recent: Readonly<Record<Remembering, readonly string[]>>;
  onQueryChange: (query: Query) => void;
  onInSelectionChange: (inSelection: boolean) => void;
  onReplacementChange: (replacement: string) => void;
  onFindNext: () => void;
  onReplace: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
};

/**
 * The find band, under the grid and inside the panel flow rather than over it.
 *
 * Deliberately not a layer: a layer hides the native video surface (decision 1, T8) and searching
 * while the video plays is the point of having it here. Non-modal for the same reason, so the grid
 * stays usable behind it. See docs/find-replace-tasks.md F2 and F3.
 */
export default function FindBar({
  mode,
  query,
  replacement,
  outcome,
  refusal,
  replaced,
  inSelection,
  recent,
  onQueryChange,
  onInSelectionChange,
  onReplacementChange,
  onFindNext,
  onReplace,
  onReplaceAll,
  onClose,
}: FindBarProps) {
  const titleId = useId();
  const fieldId = useId();
  const replacementId = useId();
  const fieldRef = useRef<HTMLInputElement>(null);
  /** The boxes the two lists hang under, read when one opens rather than held as state. */
  const boxes = useRef<Record<Remembering, HTMLElement | null>>({
    needle: null,
    replacement: null,
  });
  const [listAt, setListAt] = useState<{
    field: Remembering;
    left: number;
    top: number;
    width: number;
  } | null>(null);
  const [highlight, setHighlight] = useState(0);

  const held = (field: Remembering) => (field === "needle" ? query.needle : replacement);
  const put = (field: Remembering, value: string) => {
    if (field === "needle") {
      onQueryChange({ ...query, needle: value });
      return;
    }
    onReplacementChange(value);
  };

  /** Under the field, in the viewport's own coordinates, the way the line's own combos open. */
  function openList(field: Remembering) {
    const box = boxes.current[field]?.getBoundingClientRect();
    if (box === undefined || recent[field].length === 0) {
      return;
    }
    setListAt({ field, left: box.left, top: box.bottom, width: box.width });
    setHighlight(Math.max(0, recent[field].indexOf(held(field))));
  }

  function pick(field: Remembering, value: string) {
    setListAt(null);
    put(field, value);
    fieldRef.current?.focus();
  }

  /**
   * The keys a remembering field answers, in the order the line's combos answer them: Escape closes
   * an open list before it closes anything else, the arrows open and walk it, and Enter picks from
   * it or does what the field's own Enter does.
   */
  function onFieldKeyDown(field: Remembering, event: KeyboardEvent<HTMLInputElement>) {
    const list = recent[field];
    const open = listAt !== null && listAt.field === field;
    if (event.key === "Escape" && open) {
      event.preventDefault();
      // Stopped here, or the band's own Escape would close the band behind the list.
      event.stopPropagation();
      setListAt(null);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openList(field);
        return;
      }
      if (list.length === 0) {
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : list.length - 1;
      setHighlight((at) => (at + step) % list.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const picked = open ? list[highlight] : undefined;
      if (picked !== undefined) {
        pick(field, picked);
        return;
      }
      // Enter in the field is find next, and in the replacement it is replace next, per 9.2.
      if (field === "needle") {
        onFindNext();
        return;
      }
      onReplace();
    }
  }

  // Opened on purpose, so it takes the keyboard: a band the user has to click into first would be
  // slower than the menu it replaces. Refocused on a mode change, which is the same intent again.
  useLayoutEffect(() => {
    fieldRef.current?.focus();
  }, [mode]);

  const empty = query.needle === "";

  return (
    <section
      className="findbar"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key !== "Escape") {
          return;
        }
        event.preventDefault();
        // An open list is what Escape closes first, wherever the keyboard is inside the band: it
        // is opened by its own button too, and a gesture that shut the whole band instead would
        // cost the search. The line's own combos answer Escape the same way.
        if (listAt !== null) {
          setListAt(null);
          return;
        }
        onClose();
      }}
    >
      <h2 className="findbar__title" id={titleId}>
        {mode === "replace" ? en.find.replaceTitle : en.find.title}
      </h2>
      <label className="bar__label" htmlFor={fieldId}>
        {en.find.needleLabel}
      </label>
      <span
        className="findbar__combo"
        ref={(node) => {
          boxes.current.needle = node;
        }}
      >
        <input
          id={fieldId}
          ref={fieldRef}
          className="findbar__needle"
          type="text"
          role="combobox"
          aria-expanded={listAt !== null && listAt.field === "needle"}
          aria-controls={LIST_ID}
          aria-activedescendant={
            listAt !== null && listAt.field === "needle" ? `${OPTION_ID}${highlight}` : undefined
          }
          value={query.needle}
          onChange={(event) => onQueryChange({ ...query, needle: event.target.value })}
          onKeyDown={(event) => onFieldKeyDown("needle", event)}
        />
        <button
          className="findbar__needle-open"
          type="button"
          aria-label={en.find.recentNeedles}
          aria-expanded={listAt !== null && listAt.field === "needle"}
          // Nothing remembered is nothing to open, so the opener greys while the field stays usable.
          disabled={recent.needle.length === 0}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() =>
            listAt !== null && listAt.field === "needle" ? setListAt(null) : openList("needle")
          }
        />
      </span>
      {mode === "replace" && (
        <>
          <label className="bar__label" htmlFor={replacementId}>
            {en.find.replaceLabel}
          </label>
          <span
            className="findbar__combo"
            ref={(node) => {
              boxes.current.replacement = node;
            }}
          >
            <input
              id={replacementId}
              className="findbar__replacement"
              type="text"
              role="combobox"
              aria-expanded={listAt !== null && listAt.field === "replacement"}
              aria-controls={LIST_ID}
              aria-activedescendant={
                listAt !== null && listAt.field === "replacement"
                  ? `${OPTION_ID}${highlight}`
                  : undefined
              }
              value={replacement}
              onChange={(event) => onReplacementChange(event.target.value)}
              onKeyDown={(event) => onFieldKeyDown("replacement", event)}
            />
            <button
              className="findbar__replacement-open"
              type="button"
              aria-label={en.find.recentReplacements}
              aria-expanded={listAt !== null && listAt.field === "replacement"}
              disabled={recent.replacement.length === 0}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() =>
                listAt !== null && listAt.field === "replacement"
                  ? setListAt(null)
                  : openList("replacement")
              }
            />
          </span>
        </>
      )}
      {/* The order is the reference's own, down its §9.2 table: case, expression, the two skips,
        then the scope. */}
      <label className="findbar__case-label">
        <input
          className="findbar__case"
          type="checkbox"
          checked={query.matchCase}
          onChange={(event) => onQueryChange({ ...query, matchCase: event.target.checked })}
        />
        {en.find.matchCase}
      </label>
      <label className="findbar__regex-label">
        <input
          className="findbar__regex"
          type="checkbox"
          checked={query.regex}
          onChange={(event) => onQueryChange({ ...query, regex: event.target.checked })}
        />
        {en.find.regex}
      </label>
      <label className="findbar__skip-comments-label">
        <input
          className="findbar__skip-comments"
          type="checkbox"
          checked={query.skipComments}
          onChange={(event) => onQueryChange({ ...query, skipComments: event.target.checked })}
        />
        {en.find.skipComments}
      </label>
      <label className="findbar__skip-tags-label">
        <input
          className="findbar__skip-tags"
          type="checkbox"
          checked={query.skipTags}
          onChange={(event) => onQueryChange({ ...query, skipTags: event.target.checked })}
        />
        {en.find.skipTags}
      </label>
      <label className="findbar__scope-label">
        <input
          className="findbar__scope"
          type="checkbox"
          checked={inSelection}
          onChange={(event) => onInSelectionChange(event.target.checked)}
        />
        {en.find.inSelection}
      </label>
      <button className="findbar__next" type="button" disabled={empty} onClick={onFindNext}>
        {en.find.findNext}
      </button>
      {mode === "replace" && (
        <>
          <button className="findbar__replace" type="button" disabled={empty} onClick={onReplace}>
            {en.find.replace}
          </button>
          <button
            className="findbar__replace-all"
            type="button"
            disabled={empty}
            onClick={onReplaceAll}
          >
            {en.find.replaceAll}
          </button>
        </>
      )}
      {/* Drawn only once a search has actually run: an empty band must not accuse the user of a
        pattern they have not searched for yet. */}
      {outcome === "missing" && <span className="findbar__missing">{en.find.noMatch}</span>}
      {/* A refused pattern moved nothing and wrote nothing, which is what these two say. */}
      {refusal !== null && (
        <span className="findbar__refused">
          {refusal === "slow" ? en.find.tooSlow : en.find.badPattern}
        </span>
      )}
      {replaced !== null && (
        <span className="findbar__replaced">
          {fill(replaced === 1 ? en.find.replaced.one : en.find.replaced.other, {
            count: replaced,
          })}
        </span>
      )}
      {listAt !== null && (
        <div
          className="findbar__recent"
          id={LIST_ID}
          role="listbox"
          aria-label={
            listAt.field === "needle" ? en.find.recentNeedles : en.find.recentReplacements
          }
          style={{ left: listAt.left, top: listAt.top, minWidth: listAt.width }}
        >
          {recent[listAt.field].map((value, at) => (
            <button
              key={value}
              id={`${OPTION_ID}${at}`}
              type="button"
              role="option"
              aria-selected={at === highlight}
              className={at === highlight ? "findbar__term findbar__term--on" : "findbar__term"}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(listAt.field, value)}
            >
              {value}
            </button>
          ))}
        </div>
      )}
      <button className="findbar__close" type="button" onClick={onClose}>
        {en.find.close}
      </button>
    </section>
  );
}
