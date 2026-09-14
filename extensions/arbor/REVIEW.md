# Arbor review (branch `review/arbor`, based on `origin/main` @ 4e1daf2, Arbor 0.1.4)

Scope: every file under `extensions/arbor/src` (model, store, sync, history, container actions,
io, backups, entrypoints, components, hooks) plus `wxt.config.ts` and the built manifest. Nothing
outside `extensions/arbor` was touched; no dependency added; no version bump.

Method: read everything, then for each suspicion produced runtime evidence first. Two kinds:

- vitest on the existing harnesses (`src/lib/sync/testing/fake-browser.ts`,
  `src/lib/store/testing/fake-indexeddb.ts`, `MemoryTreeStore`).
- The built extension loaded into Chromium 153 and Microsoft Edge 153 through Playwright
  (`~/.browserforge/release/.tools/pw/review-arbor-*.mjs`, kept outside the repo). These probes
  instrumented the service worker for `windows.*` / `tabs.*` event order, drove the side panel and
  options page through the DOM, read the tree through the `getState` message, forced rebuilds through
  Recovery and killed the worker through CDP `ServiceWorker.stopWorker`. Observations are quoted below.

Tests: **227 passing in 13 files before -> 231 passing in 13 files after** (repo: 555 -> 559).
Gates green at every commit: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`,
`pnpm --filter @browserforge/arbor build`.

Commits (oldest first):

| SHA       | Subject                                                                              |
| --------- | ------------------------------------------------------------------------------------ |
| `030dc7c` | inline editors finish once; Escape no longer commits the typed title or note         |
| `0ba8d6b` | ops appended during a compaction stay pending                                        |
| `716fff6` | rebuild matches tabs by their pending url too, so loading windows are not duplicated |
| `7318ad1` | side panel shows a loading state instead of an empty tree before the first update    |
| `e35cdf5` | Tabs Outliner import keeps the tree structure of the real snapshot format            |
| `ecba509` | Arbor export import never drops nodes silently                                       |
| `372f0c4` | options number fields no longer snap to the clamped value while typing               |

---

## Confirmed bugs (fixed)

### 1. HIGH - Tabs Outliner import flattened the whole tree

- **Cause.** The data the Import screen tells users to copy (`onViewClose_lastSessionSnapshot`), the
  IndexedDB `currentSessionSnapshot.data` dump and exported `.tree` files are a flat array of
  `[flag, { type, data, marks }, indexPath]` rows in depth-first order; a node's place in the tree is
  its index path, not nesting. The permissive parser only knew the nested `[node, [children]]` pair
  form and treated each row as a list of unrelated values: the flag and the path were ignored and the
  node spec became a top-level node. Every window imported empty with all its tabs beside it, so the
  headline "import your Tabs Outliner backup" produced a flat list and "Reopen all" on an imported
  window opened nothing. The row shape is the one used by the public recovery scripts (rwohleb's DB
  dump, jalaziz's `.tree` dedupe / Great Suspender fixers).
- **Evidence.** `io.test.ts > rebuilds the hierarchy of Tabs Outliner's flat row format`: before the
  fix the preview roots were `Work, A, B, B child, note, (window), old.test, Reading, C, Orphan` (10
  roots, no children anywhere).
- **Fix.** `parseArray` recognises rows of that shape and attaches each under the row whose path is
  its prefix; a row whose parent path was never seen is hoisted, not dropped; a session root at `[]`
  is unwrapped as before; non-row elements still go through the generic parser. The nested form still
  works. Commit `e35cdf5`.

### 2. MEDIUM - A rebuild while a new window was still loading duplicated it

- **Cause.** A tab committing its first navigation reports `url: ""` and the page in `pendingUrl`.
  Events create its node with that url (`adoptOrCreate` uses `pendingUrl || url`), but
  `rebuildFrom` matched windows and tabs on `t.url` alone. With every tab of the window unverifiable,
  the id match failed, the URL-overlap match saw only blank urls and gave up, so the rebuild created a
  second container bound to the window, unbound the first one and left two saved copies of its tabs.
  Rebuilds run on every worker start, on the install / startup resyncs, on the +30 s startup alarm,
  on Recovery restore and on replace import, so any window opened shortly before one of those was at
  risk.
