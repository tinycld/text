# text

Plain-text and rich-text documents.

Feature package for the [tinycld](https://tinycld.org/) ecosystem. Lives as a standalone git repo alongside the [`tinycld`](https://tinycld.org/) app shell and other sibling feature packages (`contacts`, `mail`, `calendar`, `drive`, `calc`, `google-takeout-import`). `@tinycld/core` is the shared runtime/UI library, nested inside the `tinycld` shell repo at `tinycld/core/` and imported as `@tinycld/core`.

## What it does

Stores documents as `.docx` files in `@tinycld/drive` and edits them
collaboratively. Documents open from the drive UI (text registers a docx
preview + an "Open in Text" file action) or from the dedicated
`/a/<org>/text` index. The editor is a ProseMirror instance (hosted in a
WebView on native, inline on web) backed by a Yjs document.

Editing features:

- Rich-text formatting (bold / italic / underline / strike, headings,
  alignment, indent, code, lists)
- Font family and font size pickers; text color and highlight
- Tables with cell shading and per-edge borders, plus a `TableMenu`
  for structural ops
- Inline images (paste / drag-drop / file picker), with resize and
  text-wrap modes (inline, left, right, break)
- Threaded comments anchored to selections (`NewCommentModal`,
  `TextCommentDrawer`, `useDocumentComments`)
- @-mentions of org members (`useMentionSuggestions`)
- Slash menu (`SlashMenu`) for block-level insertions; link popover
  (`LinkPopover`) for inline link editing
- New from template — picks a Drive docx template and copies its bytes
  into a fresh doc (`@tinycld/drive`'s `TemplatePickerDialog` +
  `useHasTemplates`; a template is just a Drive `.docx`)
- Markdown import and export — **Edit → Paste as Markdown** parses the
  clipboard as Markdown and inserts structured content; **File →
  Download (.md)** saves the document as Markdown alongside the
  canonical `.docx` (`lib/markdown/`)
- Manual version snapshots — **File → Save version** flushes the
  current Y.Doc to a labeled `drive_item_versions` row so a named
  state can be restored later. Each row stores both the canonical
  `.docx` blob and the raw Yjs snapshot, so a restore round-trips
  suggestions and authorship metadata losslessly.
- Find and replace (`FindReplaceBar`) — open via ⌘F on web or via
  **Edit → Find…** on iOS / Android (the bar is wired on every platform;
  the ⌘F shortcut binding is web-only)
- Undo / redo via Y.UndoManager
- Print (browser print on web, iOS print sheet on iPad)
- Live presence — peer cursors and selections through Yjs awareness
- Document context menu and File menu actions (rename, make a copy,
  share, move to trash, details) via `useDocumentFileActions` and
  drive's `ShareDialogConnected`
- Save status indicator and reconnecting indicator wired to the
  realtime room's state
- Word count badge
- Landing panel (`No-File panel`) — when the workspace has no
  last-opened doc, the rail surfaces **New document** / **Upload
  files** / **Recent files**; otherwise the rail deep-links straight
  back to the most recent doc
- Keyboard shortcuts (full list in the in-app help topic
  `text:keyboard-shortcuts`)

Change tracking (Google-Docs-style):

- **Editor mode dropdown** (`EditorModeMenu`) — toggle the editor
  between **Editing** / **Suggesting** / **Viewing**. Viewing is always
  available; Editing and Suggesting are gated by the live drive_share
  role through `use-suggestion-permissions`. The non-Editing modes
  light up the dropdown trigger in the primary accent color so the
  writer can see at a glance their edits aren't behaving like normal
  edits.
- **Suggesting marks** — inline inserts (`SuggestedInsert`), deletes
  (`SuggestedDelete`), block-level changes (`SuggestedBlockChange`),
  format changes (`SuggestedFormatChange`), and a `SuggestedTable`
  family that captures cell additions, removals, and reshapes. Each
  suggestion carries an `authorId` and `ts` so the renderer can
  per-author-color and attribute it.
- **Review drawer** (`ReviewDrawer`, `OpenReviewDrawerButton`) — opens
  alongside the editor with three tabs:
    - **Suggestions** — anchored and orphaned suggestions, per-row
      Accept / Reject, **Accept all** / **Reject all** across every
      open suggestion, click-to-focus that scrolls the editor to the
      suggestion's range and highlights it (`click-to-focus.ts`)
    - **Activity** — reverse-chronological feed of edit events
      (60-second debounced windows of free typing) and resolved
      suggestion decisions, gated behind audience-presence (the log
      only fills while at least one collaborator is in the room with
      the writer)
    - **Authorship** — per-author bar chart of who wrote how much, plus
      a "Color text by author" toggle that paints every run in its
      author's color through a ProseMirror decoration plugin
- **Threaded discussion per suggestion** (`SuggestionThread`,
  `SuggestionThreadSheet`, `SuggestionReplyComposer`) — every
  suggestion can have a back-and-forth reply thread, stored in the
  same `text_comments` collection that powers regular comments and
  cleaned up by `suggestion_discussion_cleanup.go` when the suggestion
  resolves.
- **docx round-trip** — `<w:ins>` / `<w:del>` runs and tracked
  block/format changes are translated both directions by
  `server/translate/suggestion_*.go`, so a suggestion authored in
  tinycld survives a download → reupload through Word and vice versa.
- **Server-stamped authorship** — the realtime broker rejects client
  frames that touch reserved Y.Doc roots (`clientAuthors`,
  `clientFirstSeen`, `editEvents`); only the server stamps authorship
  metadata, so a malicious client can't forge who wrote what.

Text depends on `@tinycld/drive` — the `drive_item` row is the document's
identity, drive's share rules govern who can open the room, and the
docx blob attached to the drive_item is the source of truth that
survives across sessions.

## Theory of operations

The short version: every document is a Yjs `Y.Doc` mirrored on the
client and server; clients send CRDT update bytes to the server over a
WebSocket; the server appends each update to a SQLite-backed
write-ahead log before applying it; periodically (or when the last
client leaves) the server serializes the doc to `.docx` and writes the
bytes back onto the drive_item's `file` field.

```
┌──────────────────────────────────────────────────────────────────────┐
│  Client (React Native / web)                                         │
│                                                                      │
│   DocumentToolbar / MenuBar / FindReplaceBar / TextCommentDrawer     │
│                       │                                              │
│                       ▼                                              │
│   ProseMirror editor  ──  y-prosemirror bridge                       │
│   (WebView on native, inline on web)                                 │
│                       │                                              │
│                       ▼                                              │
│   Y.Doc  (XmlFragment for body, awareness, undo manager)             │
│                       │                                              │
│                       ▼                                              │
│   @tinycld/core useRealtimeRoom  ── WebSocket ──┐                    │
└─────────────────────────────────────────────────┼────────────────────┘
                                                  │
┌─────────────────────────────────────────────────┼────────────────────┐
│  Server (Go, PocketBase + tinycld.org/core)     │                    │
│                                                 ▼                    │
│   core/realtime  broker  (roomKind "text-doc")                       │
│        │                                                             │
│        │  every accepted MsgDocUpdate:                               │
│        │    1. Append(seq, bytes) to Journal  ── WAL row             │
│        │    2. ApplyUpdate to server-side ycrdt.Doc                  │
│        │    3. fan out to other peers                                │
│        ▼                                                             │
│   Runtime  (per-room server-side ycrdt.Doc; same shape as TS)        │
│        │   ▲                                                         │
│        │   │  bootstrapHook: on first open, parse docx blob and      │
│        │   │  seed Y.Doc BEFORE SyncReply; then Replay() folds       │
│        │   │  any un-truncated WAL rows back on top                  │
│        │   │  ┌────────────────────────────────────────────────┐     │
│        │   └──┤ drive_items.file  (docx blob in PocketBase)     │    │
│        │      └────────────────────────────────────────────────┘     │
│        ▼                                                             │
│   SaveCoordinator  (debounce 3s, ceiling 15s, teardown 30s)          │
│        │                                                             │
│        ▼                                                             │
│   flush: Y.Doc → ProseMirror JSON → doctaculous → .docx bytes →      │
│          drive_items.file → Journal.Truncate(throughSeq)             │
└──────────────────────────────────────────────────────────────────────┘
```

### Y.Doc is the wire format

The wire format and the in-memory format are the same: a Yjs document
that both the client (`yjs`) and the server
(`github.com/skyterra/y-crdt`) instantiate byte-for-byte. The body lives
in a single `Y.XmlFragment` shaped to ProseMirror's schema by
`y-prosemirror`. Awareness (cursor positions, selection ranges, peer
presence) rides on a separate `y-protocols/awareness` channel through
the same WebSocket.

The client package has no docx parser at all — `doctaculous` (the
docx ↔ ProseMirror translator under `server/translate/`) is a Go-only
dependency. Bootstrapping is always server-side so the wire shape every
joiner sees is canonical regardless of join order: there is no "first
joiner parses docx, everyone else syncs from peer" race, and a peer
dropping mid-edit doesn't strand the next joiner with stale state.

### Realtime room lifecycle

Text registers itself as a `realtime.RoomKind` named `"text-doc"` (see
`server/register.go`). For each `drive_item.id` clients reach via
`useRealtimeRoom({ roomKind: 'text-doc', roomID: driveItemID, … })`:

1. **Authorize** — the room rejects clients without a `drive_shares`
   row linking them to the item. The role on that row also drives the
   `readOnly` flag in `MsgServerHello` (viewer ⇒ read-only; missing /
   unresolvable role ⇒ fail closed).
2. **Bootstrap** — on first open, `Runtime.NewDoc` invokes the
   bootstrap hook, which loads `drive_items.file`, parses the docx
   via `translate.DocxToPMJSON`, and seeds the `Y.Doc` with
   `translate.SeedFromPMJSON` — synchronously, before the broker
   sends `SyncReply`. Empty / missing files seed nothing; the first
   edit and subsequent flush materialize a docx from scratch.
3. **WAL replay** — immediately after bootstrap, the broker calls
   `Journal.Replay` for this `(text-doc, roomID)` and folds every
   un-truncated update from the previous server lifetime back into
   the doc, in seq order. This is what makes edits that arrived
   between the last successful flush and a server crash survive.
4. **Updates** — every accepted `MsgDocUpdate` is `Journal.Append`'d
   under a freshly minted, strictly-monotonic per-room seq, then
   `ycrdt.ApplyUpdate`'d into the server's doc, then fanned out to
   other peers. Append precedes apply: if the WAL write fails the
   update is rejected rather than silently lost.
5. **Save** — the `SaveCoordinator` watches doc updates and triggers a
   flush on a 3-second debounce, a 15-second ceiling, or a 30-second
   teardown when the last client leaves. Failures retry with
   exponential backoff (1s, 2s, 4s, 8s, 16s, 30s cap).
6. **Truncate** — once a flush completes, the coordinator calls
   `Journal.Truncate(throughSeq)` with the highest seq it observed at
   flush start, dropping WAL rows whose state is now reflected in the
   docx blob.

### How core's WAL provides durability

The journal is core's, not text's. Core exports a `Journal` interface
(`core/realtime/journal.go`) with three operations:

```go
type Journal interface {
    Append(kind, id string, seq int64, update []byte) error
    Replay(kind, id string, apply func(seq int64, update []byte) error) error
    Truncate(kind, id string, throughSeq int64) error
}
```

Text uses the production implementation, `PocketBaseJournal`
(`core/realtime/journal_pocketbase.go`), which stores each update as a
row in the `realtime_doc_updates` PocketBase collection — created by a
core migration. The collection lives in the same SQLite database as
the rest of the app, so writes are durable against SIGKILL via
SQLite's WAL journal-mode `fsync`. The `update` column is
base64-encoded so the raw CRDT bytes survive PocketBase's text-field
encoding; the `(room_kind, room_id, seq)` index is unique so a
duplicate-seq write is a programming bug rather than a silent
overwrite.

The contract is:

- The broker serializes `Append` calls per `(kind, id)` (one
  goroutine per room route path), so seq monotonicity is the
  broker's responsibility, not the journal's.
- A failed `Append` aborts the apply — the in-memory doc and the
  on-disk WAL never diverge.
- A failed `Replay` aborts room bootstrap entirely; the alternative
  (silently dropping rows we can't decode) would let stale state
  leak back into the doc.
- `Truncate` with a `throughSeq` ≤ the current floor is a no-op,
  which keeps the post-flush bookkeeping idempotent under retries.

The cascade hook at the bottom of `Register` (in `server/register.go`)
calls `Journal.Truncate(roomKind, driveItemID, math.MaxInt64)` when a
`drive_items` record is deleted, so a deleted document's WAL rows
don't linger.

### Worst-case durability window

During steady-state typing the WAL is the durability surface — every
keystroke (technically every Y.Doc update bundle) is `fsync`'d before
the broker acknowledges it. Between flushes, the docx blob in
`drive_items.file` lags by up to `DefaultCeilingInterval` (15s) of
continuous editing, but the in-flight WAL has every byte. After a
server crash, the next client to open the room sees:

1. The bootstrap parses the last-saved docx into the new Y.Doc.
2. `Replay` folds every un-truncated WAL row on top, in seq order.
3. The `SyncReply` reflects the union — nothing is lost.

The only window where edits can disappear is a `Journal.Append` write
that fsync's *but* the corresponding flush completed *and* the
following `Truncate` partially applied before the crash. The truncate
contract (delete-where-seq-≤-N as a single SQLite statement) makes
this effectively impossible at the row level; the worst observed
recovery state is "some WAL rows the doc has already absorbed get
replayed again", which Yjs handles as a no-op via CRDT idempotence.

### docx serialization

Flush translates the Y.Doc to ProseMirror JSON
(`translate.PMJSONFromYDoc`), then runs it through doctaculous
(`translate.PMJSONToDocx`) to produce docx bytes, then writes those
bytes onto `drive_items.file`. doctaculous's `NumberingManager` is a
process-global singleton, so concurrent flushes across rooms are
serialized inside the `translate` package via `numberingMu`; the
flush wrapper also installs a deferred `recover` because doctaculous
has historically panicked on malformed inputs, and the
SaveCoordinator's retry path handles errors much better than a dead
broker goroutine.

PocketBase renames the on-disk blob to a fresh hash on every save, so
the prior version of the docx isn't overwritten in place — if a
flush goes wrong, the previous blob is still on disk until PB's
cleanup runs.

### Comments and mentions

Comments are not in the `Y.Doc`. They live in a regular PocketBase
collection, `text_comments`, one row per thread root or reply. The
editor subscribes via `useDocumentComments` with `useOrgLiveQuery`;
mutations go through `useMutation`. Mentions resolve through
`useMentionSuggestions` against the org's user list.

## Platform support

| Feature                            | Web | Native (iOS / Android) |
|------------------------------------|-----|------------------------|
| Open / view documents              | ✅  | ✅ (WebView host)      |
| Edit                               | ✅  | ✅                      |
| Realtime collaboration             | ✅  | ✅                      |
| Tables (insert, shading, borders)  | ✅  | ✅                      |
| Inline images (insert)             | ✅  | ✅                      |
| Inline images (wrap / resize)      | ✅  | ✅ [^image-mobile]      |
| Comments                           | ✅  | ✅                      |
| Mentions                           | ✅  | not yet                |
| Templates                          | ✅  | ✅                      |
| Alignment + indent / outdent       | ✅  | ✅                      |
| Font family / font size            | ✅  | ✅                      |
| Inline code + code block           | ✅  | ✅                      |
| Cell shading                       | ✅  | ✅                      |
| Slash menu                         | ✅  | ✅                      |
| Find / replace                     | ✅  | ✅                      |
| Word count                         | ✅  | ✅                      |
| Suggesting mode (track changes)    | ✅  | ✅                      |
| Review drawer (suggestions tab)    | ✅  | ✅                      |
| Activity tab (edit timeline)       | ✅  | ✅                      |
| Authorship coloring                | ✅  | ✅                      |
| Print                              | browser print | iOS print sheet |

The native editor runs inside a WebView hosting the same ProseMirror
build under `webview-editor/`. The Yjs document and WebSocket live in
the native (RN) layer; bridge messages keep the editor view and the
doc in sync.

[^image-mobile]: Native uses a bottom-sheet anchored to the selected
    image (wrap mode chips + S / M / L / Original size presets) rather
    than the desktop's drag handles. See the `text:image-on-mobile`
    help topic.

## Package layout

```
text/
    manifest.ts             package manifest
    pb-migrations/          text_comments + related schema
    help/                   in-app help topics (markdown + frontmatter)
    server/                 Go server module — bootstrap, flush, WAL hook
        register.go         realtime + cascade-truncate registration
        runtime.go          per-room ycrdt.Doc registry + janitor
        bootstrap.go        docx → Y.Doc on first open
        flush.go            Y.Doc → docx → drive_items.file
        authorize.go        drive_shares-based access
        suggestions_authz.go            per-frame validator: reject
                                        client writes to server-owned
                                        authorship roots
        suggestion_discussion_cleanup.go  drop reply threads when their
                                          suggestion resolves
        translate/          doctaculous docx ↔ ProseMirror JSON, plus
                            suggestion_marks, format_change_marks,
                            suggestions_part — full round-trip of
                            <w:ins>/<w:del>/tracked block changes
        wal_e2e_test.go     end-to-end WAL replay / truncate / cleanup
    tinycld/text/           TypeScript source
        provider.tsx        registers DocumentPreview + drive actions
        screens/            index + [id]
        components/         toolbar, menubar, popovers, dialogs
            menubar/        File/Edit/Format/Insert/Help menus
            suggestions/    ReviewDrawer (Suggestions/Activity/Authorship),
                            SuggestionThread, SuggestionRow,
                            OpenReviewDrawerButton, AuthorshipPopover
            comments/       NewCommentModal, NewCommentButton,
                            OpenCommentsDrawerButton, TextCommentDrawer
            EditorModeMenu  Editing / Suggesting / Viewing toggle
        hooks/              use-document-editor (.web / .native), useTextRoom,
                            use-document-suggestions, use-suggestion-bridge,
                            use-suggestion-permissions, use-resolve-suggestion,
                            use-activity-entries, use-client-authors, …
        stores/             editor-mode-store, review-drawer-store,
                            authorship-display-store
        lib/                editor config, find/replace, image handling
            suggestions/    build-extensions, command-layer, decorations,
                            block/format/table change utils, bulk-resolve,
                            click-to-focus, discussions, resolve,
                            session-grouping, suggestions-map
            authorship/     aggregate-contributors, decoration plugin glue
            markdown/       md-to-pm, pm-to-md
        webview-editor/     ProseMirror build hosted by the native editor
                            (includes suggested-* extensions + authorship
                             decoration plugin)
        collections.ts, types.ts
        tests/              vitest unit tests (including suggestions/)
```

Go module: `tinycld.org/packages/text`. Imports `tinycld.org/core/realtime`
through the standard go.mod replace directive the app shell installs.

## Development

```sh
# Clone the app shell and this package as siblings
cd ~/code/tinycld
git clone git@github.com:tinycld/tinycld.git
git clone git@github.com:tinycld/text.git

# Install deps in the app shell
cd tinycld
pnpm install

# Link this package (and its dependency, @tinycld/drive) into the app shell
pnpm run packages:link ../drive
pnpm run packages:link ../text

# Run the full stack
pnpm run dev
```

## Standalone checks

Lint and typecheck both run from the app shell — biome and TypeScript live
there, and the app shell's tsconfig pulls in `expo`'s base config, `uniwind`
type augments, and the live `~/types/pbSchema` generated from PocketBase,
none of which a standalone invocation in this package can see. Biome's
config lives in `tinycld/biome.json` and applies to every linked package
(there is no `biome.json` in this repo).

```sh
cd ../tinycld
pnpm run packages:link ../text    # only needed once per checkout
pnpm run lint                     # scans this package via the app's biome rules
pnpm run typecheck                # full app-shell tsc
pnpm run test:unit                # vitest, including this package's tests/
pnpm run test:go                  # go test on this package's server/
```

## CI

`.github/workflows/ci.yml` runs lint, typecheck, and vitest on every push to
`main` and every PR. It clones `tinycld/tinycld@main` into a sibling
directory, installs the app shell's deps, links this package in, and runs
the checks — exactly what a developer does locally.

## Package anatomy

- `manifest.ts` — single source of truth for capabilities
- `package.json` — name, exports map, peer deps
- `tsconfig.json` — typecheck config (lint config lives in the app shell's `biome.json`)
- `tests/` — vitest unit tests
