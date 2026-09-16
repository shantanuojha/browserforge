# Arbor changelog

User-facing changes per Chrome Web Store release. Dates are release dates.

## Unreleased

### Fixed

- **Scheduled backups no longer stop silently.** Every scheduled run re-checked the Pro licence
  and switched the schedule off whenever that check did not come back positive, including when the
  check itself could not be completed (for example the licence record could not be read at that
  moment). One such hiccup disarmed the timer for good; only a settings change or a browser
  restart brought it back, which is why backups could arrive at 17:01 and 17:50 and then not at
  all. A run that cannot confirm the licence is now skipped and the schedule stays armed; it is
  only switched off when you disable it or when the licence is definitely not Pro any more
  (deactivated, rejected by the provider, or offline for longer than the grace period). Arbor
  also re-creates the backup timer whenever it finds it missing (Chrome does not promise that
  timers survive a browser restart) and when a clock change has pushed the next run into the
  future. The browser itself may still hold a timer back while idle or, in Edge, in efficiency
  mode; that cannot be prevented from an extension, but it is now visible (below).
- **The Backups card shows what the schedule did last.** "Last scheduled run: 19:00 — written
  (112 nodes)", or why nothing was written: "skipped: licence check unavailable", "skipped: not
  Pro", "failed: …". The line updates live while the Options page is open.
- "Back up now" says "Could not check the Pro licence; try again" instead of "Scheduled backups
  are a Pro feature" when the licence record cannot be read.

## 0.1.6 — 2026-09-16

### Changed

- **Pro purchases move to Polar.** Arbor Pro licence keys are now issued and checked through
  Polar (polar.sh), which handles checkout, invoices and refunds as the merchant of record. The
  extension's only network call becomes the licence check against `api.polar.sh`; nothing else
  about what Arbor sends or stores changes, and Arbor asks for no new permissions. "Buy Pro" opens
  the Polar checkout and "Restore purchase" opens the Polar customer portal, where you can also
  free a seat you no longer use. A key activated with the previous provider shows as "not valid"
  once; paste the same key again to activate it here.
- **Deleting never closes your tabs any more.** "Delete" on a window, group, tab or note is now two
  separate actions, so removing something from the tree cannot take your open tabs with it:
  - **Remove from tree** (the trash button, the Delete key, the menu) takes the node and its saved
    tabs, notes and closed groups out of the tree and leaves the browser alone. Open tabs inside it
    stay open and stay in the tree: each goes back under its own window, at its position in the tab
    strip, the moment the group goes, so nothing is ever missing from the panel. An open window
    cannot leave the tree while it is open; on it the entry reads **Remove saved items** and clears
    its name, note and saved items instead (it is greyed out when there is nothing to remove). On an
    open tab it drops the tab's note and files the tab back under its window.
  - **Close tabs and remove** (the menu, Shift+Delete) is the old behaviour: it closes every open
    tab beneath the node without saving them, then removes the node. It is shown in red, still asks
    first, and the question now says how many open tabs will close and that the saved items will be
    deleted.
  - Both can be undone in one step (Ctrl+Z or the Undo button in the toast): a remove puts the nodes
    back where they were, with their names and notes, and moves the open tabs it kept back to their
    places; a close-and-remove puts the nodes back and reopens the tabs where they were.
- The Delete key no longer means "Close and save". That action keeps its button and menu entry.

## 0.1.5 — 2026-09-15

### Fixed

- **Tabs Outliner import keeps your tree.** The data Tabs Outliner stores (and the `.tree` files it
  exports) list every node with its position rather than nesting them. Arbor read that list as a flat
  set of unrelated items, so every window imported empty with its tabs beside it. The import now
  rebuilds the full window and tab hierarchy, including nested groups and notes; a node whose parent
  is missing from the file is kept at the top level instead of being lost.
- **No duplicate windows after a rebuild.** A window opened moments before Arbor rebuilt its tree
  (at browser start, on install, from Recovery or a replace import) could appear twice: once open and
  once as a closed copy of the same tabs. Tabs that were still loading are now recognised, so the
  window is matched instead of recreated.
- **Escape cancels a rename or note edit; Enter commits it once.** Pressing Escape after typing used
  to save the typed text anyway, and Enter (Ctrl+Enter in a note) saved it twice, leaving two
  identical Undo steps. Each edit now finishes exactly once: Escape discards, Enter commits.
- **Importing an Arbor export never drops nodes silently.** A hand-edited or concatenated export with
  duplicate ids or a parent loop used to lose nodes from the preview without any warning. Duplicates
  are now skipped with a warning and looped nodes are lifted to the top level and counted in the
  "missing parent" warning.
- **Options number fields no longer jump while typing.** Clearing the snapshot or backup interval
  and typing a new value used to snap to the minimum on the first keystroke, so typing "10" gave
  "110" or "50". The field now keeps what you type and only clamps to the allowed range when you
  leave it.
- **No "0 nodes" flash when the side panel opens.** The panel briefly showed "0 nodes, 0 open" and
  "No windows or tabs yet." before the tree arrived, which could read as lost data after a browser
  restart. It now shows a short loading state instead.
- Recovery snapshots written just before an import or restore now include changes made while the
  previous snapshot was being saved.

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
