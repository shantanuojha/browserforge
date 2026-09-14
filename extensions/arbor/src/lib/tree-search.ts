/** The panel's search box: every whitespace-separated term must appear in title, url or note. */
import type { TreeNode } from "./model";

export type NodeFilter = (node: TreeNode) => boolean;

export function searchMatcher(query: string): NodeFilter | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const terms = q.split(/\s+/);
  return (n) => {
    const hay = `${n.title}\n${n.url ?? ""}\n${n.note ?? ""}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  };
}
