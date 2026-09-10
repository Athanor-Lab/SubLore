import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { en } from "../i18n/en";
import { fill } from "../i18n/format";
import {
  isProjectError,
  type EpisodeFileView,
  type EpisodeView,
  type FileRole,
  type ProjectDeletedView,
  type ProjectError,
  type ProjectErrorCode,
  type ProjectSession,
  type ProjectView,
} from "../types/project";

/** Typed so that adding a code or a role without a string is a compile error. */
const errorMessages: Record<ProjectErrorCode, string> = en.project.errors;
const roleNames: Record<FileRole, string> = en.project.roles;

export function projectErrorMessage(error: ProjectError): string {
  const message = errorMessages[error.code];
  // Only the version failure carries numbers, and its sentence is the only one that asks for them.
  if (error.found === null || error.supported === null) {
    return message;
  }
  return fill(message, { found: error.found, supported: error.supported });
}

export function projectDeletedLine(deleted: ProjectDeletedView): string {
  return fill(en.project.deleted, { folder: deleted.folder });
}

export function episodeLine(ordinal: number, title: string): string {
  return fill(en.project.episode, { ordinal, title });
}

/** The row shows the file's own name; its role and its whole path are the row's tooltip. */
export function fileLine(file: EpisodeFileView): string {
  return fill(en.project.file, { role: roleNames[file.role], path: file.path });
}

/** Both separators, because a project database written on Windows is opened on Linux and back. */
export function fileName(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut === -1 ? path : path.slice(cut + 1);
}

/** A rejection from the backend carries a ProjectError; anything else is a broken command. */
function toProjectError(failure: unknown): ProjectError {
  return isProjectError(failure)
    ? failure
    : { code: "commandFailed", found: null, supported: null, detail: String(failure) };
}

export type Project = {
  project: ProjectView | null;
  /** Newest first, what File > Recent projects draws (interface-spec 3.1 item 5). */
  recent: string[];
  deleted: ProjectDeletedView | null;
  error: ProjectError | null;
  /** The episode the rail is on, and what an episode command acts on. */
  selected: EpisodeView | null;
  select: (episodeId: number) => void;
  create: (folder: string) => Promise<void>;
  open: (folder: string) => Promise<void>;
  close: () => Promise<void>;
  addEpisode: (title: string) => Promise<void>;
  renameEpisode: (episodeId: number, title: string) => Promise<void>;
  deleteEpisode: (episodeId: number) => Promise<void>;
  attachFile: (episodeId: number, role: FileRole, path: string) => Promise<void>;
  detachFile: (fileId: number) => Promise<void>;
  locateFile: (fileId: number, path: string) => Promise<void>;
  remove: () => Promise<void>;
  choosePath: (kind: "project-folder" | "project-file") => Promise<string | null>;
};

