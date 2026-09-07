/**
 * The video IPC contract. Mirrors src-tauri/src/video. The region's unit is stated in three places
 * (here, `VideoRegion` in video/mod.rs, `SurfaceRegion` in video/surface) and they change together.
 */

export type VideoRegion = {
  /** Native device px, relative to the webview viewport. Resolved by the page: see VideoStage. */
  x: number;
  y: number;
  /** Native device px. Zero in either dimension hides the surface. */
  width: number;
  height: number;
};

export type VideoOpened = {
  path: string;
  /** Seconds, always greater than zero. */
  duration: number;
};

/**
 * What the open media is, as mpv answers for it. Every field but the path may be missing: a
 * container that does not carry a number is drawn as unknown rather than as a guess.
 */
export type VideoDetails = {
  path: string;
  fps: number | null;
  width: number | null;
  height: number | null;
  frames: number | null;
  duration: number | null;
  codec: string | null;
};

export type VideoErrorCode =
  | "playerUnavailable"
  | "invalidPath"
  | "openFailed"
  | "openTimeout"
  | "notLoaded"
  | "commandFailed"
  | "playbackStopped";

export type VideoError = {
  code: VideoErrorCode;
  /** Technical, not user-facing, may be empty. */
  detail: string;
};

export type VideoPlayerStatus = "idle" | "loading" | "ready";

export type VideoPlayerState = {
  status: VideoPlayerStatus;
  path: string | null;
  duration: number | null;
  paused: boolean;
};

export type VideoPositionEvent = {
  position: number;
};

/**
 * The box the picture fills, in pixels, once mpv has applied the file's pixel aspect and its
 * rotation. It is not the stored frame: an anamorphic or rotated media draws a different box.
 */
export type VideoPictureSize = {
  width: number;
  height: number;
};

/**
 * Null is the whole of the absence: a media with no picture, the window between an open and the
 * first decoded frame, and a failed open. Never zero, which arithmetic would consume as a size.
 */
export type VideoPictureEvent = {
  picture: VideoPictureSize | null;
};

const ERROR_CODES: ReadonlySet<string> = new Set<VideoErrorCode>([
  "playerUnavailable",
  "invalidPath",
  "openFailed",
  "openTimeout",
  "notLoaded",
  "commandFailed",
  "playbackStopped",
]);

/** Commands reject with a VideoError object, but a thrown value is never trusted on sight. */
export function isVideoError(value: unknown): value is VideoError {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { code?: unknown; detail?: unknown };
  return typeof candidate.code === "string" && ERROR_CODES.has(candidate.code);
}
