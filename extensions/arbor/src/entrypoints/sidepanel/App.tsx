import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browser } from "wxt/browser";
import { Button, ProBadge } from "@browserforge/ui";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Icon } from "@/components/Icon";
import { ImportExportView } from "@/components/ImportExportView";
import { RecoveryView } from "@/components/RecoveryView";
import { TreeView, type TreeActions } from "@/components/TreeView";
import { UpsellRow } from "@/components/UpsellRow";
import { useHistory } from "@/hooks/useHistory";
import { usePro } from "@/hooks/usePro";
import { useSettings } from "@/hooks/useSettings";
import { useTreeState } from "@/hooks/useTreeState";
import { summarizeContainer } from "@/lib/container-actions";
import { history } from "@/lib/history";
import { msg } from "@/lib/messages";
import { descendantIds, ops, type NodeId, type Tree } from "@/lib/model";
import { primaryActionFor } from "@/lib/primary-action";

type View = "tree" | "recovery" | "io";

/** Footer message; `undo` adds an Undo button for the entry just recorded. */
interface Toast {
  text: string;
  undo?: boolean;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Body of the delete confirmation: what goes, and how many open tabs it closes unsaved. */
function deleteWarning(tree: Tree, id: NodeId): string {
  const node = tree.get(id);
  if (!node) return "";
  const nested = descendantIds(tree, id).length;
  const live = summarizeContainer(tree, node).liveTabs + (node.liveTabId !== undefined ? 1 : 0);
  const what = `This removes "${node.title}"${nested ? ` and ${nested} nested node(s)` : ""}.`;
  const open = live
    ? ` ${live} open tab${live === 1 ? " is" : "s are"} closed without being saved.`
    : "";
  return `${what}${open} Earlier snapshots in Recovery still contain them.`;
}

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
  const [toast, setToast] = useState<Toast | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const fallback = useMemo(() => faviconFallback(), []);

  const report = useCallback((e: unknown) => {
    setToast({ text: e instanceof Error ? e.message : String(e) });
  }, []);
  const hist = useHistory(report);
  const { undo, redo, push } = hist;

