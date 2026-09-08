import { useCallback, useEffect, useRef, useState } from "react";

/** The reference's default: ten seconds, then the message clears itself (interface-spec 1.5). */
const DEFAULT_MESSAGE_MS = 10000;

/**
 * The status bar's timed message: a sentence any command can push, cleared by a timer, replaced
 * outright by the next push with a clock of its own (interface-spec 1.5). One slot, no queue,
 * which is the reference's behaviour.
 */
export function useTimedMessage(): [string | null, (text: string, ms?: number) => void] {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const say = useCallback((text: string, ms: number = DEFAULT_MESSAGE_MS) => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
    }
    setMessage(text);
    timer.current = setTimeout(() => {
      timer.current = null;
      setMessage(null);
    }, ms);
  }, []);

  // The timer dies with the component, so an unmounted bar never sets state.
  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  return [message, say];
}
