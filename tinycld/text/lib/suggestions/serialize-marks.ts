import type { Mark, Schema } from '@tiptap/pm/model'

import type { SerializedMarks } from '../../webview-editor/source/suggestions/suggestion-types'

// serialize-marks converts ProseMirror Mark[] to/from the
// SerializedMarks JSON shape used by suggestedFormatChange's
// before/after attributes. Mark attributes (link href, textColor
// color, fontSize size, …) are preserved so the resolver can fully
// reconstruct the proposed mark set on accept.
//
// Unknown mark types during deserialize are silently dropped (rather
// than thrown) so a docx import with an unknown formatting kind
// doesn't crash the editor — the suggestion still resolves, just
// without the unknown mark. Same silent-drop philosophy as
// SuggestedInsert / SuggestedDelete / SuggestedBlockChange parseHTML.

export function serializeMarks(marks: readonly Mark[]): SerializedMarks {
    return marks.map(m => {
        const entry: { type: string; attrs?: Record<string, unknown> } = { type: m.type.name }
        const attrs = m.attrs
        if (attrs && Object.keys(attrs).length > 0) {
            entry.attrs = { ...attrs }
        }
        return entry
    })
}

export function deserializeMarks(serialized: SerializedMarks, schema: Schema): Mark[] {
    const out: Mark[] = []
    for (const entry of serialized) {
        const markType = schema.marks[entry.type]
        if (!markType) continue
        out.push(markType.create(entry.attrs ?? null))
    }
    return out
}
