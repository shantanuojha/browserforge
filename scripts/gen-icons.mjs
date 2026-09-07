#!/usr/bin/env node
/**
 * Generates placeholder extension icons as solid-colour PNGs, one palette per extension.
 *
 * Dependency-free: implements a minimal PNG encoder (IHDR + IDAT + IEND) using Node's
 * zlib for deflate and a small CRC32 routine.
 *
 * Usage:  node scripts/gen-icons.mjs [arbor|reroute|cookiesweep ...]
 *         (no args = all extensions)
 *
 * Output: extensions/<ext>/public/icon/{16,32,48,96,128}.png
 * WXT auto-detects `public/icon/*.png` (extension root) and fills manifest `icons`.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIZES = [16, 32, 48, 96, 128];

/** @type {Record<string, { fill: [number, number, number]; accent: [number, number, number] }>} */
const PALETTES = {
  arbor: { fill: [0x2e, 0x7d, 0x32], accent: [0xa5, 0xd6, 0xa7] }, // forest green
  reroute: { fill: [0x39, 0x49, 0xab], accent: [0xc5, 0xca, 0xe9] }, // indigo
  cookiesweep: { fill: [0xef, 0x6c, 0x00], accent: [0xff, 0xe0, 0xb2] }, // amber
};

// ---- CRC32 (IEEE 802.3, as used by PNG) ------------------------------------------------
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
/** @param {Uint8Array} bytes */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** @param {string} type @param {Uint8Array} data */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([len, typeBytes, data, crc]);
}

/**
 * Encode an RGBA image as PNG.
 * @param {number} size
 * @param {(x: number, y: number) => [number, number, number, number]} pixel
 */
function encodePng(size, pixel) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Raw scanlines: 1 filter byte (0 = None) + size * 4 bytes.
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = rowStart + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Solid rounded square in `fill`, with a small `accent` square in the lower-right so the
 * three extensions are distinguishable even at 16px. Transparent outside the rounded rect.
 * @param {number} size
 * @param {{ fill: number[]; accent: number[] }} palette
 */
function iconPixel(size, palette) {
  const radius = Math.max(1, Math.round(size * 0.2));
  const inset = Math.round(size * 0.58);
  const [fr, fg, fb] = palette.fill;
  const [ar, ag, ab] = palette.accent;
  return (/** @type {number} */ x, /** @type {number} */ y) => {
    // Rounded-corner test.
    const cx = x < radius ? radius : x >= size - radius ? size - radius - 1 : x;
    const cy = y < radius ? radius : y >= size - radius ? size - radius - 1 : y;
    const dx = x - cx;
    const dy = y - cy;
    if (dx * dx + dy * dy > radius * radius)
      return /** @type {[number,number,number,number]} */ ([0, 0, 0, 0]);
    if (x >= inset && y >= inset && x < size - radius && y < size - radius) {
      return /** @type {[number,number,number,number]} */ ([ar, ag, ab, 255]);
    }
    return /** @type {[number,number,number,number]} */ ([fr, fg, fb, 255]);
  };
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PALETTES);
for (const ext of targets) {
  const palette = PALETTES[ext];
  if (!palette) {
    console.error(`Unknown extension "${ext}". Known: ${Object.keys(PALETTES).join(", ")}`);
    process.exitCode = 1;
    continue;
  }
  const outDir = join(ROOT, "extensions", ext, "public", "icon");
  mkdirSync(outDir, { recursive: true });
  for (const size of SIZES) {
    const png = encodePng(size, iconPixel(size, palette));
    writeFileSync(join(outDir, `${size}.png`), png);
  }
  console.log(`✓ ${ext}: wrote ${SIZES.map((s) => `${s}.png`).join(", ")} -> ${outDir}`);
}