- **Evidence.** First seen by accident in Chromium 153: the install resync right after
  `windows.create({ url: [...] })` logged `windowsCreated: 1, tabsCreated: 2, nodesSaved: 3` and the
  panel showed W2 twice (one closed container with `data:...` titled saved tabs, one open). Made
  deterministic with `review-arbor-pending.mjs`: two navigations to an unroutable host (`url: ""`,
  `pendingUrl` set, `status: loading`), then Recovery "snapshot now + restore" to force a rebuild:
  containers 2 -> 3, tab nodes 2 -> 4 (2 saved) before; unchanged after, report
  `windowsMatched: 2, tabsMatched: 4`. Same in Edge 153. Fake-browser test
  `tracker.test.ts > re-attaches a window whose tabs are still loading (pendingUrl only)` reproduces
  the identical report.
- **Fix.** `rebuildFrom` matches on `url || pendingUrl` everywhere it compares a live tab with a node
  (id verification, blank checks, URL-overlap scoring, candidate lookup). Commit `716fff6`.

### 3. MEDIUM - Escape committed a rename / note edit; Enter committed twice

- **Cause.** `TitleEditor` and `NoteEditor` commit on blur. Their commit and cancel handlers
  (`onRename`, `onSaveNote`, `onCancelEdit` in `TreeView`) call `focusTree()` while the editor is
  still mounted; moving focus blurs the input synchronously and ran the blur-commit a second time. So
  Escape after typing committed the typed text (the opposite of what the placeholder promises), and
  Enter / Ctrl+Enter sent two identical `applyOps` and pushed two history entries.
- **Evidence (Chromium 153 and Edge 153, `review-arbor-events.mjs` probes 4-7).** Rename, type
  `SHOULD-NOT-STICK`, Escape -> the group was titled `SHOULD-NOT-STICK`. Rename + Enter -> the
  `storage.session` undo stack grew by 2 (`rename "..."` twice). Note editor + Escape -> note saved.
  Ctrl+Enter -> two `edit note on "WORK"` entries. All four pass after the fix.
- **Fix.** Each editor instance finishes (commit or cancel) exactly once (`useFinishOnce`). Commit
  `030dc7c`.

### 4. LOW - Ops appended during a compaction were forgotten by the compaction counter

- **Cause.** `LogTreeStore.compact()` set `opsSinceSnapshot = 0` after `putSnapshot` resolved, but
  `append()` is synchronous and can run while the snapshot is being written; those ops are not in the
  snapshot. With the counter at 0, `compactIfDue` stayed idle and, worse, `replaceTree` /
  `restoreSnapshot` skipped the compaction that pins the outgoing tree and then ran
  `deleteOpsThrough(seq)`, so the Recovery snapshot written before an import or restore could miss the
  latest changes. The live tree itself was never affected.
- **Evidence.** `store.test.ts > keeps counting ops appended while a snapshot is being written`
  (gated `putSnapshot`): `compactIfDue` returned `false` and after `replaceTree([])` no snapshot
  contained the late node.
- **Fix.** The counter subtracts only the ops the snapshot covered. Commit `0ba8d6b`.

### 5. LOW - Arbor export import dropped nodes silently on corrupt files

- **Cause.** `parseArborExport` built a `Map` by id and walked from the roots: a duplicate id replaced
  the earlier node, and members of a parent cycle were unreachable and vanished from the preview, with
  no warning in either case. Arbor never writes such files; hand-edited or concatenated ones can.
- **Evidence.** `io.test.ts > never drops nodes silently`: cycle file counted 1 of 4 nodes, duplicate
  file 1 of 2, `warnings: []`.
