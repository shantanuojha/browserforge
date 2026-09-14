/** Small type guards and coercions shared by every package. */

/** True for plain objects (not `null`, not arrays). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Human-readable message for anything thrown or rejected. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
