/** Joins truthy class names; keeps component files free of `.filter(Boolean).join(" ")` noise. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
