import { useLayoutEffect, useRef, useState } from "react";

import { useLayer } from "../hooks/useLayers";
import { type Preferences } from "../hooks/usePreferences";
import { en } from "../i18n/en";

type PreferencesDialogProps = {
  preferences: Preferences;
  onConfirm: (next: Preferences) => void;
  onClose: () => void;
};

/** The three fields, in the order the words above read. Each is a whole number of milliseconds. */
const FIELDS: readonly { key: keyof Preferences; label: string }[] = [
  { key: "leadInMs", label: en.preferences.leadIn },
  { key: "leadOutMs", label: en.preferences.leadOut },
  { key: "newCueMs", label: en.preferences.newCue },
];

/**
 * What View > Preferences opens: the small set interface-spec 9.6 keeps for v1. The CPS limit is
 * fixed (decision 24 A8) and the interface language has its own dialog, so neither is here.
 *
 * A field is refused where it is typed rather than quietly turned into something else: a number the
 * app cannot use is a number the user should see refused, and the backend clamps besides.
 */
export default function PreferencesDialog({
  preferences,
  onConfirm,
  onClose,
}: PreferencesDialogProps) {
  const firstRef = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState<Record<keyof Preferences, string>>({
    leadInMs: String(preferences.leadInMs),
    leadOutMs: String(preferences.leadOutMs),
    newCueMs: String(preferences.newCueMs),
  });
  const [refused, setRefused] = useState(false);
  // Mounted only while the panel is open, so the video surface hides for exactly that long (T8).
  useLayer(true);

  useLayoutEffect(() => {
    firstRef.current?.focus();
    firstRef.current?.select();
  }, []);

  const words = en.preferences;

  function confirm() {
    const next: Partial<Preferences> = {};
    for (const { key } of FIELDS) {
      const value = Number(typed[key]);
      // A whole number of milliseconds and nothing else: a fraction of a millisecond is not a time
      // the document can hold, and a word is not a number at all.
      if (!Number.isInteger(value) || value < 0) {
        setRefused(true);
        return;
      }
      next[key] = value;
    }
    onConfirm(next as Preferences);
  }

  return (
    <div
      className="preferences"
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
        className="preferences__panel"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <h2 className="preferences__heading">{words.title}</h2>
        {FIELDS.map((field, index) => (
          <label className="preferences__field" key={field.key}>
            <span className="preferences__label">{field.label}</span>
            <input
              className={`preferences__value preferences__${field.key}`}
              ref={index === 0 ? firstRef : undefined}
              value={typed[field.key]}
              inputMode="numeric"
              spellCheck={false}
              aria-invalid={refused}
              onChange={(event) => {
                setTyped((current) => ({ ...current, [field.key]: event.target.value }));
                setRefused(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  confirm();
                }
              }}
            />
          </label>
        ))}
        {refused && (
          <p className="preferences__refusal" role="alert">
            {words.refused}
          </p>
        )}
        <div className="preferences__buttons">
          <button type="button" className="preferences__confirm" onClick={confirm}>
            {words.confirm}
          </button>
          <button type="button" className="preferences__cancel" onClick={onClose}>
            {words.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}
