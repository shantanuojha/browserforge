/**
 * Readers for build-time configuration values (`import.meta.env.*`). Every reader treats a
 * malformed value as unset so a typo in `.env` degrades to "not configured" instead of a crash.
 */

/** A positive safe integer from a string or number; `undefined` for anything else. */
export function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** A non-empty `https:` URL; `undefined` for anything else. */
export function readHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  try {
    return new URL(text).protocol === "https:" ? text : undefined;
  } catch {
    return undefined;
  }
}
