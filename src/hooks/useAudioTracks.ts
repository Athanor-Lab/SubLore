import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { en } from "../i18n/en";

/** One of the open media's audio tracks, as `src-tauri/src/video/player.rs` reports it. */
export type AudioTrack = {
  /** mpv's own `aid`, which is what switching sets. */
  id: number;
  ffIndex: number;
  lang: string | null;
  title: string | null;
  /** mpv's own `selected` flag. Not where the mark comes from: see `currentId` below. */
  playing: boolean;
};

/** What both audio track commands answer: the list, and which track the panel is drawing. */
export type AudioTrackList = {
  tracks: AudioTrack[];
  currentId: number | null;
};

/** No media open, and a media with no audio: neither has a track to mark. */
const NO_TRACKS: AudioTrackList = { tracks: [], currentId: null };

/**
 * The open media's audio tracks, and the one being drawn.
 *
 * Which track that is comes from the backend, which is the side that knows: it is the stream the
 * peak job was started on. Working it out here from mpv's `selected` flag meant the panel followed
 * the track that was asked for while the menu followed a flag mpv had not set, so a switch drew one
 * track and ticked another. See BACKLOG N14.
 */
export function useAudioTracks(
  path: string | null,
  ready: boolean,
  /** Says a refusal on the status bar's timed slot: this hook has no surface of its own. */
  onRefused: (text: string) => void,
): {
  tracks: AudioTrack[];
  currentId: number | null;
  switchTo: (id: number) => void;
} {
  const [list, setList] = useState<AudioTrackList>(NO_TRACKS);

  /**
   * Which reading the menu is showing. A switch and the read that follows a new file both write the
   * same list, and neither used to say which request it belonged to: two switches picked in quick
   * succession applied in whichever order they answered, and the mark could go back to the track
   * before while the backend played the one after. The menu's own comment below says why that is
   * the state to avoid. See BACKLOG.md N64.
   */
  const asking = useRef(0);

  // Ready, not merely open: `video_open` sets the path and says Loading before mpv has the file,
  // and the backend refuses a track list at that point for the reason `loaded_path` gives. Asking
  // then answered nothing, and the path did not change again when the load finished, so the menu
  // stayed empty for the whole session.
  useEffect(() => {
    if (path === null || !ready) {
      setList(NO_TRACKS);
      return;
    }
    asking.current += 1;
    const mine = asking.current;
    void invoke<AudioTrackList>("audio_tracks")
      .then((listed) => {
        if (mine === asking.current) {
          setList(listed);
        }
      })
      .catch(() => {
        // No tracks to offer is the same shape as a media with none, and the panel's own line
        // already says that. Nothing here is worth a second message.
        if (mine === asking.current) {
          setList(NO_TRACKS);
        }
      });
  }, [path, ready]);

  const switchTo = useCallback(
    (id: number) => {
      asking.current += 1;
      const mine = asking.current;
      void invoke<AudioTrackList>("audio_switch_track", { id })
        .then((listed) => {
          if (mine === asking.current) {
            setList(listed);
          }
        })
        .catch(() => {
          if (mine !== asking.current) {
            return;
          }
          // The waveform's failure line covers one half of this, a switch whose peak job started
          // and then failed. It does not cover the other: a switch refused before any job exists
          // emits no event at all, so the waveform says nothing and the command did nothing in
          // silence. That half is said here. See BACKLOG.md N27.
          onRefused(en.audio.switchRefused);
          // And the menu is asked again, because one that silently keeps its old mark would be
          // claiming a track the app is not drawing.
          void invoke<AudioTrackList>("audio_tracks")
            .then((listed) => {
              if (mine === asking.current) {
                setList(listed);
              }
            })
            .catch(() => undefined);
        });
    },
    [onRefused],
  );

  return { tracks: list.tracks, currentId: list.currentId, switchTo };
}
