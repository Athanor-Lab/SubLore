import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { en } from "../i18n/en";
import {
  isVideoError,
  type VideoDetails,
  type VideoError,
  type VideoErrorCode,
  type VideoOpened,
  type VideoPictureEvent,
  type VideoPictureSize,
  type VideoPlayerState,
  type VideoPositionEvent,
  type VideoRegion,
} from "../types/video";

/** Typed so that adding a VideoErrorCode without a string is a compile error. */
const errorMessages: Record<VideoErrorCode, string> = en.video.errors;

export function videoErrorMessage(code: VideoErrorCode): string {
  return errorMessages[code];
}

const IDLE_STATE: VideoPlayerState = {
  status: "idle",
  path: null,
  duration: null,
  paused: true,
};

/** A rejection from the backend carries a VideoError; anything else is a broken command. */
function toErrorCode(error: unknown): VideoErrorCode {
  return isVideoError(error) ? error.code : "commandFailed";
}

export type VideoPlayer = {
  state: VideoPlayerState;
  position: number;
  /** The box the picture fills, or null while nothing is decoded and for a media with none. */
  picture: VideoPictureSize | null;
  errorCode: VideoErrorCode | null;
  open: (path: string) => Promise<void>;
  /** Unload the media, leaving the player up. See interface-spec 3.4, Close video. */
  close: () => Promise<void>;
  togglePlayback: () => Promise<void>;
  /** Play from the playhead, and stop where it stands: absolute, unlike the toggle above. */
  play: () => Promise<void>;
  pause: () => Promise<void>;
  seek: (position: number) => Promise<void>;
  /** Play a stretch and stop at its end, both in seconds. See docs/play-range-tasks.md. */
  playRange: (from: number, to: number) => Promise<void>;
  /** What the open media is, or null when the read failed and the error was reported. */
  details: () => Promise<VideoDetails | null>;
  /** Move by whole frames, back when negative. A picture that is playing is left alone. */
  step: (frames: number) => Promise<void>;
  setRegion: (region: VideoRegion) => void;
};

/**
 * @param covered whether an HTML layer is open over the page. The surface hides while it is, and
 * the backend derives that from the flag: the frontend never shows or hides it (decision 1, T8).
 */
