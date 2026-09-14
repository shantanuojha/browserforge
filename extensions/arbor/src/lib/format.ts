/** Pure presentation formatting shared by the pages. */

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** `YYYYMMDD-HHMM` in local time, for file names. */
export function fileStamp(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}
