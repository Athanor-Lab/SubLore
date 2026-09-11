/**
 * What one wheel gesture is worth, in notches.
 *
 * A browser reports the same detent three ways and the mode says which: pixels, lines or pages. A
 * hundred pixels is one notch, three lines are one, and a page is one, which is what makes the
 * three modes reach the same step instead of three different ones. Shared rather than copied,
 * because the grid and the transport both step by it (N128, N133).
 *
 * The delta is read off whichever axis carries it: some browsers move a shifted wheel onto the
 * other one, and a vertical list would then answer nothing at all.
 */
const NOTCH_PX = 100;
const LINES_PER_NOTCH = 3;

export function notchesOf(event: WheelEvent): number {
  const along = event.deltaY !== 0 ? event.deltaY : event.deltaX;
  if (event.deltaMode === 1) {
    return along / LINES_PER_NOTCH;
  }
  if (event.deltaMode === 2) {
    return along;
  }
  return along / NOTCH_PX;
}
