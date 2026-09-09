/**
 * Colour, in the notations the picker shows and the file writes.
 *
 * The picker holds its state as HSV rather than as bytes, and that is the whole reason this module
 * exists rather than a pair of helpers beside the panel. A grey has no hue: converting it to RGB and
 * back reads the hue as zero, so a picker that re-derived its state on every change would swing its
 * hue slider to red the moment a translator picked white. What is held is what the user set; what is
 * shown is what that means.
 */

/** Red, green and blue, each 0 to 255. */
export type Rgb = { r: number; g: number; b: number };

/** Hue 0 to 360, saturation and value 0 to 1. Hue survives a colour that has none. */
export type Hsv = { h: number; s: number; v: number };

/** Hue 0 to 360, saturation and lightness 0 to 1. */
export type Hsl = { h: number; s: number; l: number };

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function byte(value: number): number {
  return clamp(Math.round(value), 0, 255);
}

/** `#RRGGBB` or `RRGGBB`, in either case. Anything else is not a colour and reads as null. */
export function rgbFromHex(hex: string): Rgb | null {
  const found = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (found === null) {
    return null;
  }
  const digits = found[1];
  return {
    r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    b: Number.parseInt(digits.slice(4, 6), 16),
  };
}

export function hexFromRgb({ r, g, b }: Rgb): string {
  const pair = (value: number) => byte(value).toString(16).toUpperCase().padStart(2, "0");
  return `#${pair(r)}${pair(g)}${pair(b)}`;
}

/**
 * ASS writes a colour as `&HBBGGRR&`, blue first, and a leading `&H` and trailing `&` that some
 * files leave off. Read both shapes, write the full one.
 */
export function rgbFromAss(value: string): Rgb | null {
  const found = /^&?H?([0-9a-fA-F]{6})&?$/.exec(value.trim());
  if (found === null) {
    return null;
  }
  const digits = found[1];
  return {
    b: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    r: Number.parseInt(digits.slice(4, 6), 16),
  };
}

export function assFromRgb({ r, g, b }: Rgb): string {
  const pair = (value: number) => byte(value).toString(16).toUpperCase().padStart(2, "0");
  return `&H${pair(b)}${pair(g)}${pair(r)}&`;
}

/**
 * The hue a colour has, or the one it was given.
 *
 * `fallback` is what a grey keeps: red, green and blue equal leave the hue undefined, and every
 * formula that computes it anyway answers zero. The picker passes the hue it is already holding, so
 * a translator who types `#808080` sees the slider stay where they left it.
 */
export function hsvFromRgb({ r, g, b }: Rgb, fallback = 0): Hsv {
  const red = clamp(r, 0, 255) / 255;
  const green = clamp(g, 0, 255) / 255;
  const blue = clamp(b, 0, 255) / 255;
  const high = Math.max(red, green, blue);
  const low = Math.min(red, green, blue);
  const spread = high - low;

  let hue = fallback;
  if (spread > 0) {
    if (high === red) {
      hue = ((green - blue) / spread) % 6;
    } else if (high === green) {
      hue = (blue - red) / spread + 2;
    } else {
      hue = (red - green) / spread + 4;
    }
    hue *= 60;
    if (hue < 0) {
      hue += 360;
    }
  }
  return { h: hue, s: high === 0 ? 0 : spread / high, v: high };
}

export function rgbFromHsv({ h, s, v }: Hsv): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const saturation = clamp(s, 0, 1);
  const value = clamp(v, 0, 1);
  const chroma = value * saturation;
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const base = value - chroma;
  const [red, green, blue] =
    hue < 60
      ? [chroma, second, 0]
      : hue < 120
        ? [second, chroma, 0]
        : hue < 180
          ? [0, chroma, second]
          : hue < 240
            ? [0, second, chroma]
            : hue < 300
              ? [second, 0, chroma]
              : [chroma, 0, second];
  return {
    r: byte((red + base) * 255),
    g: byte((green + base) * 255),
    b: byte((blue + base) * 255),
  };
}

/** The third notation the reference shows. Same hue as HSV, a different second and third number. */
export function hslFromRgb(rgb: Rgb, fallback = 0): Hsl {
  const { h, s, v } = hsvFromRgb(rgb, fallback);
  const lightness = v * (1 - s / 2);
  const saturation =
    lightness === 0 || lightness === 1 ? 0 : (v - lightness) / Math.min(lightness, 1 - lightness);
  return { h, s: saturation, l: lightness };
}

export function rgbFromHsl({ h, s, l }: Hsl): Rgb {
  const lightness = clamp(l, 0, 1);
  const saturation = clamp(s, 0, 1);
  const value = lightness + saturation * Math.min(lightness, 1 - lightness);
  return rgbFromHsv({ h, s: value === 0 ? 0 : 2 * (1 - lightness / value), v: value });
}

/** How the three notations are drawn: whole numbers, because that is what a field takes. */
export function roundedHsv({ h, s, v }: Hsv): { h: number; s: number; v: number } {
  return { h: Math.round(h), s: Math.round(s * 100), v: Math.round(v * 100) };
}

export function roundedHsl({ h, s, l }: Hsl): { h: number; s: number; l: number } {
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}
