import type { TreeState } from "@/lib/messages";
import type { Tree } from "@/lib/model";
import { ImportExportView } from "../ImportExportView";
import { RecoveryView } from "../RecoveryView";
import { TreeView, type TreeActions } from "../TreeView";
import type { PanelView } from "./PanelHeader";

export interface PanelBodyProps {
  view: PanelView;
  state: TreeState | null;
  tree: Tree;
  error: string | null;
  query: string;
  actions: TreeActions;
  faviconFallback: ((url: string) => string) | null;
  pro: boolean | null;
}

function TreeBody(props: PanelBodyProps) {
  const { state, tree, error, query, actions, faviconFallback } = props;
  if (error && !state) {
    return <div className="tree__empty">Could not reach the background service: {error}</div>;
  }
  // Until the background has sent the tree once, the panel has nothing to show; painting the
  // empty tree ("No windows or tabs yet.") for that moment reads as data loss.
  if (state === null) return <div className="tree__empty">Loading...</div>;
  return (
    <TreeView
      tree={tree}
      live={state.live}
      query={query}
      actions={actions}
      faviconFallback={faviconFallback}
    />
  );
}

export function PanelBody(props: PanelBodyProps) {
  const { view, tree, pro } = props;
  if (view === "recovery") return <RecoveryView currentNodeCount={tree.size} />;
  if (view === "io") return <ImportExportView pro={pro} nodeCount={tree.size} />;
  return <TreeBody {...props} />;
}
