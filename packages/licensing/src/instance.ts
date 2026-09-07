export type BrowserFamily =
  "chrome" | "edge" | "firefox" | "opera" | "brave" | "safari" | "browser";

/** Coarse browser family from a user-agent string. Never includes version numbers. */
export function browserFamily(userAgent: string | undefined): BrowserFamily {
  const ua = userAgent ?? "";
  if (/Edg\//.test(ua)) return "edge";
  if (/OPR\//.test(ua)) return "opera";
  if (/Firefox\//.test(ua)) return "firefox";
  if (/Brave/.test(ua)) return "brave";
  if (/Chrome\//.test(ua)) return "chrome";
  if (/Safari\//.test(ua)) return "safari";
  return "browser";
}

const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export const INSTANCE_SUFFIX_LENGTH = 6;

/** Random 6-char lowercase base36 suffix, so each profile gets its own instance. */
export function randomInstanceSuffix(): string {
  const bytes = new Uint8Array(INSTANCE_SUFFIX_LENGTH);
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = "";
  for (const b of bytes) out += SUFFIX_ALPHABET[b % SUFFIX_ALPHABET.length];
  return out;
}

export function buildInstanceName(productName: string, family: BrowserFamily, suffix: string) {
  return `${productName}@${family}-${suffix}`;
}
