# text

Plain-text and rich-text documents.

Feature package for the [tinycld](https://tinycld.org/) ecosystem. Lives as a standalone git repo alongside the [`tinycld`](https://tinycld.org/) app shell and other sibling feature packages (`contacts`, `mail`, `calendar`, `drive`, `calc`, `google-takeout-import`). `@tinycld/core` is the shared runtime/UI library, nested inside the `tinycld` shell repo at `tinycld/core/` and imported as `@tinycld/core`.

## What it does

Stores documents as `.docx` files in `@tinycld/drive` and edits them
collaboratively. Documents open from the drive UI (text registers a docx
preview + an "Open in Text" file action) or from the dedicated
`/a/text` index. The editor is a ProseMirror instance (hosted in core's
pooled editor WebView on native, inline on web) backed by a Yjs document.

Editing features:

- Rich-text formatting (bold / italic / underline / strike, headings,
  alignment, indent, code, lists)
- Responsive toolbar (`DocumentToolbar` on core's `ResponsiveToolbar`)
  — on both platforms, whatever doesn't fit the width folds into a
  **More** menu; the pickers and the table menu become submenus there
- Collapsing document header — the title and the comments-drawer
  button always stay; presence avatars, save status, word count, and
  the reconnecting indicator drop one by one as width runs out
- Font family and font size pickers; text color and highlight
- Tables with cell shading and per-edge borders, plus a `TableMenu`
  for structural ops
- Inline images (paste / drag-drop / file picker), with resize and
  text-wrap modes (inline, left, right, break)
- Threaded comments anchored to selections (`NewCommentModal`,
  `TextCommentDrawer`, `useDocumentComments`)
- @-mentions of other users on the server (`useMentionSuggestions`)
- Slash menu (`SlashMenu`) for block-level insertions; link popover
  (`LinkPopover`) for inline link editing
- New from template — picks a Drive docx template and copies its bytes
  into a fresh doc (`@tinycld/drive`'s `TemplatePickerDialog` +
  `useHasTemplates`; a template is just a Drive `.docx`)
- Markdown import and export — **Edit → Paste as Markdown** parses the
  clipboard as Markdown and inserts structured content; **File →
  Download (.md)** saves the document as Markdown alongside the
  canonical `.docx` (`lib/markdown/`)
- PDF export — **File → Download (.pdf)** renders the stored `.docx`
  to PDF on the server through drive's `exportItem` (`FileMenu`); like
  **Download (.docx)** it reflects the last flushed state, not
  unflushed keystrokes
- Manual version snapshots — **File → Save version** flushes the
  current Y.Doc to a labeled `drive_item_versions` row so a named
  state can be restored later. When the room is live the row stores
  both the canonical `.docx` blob and the raw Yjs snapshot, so a
  restore round-trips suggestions and authorship metadata. Snapshot and
  restore both no-op gracefully on a dormant room — no `yjs_state` is
  written, and the protected roots (authorship, edit events) are not
  recovered.
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
  and format changes (`SuggestedFormatChange`). Table changes (cell
  additions, removals, and reshapes) are a `TableChange` type
  (`lib/suggestions/table-change-utils.ts`) that rides on
  `SuggestedBlockChange` node attributes. Each suggestion carries an
  `authorId` and `ts` so the renderer can per-author-color and
  attribute it.
- **Review drawer** (`ReviewDrawer`, `OpenReviewDrawerButton`) — opens
  alongside the editor with three tabs:
    - **Suggestions** — open anchored suggestions in document order,
      per-row Accept / Reject, **Accept all** / **Reject all** across
      every open anchored suggestion (shown only to users who can
      resolve), click-to-focus that scrolls the editor to the
      suggestion's range and highlights it (`click-to-focus.ts`).
      Orphaned suggestions (map entries whose marks left the doc) are
      deleted by the suggestion bridge and never listed.
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

## Automation rules

Text contributes one trigger to the ecosystem-wide automation-rule
engine, and no actions:

- **`text:comment-added`** — "A comment is added to a document", fired
  on `text_comments` create. Exposed fields: `body` (labelled
  "Comment"), `quoted_text`, `author_name` (labelled "Commenter"), and
  `drive_item` (labelled "Document").

The trigger fires when *anyone* comments on a document the rule owner
can see — not only when the owner comments. That is a deliberate
design choice. The trigger declares **no** `ownerField`: an `author`
field would auto-detect and scope the rule to the commenter ("when I
comment"), which is backwards. Instead `text/server/automation.go`
registers a `commentOwnerResolver` that delegates to core's
`driveshare.ParticipantIDs`, so the rule fires for every participant on
the document. It delegates rather than re-deriving the sharing rules
because a second copy would drift, and an over-reporting resolver would
fire other users' rules on documents they cannot see.

Contrast this with drive's `drive:mentioned-in-comment` trigger, which
fires only on @-mentions addressed to you and covers documents,
spreadsheets and files alike. This one is broader: every comment on
every document you can reach.

**No actions.** Document content is stored as collaborative Yjs edit
operations rather than as record fields a rule could set, so text
contributes triggers only. A rule that starts from a comment can still
use any action another installed package offers.

The catalog is declared with `automation: { definitions: 'automation' }`
in `manifest.ts` plus a `"./automation"` entry in the `package.json`
exports map; the definitions live in `tinycld/text/automation.ts` and
the Go-side registration in `server/automation.go`. The in-app help
topic is `help/rules.md`.

Docs: [Automation rules](https://tinycld.org/docs/automation-rules)
(users) · [Automation anatomy](https://tinycld.org/docs/anatomy/automation)
(package authors).

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
│        │    1. ApplyUpdate to server-side ycrdt.Doc                  │
│        │    2. fan out to other peers                                │
│        ▼                                                             │
│   Runtime  (per-room server-side ycrdt.Doc; same shape as TS)        │
│        │   ▲                                                         │
│        │   │  Seed: when the broker has no parked document and no   │
│        │   │  matching checkpoint, parse the docx blob and seed the │
│        │   │  Y.Doc BEFORE SyncReply                                │
│        │   │  ┌────────────────────────────────────────────────┐     │
│        │   └──┤ drive_items.file  (docx blob in PocketBase)     │    │
│        │      └────────────────────────────────────────────────┘     │
│        │   ▲                                                         │
│        │   │  checkpoint: full Y.Doc state + epoch + fingerprint,    │
│        │   │  stored at eviction / read-only / drain / terminate     │
│        │   │  ┌────────────────────────────────────────────────┐     │
│        │   └──┤ realtime_doc_checkpoints (core collection)      │    │
│        │      └────────────────────────────────────────────────┘     │
│        ▼                                                             │
│   SaveCoordinator  (debounce 3s, ceiling 15s, teardown 30s)          │
│        │                                                             │
│        ▼                                                             │
│   flush: Y.Doc → ProseMirror JSON → omnidoc → .docx bytes →      │
│          drive_items.file                                            │
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

The client package has no docx parser at all — `omnidoc` (the
docx ↔ ProseMirror translator under `server/translate/`) is a Go-only
dependency. Bootstrapping is always server-side so the wire shape every
joiner sees is canonical regardless of join order: there is no "first
joiner parses docx, everyone else syncs from peer" race, and a peer
dropping mid-edit doesn't strand the next joiner with stale state.

### Realtime room lifecycle

Text registers itself as a `realtime.RoomKind` named `"text-doc"` (see
`server/register.go`). For each `drive_item.id` clients reach via
`useRealtimeRoom({ roomKind: 'text-doc', roomID: driveItemID, … })`:

1. **Authorize** — `makeAuthorize` in `server/register.go` delegates
   to core's `driveshare.CheckRead`: a signed-in user may join iff
   they can read the item (its creator, or the holder of any
   `drive_shares` row). Anonymous share-link visitors are admitted
   through `sharelink.AuthorizeAnonRoom`. The resolved role drives
   the `readOnly` flag in `MsgServerHello` (viewer ⇒ read-only;
   missing / unresolvable role ⇒ fail closed).
2. **Open** — the broker decides where the document comes from. A
   document whose room emptied within the last 30 minutes is still in
   memory (parked) and is reused as is. Otherwise, if a checkpoint is
   stored for the room and its fingerprint still matches the stored
   file, the Y.Doc is rebuilt from that state. Only when neither exists
   does `Runtime.Seed` run the bootstrap hook: load `drive_items.file`,
   parse the docx via `translate.DocxToPMJSON`, seed the `Y.Doc` with
   `translate.SeedFromPMJSON` — all before the broker sends
   `SyncReply`. Empty / missing files seed nothing; the first edit and
   subsequent flush materialize a docx from scratch.
3. **Updates** — every accepted `MsgDocUpdate` is `ycrdt.ApplyUpdate`'d
   into the server's doc, then fanned out to other peers. Nothing is
   written per edit.
4. **Save** — the `SaveCoordinator` watches doc updates and triggers a
   flush on a 3-second debounce, a 15-second ceiling, or a 30-second
   teardown when the last client leaves. Failures retry with
   exponential backoff (1s, 2s, 4s, 8s, 16s, 30s cap). While the server
   is read-only a save is deferred, not failed.
5. **Park** — when the last client leaves, the broker keeps the Y.Doc
   in memory. A reopen within `realtime.ParkIdle` (30 min) lands on the
   SAME document, so a client whose connection blipped merges as a
   no-op and resends only what the server lacks.
6. **Checkpoint** — the broker stores the full Y.Doc state, the
   document's epoch and the stored file's name (the fingerprint) in
   `realtime_doc_checkpoints` when it evicts a parked document, when
   read-only mode begins, at drain and at terminate. The next open from
   that row is the same document incarnation.

### Why the document identity matters

A Y.Doc rebuilt from the docx is a new incarnation: y-crdt mints a fresh
clientID and the seed order is not stable, so every item gets a new
identity even though the text is the same. A client that still holds the
previous incarnation then duplicates the content when it merges, and its
unsent edits reference items the server never had. The parked document
and the checkpoint keep the identities. The epoch names the incarnation:
the broker puts it in every `MsgServerHello`, and core's `useRealtimeRoom`
discards the local doc only when the epoch it synced under changes — a
hard crash, or a file replaced outside the room.

The fingerprint is the stored file's name. Every save writes the file
under a fresh random suffix, so an upload, a version restore or any other
replacement changes it, and the broker then re-seeds from the new file
instead of trusting a stale document.

The cascade hook at the bottom of `registerRealtime` (in
`server/register.go`) calls `realtime.DropRoom` when a `drive_items`
record is deleted, so a deleted document's parked Y.Doc and checkpoint row
don't linger.

### Worst-case durability window

The docx blob in `drive_items.file` lags by up to `DefaultCeilingInterval`
(15s) of continuous editing. Every graceful stop (read-only pause, drain,
terminate) stores the document first and loses nothing. A hard crash
loses at most that window, and the next open re-seeds from the docx under
a new epoch, so clients discard their local copy and resync.

### docx serialization

Flush translates the Y.Doc to ProseMirror JSON
(`translate.PMJSONFromYDoc`), then runs it through omnidoc
(`translate.PMJSONToDocx`) to produce docx bytes, then writes those
bytes onto `drive_items.file`. Each call builds its own omnidoc
`*docx.Document`, so concurrent flushes across rooms need no
serialization; the flush wrapper still installs a deferred `recover`
so a panic on malformed input becomes an error, and the
SaveCoordinator's retry path handles errors much better than a dead
broker goroutine.

PocketBase renames the on-disk blob to a fresh hash on every save, so
the prior version of the docx isn't overwritten in place — if a
flush goes wrong, the previous blob is still on disk until PB's
cleanup runs.

### Comments and mentions

Comments are not in the `Y.Doc`. They live in a regular PocketBase
collection, `text_comments`, one row per thread root or reply. The
editor subscribes via `useDocumentComments` with `useLiveQuery`;
mutations go through core's `useBaseCommentMutations`
(`hooks/use-comment-mutations.ts`). Mentions resolve through
`useMentionSuggestions` against the server's `users` collection (the
current user is excluded; guests can't enumerate the roster).

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
| Mentions (in comment composer)     | ✅  | ✅                     |
| Mentions (in-editor autocomplete)  | not yet | not yet            |
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
| Activity tab (edit timeline)       | ✅  | not yet [^web-only-tabs] |
| Authorship coloring                | ✅  | not yet [^web-only-tabs] |
| Print                              | browser print | iOS print sheet |

The native editor runs inside core's pooled `editor-webview` host
(`@tinycld/core/lib/editor/use-webview-editor`), which loads the same
ProseMirror build under `webview-editor/`. The Yjs document, awareness,
and the realtime WebSocket all live in the native (RN) layer; the page
opens no socket of its own. Doc updates and carets are relayed over
the WebView bridge using the vocabulary in
`webview-editor/source/relay-protocol.ts`, so the WebView is never
handed a credential and one human never shows up as two peers.

[^web-only-tabs]: `ReviewDrawer` shows the Activity and Authorship
    tabs only on web (`Platform.OS === 'web' && yDoc != null`) — the
    edit-events pipeline and the authorship walker aren't wired through
    the WebView bridge yet, so the native drawer is Suggestions-only.

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
    server/                 Go server module — seed, flush, checkpoint wiring
        register.go         realtime + cascade-drop registration
        runtime.go          per-room ycrdt.Doc registry
        bootstrap.go        docx → Y.Doc on first open
        flush.go            Y.Doc → docx → drive_items.file
        oauth_scopes.go     text:read / text:write scope registration
        version_hooks.go    drive VersionHook: manual version snapshots
                            capture / restore the live Yjs state
        suggestions_authz.go            per-frame validator: reject
                                        client writes to server-owned
                                        authorship roots
        suggestion_discussion_cleanup.go  drop reply threads when their
                                          suggestion resolves
        translate/          omnidoc docx ↔ ProseMirror JSON, plus
                            suggestion_marks, format_change_marks,
                            suggestions_part — full round-trip of
                            <w:ins>/<w:del>/tracked block changes
        render/             sanitize.go — text's HTML sanitizer allowlist
                            + RendererVersion for the preview endpoint
        checkpoint_e2e_test.go  end-to-end park / evict / reopen / cleanup
    tinycld/text/           TypeScript source
        provider.tsx        registers TextPreview (registerPreview +
                            registerShareEditor) + drive actions
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
            authorship/     aggregate-contributors, walk-paragraph-authors
            markdown/       md-to-pm, pm-to-md
        webview-editor/     ProseMirror build hosted by core's editor-webview
                            on native (includes suggested-* extensions +
                            authorship decoration plugin in
                            source/authorship/, also used on web)
            source/relay-protocol.ts  message vocabulary for relaying Yjs
                                      updates + carets over the bridge (the
                                      page opens no socket of its own)
        collections.ts, types.ts
        tests/              vitest unit tests (including suggestions/)
```

Go module: `tinycld.org/packages/text`. Imports `tinycld.org/core/realtime`
through the standard go.mod replace directive the app shell installs.

## Command line

Text contributes exactly one command group to the `tinycld` binary:

```sh
tinycld text comments <path>            # list a document's threads
tinycld text comments <path> --add "Needs a citation here"
tinycld text comments <path> --add "Agreed" --reply-to <id>
tinycld text comments <path> --add "..." --quote "the passage"
tinycld text comments <path> --resolve <id>
tinycld text comments <path> --reopen <id>
tinycld text comments <path> --all      # include resolved threads
```

`comment` is accepted as an alias. The group requests the `text:read`
and `text:write` OAuth scopes, which the Go server registers with
core through `oauth.RegisterPackage` (`server/oauth_scopes.go`) —
they cover `text_comments` only; the documents themselves are
governed by drive's scopes.

There is deliberately **no `text new` command.** Documents *are*
`drive_items`, so `tinycld drive put` / `cat` / `get` / `rm` already
create, read, download and delete them; and a Yjs CRDT body has no safe
shell write representation. That is why the command line exposes
comments only.

The `tinycld` binary is a Go CLI the server cross-compiles containing
exactly its installed package set; users download it from **Settings →
Personal → About**. This package's group is sourced from `cli/` and
declared by a `cli` manifest block naming only the Go package and
module (`{ package: 'cli', module: 'tinycld.org/packages/text/cli' }`);
the manifest declares no scopes. The in-app help topic is
`help/command-line.md`.

Docs: [Command line tool](https://tinycld.org/docs/command-line-tool) ·
[CLI reference](https://tinycld.org/docs/reference/cli-reference).

## Development

```sh
# Assemble a workspace with the app shell, this package, and its
# dependency @tinycld/drive as sibling checkouts
mkdir ~/code/tinycld && cd ~/code/tinycld
npx @tinycld/bootstrap@latest --assemble-only --with drive --with text

# Install at the workspace root (links members + runs the generator)
pnpm install

# Run the full stack
cd tinycld
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
cd text
pnpm exec tinycld-pkg check       # biome + tsc + vitest, scoped to this package
pnpm exec tinycld-pkg test        # vitest only
pnpm exec tinycld-pkg test:e2e    # playwright (this package only)
cd server && go test ./...        # Go tests for this package's server/
```

## CI

`.github/workflows/ci.yml` runs three jobs on every push to `main` and
every PR: **Typecheck & Unit** (`pnpm exec tinycld-pkg check`), **E2E**
(Playwright via `tinycld-pkg test:e2e`), and **Go tests** (`go test ./...`
in `server/`). Each job checks this repo out into its member slot and
assembles the workspace around it with `@tinycld/bootstrap --assemble-only`,
resolving the `tinycld` and `drive` siblings to a branch matching the PR's
branch name when one exists (falling back to their default branch), then
runs `pnpm install` at the workspace root — exactly what a developer does
locally.

## Package anatomy

- `manifest.ts` — single source of truth for capabilities
- `package.json` — name, exports map, peer deps
- `tsconfig.json` — typecheck config (lint config lives in the app shell's `biome.json`)
- `server/` — Go server module, including `server/automation.go` (trigger
  registration + the participant owner resolver)
- `cli/` — Go source for this package's `tinycld text` command group
- `tinycld/text/automation.ts` — the automation trigger catalog
- `tests/` — vitest unit tests (`*.test.ts(x)`) and Playwright e2e specs (`*.spec.ts`); `playwright.config.ts` points its `testDir` here too
