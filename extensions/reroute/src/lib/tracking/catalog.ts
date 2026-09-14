/**
 * ClearURLs catalog -> static DNR `removeParams` rules.
 *
 * This module is imported both by the extension (JS-side cleaner) and by
 * `scripts/build-tracking-rules.mjs` through Node's type stripping, so it and everything under
 * `./catalog/` must stay dependency-free, use erasable TypeScript only, and import relative
 * modules with explicit `.ts` extensions.
 */

export * from "./catalog/conditions.ts";
export * from "./catalog/generate.ts";
export * from "./catalog/known-params.ts";
export * from "./catalog/params.ts";
export * from "./catalog/providers.ts";
