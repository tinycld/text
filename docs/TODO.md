# @tinycld/text — outstanding review items

Captured from the May 2026 multi-agent code review of the entire package. Each section lists what remains to do, with severity (`CRITICAL` / `IMPORTANT` / `NIT`) and a one-line "why this matters."

A checked box means the item is fixed on `main`. The session that introduced this file fixed the three boxes you'll see ticked under "Authorization & test coverage" below.

---

## Authorization & test coverage

- [x] **CRITICAL** — `isReadOnlyForConn` returns a real owner/editor vs viewer signal sourced from `drive_shares.role` (was a `return false` stub).
- [x] **CRITICAL** — `resolveShareRole` constrains `user_org.org = drive_items.org` so stale cross-org shares no longer grant access.
- [x] **IMPORTANT** — Trivial unit tests replaced with real coverage. 41 assertions across 5 files now exercise the manifest contract (incl. `server.module` vs `go.mod`, declared directories existing on disk), the `text.open` action's id/icon/label/`isApplicable`/`onPress` semantics, banner formatters, color stability, Y.Doc binding shape, and `typedServerHello`/`typedServerSlot` edge cases.

---

## Critical (deferred — pick up next)

### Incremental persistence / write-ahead journal
- [x] **CRITICAL** — done. Core now ships a per-room WAL: every accepted `MsgDocUpdate` is appended to `realtime_doc_updates` synchronously before fan-out, so SIGKILL between accept and snapshot does not lose the edit. On room create, the broker replays journal rows after the docx bootstrap. SaveCoordinator truncates the journal after every successful docx flush. Text and calc are wired up, including cascade-delete hooks. See plan `~/Documents/plans/2026-05-15-realtime-wal-plan.md`.

### Server-side write enforcement for viewers
- [ ] **CRITICAL** — the read-only signal we now ship in `MsgServerHello` is *advisory*. A viewer client that ignores `readOnly=true` can still POST `MsgDocUpdate` frames and the broker will apply them. Need a server-side write filter in core's realtime layer (per-room write predicate) or text needs to reject `MsgDocUpdate` frames from viewer connections.
- Filed-with: this depends on core's realtime growing a write hook; coordinate with calc which has the same gap.

---

## Important

### Server / persistence / realtime
- [ ] **IMPORTANT** — `runtime.go:151` `ApplyUpdate` has no payload size cap. A 100 MB frame exhausts memory before the recover guard triggers. Cap at the broker (e.g. 1 MiB) and reject earlier.
- [x] **IMPORTANT** — `pm_to_docx.go:715` `AddImageFromData` accepts arbitrary bytes from a client-supplied data: URI. **Done** — added `MaxImageBytes = 4 MiB` cap plus a media-type allow-list (`image/{png,jpeg,gif,webp}`). Oversized / unsupported-type images are dropped with new `WarningImageTooLarge` / `WarningUnsupportedImageType` codes surfaced via `PMJSONToDocxWithWarnings`; the legacy `PMJSONToDocx` wraps it for backward compatibility.
- [x] **IMPORTANT** — `bootstrap.go:89` `io.ReadAll(rdr)` slurps the entire docx into memory with no cap. **Done** — added `MaxDocxBytes = 25 MiB`; reads route through `readCappedBytes` (`io.LimitReader` + post-read length check). Over-cap blobs error out and the existing bootstrap-failure path degrades to an empty Y.Doc.
- [ ] **IMPORTANT** — WordZero's `NumberingManager` is a global singleton with no mutex around concurrent flushes of different rooms (`flush.go:25-28`, `pm_to_docx.go` header). Two simultaneous flushes can interleave numbering allocations and produce malformed list output. Either serialize flushes through a package-level `sync.Mutex` or replace the library.
- [x] **IMPORTANT** — `runtime.go:71-89` has no janitor for orphaned docs. **Done** — `textDocHandle` tracks `lastActivity` (updated on `ApplyUpdate` / `EncodeStateAsUpdate`); `Runtime.StartJanitor` spawns a goroutine that wakes every `JanitorInterval` (5 min) and `Close`s handles idle past `MaxIdleDuration` (30 min). `Runtime.Stop` cleanly joins the goroutine for tests / shutdown.
- [x] **IMPORTANT** — `runtime.go` `importWarnings` map has no TTL or size bound. **Done** — each entry is timestamped; the janitor (and every `SetImportWarnings` call) evicts entries older than `ImportWarningsTTL` (1 h). The map is capped at `MaxImportWarningRooms` (256) — on overflow the oldest entry is dropped.

