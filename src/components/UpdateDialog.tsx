import { invoke } from "@tauri-apps/api/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useLayer } from "../hooks/useLayers";
import { en } from "../i18n/en";
import { fill } from "../i18n/format";

type UpdateDialogProps = {
  onClose: () => void;
};

/** What the backend answers. Kept in step with `Verdict` in `src-tauri/src/update.rs`. */
type Verdict =
  | { kind: "upToDate" }
  | { kind: "newer"; version: string; url: string }
  | { kind: "failed"; reason: string };

/**
 * What Help > Check for updates opens (interface-spec 3.8). The check runs because this panel is
 * open and for no other reason: nothing here is scheduled and nothing runs at startup.
 *
 * The address of the release is never handed back to the backend. The panel says "open what you
 * found", and the backend opens the page it found itself (update-check-tasks.md).
 */
export default function UpdateDialog({ onClose }: UpdateDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  // Mounted only while the panel is open, so the video surface hides for exactly that long (T8).
  useLayer(true);

  useEffect(() => {
    let showing = true;
    void invoke<Verdict>("update_check").then(
      (found) => {
        if (showing) {
          setVerdict(found);
        }
      },
      (failure: unknown) => {
        // The command itself failing is the same answer as the network failing: unknown.
        console.error("the update check could not be run", failure);
        if (showing) {
          setVerdict({ kind: "failed", reason: String(failure) });
        }
      },
    );
    return () => {
      showing = false;
    };
  }, []);

  useLayoutEffect(() => {
    panelRef.current?.focus();
  }, []);

  const words = en.update;

  return (
    <div
      className="update"
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
        className="update__panel"
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <h2 className="update__heading">{words.title}</h2>
        {verdict === null && <p className="update__asking">{words.asking}</p>}
        {verdict?.kind === "upToDate" && <p className="update__current">{words.upToDate}</p>}
        {verdict?.kind === "newer" && (
          <>
            <p className="update__newer">{fill(words.newer, { version: verdict.version })}</p>
            <button
              type="button"
              className="update__open"
              onClick={() => void invoke("update_open_release")}
            >
              {words.open}
            </button>
          </>
        )}
        {verdict?.kind === "failed" && (
          <p className="update__failed" role="alert">
            {words.failed}
          </p>
        )}
        <div className="update__buttons">
          <button type="button" className="update__close" onClick={onClose}>
            {words.close}
          </button>
        </div>
      </div>
    </div>
  );
}
