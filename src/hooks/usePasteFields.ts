import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

/** Kept in step with `src-tauri/src/paste_fields.rs`; the file it comes from carries these names. */
export type PasteFields = {
  comment: boolean;
  layer: boolean;
  start: boolean;
  end: boolean;
  style: boolean;
  actor: boolean;
  marginL: boolean;
  marginR: boolean;
  marginV: boolean;
  effect: boolean;
  text: boolean;
};

/**
 * The text alone, which is what Sublore did before the dialog existed and what the store answers
 * with until it has been written (paste-over-tasks.md P2).
 */
export const DEFAULT_PASTE_FIELDS: PasteFields = {
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
  text: true,
};

/**
 * Which fields the last paste over took, which is what the next one's dialog opens holding. Read
 * once when the shell mounts and written when the dialog is confirmed: losing the file costs the
 * last answer, so nothing here fails loudly.
 */
export function usePasteFields(): {
  pasteFields: PasteFields;
  store: (next: PasteFields) => Promise<void>;
} {
  const [pasteFields, setPasteFields] = useState<PasteFields>(DEFAULT_PASTE_FIELDS);

  useEffect(() => {
    void invoke<PasteFields>("paste_fields_read")
      .then(setPasteFields)
      .catch((failure: unknown) => {
        console.error("the stored paste fields could not be read", failure);
      });
  }, []);

  const store = useCallback(async (next: PasteFields) => {
    // Held from the moment they are confirmed, whatever the write does: the paste that follows must
    // take what the dialog was left holding, and a failed write costs the next launch, not this one.
    setPasteFields(next);
    try {
      await invoke("paste_fields_write", { fields: next });
    } catch (failure) {
      console.error("the paste fields could not be stored", failure);
    }
  }, []);

  return { pasteFields, store };
}
