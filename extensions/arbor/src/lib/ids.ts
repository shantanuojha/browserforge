/**
 * nanoid-style local id generator. 21 URL-safe characters from `crypto.getRandomValues`
 * (available in service workers, extension pages and Node >= 19).
 */
const ALPHABET = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

export function newId(size = 21): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  let id = "";
  for (let i = 0; i < size; i++) {
    id += ALPHABET[(bytes[i] ?? 0) & 63];
  }
  return id;
}
