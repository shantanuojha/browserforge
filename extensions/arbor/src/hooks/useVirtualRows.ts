import { useCallback, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from "react";
import type { FlatRow, NodeId } from "@/lib/model";
import {
  layoutRows,
  scrollTopToReveal,
  visibleRowIndices,
  type RowLayout,
} from "@/lib/tree-layout";

const INITIAL_VIEWPORT = 600;

export interface VirtualRows {
  containerRef: React.RefObject<HTMLDivElement | null>;
  layout: RowLayout;
  /** Indices into `rows` of the rows to render right now. */
  visibleIndices: number[];
  /** Height of the scroll container, for page-sized keyboard steps. */
  viewport: number;
  onScroll(e: UIEvent<HTMLDivElement>): void;
  scrollRowIntoView(i: number): void;
}

/** Virtualised rendering of `rows` inside a scroll container with per-row heights. */
export function useVirtualRows(
  rows: readonly FlatRow[],
  editingNoteId: NodeId | null,
): VirtualRows {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(INITIAL_VIEWPORT);

  const layout = useMemo(() => layoutRows(rows, editingNoteId), [rows, editingNoteId]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setViewport(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scrollRowIntoView = useCallback(
    (i: number) => {
      const el = containerRef.current;
      if (!el || i < 0) return;
      const target = scrollTopToReveal(layout, i, {
        scrollTop: el.scrollTop,
        height: el.clientHeight,
      });
      if (target !== null) el.scrollTop = target;
    },
    [layout],
  );

  return {
    containerRef,
    layout,
    visibleIndices: visibleRowIndices(layout, scrollTop, viewport),
    viewport,
    onScroll: (e) => setScrollTop(e.currentTarget.scrollTop),
    scrollRowIntoView,
  };
}
