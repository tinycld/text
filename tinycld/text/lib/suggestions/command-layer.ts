import { Extension } from '@tiptap/core'
import type { MarkType, Slice } from '@tiptap/pm/model'
import { type EditorState, Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { ReplaceStep } from '@tiptap/pm/transform'
import type * as Y from 'yjs'
import { EDITOR_MODE_SUGGESTING, type EditorModeStore } from '../../stores/editor-mode-store'
import { type BlockChange, extractBlockChanges, isBlockDeleteStep } from './block-change-utils'
import { extractMarkToggles, summarizeToggles } from './format-change-utils'
import { createSuggestionSession, type SuggestionSession } from './session-grouping'
import { SuggestionsMap } from './suggestions-map'

// Shared context the per-step handlers need. Pulled out so the
// step-loop body in appendTransaction stays small enough to keep
// cognitive complexity under biome's noExcessiveCognitiveComplexity
// threshold (max 45). The fields are immutable for the lifetime of
// one appendTransaction call.
interface StepContext {
    out: Transaction
    insertMarkType: MarkType
    deleteMarkType: MarkType
    formatChangeMarkType: MarkType
    suggestionId: string
    authorId: string
    now: number
}

// True iff every text node in `slice` is already marked as the
// current author's active-session insertion. Drives Case 2d — the
// author retracting their own pending suggestion within the idle
// window keeps the delete (no suggestedDelete restore).
function isAllOwnActiveSuggestion(slice: Slice, suggestionId: string): boolean {
    if (slice.content.size === 0) return false
    let allOwn = true
    slice.content.descendants(node => {
        if (node.isText) {
            const m = node.marks.find(
                mark =>
                    mark.type.name === 'suggestedInsert' && mark.attrs.suggestionId === suggestionId
            )
            if (!m) allOwn = false
        }
        return true
    })
    return allOwn
}

function applyInsertStep(ctx: StepContext, from: number, sliceSize: number): void {
    // For inserts: the step's `from` is in stepDoc (pre-step)
    // coordinates but coincides with the start of the inserted
    // content in post-step coordinates (inserts don't shift positions
    // at or to the left of their `from`). Map through any prior
    // steps already appended to `out` for safety in multi-step bundles.
    const mapped = ctx.out.mapping.map(from)
    ctx.out.addMark(
        mapped,
        mapped + sliceSize,
        ctx.insertMarkType.create({
            suggestionId: ctx.suggestionId,
            authorId: ctx.authorId,
            ts: ctx.now,
        })
    )
}

// Returns true if the delete actually drew a restore + mark; false
// when Case 2d applied (the delete was allowed to stand).
function applyDeleteStep(
    ctx: StepContext,
    tr: Transaction,
    stepIndex: number,
    from: number,
    to: number
): boolean {
    // For deletes: pull the deleted slice from the pre-step doc
    // (tr.docs[i] is the doc *before* step i was applied; if i===0,
    // that's the doc we'd see in oldState).
    const oldDoc = tr.docs[stepIndex]
    const deletedSlice = oldDoc.slice(from, to)

    // Case 2d: the deleted range was entirely covered by the current
    // author's CURRENT active suggestion. Let the delete stand — the
    // author is retracting their own pending work within the idle window.
    if (isAllOwnActiveSuggestion(deletedSlice, ctx.suggestionId)) {
        return false
    }

    // Restore + mark. Insert the slice at the mapped pre-step
    // position (in `out`'s frame, which starts at newState). For a
    // single-step delete transaction, that's exactly `from`.
    const mappedFrom = ctx.out.mapping.map(from)
    ctx.out.insert(mappedFrom, deletedSlice.content)
    ctx.out.addMark(
        mappedFrom,
        mappedFrom + deletedSlice.content.size,
        ctx.deleteMarkType.create({
            suggestionId: ctx.suggestionId,
            authorId: ctx.authorId,
            ts: ctx.now,
        })
    )
    return true
}

function applyReplaceStep(
    ctx: StepContext,
    tr: Transaction,
    stepIndex: number,
    from: number,
    to: number,
    sliceSize: number
): void {
    // Replace: typing/pasting over a selection. PM has already
    // removed [from, to) and inserted the new slice at `from` in the
    // post-step doc. We treat this as a delete (preserve the old
    // range as `suggestedDelete`) AND an insert (mark the new range
    // as `suggestedInsert`), sharing the same suggestionId so they
    // group as one logical edit.
    const oldDoc = tr.docs[stepIndex]
    const deletedSlice = oldDoc.slice(from, to)

    // Case 2d also applies to the delete-side of a replace: if the
    // entire old range was the current author's active-session
    // insertion, we let the delete stand and only stamp the new content.
    const skipRestore = isAllOwnActiveSuggestion(deletedSlice, ctx.suggestionId)

    // In post-step coordinates the new slice starts at `from` (PM
    // has already done the splice). Map through prior appended steps.
    const newContentStart = ctx.out.mapping.map(from)

    if (!skipRestore) {
        // Restore the deleted slice BEFORE the new content with a
        // suggestedDelete mark, so the document reads: [old struck][new ins].
        ctx.out.insert(newContentStart, deletedSlice.content)
        ctx.out.addMark(
            newContentStart,
            newContentStart + deletedSlice.content.size,
            ctx.deleteMarkType.create({
                suggestionId: ctx.suggestionId,
                authorId: ctx.authorId,
                ts: ctx.now,
            })
        )
    }

    // After the optional restore, `from` now maps to the position
    // immediately after the restored slice — exactly the start of
    // the newly-inserted content. (If Case 2d applied and we didn't
    // insert anything, this maps to the same position as newContentStart.)
    const insertStart = ctx.out.mapping.map(from)
    ctx.out.addMark(
        insertStart,
        insertStart + sliceSize,
        ctx.insertMarkType.create({
            suggestionId: ctx.suggestionId,
            authorId: ctx.authorId,
            ts: ctx.now,
        })
    )
}

// applyFormatChangeStep handles all AddMark/RemoveMark steps in `tr`
// as a single suggested-format-change. The user's mark toggles have
// already landed in `newState` (appendTransaction sees post-step doc),
// so we (a) undo each toggle on `out` — re-add removed marks, remove
// added marks — and (b) stamp a single suggestedFormatChange mark
// over the merged [from, to) range carrying serialized before/after
// snapshots. The resolver (Task 5) re-applies the after-set on accept
// or leaves the before-set intact on reject.
//
// Why undo first instead of leaving the user's marks visible: the
// suggestion is exactly that — proposed, not applied. The visual
// hint that a format change is pending comes from the decoration
// plugin (Task 6), which renders the after-set as a styled overlay
// on the suggestedFormatChange range. Leaving the raw bold/italic
// mark on the run would make the doc render as if the change were
// already accepted, defeating the purpose of suggestion mode.
function applyFormatChangeStep(
    ctx: StepContext,
    tr: Transaction,
    oldState: EditorState,
    newState: EditorState
): boolean {
    const toggles = extractMarkToggles(tr)
    if (toggles.length === 0) return false

    // Undo each toggle on the output transaction. The output is
    // anchored at newState's doc, so we reverse what landed: re-add
    // marks the user removed and remove marks the user added. We map
    // the toggle ranges through `out.mapping` for safety against any
    // prior steps appended in this iteration (currently none, since
    // format changes run first, but the discipline is cheap).
    for (const t of toggles) {
        const from = ctx.out.mapping.map(t.from)
        const to = ctx.out.mapping.map(t.to)
        if (t.isAdd) {
            ctx.out.removeMark(from, to, t.mark)
        } else {
            ctx.out.addMark(from, to, t.mark)
        }
    }

    const summary = summarizeToggles(toggles, oldState, newState)
    const fcFrom = ctx.out.mapping.map(summary.from)
    const fcTo = ctx.out.mapping.map(summary.to)
    ctx.out.addMark(
        fcFrom,
        fcTo,
        ctx.formatChangeMarkType.create({
            suggestionId: ctx.suggestionId,
            authorId: ctx.authorId,
            ts: ctx.now,
            before: summary.before,
            after: summary.after,
        })
    )
    return true
}

// applyBlockChangeStep handles all block-level changes the user emitted
// in `tr` (setBlockType, setNodeAttribute, block delete) as
// suggestedBlockChange node attributes plus, for kind='delete',
// companion suggestedDelete marks on the inline content. Mirrors the
// format-change branch's "undo + stamp" pattern:
//
//   - kind='attr' / 'type-swap': revert the user's change on `out` by
//     calling setNodeMarkup with the before-type + before-attrs, then
//     also write the suggestedBlockChange payload as a node attribute.
//     A single setNodeMarkup call carries both — the before-attrs
//     restore the user-facing shape, and the suggestedBlockChange
//     entry records the proposed transition.
//
//   - kind='delete': the block is gone from newState. Re-insert the
//     original block node at the mapped position, stamp the
//     suggestedBlockChange attribute with after.deleted=true, and add
//     suggestedDelete marks over the inline content so the
//     strikethrough decoration applies to the text.
//
// Block changes take precedence over the format-change branch in the
// main appendTransaction loop. The reason: a type-swap from paragraph
// to heading might incidentally introduce attribute marks
// (clearIncompatible runs inside setBlockType to strip marks the new
// type doesn't allow). Those incidental mark-toggle steps should NOT
// be re-stamped as format changes — they're a side-effect of the
// type swap, not a separate proposal. By detecting block changes
// first, the format-change extractMarkToggles call still runs but on
// transactions where structural intent dominates we accept the small
// drift (a format-change wrapper might co-exist with the
// suggestedBlockChange entry, both pointing at the same suggestionId).
//
// Returns the set of step INDICES the block-change handling consumed
// so the caller's regular ReplaceStep dispatch skips them. AttrStep
// and ReplaceAroundStep aren't in that loop in the first place; the
// returned set therefore only needs to cover ReplaceStep block-deletes
// to prevent the existing text-delete path from double-restoring.
function applyBlockChangeStep(
    ctx: StepContext,
    tr: Transaction,
    oldState: EditorState,
    schema: EditorState['schema']
): { consumedReplaceSteps: Set<number>; hadEffect: boolean } {
    const consumed = new Set<number>()
    const changes = extractBlockChanges(tr, oldState)
    if (changes.length === 0) {
        return { consumedReplaceSteps: consumed, hadEffect: false }
    }

    // Identify ReplaceStep indices that correspond to block deletes so
    // the caller can skip them in its text-delete path.
    for (let i = 0; i < tr.steps.length; i++) {
        const step = tr.steps[i]
        if (step instanceof ReplaceStep && isBlockDeleteStep(step, oldState)) {
            consumed.add(i)
        }
    }

    // Process back-to-front so earlier positions stay stable while we
    // apply structural edits on `out`.
    const sorted = [...changes].sort((a, b) => b.pos - a.pos)
    for (const change of sorted) {
        applyOneBlockChange(ctx, change, schema)
    }
    return { consumedReplaceSteps: consumed, hadEffect: true }
}

function applyOneBlockChange(
    ctx: StepContext,
    change: BlockChange,
    schema: EditorState['schema']
): void {
    const payload = {
        suggestionId: ctx.suggestionId,
        authorId: ctx.authorId,
        ts: ctx.now,
        before: { type: change.beforeType, attrs: change.beforeAttrs },
        after:
            change.kind === 'delete'
                ? {
                      type: change.beforeType,
                      attrs: change.beforeAttrs,
                      deleted: true,
                  }
                : { type: change.afterType, attrs: change.afterAttrs },
    }

    if (change.kind === 'attr' || change.kind === 'type-swap') {
        applyBlockAttrOrTypeSwap(ctx, change, schema, payload)
        return
    }
    applyBlockDelete(ctx, change, schema, payload)
}

function applyBlockAttrOrTypeSwap(
    ctx: StepContext,
    change: Extract<BlockChange, { kind: 'attr' | 'type-swap' }>,
    schema: EditorState['schema'],
    payload: Record<string, unknown>
): void {
    // The block exists in newState at the mapped position. Reset its
    // type + attrs to the before-state and bake in our
    // suggestedBlockChange payload in a single setNodeMarkup call —
    // this both reverts the user's change AND records the proposal.
    const mappedPos = ctx.out.mapping.map(change.pos)
    const beforeType = schema.nodes[change.beforeType]
    if (!beforeType) return
    const node = ctx.out.doc.nodeAt(mappedPos)
    if (!node) return
    const nextAttrs: Record<string, unknown> = {
        ...change.beforeAttrs,
        suggestedBlockChange: payload,
    }
    ctx.out.setNodeMarkup(mappedPos, beforeType, nextAttrs)
}

function applyBlockDelete(
    ctx: StepContext,
    change: Extract<BlockChange, { kind: 'delete' }>,
    schema: EditorState['schema'],
    payload: Record<string, unknown>
): void {
    // The block was removed by the user's transaction. Re-insert a
    // fresh copy (with the before-attrs plus our suggestedBlockChange
    // payload baked in) at the mapped position, then add
    // suggestedDelete marks across the restored inline content so the
    // strikethrough decoration applies.
    const beforeType = schema.nodes[change.beforeType]
    if (!beforeType) return

    const nextAttrs: Record<string, unknown> = {
        ...change.beforeAttrs,
        suggestedBlockChange: payload,
    }
    const newBlock = beforeType.create(
        nextAttrs,
        change.beforeNode.content,
        change.beforeNode.marks
    )

    const mappedPos = ctx.out.mapping.map(change.pos)
    ctx.out.insert(mappedPos, newBlock)
    // The inserted block's inline content sits at [mappedPos + 1,
    // mappedPos + 1 + content.size). addMark only applies to inline
    // nodes inside that range, so the suggestedBlockChange node
    // attribute is unaffected.
    const innerFrom = mappedPos + 1
    const innerTo = innerFrom + change.beforeNode.content.size
    if (innerTo > innerFrom) {
        ctx.out.addMark(
            innerFrom,
            innerTo,
            ctx.deleteMarkType.create({
                suggestionId: ctx.suggestionId,
                authorId: ctx.authorId,
                ts: ctx.now,
            })
        )
    }
}

// Plugin key tag for transactions the command layer itself appends.
// We check this in appendTransaction to short-circuit re-entry: when
// y-prosemirror or another plugin echoes our own appended transaction
// back through us, we must not re-mark or re-restore.
const PLUGIN_KEY = new PluginKey('tinycld:suggestion-command-layer')

export interface SuggestionCommandLayerOptions {
    modeStore: EditorModeStore
    yDoc: Y.Doc
}

// createSuggestionCommandPlugin builds the ProseMirror plugin that
// implements the suggesting-mode rewrite layer. It hooks into
// appendTransaction so it observes every user-driven transaction and
// emits a corrective transaction that:
//
//   - INSERTS: wraps the inserted range in suggestedInsert with the
//     active session's suggestionId + authorId + ts.
//   - DELETES: restores the deleted slice in place (so the user's
//     change is visually "tracked" not destructive) and wraps it in
//     suggestedDelete carrying the same attribution.
//   - FORMAT TOGGLES (Phase 5): undoes the user's mark toggle and
//     stamps suggestedFormatChange over the range with before/after
//     snapshots of the affected marks. The raw bold/italic/link mark
//     itself is reverted so the doc doesn't render the change as if
//     accepted; the decoration plugin (Task 6) provides the visual
//     overlay that signals "this format change is pending".
//
// Special case 2d (deleting one's own active-suggestion content within
// the idle window): the delete is allowed to stand. This is how
// authors retract a freshly-typed character — the suggestion isn't
// fossilized until the idle window elapses, and within the window the
// author may freely edit their own pending suggestion.
//
// Sessions are keyed by the editor's identity (userOrgId in the mode
// store). When the identity changes, the previous session is dropped
// so the next touch mints a fresh suggestionId — the per-author
// session is the right boundary for "this person's pending work".
//
// The suggestions Y.Map entry is created lazily on first touch of a
// new suggestionId. y-prosemirror bundles the PM step transaction and
// the Y.Map.set into a single Yjs transaction at commit time, so the
// doc + suggestions index update atomically — partial-fail isn't
// possible.
export function createSuggestionCommandPlugin(options: SuggestionCommandLayerOptions): Plugin {
    const { modeStore, yDoc } = options
    const suggestionsMap = new SuggestionsMap(yDoc)
    // Sessions are per-author; if the editor's identity changes (user
    // signs out/in, OTP guest session ends, etc.), we discard the
    // previous session so the next touch mints a fresh suggestionId.
    let session: SuggestionSession | null = null
    let sessionAuthorId: string | null = null

    const getSession = (authorId: string): SuggestionSession => {
        if (sessionAuthorId !== authorId) {
            session = createSuggestionSession(authorId)
            sessionAuthorId = authorId
        }
        // biome-ignore lint/style/noNonNullAssertion: session is set when authorId differs
        return session!
    }

    return new Plugin({
        key: PLUGIN_KEY,
        appendTransaction(transactions, oldState, newState) {
            const { mode, identity } = modeStore.getState()
            if (mode !== EDITOR_MODE_SUGGESTING) return null
            if (!identity) return null
            if (transactions.length === 0) return null

            // Skip transactions originated by the command layer itself
            // (avoid infinite recursion when y-prosemirror or other
            // plugins re-emit our appended transactions).
            if (transactions.some(tr => tr.getMeta(PLUGIN_KEY))) return null

            // Only act on user-driven content changes.
            if (!transactions.some(tr => tr.docChanged)) return null

            const sess = getSession(identity.userOrgId)
            const suggestionId = sess.touch()
            const now = Date.now()

            // Build a single appended transaction representing all the
            // mark/restore work. Tag it with the plugin key so we don't
            // recurse on it.
            const out = newState.tr
            out.setMeta(PLUGIN_KEY, true)
            const ctx: StepContext = {
                out,
                insertMarkType: newState.schema.marks.suggestedInsert,
                deleteMarkType: newState.schema.marks.suggestedDelete,
                formatChangeMarkType: newState.schema.marks.suggestedFormatChange,
                suggestionId,
                authorId: identity.userOrgId,
                now,
            }

            let stepHadEffect = false
            for (const tr of transactions) {
                if (processTransaction(ctx, tr, oldState, newState)) {
                    stepHadEffect = true
                }
            }

            if (!stepHadEffect && out.steps.length === 0) {
                return null
            }

            // Ensure the suggestions map entry exists. Idempotent —
            // SuggestionsMap.create skips known ids. We write outside
            // the PM transaction because PM doesn't know about Y.Map
            // writes; y-prosemirror brackets the whole appendTransaction
            // emit into a single Yjs transaction, so the Map.set still
            // commits atomically with the PM steps.
            suggestionsMap.create({
                id: suggestionId,
                authorId: identity.userOrgId,
                createdAt: now,
            })

            return out
        },
    })
}

// processTransaction handles one user transaction's worth of steps:
// block-change detection → format-change detection → text insert/
// delete/replace fan-out. Returns true iff at least one step produced
// observable work that should keep the appended transaction alive.
// Pulled out of appendTransaction to keep cognitive complexity under
// biome's noExcessiveCognitiveComplexity threshold.
function processTransaction(
    ctx: StepContext,
    tr: Transaction,
    oldState: EditorState,
    newState: EditorState
): boolean {
    let hadEffect = false

    // Phase 5: block-level changes (setBlockType, setNodeAttribute,
    // block delete) take precedence — they can incidentally emit
    // Add/Remove mark steps as setBlockType strips marks the new type
    // doesn't allow, and we don't want those side-effects to fan out
    // into a separate suggestedFormatChange entry. The block branch
    // returns the set of ReplaceStep indices it consumed so the
    // text-delete path below can skip them.
    const block = applyBlockChangeStep(ctx, tr, oldState, newState.schema)
    if (block.hadEffect) hadEffect = true

    // Phase 5: detect format changes (toggleBold / toggleItalic / link
    // / textColor / …) next. A single user command may emit multiple
    // AddMark/RemoveMark steps; the helper collapses them into one
    // suggestedFormatChange spanning the merged range.
    if (applyFormatChangeStep(ctx, tr, oldState, newState)) hadEffect = true

    if (processReplaceSteps(ctx, tr, block.consumedReplaceSteps)) hadEffect = true
    return hadEffect
}

// processReplaceSteps walks the transaction's ReplaceSteps and routes
// each to the appropriate handler (insert / delete / replace). The
// block branch's consumedReplaceSteps set is honored: a step already
// handled as a block delete is not double-counted here.
function processReplaceSteps(ctx: StepContext, tr: Transaction, consumed: Set<number>): boolean {
    let hadEffect = false
    for (let i = 0; i < tr.steps.length; i++) {
        if (consumed.has(i)) continue
        const step = tr.steps[i]
        if (!(step instanceof ReplaceStep)) continue
        const { from, to, slice } = step
        const sliceSize = slice.content.size
        const isInsert = from === to && sliceSize > 0
        const isDelete = from !== to && sliceSize === 0
        const isReplace = from !== to && sliceSize > 0

        if (isInsert) {
            applyInsertStep(ctx, from, sliceSize)
            hadEffect = true
        } else if (isDelete) {
            if (applyDeleteStep(ctx, tr, i, from, to)) hadEffect = true
        } else if (isReplace) {
            applyReplaceStep(ctx, tr, i, from, to, sliceSize)
            hadEffect = true
        }
    }
    return hadEffect
}

// SuggestionCommandLayer is the TipTap extension wrapper that mounts
// the plugin into the editor. The extension is always loaded; the
// plugin internally short-circuits when the mode store reports
// anything other than 'suggesting', so toggling modes doesn't require
// remounting or reconfiguring the editor.
export const SuggestionCommandLayer = Extension.create<SuggestionCommandLayerOptions>({
    name: 'suggestionCommandLayer',

    addOptions() {
        // Defaults aren't usable in production — the editor mount
        // must pass real modeStore + yDoc. Returning empty placeholders
        // avoids a crash if a tooling context (schema-only typecheck,
        // a `getSchema([SuggestionCommandLayer])` call without
        // configure) loads the extension without configuring it.
        return {
            modeStore: null as unknown as EditorModeStore,
            yDoc: null as unknown as Y.Doc,
        }
    },

    addProseMirrorPlugins() {
        const { modeStore, yDoc } = this.options
        if (!modeStore || !yDoc) return []
        return [createSuggestionCommandPlugin({ modeStore, yDoc })]
    },
})
