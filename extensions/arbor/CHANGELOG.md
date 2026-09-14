# Arbor changelog

User-facing changes per Chrome Web Store release. Dates are release dates.

## 0.1.3 — 2026-09-15

### Fixed

- **Groups can reopen their tabs.** A group whose tabs were closed now offers "Reopen all"
  (row button, right-click menu, or Enter on the row), exactly like a closed window does. The
  Reopen button on a closed window or group stays visible instead of appearing only on hover.
- **Reopening a tab inside a group keeps it in the group.** Restoring a saved tab (click Restore,
  double-click, Enter, or the menu) reopens that very node in place, with its parent, position and
  children unchanged. It used to jump out of the group and land under the window.
- **No more empty "Window" nodes.** A window node that has nothing left under it, after its tabs
  were closed, deleted or dragged elsewhere, is removed automatically. Existing empty window nodes
  in your tree are cleaned up the first time this version starts. Groups and notes are never
  removed, a window holding a note or a group stays, and an open browser window keeps its node
  even when it only shows a new-tab page.
- Tabs dragged out of their window node no longer get pulled back when the tab strip is
  reordered, and they are matched again correctly after a restart.

### Added

- **Undo and redo.** Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) while the side panel has focus, plus two
  toolbar buttons whose tooltips say what will be undone ("Undo: delete 3 tabs"). Covers
  moving, deleting, close-and-save, reopening, renaming, notes and new groups; undoing a delete
  puts the nodes back where they were with their notes, undoing close-and-save reopens the same
  tabs in place. A short toast with an Undo button follows delete, close-and-save and reopen.
  The history is kept for the browser session (up to 50 steps) and survives closing and
  reopening the panel.
- "Close all and save" on any window or group row closes every open tab beneath it and keeps
  the nodes in place, saved.

## 0.1.2 — 2026-09-08

### Fixed

- Live tabs that had been dragged into a group (or under a saved window) were duplicated under
  their window and marked saved after the background restarted. They are now matched again
  wherever they sit in the tree.

## 0.1.1 — 2026-09-08

### Fixed

- **Tabs disappearing under a collapsed window.** Expanding a window node, or clearing a note,
  silently did nothing once it had been collapsed, hiding every tab beneath it. Both work again.
- Windows and tabs that were already open when Arbor was installed, or that the browser restores
  a few seconds after starting, are now picked up reliably.
- A window whose only tab is a new-tab page re-attaches to its node after a restart instead of
  leaving a stale empty copy behind.
- Live windows and live tabs can be dropped into groups; the tree position is yours to arrange,
  the browser is only told to move a tab when it changes windows or order.
- Side panel footer stays on one line when Pro is not on sale.

## 0.1.0 — 2026-09-08

First Chrome Web Store release: tree of live windows and tabs in the side panel, saved nodes
that persist when tabs close, drag-and-drop, notes, search, close-and-save, "close everything
and save", IndexedDB op-log storage with snapshots and a Recovery screen, JSON export/import and
Tabs Outliner import, optional Pro licence for scheduled local backups.
