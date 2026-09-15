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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A UUID (any version), lower-cased; `undefined` for anything else. */
export function readUuid(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return UUID_PATTERN.test(text) ? text.toLowerCase() : undefined;
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-_]{0,62}[a-z0-9])?$/i;

/** A URL path segment such as an organisation slug (letters, digits, `-`, `_`); else `undefined`. */
export function readSlug(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return SLUG_PATTERN.test(text) ? text : undefined;
}

/** One of `allowed`, matched case-insensitively after trimming; `undefined` for anything else. */
export function readEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().toLowerCase();
  return allowed.find((candidate) => candidate.toLowerCase() === text);
}