export function useProject(): Project {
  const [project, setProject] = useState<ProjectView | null>(null);
  const [deleted, setDeleted] = useState<ProjectDeletedView | null>(null);
  const [error, setError] = useState<ProjectError | null>(null);
  const [chosenId, setChosenId] = useState<number | null>(null);
  // What File > Recent projects draws, newest first. The backend list moves on every open, create
  // and delete, so it is re-read after each of those (interface-spec 3.1 item 5).
  const [recent, setRecent] = useState<string[]>([]);
  // Nothing is remembered until the last session has been read back, so the first render does not
  // overwrite the episode it is about to restore (decision 24, D5).
  const [restored, setRestored] = useState(false);

  const episodes = project?.episodes ?? [];
  // The last episode is the one just added, and it is also the sane target after a project change,
  // which is why a selection that no longer exists falls back to it rather than to nothing.
  const selected: EpisodeView | null =
    episodes.find((episode) => episode.id === chosenId) ?? episodes.at(-1) ?? null;
  const selectedId = selected?.id ?? null;

  /** Re-read the remembered list. Failing costs a stale menu, so it is logged and never surfaced. */
  const refreshRecent = useCallback(async () => {
    try {
      setRecent((await invoke<ProjectSession>("project_session")).recent);
    } catch (failure) {
      console.error("the recent-projects list could not be read", failure);
    }
  }, []);

  /**
   * Every command that returns a project ends the same way, so the handling lives in one place.
   * `replacesProject` says what the backend does on failure: an open that fails leaves nothing
   * open, while an edit that fails changed nothing, so the view on screen is still the truth.
   */
  /**
   * Which request the rail is showing. Nothing greys while a project command runs, so a second one
   * can be asked for before the first answers, and without this they would apply in whichever order
   * the backend replied: an open answering after a close puts back a project the user closed. The
   * video player has had the same counter since its own opens could overlap (N62).
   */
  const asking = useRef(0);

  const run = useCallback(
    async (command: string, args: Record<string, unknown>, replacesProject: boolean) => {
      asking.current += 1;
      const mine = asking.current;
      setError(null);
      setDeleted(null);
      try {
        const view = await invoke<ProjectView>(command, args);
        if (mine === asking.current) {
          setProject(view);
        }
      } catch (failure) {
        if (mine !== asking.current) {
          return;
        }
        if (replacesProject) {
          setProject(null);
        }
        setError(toProjectError(failure));
      } finally {
        if (mine === asking.current) {
          // Opening and creating move the remembered list; an edit inside the project does not.
          if (replacesProject) {
            void refreshRecent();
          }
        }
      }
    },
    [refreshRecent],
  );

  const create = useCallback(
    async (folder: string) => run("project_create", { folder }, true),
    [run],
  );

  const open = useCallback(async (folder: string) => run("project_open", { folder }, true), [run]);

  const addEpisode = useCallback(
    async (title: string) => {
      // Clearing the selection makes the episode that is about to arrive the selected one.
      setChosenId(null);
      await run("project_add_episode", { title }, false);
    },
    [run],
  );

  const renameEpisode = useCallback(
    async (episodeId: number, title: string) =>
      run("project_rename_episode", { episodeId, title }, false),
    [run],
  );

  const deleteEpisode = useCallback(
    async (episodeId: number) => run("project_delete_episode", { episodeId }, false),
    [run],
  );

  const attachFile = useCallback(
    async (episodeId: number, role: FileRole, path: string) =>
      run("project_attach_file", { episodeId, role, path }, false),
    [run],
  );

  const detachFile = useCallback(
    async (fileId: number) => run("project_detach_file", { fileId }, false),
    [run],
  );

  const locateFile = useCallback(
    async (fileId: number, path: string) => run("project_locate_file", { fileId, path }, false),
    [run],
  );

  const close = useCallback(async () => {
    asking.current += 1;
    const mine = asking.current;
    setError(null);
    setDeleted(null);
    try {
      await invoke("project_close");
      if (mine === asking.current) {
        setProject(null);
        setChosenId(null);
      }
    } catch (failure) {
      if (mine === asking.current) {
        setError(toProjectError(failure));
      }
    }
  }, []);

  const remove = useCallback(async () => {
    asking.current += 1;
    const mine = asking.current;
    setError(null);
    // The backend closes and clears the project before it removes a single file, so nothing is
    // open afterwards whether the removal worked or not.
    setProject(null);
    setChosenId(null);
    try {
      const gone = await invoke<ProjectDeletedView>("project_delete");
      if (mine === asking.current) {
        setDeleted(gone);
      }
    } catch (failure) {
      if (mine === asking.current) {
        setError(toProjectError(failure));
      }
    } finally {
      if (mine === asking.current) {
        // A deleted project leaves the remembered list too (session.rs forgotten()).
        void refreshRecent();
      }
    }
  }, [refreshRecent]);

  const choosePath = useCallback(async (kind: "project-folder" | "project-file") => {
    setError(null);
    try {
      // Null means the user cancelled the dialog, which is not a failure.
      return await invoke<string | null>("choose_path", { kind });
    } catch (failure) {
      setError(toProjectError(failure));
      return null;
    }
  }, []);

  // Reopen what was open, and come back to the episode it was on. No document and no video: a
  // launch opens the project and nothing else (decision 24, D5).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    void (async () => {
      try {
        const session = await invoke<ProjectSession>("project_session");
        setRecent(session.recent);
        if (session.folder !== null) {
          // The oldest request there is, so it yields to anything the user has asked for since:
          // reopening what was left behind must never take the rail off a project they chose.
          const restoring = asking.current;
          const view = await invoke<ProjectView>("project_open", { folder: session.folder });
          if (restoring === asking.current) {
            setProject(view);
            setChosenId(session.episodeId);
          }
        }
      } catch (failure) {
        // The user did not ask for this open on this launch, so a project that has moved or gone
        // is a line in the log and an empty rail, not a message over an app they have not used yet.
        console.error("the project that was open could not be reopened", failure);
      } finally {
        setRestored(true);
      }
    })();
  }, []);

  // Remembered for the next launch. Failing to store it costs one selection, so it is logged and
  // never surfaced.
  useEffect(() => {
    if (!restored) {
      return;
    }
    void invoke("project_select_episode", { episodeId: selectedId }).catch((failure: unknown) => {
      console.error("the selected episode could not be remembered", failure);
    });
  }, [restored, selectedId]);

  return {
    project,
    recent,
    deleted,
    error,
    selected,
    select: setChosenId,
    create,
    open,
    close,
    addEpisode,
    renameEpisode,
    deleteEpisode,
    attachFile,
    detachFile,
    locateFile,
    remove,
    choosePath,
  };
}