### DOCX coverage (silent data loss on round-trip)
For each of these the parser drops the feature on import:
- [ ] **IMPORTANT** — Footnotes / endnotes (`docx_to_pm.go`: `<w:footnoteReference>` falls into the `default` skip with `WarningUnsupportedNode`).
- [ ] **IMPORTANT** — Headers / footers (`parseBodyChild` only reads `<w:body>`; `word/header*.xml` / `footer*.xml` are never loaded).
- [ ] **IMPORTANT** — Page breaks (`parseRun:579-585` converts `<w:br>` to `\n` text and loses the semantic distinction).
- [ ] **IMPORTANT** — Comments — the body markers are removed (with a `WarningComments`) but `comments.xml` is dropped entirely.
- [ ] **IMPORTANT** — Tracked deletions are dropped silently aside from the warning. Insertions are kept (good).
- [ ] **IMPORTANT** — Hyperlinks: `parseHyperlink` works for v1, but the post-process emitter (`pm_to_docx.go:962-1057`, the `{{__pmlink:N:open}}` / `{{__pmlink:N:close}}` token + `applyLinkRewrites` pair) is text-substitution-based and brittle — a literal `{{__pmlink:1:open}}` token appearing in user text would corrupt the file. Either escape user text or switch to a proper WordZero hyperlink API (would require forking the dep).
- [ ] **IMPORTANT** — Image dimensions are dropped (`extent` EMUs intentionally not preserved). Means resizing images in the editor is impossible
- [ ] **IMPORTANT** - Advanced image support: Paste image from system clipboard, add resize handles to images, adjust float behavior so text wraps in right click context menu
- [x] **IMPORTANT** — Table cell merges (`gridSpan`, `vMerge`), column widths, and borders are now parsed (`docx_to_pm.go:1391-1571`, plus `cell_borders.go` and `colwidth_test.go`). Shading (`<w:shd>`) is still dropped.
- [ ] **IMPORTANT** — Styles: only Heading1-6, Quote/IntenseQuote, Normal, ListParagraph are recognized. Any other `pStyle` gets `WarningUnsupportedStyle` and normalizes to plain paragraph. Custom `rStyle` is silently dropped.
- [ ] **IMPORTANT** — Code blocks: no `code` / `codeBlock` mark or node in `SupportedNodeTypes`.
- [ ] **IMPORTANT** — Math / OMML: no handling, dropped at the body level.
- [ ] **IMPORTANT** — Font size and family still dropped. Font color now round-trips via the `textStyle` mark (`types.go:74`, `MarkTypeTextStyle`); `parseRunProperties` reads `<w:color>` and `pm_to_docx.marksToTextFormat` emits it. Size (`<w:sz>`) and family (`<w:rFonts>`) remain unsupported.
- [ ] **IMPORTANT** — Alignment / indent (`<w:jc>`, `<w:ind>`) silently dropped.
- [ ] **IMPORTANT** — Numbered-list level format precision: `listTypeFromFmt` collapses every non-bullet variant onto `orderedList`. Level format (lowerRoman vs decimal etc.) is lost.

