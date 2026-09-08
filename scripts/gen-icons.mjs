#!/usr/bin/env node
/**
 * Generates the extension icons: flat, two-tone marks on an off-white rounded square.
 *
 *   arbor        a stylised tree: three connected nodes (deep green)
 *   reroute      an arrow that turns (indigo)
 *   cookiesweep  a bitten cookie with sweep marks (amber)
 *
 * Dependency-free: shapes are described in a 128-unit design space, rasterised with 4x4
 * supersampling, and written with a minimal PNG encoder (IHDR + IDAT + IEND) using Node's zlib
 * for deflate and a small CRC32 routine. Stroke widths and dot radii have minimum pixel sizes so
 * the marks stay legible at 16px; fine details (cookie chips) are dropped at small sizes.
 *
 * Usage:  node scripts/gen-icons.mjs [arbor|reroute|cookiesweep ...] [--store-dir=<dir>]
 *         (no extension args = all extensions)
 *
 * Output: extensions/<ext>/public/icon/{16,32,48,96,128}.png
 *         WXT auto-detects `public/icon/*.png` (extension root) and fills manifest `icons`.
 *         With --store-dir, also <dir>/icon-<ext>-128.png (Chrome Web Store listing icon).
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIZES = [16, 32, 48, 96, 128];
/** Design-space width; every coordinate below is in these units. */
const D = 128;
/** Supersampling grid per axis (SS*SS samples per pixel). */
const SS = 4;

// ---- Palette -----------------------------------------------------------------------------
/** @typedef {[number, number, number]} Rgb */
/** @param {string} hex */
const hex = (hex) => /** @type {Rgb} */ ([1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));

const OFF_WHITE = hex("#F6F3EC");
const BORDER = hex("#C9C3B4");
const GREEN = hex("#1E5B3C");
const INDIGO = hex("#3A47B4");
const AMBER = hex("#E08A0B");
const COCOA = hex("#6B3F12");

// ---- CRC32 (IEEE 802.3, as used by PNG) --------------------------------------------------
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

// ---- Shapes (inside tests in design space) -----------------------------------------------
/** @typedef {(x: number, y: number) => boolean} Shape */
/** @typedef {[number, number]} Pt */

/** @param {Pt} c @param {number} r @returns {Shape} */
const circle =
  ([cx, cy], r) =>
  (x, y) =>
    (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

/** Line from a to b with round caps. @param {Pt} a @param {Pt} b @param {number} w @returns {Shape} */
const segment =
  ([ax, ay], [bx, by], w) =>
  (x, y) => {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    const px = ax + t * dx;
    const py = ay + t * dy;
    return (x - px) ** 2 + (y - py) ** 2 <= (w / 2) ** 2;
  };

/**
 * Circular arc stroke of radius r around c, limited to the sector where `sector(dx, dy)` is true,
 * with round caps at the two end points.
 * @param {Pt} c @param {number} r @param {number} w
 * @param {(dx: number, dy: number) => boolean} sector @param {Pt} end1 @param {Pt} end2
 * @returns {Shape}
 */
const arc = ([cx, cy], r, w, sector, end1, end2) => {
  const caps = union(circle(end1, w / 2), circle(end2, w / 2));
  return (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    if (sector(dx, dy)) {
      const d = Math.abs(Math.hypot(dx, dy) - r);
      if (d <= w / 2) return true;
    }
    return caps(x, y);
  };
};

/** Convex polygon (any winding). @param {Pt[]} pts @returns {Shape} */
const polygon = (pts) => (x, y) => {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % pts.length];
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
};

/** Axis-aligned rounded rectangle. @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 @param {number} r @returns {Shape} */
const roundedRect = (x0, y0, x1, y1, r) => (x, y) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

/** @param {Shape[]} shapes @returns {Shape} */
const union =
  (...shapes) =>
  (x, y) =>
    shapes.some((s) => s(x, y));
/** @param {Shape} a @param {Shape} b @returns {Shape} */
const subtract = (a, b) => (x, y) => a(x, y) && !b(x, y);

/**
 * A design-space length that never renders below `minPx` device pixels at `size`.
 * Keeps strokes and dots legible when 128 units collapse into 16 pixels.
 * @param {number} units @param {number} size @param {number} minPx
 */
const atLeastPx = (units, size, minPx) => Math.max(units, (minPx * D) / size);

// ---- Icon designs --------------------------------------------------------------------------
/** @typedef {{ color: Rgb; shape: Shape }} Layer */

/** Off-white rounded square with a thin border, leaving a 6-unit transparent margin. */
function plate(size) {
  const border = atLeastPx(2.5, size, 1);
  return [
    { color: BORDER, shape: roundedRect(6, 6, D - 6, D - 6, 26) },
    {
      color: OFF_WHITE,
      shape: roundedRect(6 + border, 6 + border, D - 6 - border, D - 6 - border, 26 - border),
    },
  ];
}

