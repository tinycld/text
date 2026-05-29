import type {
    BlockChangeAfter,
    BlockChangeBefore,
    SerializedMarks,
} from '../../webview-editor/source/suggestions/suggestion-types'
import { summarizeBlockChange, summarizeFormatChange } from './decorations'

// Payload shape posted by the WebView's suggestion-popover plugin on
// show-popover (see lib/suggestions/popover.ts). Phase 2b's layered-
// marks change widens the payload from a single suggestionId to a
// suggestions[] array — Case 2b/2c stacked marks at a click position
// surface as multiple entries, one row per (suggestionId, kind).
//
// Phase 5 widens the kind union to include format-change, block-change,
// and cell-change. Entries of those kinds carry their before/after
// payloads so the popover can summarize the proposed delta inline
// ("Proposed: add bold", "Proposed: change to heading 2").
//
// The shape lives in this file (rather than next to the React
// component in components/SuggestionPopover.tsx) so the pure summary
// helper can be unit-tested without dragging the full RN component
// (and its Button → @gluestack-ui Flow-typed dependency chain) into
// the test environment.
export interface SuggestionPopoverEntry {
    id: string
    authorId: string
    kind: 'insert' | 'delete' | 'format-change' | 'block-change' | 'cell-change'
    beforeMarks?: SerializedMarks
    afterMarks?: SerializedMarks
    beforeBlock?: BlockChangeBefore
    afterBlock?: BlockChangeAfter
}

// summarizeSuggestionEntry composes the "Proposed: …" line shown
// beneath each suggestion in the popover and drawer row. The output
// is "Proposed: <delta>" — e.g. "Proposed: add bold" for a
// format-change, "Proposed: change to heading 2" for a block-change.
//
// The kind-specific delta is sourced from the shared helpers in
// decorations.ts (summarizeFormatChange, summarizeBlockChange) so the
// popover's text matches the inline decoration tooltip the user
// already sees on hover. Identical wording across surfaces avoids
// the "is the popover saying the same thing as the inline hint?"
// lookup cost.
//
// For insert/delete, where the summary is the literal snippet
// content, we return null and the caller falls back to its existing
// snippet rendering. That keeps the established Phase 2a look for
// the original two kinds unchanged while layering on the new copy
// for the Phase 5 kinds.
export function summarizeSuggestionEntry(entry: SuggestionPopoverEntry): string | null {
    if (entry.kind === 'insert' || entry.kind === 'delete') return null
    if (entry.kind === 'format-change') {
        const before = entry.beforeMarks ?? []
        const after = entry.afterMarks ?? []
        return `Proposed: ${summarizeFormatChange(before, after)}`
    }
    // block-change or cell-change: both use the same summary helper
    // because BLOCK_TYPE_LABELS in decorations.ts already covers
    // tableCell/tableHeader. The cell-change kind is a UI distinction
    // for the kind column glyph; the summary text is identical.
    const before = entry.beforeBlock
    const after = entry.afterBlock
    if (!before || !after) return null
    return `Proposed: ${summarizeBlockChange(before, after)}`
}