- **Fix.** Duplicates are skipped with a warning; one node of each cycle is lifted to the top level
  (counted in the existing "missing parent" warning) and the rest follow under it. Commit `ecba509`.

### 6. LOW - Options number fields snapped to the clamped value while typing

- **Cause.** Each keystroke was saved immediately; `saveSettings` clamps and the `storage.onChanged`
  echo fed the clamped value back into the controlled input mid-edit.
- **Evidence (Chromium 153, `review-arbor-options.mjs`).** Clear the snapshot interval -> field shows
  `1`; type `10` -> `110`, stored 110. With the backup interval's minimum of 5, typing `10` would give
  `50`. After the fix: `""` while cleared, `10` / 10 stored; `500` stays while typing and clamps to
  120 on blur.
- **Fix.** `NumberField` keeps the draft while focused, commits in-range integers as typed and the
  clamped value on blur. Commit `372f0c4`.

### 7. LOW - Side panel painted "0 nodes, 0 open" / "No windows or tabs yet." before the first tree

- **Evidence (Chromium 153, `review-arbor-panel.mjs`, MutationObserver from the first paint).**
  `{count: "0 nodes, 0 open", empty: "No windows or tabs yet."}` at t=50 ms, then
  `{count: "4 nodes, 3 open", rows: 4}` at t=63 ms. With a cold worker (IndexedDB open + rebuild) the
  window is longer and reads as lost data. After the fix only `Loading...` precedes the tree.
- **Fix.** `state === null && !error` renders a loading header and body. Commit `7318ad1`.

---

## Checked and found correct (evidence, no change)

- **Popup / DevTools windows and event order.** Chromium 153 and Edge 153 both fire
  `windows.onCreated` (type `popup`) before `tabs.onCreated` for `window.open(..., "popup")` and for
  `chrome.windows.create({ type: "popup" })`; no phantom node, no container left behind on close. The
  tracker's lazy window-node creation would also cover the reverse order for normal windows.
- **Last tab dragged / moved into a new window.** Order is `windows.onCreated(new)`,
  `tabs.onDetached`, `tabs.onAttached`, `windows.onRemoved(old)` in both browsers; the node stays one
  live node and the emptied untitled container is pruned.
- **`tabs.onReplaced`** is handled (`handleTabReplaced`, with a record-less fallback) and wired in
  `bindTrackerEvents`.
- **Worker death with the panel open.** After CDP `stopWorker` the panel's port reconnects (800 ms
  retry), receives the fresh state and keeps showing tab updates and new tabs; no duplicates after two
  restarts (Chromium and Edge).
- **Browser restart with session restore** (`--restore-last-session`): Chromium restored both windows
  before the worker's first rebuild; the URL-overlap match re-bound both containers
  (`windowsMatched: 2, tabsMatched: 5`), no duplicates.
- **Rebuild idempotency.** A second `rebuild()` over an unchanged browser appends 0 ops; migration is
  idempotent; the op log does not grow on worker restarts.
- **Compaction correctness.** Snapshot seq and node list are taken in the same synchronous block, so
  snapshot + replayed tail equals the live tree; ops flushed after the snapshot with seq <= snapshot
  seq are excluded on open and deleted by the next compaction.
- **`closeAllAndSave`** appends every save op and `compact(true)`s before closing a single tab.
- **Merge import of 10k nodes** takes ~0.55 s in the memory store.
- **New-tab pages.** Chromium `chrome://newtab/` and Edge `edge://newtab/` are both dropped on close
  (`isBlankUrl`). A blank tab that has children (Chromium set the panel tab's opener to the active
  new tab) is kept as a saved parent by design.
- **Message handlers** (`runtime.onMessage`, `onConnect`, `alarms.onAlarm`, all tab/window listeners)
  are registered synchronously at the top of `defineBackground`; handlers await `ready`.
