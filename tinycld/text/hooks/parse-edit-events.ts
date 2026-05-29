import type {
    EditEvent,
    EditEventAffectedNode,
} from '../webview-editor/source/suggestions/suggestion-types'

// parseEditEvent reads an arbitrary Y.Array entry and returns a typed
// EditEvent, or null if any required field is missing or malformed.
// Mirrors the server-side wire shape from edit_event_writer.go.
export function parseEditEvent(raw: unknown): EditEvent | null {
    if (raw === null || typeof raw !== 'object') return null
    const v = raw as Record<string, unknown>
    if (typeof v.clientId !== 'number') return null
    if (typeof v.authorId !== 'string') return null
    if (typeof v.startedAt !== 'number') return null
    if (typeof v.endedAt !== 'number') return null
    if (typeof v.editCount !== 'number') return null
    const affectedNodes = parseAffectedNodes(v.affectedNodes)
    return {
        clientId: v.clientId,
        authorId: v.authorId,
        startedAt: v.startedAt,
        endedAt: v.endedAt,
        editCount: v.editCount,
        affectedNodes,
    }
}

function parseAffectedNodes(raw: unknown): EditEventAffectedNode[] {
    if (!Array.isArray(raw)) return []
    const out: EditEventAffectedNode[] = []
    for (const item of raw) {
        if (item === null || typeof item !== 'object') continue
        const entry = item as Record<string, unknown>
        if (typeof entry.nodeId !== 'string' || typeof entry.snippet !== 'string')
            continue
        out.push({ nodeId: entry.nodeId, snippet: entry.snippet })
    }
    return out
}
