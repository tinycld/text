import type { Mark, Node as PMNode } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { AddMarkStep, RemoveMarkStep } from '@tiptap/pm/transform'
import type { SerializedMarks } from '../../webview-editor/source/suggestions/suggestion-types'
import { serializeMarks } from './serialize-marks'

// MarkToggle describes a single AddMark/RemoveMark step the user
// initiated. A single editor command (e.g. toggleBold) often emits
// multiple steps when the range has mixed mark state — we batch them
// by range and collapse into a single suggestedFormatChange.
export interface MarkToggle {
    from: number
    to: number
    mark: Mark
    isAdd: boolean
}

// Scan the transaction's steps. Return ordered MarkToggle entries
// (preserving relative order) for AddMarkStep / RemoveMarkStep.
// Returns empty array if no mark steps are present. Other step kinds
// (ReplaceStep, ReplaceAroundStep, …) are ignored — the command layer's
// existing ReplaceStep branch handles those.
//
// Steps touching suggestion-tracking marks themselves (suggestedInsert
// / suggestedDelete / suggestedFormatChange / suggestedBlockChange)
// are filtered out — those originate from the resolve layer
// (acceptSuggestion / rejectSuggestion call tr.removeMark on these
// types), not from a user formatting command. Without this filter
// the command layer would loop a resolve into a fresh
// suggestedFormatChange of "removing a suggestion mark", which makes
// no sense and breaks bulkAccept / bulkReject.
export function extractMarkToggles(tr: Transaction): MarkToggle[] {
    const out: MarkToggle[] = []
    for (const step of tr.steps) {
        if (step instanceof AddMarkStep) {
            if (isSuggestionTrackingMarkName(step.mark.type.name)) continue
            out.push({ from: step.from, to: step.to, mark: step.mark, isAdd: true })
        } else if (step instanceof RemoveMarkStep) {
            if (isSuggestionTrackingMarkName(step.mark.type.name)) continue
            out.push({ from: step.from, to: step.to, mark: step.mark, isAdd: false })
        }
    }
    return out
}

function isSuggestionTrackingMarkName(name: string): boolean {
    return (
        name === 'suggestedInsert' ||
        name === 'suggestedDelete' ||
        name === 'suggestedFormatChange' ||
        name === 'suggestedBlockChange'
    )
}

// Collect the union of marks present anywhere in [from, to). Returns
// the marks deduped by type+attrs (first occurrence wins). Used to
// compute the before/after snapshots that feed suggestedFormatChange's
// attrs.
export function marksAtRange(doc: PMNode, from: number, to: number): Mark[] {
    const out: Mark[] = []
    const seen = new Set<string>()
    doc.nodesBetween(from, to, node => {
        for (const m of node.marks ?? []) {
            const key = `${m.type.name}:${JSON.stringify(m.attrs ?? {})}`
            if (seen.has(key)) continue
            seen.add(key)
            out.push(m)
        }
    })
    return out
}

// Combine a list of MarkToggle entries into a single (from, to, before,
// after) descriptor covering the full affected range. before is the
// union of marks present at any character in the range BEFORE the
// toggles applied. after is the union of marks present AFTER (in the
// original transaction's final doc).
//
// We use a coarse approximation: from = min(toggles.from),
// to = max(toggles.to), with before/after pulled directly from the
// pre- and post- states' docs at that range. This is correct for the
// common cases (single toggleBold over a uniform range, multi-mark
// toggleBold over a range). Edge cases (toggling marks that have
// differing attrs across the range, partial overlaps with prior
// suggested* marks) collapse to a single suggestion that captures
// the user's overall intent — the resolver reapplies the after-set
// (accept) or the before-set (reject) over the whole range.
//
// Suggestion marks (suggestedInsert/Delete/BlockChange/FormatChange)
// are filtered out of before/after so the format-change attrs only
// record content-level marks — without this filter, an enclosing
// suggestedInsert from a prior author would bleed into the format
// before-set and round-trip as a "content mark" on accept.
export function summarizeToggles(
    toggles: MarkToggle[],
    originalState: EditorState,
    finalState: EditorState
): { from: number; to: number; before: SerializedMarks; after: SerializedMarks } {
    const from = Math.min(...toggles.map(t => t.from))
    const to = Math.max(...toggles.map(t => t.to))
    const beforeMarks = marksAtRange(originalState.doc, from, to).filter(isContentMark)
    const afterMarks = marksAtRange(finalState.doc, from, to).filter(isContentMark)
    return {
        from,
        to,
        before: serializeMarks(beforeMarks),
        after: serializeMarks(afterMarks),
    }
}

// isContentMark filters out suggestion-tracking marks so they don't
// leak into the before/after snapshots of a format change. The before/
// after sets exist to drive accept/reject of the FORMAT change itself;
// pulling a suggestedInsert through into "after" would, on accept,
// reapply that insert mark — wrong.
function isContentMark(m: Mark): boolean {
    return !isSuggestionTrackingMarkName(m.type.name)
}
