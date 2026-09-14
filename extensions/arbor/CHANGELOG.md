# Arbor changelog

User-facing changes per Chrome Web Store release. Dates are release dates.

## 0.1.4 — 2026-09-15

### Changed

- **Groups and windows are now the same thing.** A group is a window that is not open right now;
  an open window is a group the browser is showing. Both share one icon (a window frame, filled
  while the window is open, outlined while it is closed), the same row buttons and menu entries,
  and the same behaviour:
  - "Open as window" on a closed group or window opens it as a **new browser window** holding its
    saved tabs in tree order. Tabs of that group that are still open elsewhere are moved into the
    new window, so the window matches the tree. From then on the group _is_ that window.
  - "Reopen all" on an open window reopens its closed tabs into that window, at their positions.
  - "Close all and save" on either closes its tabs; the node stays in the tree with everything
    saved in place, ready to be opened again. A group nested inside another is a window of its
    own: it is only opened when you ask for it.
  - Every window can be renamed (F2, Shift+Enter or the menu). A window you have not named shows
    as "Window"; windows the browser opens still appear by themselves.
- Existing trees are converted the first time this version starts (recorded like any other
  change, so Recovery snapshots stay usable). Old exports and backups import unchanged; new
  exports carry format version 2. The import preview counts windows and groups together.

### Fixed

- **"Reopen all" brings back every tab in a group.** Tabs dragged into a group while open and
  closed afterwards were skipped; only tabs that had been saved into the group earlier came back.
  Reopening now covers every tab under the group, however it got there. A tab whose close the
  extension missed is treated as closed rather than skipped, one tab that cannot be opened no
  longer stops the others (the error is shown once the rest are open), and reopening no longer
  targets a popup or DevTools window that happened to have focus.

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