export function useVideoPlayer(covered: boolean): VideoPlayer {
  const [state, setState] = useState<VideoPlayerState>(IDLE_STATE);
  const [position, setPosition] = useState(0);
  const [picture, setPicture] = useState<VideoPictureSize | null>(null);
  const [errorCode, setErrorCode] = useState<VideoErrorCode | null>(null);
  // The rectangle keeps being measured while a layer is open; it stops being sent, so no `raise`
  // can restack the surface over the layer. It goes back with the uncover. See T8.
  /**
   * Which file the commands in flight belong to. Every open moves it on, and an answer that comes
   * back carrying an older one is dropped rather than written: a command sent against the file
   * that was open cannot say anything true about the file that is open now, and a refusal from it
   * would put a sentence on the status bar about a document nobody asked about. See BACKLOG N40.
   */
  const opening = useRef(0);
  const held = useRef<VideoRegion | null>(null);
  const covering = useRef(covered);
  const transitions = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    // The backend never assumes the frontend is listening: the idle state above is the default.
    const listeners = Promise.all([
      listen<VideoPlayerState>("video://state", (event) => {
        setState(event.payload);
      }),
      listen<VideoPositionEvent>("video://position", (event) => {
        setPosition(event.payload.position);
      }),
      listen<VideoError>("video://error", (event) => {
        setErrorCode(event.payload.code);
      }),
      // Its own event, not a field on the state: the shape changes about once per file, and the
      // state payload would then fire more often for nothing. See docs/video-aspect-tasks.md.
      listen<VideoPictureEvent>("video://picture", (event) => {
        setPicture(event.payload.picture);
      }),
    ]);

    return () => {
      void listeners.then((unlisteners) => {
        for (const unlisten of unlisteners) {
          unlisten();
        }
      });
    };
  }, []);

  const open = useCallback(async (path: string) => {
    opening.current += 1;
    const mine = opening.current;
    setErrorCode(null);
    try {
      const opened = await invoke<VideoOpened>("video_open", { path });
      if (mine !== opening.current) {
        return;
      }
      setPosition(0);
      setState({
        status: "ready",
        path: opened.path,
        duration: opened.duration,
        paused: true,
      });
    } catch (error) {
      if (mine === opening.current) {
        setErrorCode(toErrorCode(error));
      }
    }
  }, []);

  /** Unload the media. The player stays up, so the next open is as cheap as the first. */
  const close = useCallback(async () => {
    opening.current += 1;
    setErrorCode(null);
    try {
      await invoke("video_close");
      setPosition(0);
      setState(IDLE_STATE);
      setPicture(null);
    } catch (error) {
      setErrorCode(toErrorCode(error));
    }
  }, []);

  /**
   * Ask for one of the two states outright, rather than for the other one than now.
   *
   * The menu's Play and Stop are absolute in the reference and have to be here too: what the page
   * believes about the last press can be a render behind what mpv is doing, and a Stop that read a
   * stale belief would leave the picture running. Only the transport button, which draws that
   * belief, is a toggle.
   */
  const setPaused = useCallback(async (paused: boolean) => {
    const mine = opening.current;
    setErrorCode(null);
    try {
      await invoke(paused ? "video_pause" : "video_play");
      if (mine === opening.current) {
        setState((current) => ({ ...current, paused }));
      }
    } catch (error) {
      if (mine === opening.current) {
        setErrorCode(toErrorCode(error));
      }
    }
  }, []);

  const play = useCallback(() => setPaused(false), [setPaused]);
  const pause = useCallback(() => setPaused(true), [setPaused]);
  const togglePlayback = useCallback(() => setPaused(!state.paused), [setPaused, state.paused]);

  const seek = useCallback(async (target: number) => {
    const mine = opening.current;
    setErrorCode(null);
    setPosition(target);
    try {
      await invoke("video_seek", { position: target });
    } catch (error) {
      if (mine === opening.current) {
        setErrorCode(toErrorCode(error));
      }
    }
  }, []);

  const playRange = useCallback(async (from: number, to: number) => {
    const mine = opening.current;
    setErrorCode(null);
    // The position is not set here the way `seek` sets it: playback is about to move it anyway,
    // and drawing the start for one frame before the first event would fight the player.
    try {
      await invoke("video_play_range", { from, to });
    } catch (error) {
      if (mine === opening.current) {
        setErrorCode(toErrorCode(error));
      }
    }
  }, []);

  const step = useCallback(async (frames: number) => {
    const mine = opening.current;
    setErrorCode(null);
    try {
      await invoke("video_step", { frames });
    } catch (error) {
      if (mine === opening.current) {
        setErrorCode(toErrorCode(error));
      }
    }
  }, []);

  const details = useCallback(async (): Promise<VideoDetails | null> => {
    const mine = opening.current;
    setErrorCode(null);
    try {
      return await invoke<VideoDetails>("video_details");
    } catch (error) {
      if (mine === opening.current) {
        setErrorCode(toErrorCode(error));
      }
      return null;
    }
  }, []);

  const setRegion = useCallback((region: VideoRegion) => {
    held.current = region;
    // Held while a layer is open, and sent again when the last one closes (T8).
    if (covering.current) {
      return;
    }
    // Fire and forget: a region update the backend rejects must not block layout.
    const mine = opening.current;
    void invoke("video_set_region", { region }).catch((error: unknown) => {
      if (mine === opening.current) {
        setErrorCode(toErrorCode(error));
      }
    });
  }, []);

  useEffect(() => {
    covering.current = covered;
    // One at a time and in this order: the held rectangle first, so the frame is placed before it
    // may be shown, and no stale answer can leave the picture hidden with no layer open (T8).
    transitions.current = transitions.current
      .then(async () => {
        const region = held.current;
        if (!covered && region !== null) {
          await invoke("video_set_region", { region });
        }
        await invoke("video_set_layers", { open: covered });
      })
      .catch((error: unknown) => {
        setErrorCode(toErrorCode(error));
      });
  }, [covered]);

  return {
    state,
    position,
    picture,
    errorCode,
    open,
    close,
    togglePlayback,
    play,
    pause,
    seek,
    playRange,
    details,
    step,
    setRegion,
  };
}
