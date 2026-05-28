import { Extension } from '@tiptap/core'

import type { SuggestedBlockChange as Payload } from './suggestion-types'

// Block-level nodes the suggestedBlockChange attribute is added to.
// Mirrors the spec's TARGET_NODE_TYPES list. Tiptap's
// addGlobalAttributes silently skips entries from this list that
// aren't in the active editor's schema, so a lean editor build
// without (e.g.) a table extension won't fail here — tableCell
// just won't get the attribute because the node doesn't exist.
const TARGET_NODE_TYPES = ['paragraph', 'heading', 'listItem', 'blockquote', 'tableCell']

/**
 * SuggestedBlockChange TipTap extension.
 *
 * Adds a `suggestedBlockChange` attribute to block-level nodes
 * (paragraph, heading, listItem, blockquote, tableCell). Unlike
 * SuggestedInsert / SuggestedDelete (which are inline marks),
 * structural changes — toggling a paragraph to a heading, splitting
 * a list item, indenting a blockquote — are recorded as a node
 * attribute carrying `{ suggestionId, authorId, ts, before, after }`.
 *
 * Phase 2's renderer uses `before` to show the original structure
 * and `after` to show the proposed structure with a colored gutter
 * indicator. Accept replaces the node with `after`; reject reverts
 * to `before`. Phase 5 maps this to docx's w:pPrChange (the
 * paragraph-property-change revision element) in WordZero.
 *
 * Serialization: the payload is JSON.stringify'd and URI-encoded
 * into a `data-block-change` attribute on the node's DOM
 * representation. URI encoding is necessary because the payload
 * contains JSON-special characters (quotes, braces) that can't
 * round-trip through HTML attribute values safely. On parse, a
 * malformed value (not URI-decodable or not valid JSON) returns
 * null — silent-drop matching the local codebase convention
 * established by SuggestedInsert / SuggestedDelete (parseHTML
 * tightening + silent omission on bad data, no throws).
 *
 * addGlobalAttributes silently skips nodes from TARGET_NODE_TYPES
 * that aren't in the editor's schema. This is the desired behavior:
 * an editor without a tableCell extension (no tables) won't fail
 * here — it just won't have suggestedBlockChange on its (absent)
 * tableCells.
 */
export const SuggestedBlockChange = Extension.create({
    name: 'suggestedBlockChange',

    addGlobalAttributes() {
        return [
            {
                types: TARGET_NODE_TYPES,
                attributes: {
                    suggestedBlockChange: {
                        default: null,
                        // Phase 1 does not validate payload shape — the
                        // schema accepts any JSON-parsable object as
                        // suggestedBlockChange. Phase 2's command layer is
                        // responsible for producing well-formed
                        // { suggestionId, authorId, ts, before, after } payloads.
                        parseHTML: el => {
                            const raw = el.getAttribute('data-block-change')
                            if (!raw) return null
                            try {
                                const decoded = decodeURIComponent(raw)
                                return JSON.parse(decoded)
                            } catch {
                                return null
                            }
                        },
                        renderHTML: attrs => {
                            const value = (attrs as { suggestedBlockChange: Payload | null })
                                .suggestedBlockChange
                            if (!value) return {}
                            return {
                                'data-block-change': encodeURIComponent(JSON.stringify(value)),
                            }
                        },
                    },
                },
            },
        ]
    },
})

// Re-export the payload type under a non-colliding name so callers
// can pull both the extension and the attribute shape from one
// module without reaching into suggestion-types.
export type { SuggestedBlockChange as SuggestedBlockChangeAttrs } from './suggestion-types'