### Frontend conventions
- [x] **IMPORTANT** — `captureException` now wraps the create-document and image-insert paths. `screens/index.tsx` + `sidebar.tsx` delegate to a shared `lib/create-blank-text-document.ts` helper that uses `mutate(input, { onSuccess, onError })` and routes failures through `captureException('text.createDoc', err)`. `components/ImageInsertButton.tsx` extracts a `handleImageInsert(onInsert, deps)` helper with the same shape — picker exceptions go through `captureException('text.imageInsert', err)`; null (user cancelled) stays silent.
- [x] **IMPORTANT** — Create flows use the project-standard `mutate` (fire-and-forget with `onSuccess`/`onError` callbacks). `mutateAsync` calls and surrounding async `useCallback`s removed at both call sites.
- [x] **IMPORTANT** — Raw hex colors in `screens/index.tsx` replaced with `useThemeColor`: `'white'` → `accent-foreground` (matches the button's `bg-accent`), `'#888'` → `muted-foreground`, `'#3b82f6'` → `primary` (the project's brand teal — `accent` would render invisible as it's a soft pale-teal background, not an icon tint). `lib/color-for-user.ts` palette is a legitimate exception (Yjs awareness needs literal CSS strings).
- [x] **IMPORTANT** — Duplicate query+create block extracted to `hooks/use-text-documents.ts` (`useTextDocuments()` + `useCreateBlankTextDocument()`). Both call sites now import the hooks and shrink (`screens/index.tsx` 129→105 LOC, `sidebar.tsx` 67→43 LOC). `useTextDocuments` wraps `useOrgLiveQuery` with the docx-mime filter; `useCreateBlankTextDocument` wraps `useCreateDriveItem` + the blank-blob helper + `captureException('text.createDoc')` and exposes `{ create(onCreated), isPending }`. Coverage in `tests/use-text-documents.test.tsx`.
- [ ] **IMPORTANT** — `useState` + `useEffect` sync in `components/LinkPopover.tsx:18,27-29`. The `biome-ignore` comment is a tell. Replace with a Zustand store or `key={isOpen}` remount.

### Collaboration correctness
- [x] **IMPORTANT** — `SaveStatusIndicator` now accepts `isConnected` and renders an "Offline" pill (`CloudOff` + muted-foreground) that wins over `saveStatus`. The state transitions live in `components/save-status-state.ts`; `screens/[id].tsx` passes `room.isConnected` through.
- [ ] **IMPORTANT** — `runtime.go:177` `EncodeStateAsUpdate(h.doc, nil)` always sends the full Y.Doc state. Plumb through the peer state vector when room sizes grow. (Bridge helpers live at `server/translate/yjs_bridge.go`, but the broker-facing encode call is in `runtime.go`.)
- [ ] **IMPORTANT** — `initialAwareness` object literal recreated each render in `hooks/useTextRoom.ts:56-61`. Memoise; expose `setLocalState` for live name updates.
- [x] **IMPORTANT** — Awareness cleanup is already handled by core's `useRealtimeRoom` effect teardown (`packages/@tinycld/core/lib/realtime/use-realtime-room.ts:200-204` calls `awareness.setLocalState(null)` before destroying the WS on unmount / roomKind / roomID change). Documented in `useTextRoom`'s header comment and locked by `tests/use-text-room-cleanup.test.tsx`. No text-side cleanup needed.
- [ ] **IMPORTANT** — Image data: URIs round-trip through Yjs and broadcast to every peer (acknowledged in `ImageInsertButton.tsx:11-19` as v1). The `drive` dependency is already declared — wire `useCreateDriveItem` and insert by URL instead of base64. (Paste/drop path NOW uses drive — see new entry under Missing features. The toolbar's `ImageInsertButton` still uses data: URIs.)

### Type-safety
- [x] **IMPORTANT** — `serverHello` / `serverSlot` are now zod-validated. `serverHelloSchema` / `serverSlotSchema` live at the top of `hooks/useTextRoom.ts`; `TextServerHello` / `TextServerSlot` are `z.infer`. Parse failures route through `captureException` with tags `useTextRoom.serverHello.parse` / `useTextRoom.serverSlot.parse` and fall back to the existing safe defaults. Covered by `tests/use-text-room-schemas.test.tsx`.

### CI / build
- [ ] **IMPORTANT** — Go server tests never run in CI. `.github/workflows/ci.yml` runs vitest only. `server/{authorize,bootstrap,flush,runtime,fixtures}_test.go` and `server/translate/*_test.go` execute locally only. Add a `go test ./server/...` step.
- [ ] **IMPORTANT** — Playwright never runs in CI. `tests/text-document.spec.ts` exists but isn't executed on PRs. Add a workflow step.
- [ ] **IMPORTANT** — `APP_REF: main` is unpinned. Silent break risk on app-shell changes.
- [ ] **IMPORTANT** — `tests/assets/feature-test.expected.json` (48KB) has no consumer in `tests/`. Either an orphan or it belongs alongside the Go translate tests. Locate or remove.
- [ ] **IMPORTANT** — No tests for permissions/roles via Playwright, read-only enforcement, concurrent edits at the same cursor, reconnect/offline, oversized/malformed docx, FE-side "Open in Text" from drive UI, sidebar list rendering/sorting/empty state, delete flow, navigation to missing/unauthorized docs.

### Missing features (a "documents" product needs these)

Ordered roughly by user-visible ROI:

- [x] Document rename — Implemented via `components/DocumentTitle.tsx`; click-to-edit, Enter to commit, Escape to cancel, blocked when read-only.
- [x] Find / replace within document (Cmd+F). Implemented as an in-package ProseMirror plugin (`lib/find-replace-plugin.ts`) plus a screen-level `FindReplaceBar` overlay (`components/FindReplaceBar.tsx`). Cmd/Ctrl+F opens the bar, Cmd/Ctrl+G + F3 (with Shift for prev) cycle, Escape closes. State lives in a Zustand store at `lib/stores/find-replace-store.ts`. Coverage: `tests/find-replace-store.test.ts`, `tests/find-replace-plugin.test.ts`, `tests/find-replace.spec.ts`.
- [ ] Slash menu for block insertion (`/heading`, `/table`, `/image`). Tiptap mention extension.
- [x] Drag-and-drop / paste image. The web editor's `editorProps.handlePaste` + `handleDrop` (in `hooks/use-document-editor.web.tsx`) detect image files via `lib/extract-image-files.ts`, upload through `useCreateDriveItem`, and insert the resulting `pb.files.getURL(...)` via `setImage({ src })`. Non-image pastes fall through to the default flow. Failures route through `captureException('text.pasteImageUpload')`. Unit coverage: `tests/extract-image-files.test.ts`.
- [ ] Presence cursors — avatars exist (`screens/[id].tsx:91`) but `@tiptap/extension-collaboration-cursor` is not wired, so remote carets are invisible.
- [ ] Document share link / public viewer — no `public-screens/share/[token].tsx`. Drive has it; text doesn't.
- [ ] Export to PDF / Markdown / HTML — server endpoint + "More" menu in document header.
- [ ] Comments / annotations / suggestions — no `text_comment` collection, no comment marks, no thread UI.
- [ ] Version history — Yjs has snapshot APIs; .docx is already persisted, so checkpoints are cheap.
- [ ] Tracked changes — fixture and Playwright test are skipped pending implementation.
- [ ] Document templates — no "new from template" on `screens/index.tsx`.
- [ ] Word count / outline / table-of-contents panel.
- [ ] Find-across-documents search.
- [ ] Star / favorite / pin to top.
- [ ] Move-to-folder.
- [ ] Trash / restore UI.
- [ ] Read-only viewer mode end-to-end (plumbing exists, no e2e test, server-side write filter still missing — see Critical).
- [ ] Mobile editing UX (the editor is `.web.tsx` only; no native fallback).

---

## Nits

- [ ] `lib/color-for-user.ts` allocates a fresh hash per render. Memoise per `userId` in a module-level Map if it ever shows up in profiling.
- [ ] `provider.tsx` returns a Fragment and exists only for side-effect imports. Add a 2-line comment so a future maintainer doesn't delete the file as a no-op.
- [ ] `provider.tsx` does not wrap children in an error boundary. A side-effect module that throws during registration takes down the whole shell.
- [ ] `useCallback`s on functions only passed to non-memoised `Pressable` consumers in `screens/index.tsx:38`, `sidebar.tsx:43`. Dead ceremony; delete.
- [ ] `DocumentToolbar` re-renders on every editor selection change. Wrap `FormatButton` in `React.memo` or hoist the row.
- [ ] The nested `text/tinycld/text/` source layout works (the package generator resolves through `package.json` exports), but no other sibling does this. Flatten to `text/{components,hooks,lib,screens}/` while the package is still small.
- [ ] `docx_to_pm.go` is ~1975 LOC (grew past 1400 as cell-borders / colwidth / gridSpan / vMerge / textStyle landed). Split into `docx_zip.go`, `docx_parse.go`, `docx_lists.go`, `docx_images.go`.
- [ ] Dependency risk: `github.com/ZeroHawkeye/wordZero` is low-activity and has historically panicked on malformed inputs. Long-term, vendor a fork or replace with `unidoc/unioffice` (which has hyperlink/footnote/comment APIs).
- [ ] Dependency risk: `github.com/skyterra/y-crdt` is a date-stamped pseudoversion; `server/translate/yjs_bridge.go:32-49` documents two upstream bugs it patches around. Fork it or hide behind an interface.
- [ ] `parseRelationships` / `parseNumberingFormats` in `docx_to_pm.go:131-153,160-203` silently return `nil` on `xml.Unmarshal` error. No warning, no log. A malformed relationships file means every hyperlink href becomes empty string.
- [ ] Inconsistent logger routing: `runtime.go:84` uses package-global `slog`, `bootstrap.go` and `flush.go` use `app.Logger()`. Thread `app.Logger()` (or `*slog.Logger`) into the Runtime constructor.
- [ ] Performance — `applyLinkRewrites` in `pm_to_docx.go:1018-1057` is O(N*M) string churn. A doc with 200 links and 500 KB body is ~100 MB churn per flush. Switch to a single-pass `strings.Builder` walk.
- [ ] Performance — `resolveMediaSrc` in `docx_to_pm.go:967-991` does a linear scan over `p.zip.File` per image. Index files into a map once at the start of `parseDocument`.
- [ ] `buildListTree` (`docx_to_pm.go:1874-1939`) takes pointers into slices that are later appended to; the backing array can reallocate while pointers remain valid into the old buffer. Convert frames to hold indices instead of pointers.
- [ ] Side-effect registration in `lib/open-in-text-action.tsx` and `lib/open-in-text-drive-action.tsx` is HMR-hostile (double registration on hot reload). Verify the registry is idempotent on duplicate IDs, or add an idempotence guard.
