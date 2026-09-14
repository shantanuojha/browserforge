/** Reading and writing files from an extension page: File API in, download out. */
import { downloadTextFile } from "@browserforge/ui";

/** Save `value` as pretty-printed JSON without the `downloads` permission. */
export function downloadJson(fileName: string, value: unknown): void {
  downloadTextFile(fileName, JSON.stringify(value, null, 2));
}

export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file"));
    reader.readAsText(file);
  });
}
