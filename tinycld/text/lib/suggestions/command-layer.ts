import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { ReplaceStep } from '@tiptap/pm/transform'
import type * as Y from 'yjs'
import { EDITOR_MODE_SUGGESTING, type EditorModeStore } from '../../stores/editor-mode-store'
import { createSuggestionSession, type SuggestionSession } from './session-grouping'
import { SuggestionsMap } from './suggestions-map'

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
        appendTransaction(transactions, _oldState, newState) {
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
            const insertMarkType = newState.schema.marks.suggestedInsert
            const deleteMarkType = newState.schema.marks.suggestedDelete

            // Build a single appended transaction representing all the
            // mark/restore work. Tag it with the plugin key so we don't
            // recurse on it.
            const out = newState.tr
            out.setMeta(PLUGIN_KEY, true)
            let stepHadEffect = false

            for (const tr of transactions) {
                for (let i = 0; i < tr.steps.length; i++) {
                    const step = tr.steps[i]
                    if (!(step instanceof ReplaceStep)) continue
                    const replaceStep = step as ReplaceStep & {
                        from: number
                        to: number
                        slice: { content: { size: number } }
                    }
                    const from = replaceStep.from
                    const to = replaceStep.to
                    const sliceSize = replaceStep.slice.content.size
                    const isInsert = from === to && sliceSize > 0
                    const isDelete = from !== to && sliceSize === 0

                    if (isInsert) {
                        // For inserts: the step's `from` is in stepDoc
                        // (pre-step) coordinates but coincides with the
                        // start of the inserted content in post-step
                        // coordinates (inserts don't shift positions
                        // at or to the left of their `from`). Map
                        // through any prior steps already appended to
                        // `out` for safety in multi-step bundles.
                        const mapped = out.mapping.map(from)
                        out.addMark(
                            mapped,
                            mapped + sliceSize,
                            insertMarkType.create({
                                suggestionId,
                                authorId: identity.userOrgId,
                                ts: now,
                            })
                        )
                        stepHadEffect = true
                    } else if (isDelete) {
                        // For deletes: pull the deleted slice from the
                        // pre-step doc (tr.docs[i] is the doc *before*
                        // step i was applied; if i===0, that's the
                        // doc we'd see in oldState).
                        const oldDoc = tr.docs[i]
                        const deletedSlice = oldDoc.slice(from, to)

                        // Case 2d: the deleted range was entirely
                        // covered by the current author's CURRENT
                        // active suggestion. Let the delete stand —
                        // the author is retracting their own pending
                        // work within the idle window.
                        let allOwnActiveSuggestion = deletedSlice.content.size > 0
                        deletedSlice.content.descendants(node => {
                            if (node.isText) {
                                const m = node.marks.find(
                                    mark =>
                                        mark.type.name === 'suggestedInsert' &&
                                        mark.attrs.suggestionId === suggestionId
                                )
                                if (!m) allOwnActiveSuggestion = false
                            }
                            return true
                        })
                        if (allOwnActiveSuggestion) {
                            continue
                        }

                        // Restore + mark. Insert the slice at the
                        // mapped pre-step position (in `out`'s frame,
                        // which starts at newState). For a single-step
                        // delete transaction, that's exactly `from`.
                        const mappedFrom = out.mapping.map(from)
                        out.insert(mappedFrom, deletedSlice.content)
                        out.addMark(
                            mappedFrom,
                            mappedFrom + deletedSlice.content.size,
                            deleteMarkType.create({
                                suggestionId,
                                authorId: identity.userOrgId,
                                ts: now,
                            })
                        )
                        stepHadEffect = true
                    }
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
