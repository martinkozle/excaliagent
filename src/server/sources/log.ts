export type Logger = (message: string) => void;
/** A warning keyed by what it is about (usually a file path). */
export type Warn = (message: string, key: string) => void;

/** Wraps a logger so each key is reported at most once. */
export function onceLogger(log: Logger): Warn {
  const seen = new Set<string>();
  return (message, key) => {
    if (seen.has(key)) return;
    seen.add(key);
    log(message);
  };
}
