import { Mark, mergeAttributes } from '@tiptap/core'

import type { SerializedMarks } from './suggestion-types'

/**
 * SuggestedFormatChange TipTap mark.
 *
 * Inline mark applied to text whose mark set (bold/italic/underline/
 * strike/link/color/font/…) has been proposed for change in a
 * suggesting-mode edit. Carries the originating suggestionId, authorId
 * (the user who proposed the format change), ts (proposal timestamp in
 * Unix ms), and the before/after mark sets as SerializedMarks so the
 * resolver can either reapply the original marks (reject) or apply the
 * proposed marks (accept) over the affected range.
 *
 * SerializedMarks rather than plain string[] because mark attributes
 * matter for accept/reject — a link's href, a textColor's color, a
 * fontSize's size all need to round-trip alongside the type name.
 *
 * Both parseHTML and renderHTML are required so that the mark
 * survives the y-prosemirror serialization boundary (the WebView
 * editor's Yjs round-trip) AND round-trips through docx export/import
 * (phase 5 docx work via WordZero's w:rPrChange — the run-property
 * revision element). The parseHTML tag selector requires all the
 * required data attributes — a span without any of them is not
 * reparsed as a suggestedFormatChange, matching the codebase idiom
 * established by SuggestedInsert / SuggestedDelete for surviving
 * malformed input without crashing.
 *
 * Phase 2 added the suggest-mode command layer that creates
 * SuggestedInsert / SuggestedDelete marks; phase 5 extends it to
 * create SuggestedFormatChange marks when the user toggles formatting
 * in suggesting mode. Phase 5 also adds the docx round-trip via
 * WordZero's w:rPrChange.
 */

export interface SuggestedFormatChangeAttrs {
    suggestionId: string
    authorId: string
    ts: number
    before: SerializedMarks
    after: SerializedMarks
}

// Helpers shared between parseHTML and renderHTML for the URI-encoded
// JSON attributes that store the before/after mark sets. Encoding is
// necessary because the payload contains JSON-special characters
// (quotes, braces, brackets) that can't round-trip through HTML
// attribute values safely. Parse failures return null so the mark is
// silently dropped — matching SuggestedBlockChange's "silent-drop on
// bad data, no throws" convention.
function parseSerializedMarks(raw: string | null): SerializedMarks | null {
    if (!raw) return null
    try {
        const decoded = decodeURIComponent(raw)
        const parsed = JSON.parse(decoded)
        if (!Array.isArray(parsed)) return null
        return parsed as SerializedMarks
    } catch {
        return null
    }
}

function renderSerializedMarks(value: SerializedMarks): string {
    return encodeURIComponent(JSON.stringify(value))
}

export const SuggestedFormatChange = Mark.create({
    name: 'suggestedFormatChange',
    // inclusive: false because the command layer (command-layer.ts)
    // explicitly calls addMark on exact ranges; we never want a
    // previous user's mark to carry forward onto another user's
    // adjacent keystrokes. Same Case 2c stacking pattern established
    // by SuggestedInsert / SuggestedDelete.
    inclusive: false,
    // excludes: '' lets multiple suggestedFormatChange marks coexist
    // on the same range, recording each contributing author's format
    // proposal independently. Spec Case 2c: two users proposing
    // different format changes both register their suggestionId.
    // Without this, PM's default (excludes: name) would replace the
    // earlier mark.
    excludes: '',

    addAttributes() {
        return {
            suggestionId: {
                default: null,
                parseHTML: el => el.getAttribute('data-suggestion-id'),
                renderHTML: attrs => {
                    if (!attrs.suggestionId) {
                        return {}
                    }
                    return { 'data-suggestion-id': attrs.suggestionId }
                },
            },
            authorId: {
                default: null,
                parseHTML: el => el.getAttribute('data-author-id'),
                renderHTML: attrs => {
                    if (!attrs.authorId) {
                        return {}
                    }
                    return { 'data-author-id': attrs.authorId }
                },
            },
            ts: {
                default: null,
                parseHTML: el => {
                    const v = el.getAttribute('data-ts')
                    const n = v ? Number(v) : Number.NaN
                    return Number.isFinite(n) ? n : null
                },
                renderHTML: attrs => {
                    if (typeof attrs.ts !== 'number' || !Number.isFinite(attrs.ts)) {
                        return {}
                    }
                    return { 'data-ts': String(attrs.ts) }
                },
            },
            before: {
                default: null,
                parseHTML: el => parseSerializedMarks(el.getAttribute('data-before')),
                renderHTML: attrs => {
                    const value = (attrs as { before: SerializedMarks | null }).before
                    if (!Array.isArray(value)) return {}
                    return { 'data-before': renderSerializedMarks(value) }
                },
            },
            after: {
                default: null,
                parseHTML: el => parseSerializedMarks(el.getAttribute('data-after')),
                renderHTML: attrs => {
                    const value = (attrs as { after: SerializedMarks | null }).after
                    if (!Array.isArray(value)) return {}
                    return { 'data-after': renderSerializedMarks(value) }
                },
            },
        }
    },

    parseHTML() {
        return [
            {
                tag: 'span[data-suggested-format-change][data-suggestion-id][data-author-id][data-ts][data-before][data-after]',
            },
        ]
    },

    renderHTML({ HTMLAttributes }) {
        return [
            'span',
            mergeAttributes({ 'data-suggested-format-change': '' }, HTMLAttributes),
            0,
        ]
    },
})
