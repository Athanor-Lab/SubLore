import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

/** One subtitle stream the open video carries, as `src-tauri/src/video/player.rs` reports it. */
export type VideoSubtitleTrack = {
  /** mpv's own `sid`. */
  id: number;
  ffIndex: number;
  /** mpv's codec name. Only the ones that hold text reach here. */
  codec: string;
  lang: string | null;
  title: string | null;
};

/**
 * The open video's own subtitle streams that Sublore can make a document from.
 *
 * Only the count is read from here, by the command that opens the first of them: the backend picks
 * the stream, so nothing in the page has to agree with it about which one that is. See N116.
 */
export function useVideoSubtitleTracks(path: string | null, ready: boolean): VideoSubtitleTrack[] {
  const [tracks, setTracks] = useState<VideoSubtitleTrack[]>([]);

  /** Which reading the menu is showing, so a slow answer cannot overwrite a later one (N64). */
  const asking = useRef(0);

  // Ready, not merely open, for the reason `useAudioTracks` gives: mpv has no track list to answer
  // with until the load has finished, and the path does not change again afterwards.
  useEffect(() => {
    if (path === null || !ready) {
      setTracks([]);
      return;
    }
    asking.current += 1;
    const mine = asking.current;
    void invoke<VideoSubtitleTrack[]>("subtitle_video_tracks")
      .then((listed) => {
        if (mine === asking.current) {
          setTracks(listed);
        }
      })
      .catch(() => {
        // A list that would not be read greys the command, which is what a media with no subtitles
        // does too. Nothing here is worth a message: the user asked for nothing.
        if (mine === asking.current) {
          setTracks([]);
        }
      });
  }, [path, ready]);

  return tracks;
}
