# Arbor — tree-style tab & session manager

Store slot 1. Paid from day one (free tier + $15 one-time Pro).

## Why it exists

Tabs Outliner (100K users, $15 Pro) still ships, but 2026 reviews report randomly deleted trees,
blank windows after crashes, backups that silently stop, and licences tied to one Google account.
Arbor's entire pitch is: **it never loses your tabs**, and it imports your Tabs Outliner backup.

## Scope (Phase 3)

Free:

- Side panel showing live windows → tabs as a tree; saved (closed) nodes persist in the same tree.
- Drag-and-drop reorder/nest; notes on any node; search; close-and-save a tab, window or subtree;
  restore a node (opens in place); "close everything and save" panic button.
- Crash safety: IndexedDB append-only operation log + periodic compacted snapshots; on startup,
  replay/verify; a **Recovery** screen listing every snapshot with node counts and one-click restore.
- Manual export/import (JSON). Importer for Tabs Outliner's `onViewClose_lastSessionSnapshot` JSON
  (recover it via their extension page console; document the steps in the importer UI) and for
  Tabs Outliner's exported tree files.
- Keyboard basics: arrow navigation, Enter to focus/restore, Delete to close.

Pro (gated via `@browserforge/licensing`, feature ids: `scheduled-backups`, `drive-backup`,
`power-keys`, `multi-profile`):

- Scheduled local backups (every N minutes, rolling retention) downloadable as files.
- Planned, not shipped, and therefore not advertised as Pro in the UI (listed under "Planned" in
  Options): Google Drive backup via `chrome.identity` (optional permission requested on enable;
  hidden behind `DRIVE_BACKUP_ENABLED = false` in `src/lib/pro.ts` and absent from the manifest
  until it works) and power keyboard/clipboard commands (multi-select, cut/paste subtrees, copy as
  Markdown/HTML list).

## Data model

```ts
type NodeId = string; // nanoid-style, generated locally
interface TreeNode { id: NodeId; parentId: NodeId | null; kind: "window" | "tab" | "note";
  title: string; url?: string; favIconUrl?: string; note?: string; collapsed?: boolean;
  liveTabId?: number; liveWindowId?: number; createdAt: number; updatedAt: number; order: number }
interface Op { seq: number; ts: number; type: "add" | "update" | "move" | "remove"; ... }
interface Snapshot { seq: number; ts: number; nodes: TreeNode[]; nodeCount: number }
```

**Containers.** There is one container kind, `window`. A container is _bound_ while
`liveWindowId` points at an open browser window and _unbound_ otherwise. What the UI calls a
group is an unbound container with a user title; a window the browser opened is a bound
container with an empty title (rendered as "Window"). Behaviour follows the state, not a kind:

- "Reopen all" on an unbound container opens it as a new browser window: its closed tabs open
  there in tree order, tabs of the container still open elsewhere are moved in (`tabs.move`),
  and the container is bound to that window. Nested containers are windows of their own and are
  not recursed into.
- "Reopen all" on a bound container reopens its closed tabs into that window at their tree
  positions.
- Closing a bound container's window leaves it unbound with its tabs saved in place. Only an
  untitled, note-less, childless container is pruned; anything the user named or annotated stays.
- Dragging a live tab under an unbound container is a tree-only move (the browser tab stays where
  it is, "detached" from strip ordering) until that container is opened as a window.

Compatibility: trees, op logs, backups and exports written before 0.1.4 used a separate `group`
kind and titled browser windows "Window". `coerceNode` reads `group` as `window` wherever it
appears, and `migrationOps` (run on every rebuild, idempotent, logged as ordinary ops) turns the
old default title into the empty title. The export format is version 2; version 1 files import
unchanged.

Persistence lives in `src/lib/store/` behind an interface so tests use an in-memory adapter; the
IndexedDB backend is `src/adapters/indexeddb-store.ts`. See `docs/ARCHITECTURE.md` for the layers
and the module map of the tracker (`src/lib/sync/`).

## Licensing

Pro is a $15 one-time Lemon Squeezy licence, handled by `@browserforge/licensing` through
`src/adapters/licensing.ts` (build-time config in `src/lib/licensing-config.ts`). The store and
variant ids are baked in at build time from WXT env vars (see
`.env.example`: `WXT_LEMONSQUEEZY_STORE_ID`, `WXT_LEMONSQUEEZY_VARIANT_ID_ARBOR`, optional
`WXT_LEMONSQUEEZY_CHECKOUT_URL_ARBOR`). Without them the build still works: Pro gates stay closed
and the options page shows a neutral "Pro purchases are opening soon" note (the developer-facing
"Licensing not configured" wording only appears in dev builds). The background schedules
revalidation via `chrome.alarms`; the options page hosts the activate / deactivate dialog.

## Constraints

- Permissions stay as declared in `wxt.config.ts` (`tabs`, `storage`, `unlimitedStorage`,
  `sidePanel`, `alarms`, `favicon`); every one is used by shipped code. The optional `identity`
  permission returns only together with a working Drive upload. `host_permissions` covers only
  `https://api.lemonsqueezy.com/*` for the licence check.
- No remote code, no analytics. The only network call in the whole extension is the licence check.
- Must run in Chrome and Edge; Firefox build should compile (side panel → sidebar_action fallback is
  a stretch goal).
