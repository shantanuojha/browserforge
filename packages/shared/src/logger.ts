export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** Create a child logger with a nested scope, e.g. `arbor:tabs`. */
  child(scope: string): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: LogLevel = "info";

/** Set the global minimum level for all loggers (default `info`). */
export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

/**
 * Tiny scoped console logger. Output looks like `[arbor:tabs] message ...`.
 */
export function createLogger(scope: string): Logger {
  const prefix = `[${scope}]`;
  const emit = (level: LogLevel, args: unknown[]) => {
    if (LEVELS[level] < LEVELS[minLevel]) return;
    const fn = level === "debug" ? console.debug : console[level];
    fn(prefix, ...args);
  };
  return {
    debug: (...args) => emit("debug", args),
    info: (...args) => emit("info", args),
    warn: (...args) => emit("warn", args),
    error: (...args) => emit("error", args),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}
