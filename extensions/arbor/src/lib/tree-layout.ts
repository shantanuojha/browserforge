/**
 * Row geometry for the virtualised tree: heights are per row so note previews and the note
 * editor can expand a row, and only the rows inside the viewport (plus a margin) are rendered.
 */
import type { FlatRow } from "./model";
import type { NodeId } from "./model";

export const ROW_HEIGHT = 28;
export const NOTE_PREVIEW_HEIGHT = 22;
export const NOTE_EDITOR_HEIGHT = 78;
/** Rows rendered beyond each edge of the viewport so scrolling never shows a gap. */
export const OVERSCAN_ROWS = 6;

export interface RowLayout {
  offsets: number[];
  heights: number[];
  total: number;
}

export function rowHeight(row: FlatRow, editingNoteId: NodeId | null): number {
  if (editingNoteId === row.node.id) return ROW_HEIGHT + NOTE_EDITOR_HEIGHT;
  if (row.node.note) return ROW_HEIGHT + NOTE_PREVIEW_HEIGHT;
  return ROW_HEIGHT;
}

export function layoutRows(rows: readonly FlatRow[], editingNoteId: NodeId | null): RowLayout {
  const offsets = new Array<number>(rows.length);
  const heights = new Array<number>(rows.length);
  let y = 0;
  rows.forEach((row, i) => {
    const h = rowHeight(row, editingNoteId);
    offsets[i] = y;
    heights[i] = h;
    y += h;
  });
  return { offsets, heights, total: y };
}

/** Index of the last row starting at or above `scrollTop` (binary search over `offsets`). */
function firstRowAt(offsets: readonly number[], scrollTop: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((offsets[mid] ?? 0) <= scrollTop) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Indices of the rows to render for a viewport of `height` scrolled to `scrollTop`. */
export function visibleRowIndices(layout: RowLayout, scrollTop: number, height: number): number[] {
  const { offsets } = layout;
  if (!offsets.length) return [];
  const start = Math.max(0, firstRowAt(offsets, scrollTop) - OVERSCAN_ROWS);
  const bottom = scrollTop + height + OVERSCAN_ROWS * ROW_HEIGHT;
  const indices: number[] = [];
  for (let i = start; i < offsets.length; i++) {
    if ((offsets[i] ?? 0) > bottom) break;
    indices.push(i);
  }
  return indices;
}

/** The `scrollTop` that brings row `i` fully into a viewport of `height`, or `null` if it is. */
export function scrollTopToReveal(
  layout: RowLayout,
  i: number,
  view: { scrollTop: number; height: number },
): number | null {
  const top = layout.offsets[i] ?? 0;
  const bottom = top + (layout.heights[i] ?? ROW_HEIGHT);
  if (top < view.scrollTop) return top;
  if (bottom > view.scrollTop + view.height) return bottom - view.height;
  return null;
}
