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
- Google Drive backup via `chrome.identity` (optional permission, requested on enable).
- Power keyboard/clipboard: multi-select, cut/paste subtrees, copy as Markdown/HTML list.

## Data model

```ts
type NodeId = string; // nanoid-style, generated locally
interface TreeNode { id: NodeId; parentId: NodeId | null; kind: "window" | "tab" | "group" | "note";
  title: string; url?: string; favIconUrl?: string; note?: string; collapsed?: boolean;
  liveTabId?: number; liveWindowId?: number; createdAt: number; updatedAt: number; order: number }
interface Op { seq: number; ts: number; type: "add" | "update" | "move" | "remove"; ... }
interface Snapshot { seq: number; ts: number; nodes: TreeNode[]; nodeCount: number }
```

Persistence lives in `src/lib/store/` behind an interface so tests use an in-memory adapter.

## Licensing

Pro is a $15 one-time Lemon Squeezy licence, handled by `@browserforge/licensing` through
`src/lib/licensing.ts`. The store and variant ids are baked in at build time from WXT env vars (see
`.env.example`: `WXT_LEMONSQUEEZY_STORE_ID`, `WXT_LEMONSQUEEZY_VARIANT_ID_ARBOR`, optional
`WXT_LEMONSQUEEZY_CHECKOUT_URL_ARBOR`). Without them the build still works: Pro gates stay closed
and the options page shows "Licensing not configured". The background schedules revalidation via
`chrome.alarms`; the options page hosts the activate / deactivate dialog.

## Constraints

- Permissions stay as declared in `wxt.config.ts`; `identity` is optional and requested at runtime.
  `host_permissions` covers only `https://api.lemonsqueezy.com/*` for the licence check.
- No remote code, no analytics. The only network call in the whole extension is the licence check.
- Must run in Chrome and Edge; Firefox build should compile (side panel → sidebar_action fallback is
  a stretch goal).