  useEffect(() => {
    if (!toast) return;
    // A toast that offers Undo stays a little longer.
    const t = setTimeout(() => setToast(null), toast.undo ? 5000 : 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const undoNow = useCallback(() => {
    setToast(null);
    void undo().then((e) => {
      if (e) setToast({ text: `Undone: ${e.label}.` });
    });
  }, [undo]);
  const redoNow = useCallback(() => {
    setToast(null);
    void redo().then((e) => {
      if (e) setToast({ text: `Redone: ${e.label}.` });
    });
  }, [redo]);

  // "/" focuses search from anywhere in the panel; Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y undo and redo
  // tree edits while the panel has focus (inside a text field they keep their native meaning).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inEditor = target.tagName === "INPUT" || target.tagName === "TEXTAREA";
      if (inEditor) return;
      if (e.key === "/") {
        e.preventDefault();
        setView("tree");
        searchRef.current?.focus();
        return;
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "z") {
        e.preventDefault();
        if (e.shiftKey) redoNow();
        else undoNow();
      } else if (key === "y" && !e.shiftKey) {
        e.preventDefault();
        redoNow();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undoNow, redoNow]);

  // Every mutating action records its inverse against the tree the panel showed at the time
  // (`tree`), so `actions` is rebuilt per tree version. Collapse/expand is not recorded.
  const performDelete = useCallback(
    (id: NodeId) => {
      void msg.deleteNode.send({ id }).then((removed) => {
        const entry = history.remove(tree, removed, id);
        push(entry);
        if (entry) setToast({ text: `${entry.done}.`, undo: true });
      }, report);
    },
    [tree, push, report],
  );

  const actions = useMemo<TreeActions>(() => {
    const run = (p: Promise<unknown>) => void p.catch(report);
    const reopen = (id: NodeId) => {
      const entry = history.reopen(tree, id);
      run(msg.restoreNode.send({ id }).then(() => push(entry)));
    };
    return {
      toggleCollapse: (id, collapsed) => run(msg.applyOps.send([ops.collapse(id, collapsed)])),
      setNote: (id, note) => {
        const entry = history.note(tree, id, note);
        run(msg.applyOps.send([ops.note(id, note)]).then(() => push(entry)));
      },
      rename: (id, title) => {
        const entry = history.rename(tree, id, title);
        run(msg.applyOps.send([ops.update(id, { title })]).then(() => push(entry)));
      },
      primary: (id) => {
        const n = tree.get(id);
        if (!n) return;
        if (primaryActionFor(n) === "focus") run(msg.focusNode.send({ id }));
        else reopen(id);
      },
      closeAndSave: (id) => {
        const entry = history.closeAndSave(tree, id);
        run(
          msg.closeAndSave.send({ id }).then((n) => {
            push(entry);
            if (n) setToast({ text: `Closed and saved ${plural(n, "tab")}.`, undo: !!entry });
          }),
        );
      },
      restore: reopen,
      reopenAll: (id) => {
        const entry = history.reopen(tree, id);
        run(
          msg.reopenAll.send({ id }).then((n) => {
            push(entry);
            setToast(
              n
                ? { text: `Reopened ${plural(n, "saved tab")}.`, undo: !!entry }
                : { text: "Nothing to reopen." },
            );
          }),
        );
      },
      deleteNode: (id) => {
        const n = tree.get(id);
        if (!n) return;
        const subtree = descendantIds(tree, id).length;
        const live = n.liveTabId !== undefined || n.liveWindowId !== undefined;
        if (subtree > 0 || live) setConfirm({ kind: "delete", id });
        else performDelete(id);
      },
      move: (id, parentId, index) =>
        run(
          msg.moveNode
            .send({ id, parentId, index })
            .then((pruned) => push(history.move(tree, id, parentId, index, pruned))),
        ),
      addGroup: (parentId, index) =>
        run(
          msg.addNode
            .send({ parentId, index, kind: "group", title: "New group" })
            .then((node) => push(history.create(node, index))),
        ),
      addNote: (parentId, index) =>
        run(
          msg.addNode
            .send({ parentId, index, kind: "note", title: "Note" })
            .then((node) => push(history.create(node, index))),
        ),
    };
  }, [tree, report, push, performDelete]);

  const liveTabCount = useMemo(() => {
    let n = 0;
    for (const node of tree.values()) if (node.kind === "tab" && node.liveTabId !== undefined) n++;
    return n;
  }, [tree]);

  const closeAll = () => {
    if (settings.confirmCloseAll) setConfirm({ kind: "close-all" });
    else
      void msg.closeAllAndSave
        .send()
        .then((n) => setToast({ text: `Closed and saved ${plural(n, "tab")}.` }), report);
  };

  const undoTitle = hist.undoLabel ? `Undo: ${hist.undoLabel}` : "Nothing to undo";
  const redoTitle = hist.redoLabel ? `Redo: ${hist.redoLabel}` : "Nothing to redo";

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
            <span className="toolbar__history" role="group" aria-label="Undo and redo">
              <button
                type="button"
                className="icon-btn"
                title={`${undoTitle} (Ctrl+Z)`}
                aria-label={undoTitle}
                disabled={!hist.canUndo}
                onClick={undoNow}
              >
                <Icon name="undo" />
              </button>
              <button
                type="button"
                className="icon-btn"
                title={`${redoTitle} (Ctrl+Shift+Z)`}
                aria-label={redoTitle}
                disabled={!hist.canRedo}
                onClick={redoNow}
              >
                <Icon name="redo" />
              </button>
            </span>
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
          <span className="toast" role="status">
            <span className="toast__text">{toast.text}</span>
            {toast.undo && hist.canUndo ? (
              <Button size="sm" variant="ghost" onClick={undoNow}>
                Undo
              </Button>
            ) : null}
          </span>
        ) : pro === false ? (
          <UpsellRow compact feature="Scheduled backups." />
        ) : (
          <span>Arrows move, Enter opens, Delete closes and saves, Ctrl+Z undoes.</span>
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
              .then((n) => setToast({ text: `Closed and saved ${plural(n, "tab")}.` }), report);
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
            performDelete(id);
          }}
          onCancel={() => setConfirm(null)}
        >
          {deleteWarning(tree, confirm.id)}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
