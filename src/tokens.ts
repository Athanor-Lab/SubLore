/**
 * What a double-click takes in the current line's text box (interface-spec 8.5, N151).
 *
 * The reference selects the format's notion of a word rather than the browser's: a braced run is
 * one token however many words are inside it, and the format's own escapes are one token each. A
 * plain `textarea` would take `an8` out of `{\an8\pos(320,50)}`, which is not a thing a translator
 * ever wants to replace on its own.
 */

/** A half-open range into the text, in the same offsets a textarea's selection uses. */
export type Token = { from: number; to: number };

/**
 * The format's escapes, each one token. `\N` is a line break, `\n` a soft one and `\h` a hard
 * space; nothing else outside braces is an escape the format reads.
 */
const ESCAPES = ["\\N", "\\n", "\\h"];

/** What counts as one word outside a braced run: letters, digits, and the marks inside a word. */
const WORD = /[\p{L}\p{N}_'’]/u;

/**
 * Every braced run in `text`, in order.
 *
 * An unclosed brace takes the rest of the line with it, which is the rule `drawnText` already holds
 * and what a renderer does with it: everything from that brace on is inside the run. A run that is
 * not an override tag at all, `{curly braces}` in prose, is still one run here, because the format
 * gives the braces their meaning and not the contents.
 */
function bracedRuns(text: string): Token[] {
  const runs: Token[] = [];
  let start = 0;
  for (;;) {
    const open = text.indexOf("{", start);
    if (open === -1) {
      return runs;
    }
    const close = text.indexOf("}", open);
    if (close === -1) {
      runs.push({ from: open, to: text.length });
      return runs;
    }
    runs.push({ from: open, to: close + 1 });
    start = close + 1;
  }
}

/** The run of characters around `at` that all answer `like`, bounded by `from` and `to`. */
function runAround(
  text: string,
  at: number,
  from: number,
  to: number,
  like: (char: string) => boolean,
): Token {
  let start = at;
  while (start > from && like(text.charAt(start - 1))) {
    start -= 1;
  }
  let end = at;
  while (end < to && like(text.charAt(end))) {
    end += 1;
  }
  return { from: start, to: end };
}

/**
 * The token `offset` falls in, which is what a double-click there selects.
 *
 * An offset past the end takes the last token, which is what the reference does there rather than
 * selecting nothing. An empty text has nothing to take and answers an empty range.
 */
export function tokenAt(text: string, offset: number): Token {
  if (text.length === 0) {
    return { from: 0, to: 0 };
  }
  const at = Math.max(0, Math.min(offset, text.length));
  const runs = bracedRuns(text);

  for (const run of runs) {
    // The closing brace counts as inside: a click on it is a click on that run and nothing else.
    // The end of a run belongs to it only when there is nothing after it to belong to instead.
    if (at >= run.from && (at < run.to || at === text.length)) {
      return run;
    }
  }

  // Between runs, so the neighbours bound the search: a word never reaches across a brace.
  const before = runs.filter((run) => run.to <= at).pop();
  const after = runs.find((run) => run.from >= at);
  const from = before === undefined ? 0 : before.to;
  const to = after === undefined ? text.length : after.from;

  // Past the end of what is selectable, the character to the left: the caret is beyond every one of
  // them, so the token it sits against is what a double-click there means.
  const here = at === to ? at - 1 : at;

  for (const escape of ESCAPES) {
    for (const start of [here, here - 1]) {
      if (start >= from && text.startsWith(escape, start) && here < start + escape.length) {
        return { from: start, to: start + escape.length };
      }
    }
  }

  const char = text.charAt(here);
  if (WORD.test(char)) {
    return runAround(text, here, from, to, (candidate) => WORD.test(candidate));
  }
  if (/\s/.test(char)) {
    return runAround(text, here, from, to, (candidate) => /\s/.test(candidate));
  }
  // Punctuation: the run of characters that are neither word nor space, so an ellipsis goes whole.
  return runAround(
    text,
    here,
    from,
    to,
    (candidate) => !WORD.test(candidate) && !/\s/.test(candidate),
  );
}
