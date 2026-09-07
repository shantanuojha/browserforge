import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browser } from "wxt/browser";
import { Button, ProBadge } from "@browserforge/ui";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Icon } from "@/components/Icon";
import { ImportExportView } from "@/components/ImportExportView";
import { RecoveryView } from "@/components/RecoveryView";
import { TreeView, type TreeActions } from "@/components/TreeView";
import { UpsellRow } from "@/components/UpsellRow";
import { usePro } from "@/hooks/usePro";
import { useSettings } from "@/hooks/useSettings";
import { useTreeState } from "@/hooks/useTreeState";
import { msg } from "@/lib/messages";
import { descendantIds, ops, type NodeId } from "@/lib/model";

type View = "tree" | "recovery" | "io";

/** Chromium exposes cached favicons at `/_favicon/` when the `favicon` permission is granted. */
function faviconFallback(): ((url: string) => string) | null {
  const hasSidePanel = "sidePanel" in browser;
  if (!hasSidePanel || typeof chrome === "undefined" || !chrome.runtime?.getURL) return null;
  const base = chrome.runtime.getURL("/_favicon/");
  return (url) => `${base}?pageUrl=${encodeURIComponent(url)}&size=16`;
}

export function App() {
  const { state, tree, error } = useTreeState();
  const [settings] = useSettings();
  const pro = usePro();
  const [view, setView] = useState<View>("tree");
  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState<
    { kind: "close-all" } | { kind: "delete"; id: NodeId } | null
  >(null);
  const [toast, setToast] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const fallback = useMemo(() => faviconFallback(), []);

  const report = useCallback((e: unknown) => {
    setToast(e instanceof Error ? e.message : String(e));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // "/" focuses search from anywhere in the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key === "/" && target.tagName !== "INPUT" && target.tagName !== "TEXTAREA") {
        e.preventDefault();
        setView("tree");
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const actions = useMemo<TreeActions>(() => {
    const run = (p: Promise<unknown>) => void p.catch(report);
    return {
      toggleCollapse: (id, collapsed) => run(msg.applyOps.send([ops.collapse(id, collapsed)])),
      setNote: (id, note) => run(msg.applyOps.send([ops.update(id, { note: note || undefined })])),
      rename: (id, title) => run(msg.applyOps.send([ops.update(id, { title })])),
      primary: (id) => {
        const n = tree.get(id);
        if (!n) return;
        const live =
          (n.kind === "tab" && n.liveTabId !== undefined) ||
          (n.kind === "window" && n.liveWindowId !== undefined);
        run(live ? msg.focusNode.send({ id }) : msg.restoreNode.send({ id }));
      },
      closeAndSave: (id) => run(msg.closeAndSave.send({ id })),
      restore: (id) => run(msg.restoreNode.send({ id })),
      deleteNode: (id) => {
        const n = tree.get(id);
        if (!n) return;
        const subtree = descendantIds(tree, id).length;
        const live = n.liveTabId !== undefined || n.liveWindowId !== undefined;
        if (subtree > 0 || live) setConfirm({ kind: "delete", id });
        else run(msg.deleteNode.send({ id }));
      },
      move: (id, parentId, index) => run(msg.moveNode.send({ id, parentId, index })),
      addGroup: (parentId, index) =>
        run(msg.addNode.send({ parentId, index, kind: "group", title: "New group" })),
      addNote: (parentId, index) =>
        run(msg.addNode.send({ parentId, index, kind: "note", title: "Note" })),
    };
  }, [tree, report]);

  const liveTabCount = useMemo(() => {
    let n = 0;
    for (const node of tree.values()) if (node.kind === "tab" && node.liveTabId !== undefined) n++;
    return n;
  }, [tree]);

  const closeAll = () => {
    if (settings.confirmCloseAll) setConfirm({ kind: "close-all" });
    else
      void msg.closeAllAndSave.send().then((n) => setToast(`Closed and saved ${n} tabs.`), report);
  };

  const live = state?.live ?? { activeTabIds: [], focusedWindowId: undefined };

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__title-row">
          <h1 className="app__title">
            Arbor {pro ? <ProBadge /> : null}
            <span className="app__count">
              {tree.size} nodes, {liveTabCount} open
            </span>
          </h1>
          <div className="view-tabs" role="tablist">
            {(
              [
                ["tree", "Tree"],
                ["recovery", "Recovery"],
                ["io", "Import / Export"],
              ] as [View, string][]
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                role="tab"
                className="view-tabs__tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {view === "tree" ? (
          <div className="toolbar">
            <label className="search">
              <Icon name="search" />
              <input
                ref={searchRef}
                className="search__input"
                type="search"
                placeholder="Search title, URL or note  ( / )"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setQuery("");
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                aria-label="Search"
              />
            </label>
            <Button
              size="sm"
              variant="secondary"
              title="New group at the top level"
              onClick={() => actions.addGroup(null, 0)}
            >
              <Icon name="plus" /> Group
            </Button>
            <Button
              size="sm"
              variant="secondary"
              title="Close every open tab and keep all of them in the tree"
              disabled={liveTabCount === 0}
              onClick={closeAll}
            >
              Close all and save
            </Button>
          </div>
        ) : null}
      </header>

      <div className="app__body">
        {view === "tree" ? (
          error && !state ? (
            <div className="tree__empty">Could not reach the background service: {error}</div>
          ) : (
            <TreeView
              tree={tree}
              live={live}
              query={query}
              actions={actions}
              faviconFallback={fallback}
            />
          )
        ) : view === "recovery" ? (
          <RecoveryView currentNodeCount={tree.size} />
        ) : (
          <ImportExportView pro={pro} nodeCount={tree.size} />
        )}
      </div>

      <footer className="app__footer">
        {toast ? (
          <span>{toast}</span>
        ) : pro === false ? (
          <UpsellRow compact feature="Scheduled and Drive backups, power keys." />
        ) : (
          <span>Arrows move, Enter opens, Delete closes and saves, N adds a note.</span>
        )}
        <Button size="sm" variant="ghost" onClick={() => void browser.runtime.openOptionsPage()}>
          Options
        </Button>
      </footer>

      {confirm?.kind === "close-all" ? (
        <ConfirmDialog
          title="Close all open tabs?"
          confirmLabel="Close all and save"
          danger
          onConfirm={() => {
            setConfirm(null);
            void msg.closeAllAndSave
              .send()
              .then((n) => setToast(`Closed and saved ${n} tabs.`), report);
          }}
          onCancel={() => setConfirm(null)}
        >
          {liveTabCount} open tabs across all windows will be closed. Every one of them stays in the
          tree as a saved node and can be restored later. A blank tab is kept open so the browser
          does not quit.
        </ConfirmDialog>
      ) : null}
      {confirm?.kind === "delete" ? (
        <ConfirmDialog
          title="Delete from the tree?"
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            const id = confirm.id;
            setConfirm(null);
            void msg.deleteNode.send({ id }).catch(report);
          }}
          onCancel={() => setConfirm(null)}
        >
          This removes &quot;{tree.get(confirm.id)?.title}&quot;
          {descendantIds(tree, confirm.id).length
            ? ` and ${descendantIds(tree, confirm.id).length} nested node(s)`
            : ""}
          . Open tabs in it are closed without being saved. Earlier snapshots in Recovery still
          contain them.
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
