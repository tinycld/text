import type * as Y from 'yjs'
import {
    SUGGESTION_STATUS_OPEN,
    type Suggestion,
    type SuggestionStatus,
} from '../../webview-editor/source/suggestions/suggestion-types'

const ROOT_KEY = 'suggestions'

export interface CreateSuggestionInput {
    id: string
    authorId: string
    createdAt: number
    note?: string
}

export interface ResolveSuggestionInput {
    status: Exclude<SuggestionStatus, typeof SUGGESTION_STATUS_OPEN>
    by: string
    at: number
}

// SuggestionsMap wraps the Y.Map<string, Suggestion> rooted under the
// 'suggestions' key on the document. Centralizes write-shape decisions
// so the command layer and resolve transactions don't drift.
//
// All writes happen inside Yjs transactions implicitly — Y.Map.set is
// already transactional. The wrapper doesn't wrap them in explicit
// doc.transact() because:
//   - single Map.set calls don't need batching
//   - resolve() does one set, atomically
//   - the command layer wraps suggestion writes alongside mark writes
//     in its own ProseMirror transaction, which y-prosemirror bridges
//     into a single Yjs transaction at commit time
export class SuggestionsMap {
    private readonly map: Y.Map<Suggestion>

    constructor(doc: Y.Doc) {
        this.map = doc.getMap<Suggestion>(ROOT_KEY)
    }

    create(input: CreateSuggestionInput): void {
        // Idempotent for local replays — if the id already exists in
        // our local view, skip the write. For concurrent creates from
        // different peers with the same id (which would require a
        // ulid collision), Yjs's internal last-writer-wins resolution
        // determines the survivor; this wrapper does NOT enforce
        // first-writer-wins across the network. The command layer
        // generates ulid suggestionIds so collision is vanishingly
        // unlikely in practice — the realistic case this guard
        // protects against is the same peer re-firing create() on
        // an already-known id (transaction replay / undo-redo).
        if (this.map.has(input.id)) return
        const entry: Suggestion = {
            id: input.id,
            authorId: input.authorId,
            createdAt: input.createdAt,
            status: SUGGESTION_STATUS_OPEN,
            ...(input.note ? { note: input.note } : {}),
        }
        this.map.set(input.id, entry)
    }

    resolve(id: string, input: ResolveSuggestionInput): void {
        const existing = this.map.get(id)
        if (!existing) {
            throw new Error(`SuggestionsMap.resolve: suggestion ${id} not found`)
        }
        const updated: Suggestion = {
            ...existing,
            status: input.status,
            resolvedBy: input.by,
            resolvedAt: input.at,
        }
        this.map.set(id, updated)
    }

    get(id: string): Suggestion | undefined {
        return this.map.get(id)
    }

    list(): Suggestion[] {
        return Array.from(this.map.values())
    }

    // Drop a suggestion entry by id. Used by the orphan-cleanup pass in
    // useDocumentSuggestions when a Y.Map row has no matching mark/attr
    // in the doc — that state is unrecoverable (Accept / Reject have no
    // anchor to operate on) so the row is silently removed to keep the
    // drawer clean. Idempotent: deleting an absent id is a no-op.
    delete(id: string): void {
        this.map.delete(id)
    }

    // Batch-delete a set of ids inside a single Yjs transaction. The
    // single-transaction wrapper matters for the journal + fan-out: a
    // 5-entry cleanup lands as one MsgDocUpdate instead of five, and
    // peers observe one observe-callback fire instead of five.
    deleteMany(ids: readonly string[], doc: Y.Doc): void {
        if (ids.length === 0) return
        doc.transact(() => {
            for (const id of ids) {
                this.map.delete(id)
            }
        })
    }

    observe(handler: () => void): () => void {
        const observer = () => handler()
        this.map.observe(observer)
        return () => this.map.unobserve(observer)
    }
}
