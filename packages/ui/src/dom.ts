/** Small DOM-side effects that every extension page needs and none should re-implement. */

/** Triggers a "Save as" download of `text` under `filename`. */
export function downloadTextFile(filename: string, text: string, type = "application/json"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Resolves to false when the clipboard is unavailable (no permission, insecure context). */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** `YYYY-MM-DD` for export file names. */
export function dateStamp(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}
