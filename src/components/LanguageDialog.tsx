import { useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { useLayer } from "../hooks/useLayers";
import { en } from "../i18n/en";

type LanguageDialogProps = {
  onClose: () => void;
};

/**
 * What View > Language opens: the interface languages Sublore ships, one chosen and remembered
 * (interface-spec 3.7 item 12). The list holds English alone today; the localized names and the
 * restart question arrive with the second language, because until then a choice can never differ
 * from the active one. A language name is shown in itself, so it is not translated.
 */
const LANGUAGES: readonly { code: string; name: string }[] = [{ code: "en", name: "English" }];

export default function LanguageDialog({ onClose }: LanguageDialogProps) {
  const selectRef = useRef<HTMLSelectElement>(null);
  const [code, setCode] = useState(LANGUAGES[0].code);
  // Mounted only while the panel is open, so the video surface hides for exactly that long (T8).
  useLayer(true);

  useLayoutEffect(() => {
    selectRef.current?.focus();
  }, []);

  const words = en.language;

  function choose() {
    // A refused store costs the remembered choice, never the dialog: the close is the user's.
    invoke("language_set", { language: code }).catch((failure: unknown) => {
      console.error("the language choice could not be stored", failure);
    });
    onClose();
  }

  return (
    <div
      className="languagedialog"
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
        className="languagedialog__panel"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <label className="languagedialog__field">
          <span className="languagedialog__label">{words.prompt}</span>
          <select
            className="languagedialog__select"
            ref={selectRef}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                choose();
              }
            }}
          >
            {LANGUAGES.map((language) => (
              <option key={language.code} value={language.code}>
                {language.name}
              </option>
            ))}
          </select>
        </label>
        <div className="languagedialog__buttons">
          <button type="button" className="languagedialog__ok" onClick={choose}>
            {words.ok}
          </button>
          <button type="button" className="languagedialog__cancel" onClick={onClose}>
            {words.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}
