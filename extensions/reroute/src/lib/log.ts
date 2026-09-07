/** Rolling activity log: JS-fallback redirects, loop stops, DNR debug matches, errors. */

export type LogKind = "js" | "dnr" | "loop" | "skip" | "error";

export interface LogEntry {
  at: number;
  kind: LogKind;
  from: string;
  to?: string;
  tabId?: number;
  ruleId?: string;
  ruleName?: string;
  detail?: string;
}

export const LOG_LIMIT = 200;

/** Appends and trims to the newest LOG_LIMIT entries (newest last). */
export function appendLog(
  entries: readonly LogEntry[],
  entry: LogEntry,
  limit = LOG_LIMIT,
): LogEntry[] {
  const next = entries.length >= limit ? entries.slice(entries.length - limit + 1) : [...entries];
  next.push(entry);
  return next;
}
