/** Number of trailing characters revealed by `maskKey`. */
export const MASK_VISIBLE_CHARS = 4;

/**
 * Masks a licence key for display: only the last four characters survive,
 * e.g. `38b1417a-…-1234` becomes `XXXX-…-1234`.
 * Returns an empty string for empty input; very short keys are fully masked.
 */
export function maskKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length <= MASK_VISIBLE_CHARS) return "XXXX-…-" + "X".repeat(trimmed.length);
  return `XXXX-…-${trimmed.slice(-MASK_VISIBLE_CHARS)}`;
}

/** Normalises pasted input: trims and collapses inner whitespace/line breaks. */
export function normalizeKey(input: string): string {
  return input.replace(/\s+/g, "").trim();
}

/** Cheap client-side sanity check so we do not hit the API with obviously empty/garbage input. */
export function looksLikeLicenseKey(input: string): boolean {
  const key = normalizeKey(input);
  return key.length >= 8 && /^[A-Za-z0-9-]+$/.test(key);
}