/** @type {Record<string, (size: number) => Layer[]>} */
const ICONS = {
  /** Tree: trunk from the root node up to a fork, two branches ending in leaf nodes. */
  arbor(size) {
    const stroke = atLeastPx(11, size, 1.75);
    const node = atLeastPx(13, size, 2.4);
    /** @type {Pt} */ const root = [64, 98];
    /** @type {Pt} */ const fork = [64, 66];
    /** @type {Pt} */ const left = [36, 40];
    /** @type {Pt} */ const right = [92, 40];
    return [
      ...plate(size),
      {
        color: GREEN,
        shape: union(
          segment(root, fork, stroke),
          segment(fork, left, stroke),
          segment(fork, right, stroke),
          circle(root, node),
          circle(left, node),
          circle(right, node),
        ),
      },
    ];
  },

  /** Arrow that heads up, turns and points right: a redirected route. */
  reroute(size) {
    const stroke = atLeastPx(14, size, 2.2);
    // The head grows with the (minimum-clamped) stroke so it still reads as an arrow at 16px.
    const headHalf = Math.max(18, stroke * 1.6);
    const headLen = Math.max(24, stroke * 2.2);
    /** @type {Pt} */ const corner = [64, 68]; // arc centre
    const r = 26;
    /** @type {Pt} */ const arcStart = [corner[0] - r, corner[1]];
    /** @type {Pt} */ const arcEnd = [corner[0], corner[1] - r];
    /** @type {Pt} */ const headBase = [84, arcEnd[1]];
    return [
      ...plate(size),
      {
        color: INDIGO,
        shape: union(
          segment([arcStart[0], 100], arcStart, stroke),
          arc(corner, r, stroke, (dx, dy) => dx <= 0 && dy <= 0, arcStart, arcEnd),
          segment(arcEnd, headBase, stroke),
          polygon([
            [headBase[0] - 2, headBase[1] - headHalf],
            [headBase[0] - 2, headBase[1] + headHalf],
            [headBase[0] - 2 + headLen, headBase[1]],
          ]),
        ),
      },
    ];
  },

  /** Cookie with a bite taken out and three sweep marks trailing to the left. */
  cookiesweep(size) {
    const sweep = atLeastPx(9, size, 1.6);
    /** @type {Pt} */ const centre = [76, 66];
    const cookie = subtract(circle(centre, 38), circle([104, 38], atLeastPx(16, size, 3)));
    /** @type {Layer[]} */
    const layers = [
      ...plate(size),
      {
        color: AMBER,
        shape: union(
          cookie,
          segment([10, 46], [28, 46], sweep),
          segment([4, 66], [26, 66], sweep),
          segment([10, 86], [28, 86], sweep),
        ),
      },
    ];
    // Chocolate chips are noise below 32px.
    if (size >= 32) {
      layers.push({
        color: COCOA,
        shape: union(
          circle([62, 54], 6.5),
          circle([84, 74], 6.5),
          circle([64, 82], 6),
          circle([90, 52], 5),
        ),
      });
    }
    return layers;
  },
};

// ---- Rasteriser --------------------------------------------------------------------------
/**
 * Composite layers top-down per sub-sample (last layer wins), then average SS*SS samples into
 * premultiplied RGBA and un-premultiply for the PNG.
 * @param {number} size @param {Layer[]} layers
 */
function rasterise(size, layers) {
  const unit = D / size; // design units per pixel
  const n = SS * SS;
  return (/** @type {number} */ px, /** @type {number} */ py) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = (px + (sx + 0.5) / SS) * unit;
        const y = (py + (sy + 0.5) / SS) * unit;
        for (let i = layers.length - 1; i >= 0; i--) {
          if (layers[i].shape(x, y)) {
            const [lr, lg, lb] = layers[i].color;
            r += lr;
            g += lg;
            b += lb;
            a += 1;
            break;
          }
        }
      }
    }
    if (a === 0) return /** @type {[number,number,number,number]} */ ([0, 0, 0, 0]);
    return /** @type {[number,number,number,number]} */ ([
      Math.round(r / a),
      Math.round(g / a),
      Math.round(b / a),
      Math.round((a / n) * 255),
    ]);
  };
}

// ---- CLI ---------------------------------------------------------------------------------
const args = process.argv.slice(2);
const storeDirArg = args.find((a) => a.startsWith("--store-dir="));
const storeDir = storeDirArg ? resolve(storeDirArg.slice("--store-dir=".length)) : undefined;
const requested = args.filter((a) => !a.startsWith("--"));
const targets = requested.length ? requested : Object.keys(ICONS);

if (storeDir) mkdirSync(storeDir, { recursive: true });

for (const ext of targets) {
  const design = ICONS[ext];
  if (!design) {
    console.error(`Unknown extension "${ext}". Known: ${Object.keys(ICONS).join(", ")}`);
    process.exitCode = 1;
    continue;
  }
  const outDir = join(ROOT, "extensions", ext, "public", "icon");
  mkdirSync(outDir, { recursive: true });
  for (const size of SIZES) {
    const png = encodePng(size, rasterise(size, design(size)));
    writeFileSync(join(outDir, `${size}.png`), png);
    if (storeDir && size === 128) writeFileSync(join(storeDir, `icon-${ext}-128.png`), png);
  }
  console.log(`${ext}: wrote ${SIZES.map((s) => `${s}.png`).join(", ")} -> ${outDir}`);
  if (storeDir) console.log(`${ext}: wrote icon-${ext}-128.png -> ${storeDir}`);
}
