import { useCallback, useMemo, useRef, useState } from "react";
import { systemClock } from "@browserforge/shared";
import { faviconFallback } from "@/adapters/favicon";
import { msg } from "@/adapters/messaging";
import { openOptionsPage } from "@/adapters/runtime";
import { PanelBody } from "@/components/panel/PanelBody";
import { PanelDialogs, type PendingConfirmation } from "@/components/panel/PanelDialogs";
import { PanelHeader, type PanelView } from "@/components/panel/PanelHeader";
import { PanelFooter } from "@/components/panel/PanelFooter";
import { useHistory } from "@/hooks/useHistory";
import { usePanelShortcuts } from "@/hooks/usePanelShortcuts";
import { usePro } from "@/hooks/usePro";
import { useSettings } from "@/hooks/useSettings";
import { useToast } from "@/hooks/useToast";
import { useTreeActions } from "@/hooks/useTreeActions";
import { useTreeState } from "@/hooks/useTreeState";
import { createHistory } from "@/lib/history";
import { liveTabCount, plural } from "@/lib/panel-text";

const history = createHistory(systemClock);

export function App() {
  const { state, tree, error } = useTreeState();
  const [settings] = useSettings();
  const pro = usePro();
  const [view, setView] = useState<PanelView>("tree");
  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState<PendingConfirmation | null>(null);
  const { toast, show: notify, report } = useToast();
  const searchRef = useRef<HTMLInputElement>(null);
  const fallback = useMemo(() => faviconFallback(), []);
  const hist = useHistory(report);
  const { undo, redo, push } = hist;

  const undoNow = useCallback(() => {
    notify(null);
    void undo().then((e) => {
      if (e) notify({ text: `Undone: ${e.label}.` });
    });
  }, [undo, notify]);
  const redoNow = useCallback(() => {
    notify(null);
    void redo().then((e) => {
      if (e) notify({ text: `Redone: ${e.label}.` });
    });
  }, [redo, notify]);
  const focusSearch = useCallback(() => {
    setView("tree");
    searchRef.current?.focus();
  }, []);
  usePanelShortcuts({ focusSearch, undo: undoNow, redo: redoNow });

  const confirmDelete = useCallback((id: string) => setConfirm({ kind: "delete", id }), []);
  const { actions, performDelete } = useTreeActions({
    tree,
    history,
    push,
    report,
    notify,
    confirmDelete,
  });

  const openTabs = useMemo(() => liveTabCount(tree), [tree]);
  const closeAllNow = () => {
    setConfirm(null);
    void msg.closeAllAndSave
      .send()
      .then((n) => notify({ text: `Closed and saved ${plural(n, "tab")}.` }), report);
  };
  const closeAll = () => {
    if (settings.confirmCloseAll) setConfirm({ kind: "close-all" });
    else closeAllNow();
  };

  const loading = state === null && !error;

  return (
    <div className="app">
      <PanelHeader
        pro={pro}
        countText={loading ? "Loading..." : `${tree.size} nodes, ${openTabs} open`}
        view={view}
        onView={setView}
        query={query}
        onQuery={setQuery}
        searchRef={searchRef}
        history={{ ...hist, undo: undoNow, redo: redoNow }}
        liveTabCount={openTabs}
        onAddGroup={() => actions.addGroup(null, 0)}
        onCloseAll={closeAll}
      />
      <div className="app__body">
        <PanelBody
          view={view}
          state={state}
          tree={tree}
          error={error}
          query={query}
          actions={actions}
          faviconFallback={fallback}
          pro={pro}
        />
      </div>
      <PanelFooter
        toast={toast}
        canUndo={hist.canUndo}
        onUndo={undoNow}
        pro={pro}
        onOptions={openOptionsPage}
      />
      <PanelDialogs
        confirm={confirm}
        tree={tree}
        liveTabCount={openTabs}
        onCloseAll={closeAllNow}
        onDelete={(id) => {
          setConfirm(null);
          performDelete(id);
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
