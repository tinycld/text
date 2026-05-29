export const SUGGESTION_DOC_SCHEMA_VERSION = 1

export const SUGGESTION_STATUS_OPEN = 'open'
export const SUGGESTION_STATUS_ACCEPTED = 'accepted'
export const SUGGESTION_STATUS_REJECTED = 'rejected'

export type SuggestionStatus =
    | typeof SUGGESTION_STATUS_OPEN
    | typeof SUGGESTION_STATUS_ACCEPTED
    | typeof SUGGESTION_STATUS_REJECTED

export interface Suggestion {
    id: string
    authorId: string
    createdAt: number
    status: SuggestionStatus
    resolvedBy?: string
    resolvedAt?: number
    note?: string
}

export interface EditEventAffectedNode {
    nodeId: string
    snippet: string
}

export interface EditEvent {
    clientId: number
    authorId: string
    startedAt: number
    endedAt: number
    editCount: number
    affectedNodes: EditEventAffectedNode[]
}

export interface BlockChangeBefore {
    type: string
    attrs: Record<string, unknown>
    // Phase 5 (Task 13): a sentinel for "this block didn't exist before
    // the suggestion." Used by table operations that propose adding a
    // cell (addRow / addColumn) — the cell is freshly inserted in the
    // suggesting-mode flow and has no pre-existing before-state to
    // record. Type + attrs still mirror the proposed shape so the
    // resolve path has a complete picture when rejecting (delete the
    // freshly-added cell).
    added?: boolean
}

export interface BlockChangeAfter {
    type: string
    attrs: Record<string, unknown>
    deleted?: boolean
}

export interface SuggestedBlockChange {
    suggestionId: string
    authorId: string
    ts: number
    before: BlockChangeBefore
    after: BlockChangeAfter
}

// SerializedMarks is the JSON-serializable shape of a ProseMirror Mark[]
// used by suggestedFormatChange to record before/after mark sets.
// Each entry captures the mark's type name and (optionally) its attrs.
// Phase 5's serialize-marks helper (lib/suggestions/serialize-marks.ts)
// converts to/from ProseMirror Mark[] via the active schema.
export type SerializedMarks = Array<{ type: string; attrs?: Record<string, unknown> }>

export interface SuggestedFormatChange {
    suggestionId: string
    authorId: string
    ts: number
    before: SerializedMarks
    after: SerializedMarks
}

// Mirrors realtime.ProtectedYjsRootKeys (core/server/realtime/protected_yjs_keys.go).
// The editor schema must never include these keys in any user-driven
// transaction. Server-side, core's broker rejects any inbound update
// that mutates these roots via text's validateUpdate function.
//
// Adding a new protected key requires a coordinated change across:
//   - core's protected_yjs_keys.go (the Go source of truth)
//   - this list (the TypeScript mirror)
//   - the text package's editor schema (must not include these keys
//     in any user-driven transaction)
//   - the docx translator's custom XML mapping
export const PROTECTED_YJS_ROOT_KEYS = ['clientAuthors', 'clientFirstSeen', 'editEvents'] as const

export type ProtectedYjsRootKey = (typeof PROTECTED_YJS_ROOT_KEYS)[number]