- **Manifest and bundle.** Permissions are exactly `tabs, storage, unlimitedStorage, sidePanel,
alarms, favicon` + `api.lemonsqueezy.com`; `windows.*` needs none; no `tabGroups`, `sessions`,
  `downloads`, `identity` or `scripting` calls in the output; files are saved through an anchor
  download; no `eval` / `new Function`.

## Unconfirmed suspicions (no code changed)

- **Windows restored after the first rebuild.** If the browser restores a session window seconds
  after the worker's `rebuild()`, `windows.onCreated` / `tabs.onCreated` create a fresh untitled
  container instead of URL-matching the now-unbound one, and the +30 s resync will not merge them
  (both containers verify by id). Result would be a saved copy of the window next to the live one.
  Not reproduced: Chromium restored before the rebuild in every run. Hardening idea: in the startup
  window, `handleWindowCreated` could adopt an unbound container whose saved urls overlap the new
  window's tabs, or the resync could fold a freshly created untitled container into an unbound one
  with identical urls.
- **Flush failure has no timer-based retry.** After a failed `appendOps` the batch is re-queued but
  the next attempt waits for the next `append()` or a due compaction (alarm every minute, due after
  the interval). A worker killed in between loses those ops; the tree state itself self-heals on the
  next rebuild, only user edits (rename, note, move) in that window would be lost. Not reproduced.
- **Durability window of ~250 ms** (`flushDelayMs`) between a user edit and its IndexedDB write; the
  panel gets its reply before the write. Same self-healing argument; not treated as a bug.
- **Incognito windows.** `LiveWindow.incognito` is captured and never used; if the user allows Arbor
  in incognito (spanning mode), incognito tabs are mirrored and their urls persisted in IndexedDB and
  in exports/backups. Product and privacy decision; recommend treating incognito windows like popups
  (not tracked) or at least never saving their nodes.
- **A user group titled exactly "Window"** is renamed to the empty title by `migrationOps` on the next
  rebuild, which makes it prunable when empty and "browser-made" for matching. Only that literal title.
- **URL-overlap matching can bind a user's titled group** when it is the only container overlapping a
  restored window (e.g. after an import followed by a restart). Consistent with the README's ranking
  (bound / live / untitled win ties); noted because the group's other saved tabs then read as closed
  tabs of an open window.
- **Pinned tabs and `tabs.move` clamping.** Dropping a pinned tab node below unpinned tabs asks Chrome
  for an index it clamps; the following `onMoved` re-mirrors the strip, so the drop appears to snap
  back. Consistent, not verified in a real browser.
- **Legacy `group` kind inside persisted history steps** (`storage.session`) is not coerced. Cannot
  survive an extension update (session storage is cleared), so no path to it.
- **`withStores` with a synchronously throwing `fn`** would leave the transaction promise's rejection
  unhandled. All callers issue plain `put`/`delete`/`get` with valid keys; theoretical.
- **Tabs Outliner separator lines** import as empty containers titled "Group" (the `separator` role
  maps to a group). Harmless clutter; a product decision whether to drop them or turn them into notes.
- **`closeAllAndSave`** leaves the old containers unbound and creates a new untitled bound container
  holding the keep-alive `about:blank` tab, so the tree gains a "Window / about:blank" pair until that
  window closes. Documented behaviour ("marks everything saved first"); noted for UX.
- **Firefox.** The `favicon` permission is unknown there (warning only) and there is no
  `sidebar_action`; the toolbar button opens the options page. Stretch goal per README; not tested.

## Notes and suggestions (out of scope for this pass)

- `repro-dnd.mjs` in the pw tools still expects a `row--group` class; since 0.1.4 groups are
  `window` rows, so its first assertions fail for the wrong reason. Update it before reusing.
- Import merge appends all nodes in 500-op chunks; a failure in a later chunk would leave earlier
  chunks applied. Ids are fresh so this cannot happen today; a single `append` (all-or-nothing) would
  make it structural.
- `history.create` labels a new container "group"; with the unified model the toast reads
  "Added new group" for something the UI otherwise calls a closed window. Wording only.
