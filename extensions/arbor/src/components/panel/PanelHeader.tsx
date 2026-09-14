import type { RefObject } from "react";
import { Button, ProBadge } from "@browserforge/ui";
import { Icon } from "../Icon";

export type PanelView = "tree" | "recovery" | "io";

const VIEWS: readonly [PanelView, string][] = [
  ["tree", "Tree"],
  ["recovery", "Recovery"],
  ["io", "Import / Export"],
];

export interface HistoryControls {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  undo(): void;
  redo(): void;
}

export interface PanelHeaderProps {
  pro: boolean | null;
  /** "Loading..." until the background has sent the tree once. */
  countText: string;
  view: PanelView;
  onView(view: PanelView): void;
  query: string;
  onQuery(query: string): void;
  searchRef: RefObject<HTMLInputElement | null>;
  history: HistoryControls;
  liveTabCount: number;
  onAddGroup(): void;
  onCloseAll(): void;
}

function ViewTabs({ view, onView }: Pick<PanelHeaderProps, "view" | "onView">) {
  return (
    <div className="view-tabs" role="tablist">
      {VIEWS.map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="tab"
          className="view-tabs__tab"
          aria-selected={view === v}
          onClick={() => onView(v)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function HistoryButtons({ history }: { history: HistoryControls }) {
  const undoTitle = history.undoLabel ? `Undo: ${history.undoLabel}` : "Nothing to undo";
  const redoTitle = history.redoLabel ? `Redo: ${history.redoLabel}` : "Nothing to redo";
  return (
    <span className="toolbar__history" role="group" aria-label="Undo and redo">
      <button
        type="button"
        className="icon-btn"
        title={`${undoTitle} (Ctrl+Z)`}
        aria-label={undoTitle}
        disabled={!history.canUndo}
        onClick={history.undo}
      >
        <Icon name="undo" />
      </button>
      <button
        type="button"
        className="icon-btn"
        title={`${redoTitle} (Ctrl+Shift+Z)`}
        aria-label={redoTitle}
        disabled={!history.canRedo}
        onClick={history.redo}
      >
        <Icon name="redo" />
      </button>
    </span>
  );
}

type ToolbarProps = Pick<
  PanelHeaderProps,
  "query" | "onQuery" | "searchRef" | "history" | "liveTabCount" | "onAddGroup" | "onCloseAll"
>;

function Toolbar(props: ToolbarProps) {
  const { query, onQuery, searchRef, history, liveTabCount, onAddGroup, onCloseAll } = props;
  return (
    <div className="toolbar">
      <label className="search">
        <Icon name="search" />
        <input
          ref={searchRef}
          className="search__input"
          type="search"
          placeholder="Search title, URL or note  ( / )"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              onQuery("");
              (e.target as HTMLInputElement).blur();
            }
          }}
          aria-label="Search"
        />
      </label>
      <HistoryButtons history={history} />
      <Button
        size="sm"
        variant="secondary"
        title="New group at the top level (a closed window you can name and open later)"
        onClick={onAddGroup}
      >
        <Icon name="plus" /> Group
      </Button>
      <Button
        size="sm"
        variant="secondary"
        title="Close every open tab and keep all of them in the tree"
        disabled={liveTabCount === 0}
        onClick={onCloseAll}
      >
        Close all and save
      </Button>
    </div>
  );
}

export function PanelHeader(props: PanelHeaderProps) {
  const { pro, countText, view, onView } = props;
  return (
    <header className="app__header">
      <div className="app__title-row">
        <h1 className="app__title">
          Arbor {pro ? <ProBadge /> : null}
          <span className="app__count">{countText}</span>
        </h1>
        <ViewTabs view={view} onView={onView} />
      </div>
      {view === "tree" ? <Toolbar {...props} /> : null}
    </header>
  );
}
