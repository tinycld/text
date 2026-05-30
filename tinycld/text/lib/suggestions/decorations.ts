import { Extension } from '@tiptap/core'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { AddMarkStep, AttrStep, RemoveMarkStep, ReplaceStep } from '@tiptap/pm/transform'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type {
    BlockChangeAfter,
    BlockChangeBefore,
    SerializedMarks,
} from '../../webview-editor/source/suggestions/suggestion-types'
import { colorForUser } from '../color-for-user'

const PLUGIN_KEY = new PluginKey<DecorationSet>('tinycld:suggestion-decorations')

// Mark type names whose presence the plugin renders. Kept as a Set so
// the per-step probe (transactionMayIntroduceSuggestions) is an O(1)
// lookup. Mirrored from the buildDecorations switch below — keep these
// in sync if a new suggestion mark kind is added.
const SUGGESTION_MARK_TYPES = new Set([
    'suggestedInsert',
    'suggestedDelete',
    'suggestedFormatChange',
])

// Node attribute name whose presence on a block node the plugin
// renders. Same in-sync caveat as SUGGESTION_MARK_TYPES.
const SUGGESTION_BLOCK_CHANGE_ATTR = 'suggestedBlockChange'

// transactionMayIntroduceSuggestions returns true iff `tr` contains a
// step that could plausibly add a suggestion mark or set the
// suggestedBlockChange node attribute. False positives are safe (they
// just trigger a needless full-doc walk that produces an unchanged
// DecorationSet); false negatives would silently drop legitimate
// decorations, so we err generous:
//
//   - AddMarkStep on a suggestion mark type → yes
//   - RemoveMarkStep on a suggestion mark type → yes (in case the
//     existing decoration set was empty due to a transient race; the
//     walk produces an empty set on no-op, cheap to verify)
//   - AttrStep setting the suggestedBlockChange attribute → yes
//   - ReplaceStep whose slice content carries any suggestion mark or
//     a node with the suggestedBlockChange attribute → yes (covers
//     pasting suggesting-marked content, undo restoring a deletion,
//     and the command-layer's restore+mark step in suggesting mode)
//
// All other steps (typing in editing mode, normal format toggles,
// caret moves, scroll, etc.) return false — the dominant case where
// the per-keystroke perf gate matters.
function transactionMayIntroduceSuggestions(tr: Transaction): boolean {
    for (const step of tr.steps) {
        if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
            if (SUGGESTION_MARK_TYPES.has(step.mark.type.name)) return true
            continue
        }
        if (step instanceof AttrStep) {
            if (step.attr === SUGGESTION_BLOCK_CHANGE_ATTR) return true
            continue
        }
        if (step instanceof ReplaceStep) {
            const slice = step.slice
            if (slice.content.size === 0) continue
            let found = false
            slice.content.descendants(node => {
                if (found) return false
                if (node.isText) {
                    for (const mark of node.marks) {
                        if (SUGGESTION_MARK_TYPES.has(mark.type.name)) {
                            found = true
                            return false
                        }
                    }
                    return false
                }
                const attr = node.attrs[SUGGESTION_BLOCK_CHANGE_ATTR]
                if (attr !== undefined && attr !== null) {
                    found = true
                    return false
                }
                return true
            })
            if (found) return true
            continue
        }
        // Unknown step type — be conservative and walk. Custom steps
        // are rare on the text editor; we'd rather pay one walk than
        // miss a suggestion stamp from a future extension.
        return true
    }
    return false
}

// decorationSetIsEmpty reports whether the given DecorationSet contains
// zero decorations. DecorationSet.find() with no args returns every
// decoration in the set; checking .length is the cheapest way to
// detect "the plugin has nothing rendered today" — the precondition
// for skipping the buildDecorations walk on a transaction that also
// doesn't introduce any new suggestion content.
function decorationSetIsEmpty(set: DecorationSet): boolean {
    return set.find().length === 0
}

// Human-readable mark names for the tooltip. Falls back to the raw
// type name when the schema includes a mark we don't have a friendly
// label for — better than a cryptic abbreviation, but the common
// formatting marks all get nice names.
const MARK_LABELS: Record<string, string> = {
    bold: 'bold',
    italic: 'italic',
    underline: 'underline',
    strike: 'strikethrough',
    code: 'code',
    link: 'link',
    textStyle: 'text style',
    textColor: 'color',
    fontSize: 'font size',
    fontFamily: 'font',
    highlight: 'highlight',
    subscript: 'subscript',
    superscript: 'superscript',
}

function labelForMark(entry: { type: string }): string {
    return MARK_LABELS[entry.type] ?? entry.type
}

// summarizeFormatChange composes a brief human-readable description of
// the before→after delta. Cases (in priority order):
//   - both before and after empty → 'change formatting' (defensive
//     fallback; the command layer never stamps an empty/empty)
//   - after has marks not in before AND before has marks not in after
//     → 'change <added>/<removed>' framing
//   - only additions → 'add <a>, <b>'
//   - only removals → 'remove <a>, <b>'
// We diff by mark type name (not full attrs) because the typical
// proposal is "add bold" / "remove italic" — attribute changes (link
// href, color value) are still summarized as "change <type>".
export function summarizeFormatChange(before: SerializedMarks, after: SerializedMarks): string {
    const beforeTypes = new Set(before.map(m => m.type))
    const afterTypes = new Set(after.map(m => m.type))
    const added: string[] = []
    const removed: string[] = []
    const changed: string[] = []

    for (const entry of after) {
        if (!beforeTypes.has(entry.type)) {
            added.push(labelForMark(entry))
            continue
        }
        const beforeEntry = before.find(b => b.type === entry.type)
        // Same type on both sides — if attrs differ, treat as a change.
        const sameAttrs =
            JSON.stringify(beforeEntry?.attrs ?? {}) === JSON.stringify(entry.attrs ?? {})
        if (!sameAttrs) {
            changed.push(`change ${labelForMark(entry)}`)
        }
    }
    for (const entry of before) {
        if (!afterTypes.has(entry.type)) {
            removed.push(labelForMark(entry))
        }
    }

    const parts: string[] = []
    if (added.length > 0) parts.push(`add ${added.join(', ')}`)
    if (removed.length > 0) parts.push(`remove ${removed.join(', ')}`)
    parts.push(...changed)
    if (parts.length === 0) return 'change formatting'
    return parts.join('; ')
}

// buildFormatChangeTooltip composes the title-attribute string shown
// on hover: "Proposed by {authorId}: {summary}". The authorId is shown
// raw rather than resolved to a display name — the decoration plugin
// has no async access to the org membership table, and the popover
// (which renders on click) is the place that does richer attribution.
function buildFormatChangeTooltip(
    authorId: string,
    before: SerializedMarks,
    after: SerializedMarks
): string {
    return `Proposed by ${authorId}: ${summarizeFormatChange(before, after)}`
}

// Human-readable labels for the block-level node types that
// suggestedBlockChange targets. Covers both block-change-utils's
// TARGET_BLOCK_TYPES (paragraph / heading / listItem / blockquote)
// and table-change-utils's cell types (tableCell / tableHeader).
// If a future schema introduces a new block type without a label
// here, the raw type name is used as a fallback.
const BLOCK_TYPE_LABELS: Record<string, string> = {
    paragraph: 'paragraph',
    heading: 'heading',
    listItem: 'list item',
    bulletList: 'bullet list',
    orderedList: 'ordered list',
    blockquote: 'blockquote',
    tableCell: 'cell',
    tableHeader: 'header cell',
}

function labelForBlockType(type: string, attrs?: Record<string, unknown>): string {
    const base = BLOCK_TYPE_LABELS[type] ?? type
    // Heading gets the level appended ("heading 2") so the tooltip
    // distinguishes between heading levels — they're the most common
    // type-swap target and the distinction matters to the reader.
    if (type === 'heading' && attrs && typeof attrs.level === 'number') {
        return `heading ${attrs.level}`
    }
    return base
}

// Human-readable labels for common block-level attributes. The
// suggestedBlockChange payload's attr diff is shown as
// "<attr-label>: <value>" — e.g. "alignment: center", "heading level: 2".
//
// Cell-specific attrs (colspan/rowspan/colwidth) get human-readable
// labels too, so the tooltip on a setCellAttribute proposal reads
// "column span: 2" rather than "colspan: 2".
const BLOCK_ATTR_LABELS: Record<string, string> = {
    level: 'heading level',
    textAlign: 'alignment',
    indent: 'indent',
    blockIndent: 'indent',
    colspan: 'column span',
    rowspan: 'row span',
    colwidth: 'column width',
}

function labelForBlockAttr(attr: string): string {
    return BLOCK_ATTR_LABELS[attr] ?? attr
}

// diffBlockAttrs returns the keys whose values differ between before
// and after. Used by summarizeBlockChange to compose the "attr: value"
// fragments. We compare via JSON.stringify rather than deep equality —
// block attrs are always JSON-serializable (level: number, textAlign:
// string, indent: number) so the round-trip is safe and the stringify
// catches null/undefined parity cleanly.
function diffBlockAttrs(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
    const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)])
    const changed: string[] = []
    for (const key of keys) {
        if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
            changed.push(key)
        }
    }
    return changed
}

// summarizeBlockChange composes a brief human-readable description of
// a block-level proposal. Cases (in priority order):
//   - before.added === true → "add <block type>" ("add cell"). Phase 5
//     table addRow / addColumn proposals carry this sentinel; the cell
//     didn't exist before the suggestion, so the before-state has no
//     meaningful type/attrs to summarize — only "added" matters.
//   - after.deleted === true → "delete <block type>" ("delete paragraph"
//     / "delete cell").
//   - Type change with attr difference → "change to <after type> (<attr fragments>)"
//     ("change to heading 2 (left-aligned)"). Same-type-but-different-
//     level headings flow through this branch because the type label
//     ("heading 2") already captures the level distinction.
//   - Type change only → "change to <after type>" ("change to bullet list").
//   - Attr change only → "<attr label>: <value>" ("alignment: center",
//     "heading level: 2"). Multiple attr changes join with semicolons.
//   - Defensive fallback (no recognizable difference) → "change block".
export function summarizeBlockChange(before: BlockChangeBefore, after: BlockChangeAfter): string {
    if (before.added === true) {
        return `add ${labelForBlockType(after.type, after.attrs)}`
    }
    if (after.deleted === true) {
        return `delete ${labelForBlockType(before.type, before.attrs)}`
    }
    if (before.type !== after.type) {
        const targetLabel = labelForBlockType(after.type, after.attrs)
        // Don't list the level under "(…)" for heading swaps — it's
        // already in the target label ("heading 2").
        const diffKeys = diffBlockAttrs(before.attrs, after.attrs).filter(
            k => !(after.type === 'heading' && k === 'level')
        )
        if (diffKeys.length === 0) {
            return `change to ${targetLabel}`
        }
        const fragments = diffKeys
            .map(k => `${labelForBlockAttr(k)}: ${formatAttrValue(after.attrs[k])}`)
            .join(', ')
        return `change to ${targetLabel} (${fragments})`
    }
    // Same type — pure attr change.
    const diffKeys = diffBlockAttrs(before.attrs, after.attrs)
    if (diffKeys.length === 0) return 'change block'
    return diffKeys
        .map(k => `${labelForBlockAttr(k)}: ${formatAttrValue(after.attrs[k])}`)
        .join('; ')
}

// formatAttrValue renders an attr value for display in the tooltip.
// Strings ("center", "left") render verbatim; numbers stringify;
// null/undefined render as "default" (so "alignment: default" is a
// legible way to say "reset to the document default"). Other types
// fall back to JSON for legibility.
function formatAttrValue(value: unknown): string {
    if (value === null || value === undefined) return 'default'
    if (typeof value === 'string') return value
    if (typeof value === 'number') return String(value)
    return JSON.stringify(value)
}

function buildBlockChangeTooltip(
    authorId: string,
    before: BlockChangeBefore,
    after: BlockChangeAfter
): string {
    return `Proposed by ${authorId}: ${summarizeBlockChange(before, after)}`
}

// colorForUser returns 'hsl(<hue>, 70%, 45%)'. For the background tint
// we want a low-opacity version of the same hue; rewriting the prefix
// to 'hsla(' and appending an alpha component yields a valid CSS color
// without re-parsing the string. If the upstream helper ever changes
// format (e.g. hex), this helper is the single point to update.
function withAlpha(color: string, alpha: number): string {
    if (color.startsWith('hsl(') && color.endsWith(')')) {
        return `hsla(${color.slice(4, -1)}, ${alpha})`
    }
    return color
}

// Fixed colors for cell add/delete states. Unlike the
// paragraph/heading gutter bar (which uses the author's deterministic
// color so multi-author docs are visually distinct), cell-level
// add/delete proposals are shown in semantic green/red so the table
// reader instantly recognizes the meaning without needing color-key
// recall. Cell-attr changes retain the author color — that's a
// structural-attribute change, not an addition or removal.
const CELL_ADDED_COLOR = 'hsl(140, 60%, 40%)'
const CELL_DELETED_COLOR = 'hsl(0, 70%, 45%)'

// buildBlockChangeStyle composes the inline CSS string for a
// suggestedBlockChange node decoration. Branches:
//   - non-cell + delete   → 3px author-colored left border + opacity 0.5
//   - non-cell + add      → 3px author-colored left border (cells use
//                           the added sentinel; non-cell adds don't
//                           exist in Phase 5 but the branch is safe)
//   - non-cell + attr/swap → 3px author-colored left border, no opacity
//   - cell + added         → 2px green left + top borders
//   - cell + deleted       → 2px red left + bottom borders + opacity 0.5
//   - cell + attr/swap     → 2px author-colored left border
//
// The 2px width on cells (vs 3px on blocks) is tighter so the gutter
// bar doesn't visually shrink the cell's usable area too aggressively
// in a dense table. The added/deleted edges (top for added, bottom for
// deleted) provide a secondary directional cue without needing the
// reader to recall the green-vs-red convention.
function buildBlockChangeStyle(args: {
    isCell: boolean
    isAdded: boolean
    isDeleted: boolean
    color: string
}): string {
    const { isCell, isAdded, isDeleted, color } = args
    if (!isCell) {
        const base = `border-left: 3px solid ${color}; padding-left: 8px;`
        return isDeleted ? `${base} opacity: 0.5;` : base
    }
    if (isAdded) {
        return `border-left: 2px solid ${CELL_ADDED_COLOR}; border-top: 2px solid ${CELL_ADDED_COLOR};`
    }
    if (isDeleted) {
        return `border-left: 2px solid ${CELL_DELETED_COLOR}; border-bottom: 2px solid ${CELL_DELETED_COLOR}; opacity: 0.5;`
    }
    return `border-left: 2px solid ${color};`
}

// buildDecorations walks the doc and emits inline decorations for
// every text node carrying suggestedInsert, suggestedDelete, or
// suggestedFormatChange marks, plus a node decoration for each
// block-level node carrying a suggestedBlockChange attribute.
// Co-existing marks (the spec's Case 2b layered scenario) produce
// stacked decorations — they render on the same range with their own
// spec.kind for later querying.
//
// suggestedFormatChange gets a thin colored underline (the author's
// color) with a hover tooltip summarizing the before→after delta. The
// raw bold/italic/link mark itself was reverted by the command layer
// when it stamped the suggestion, so the underline is what tells the
// reader "a format change is pending here" without prematurely
// rendering the change as if accepted.
//
// suggestedBlockChange gets a colored left-gutter bar on the affected
// block (a 3px solid border in the author's color). For "delete" sub-
// case, the gutter bar is combined with a 0.5 opacity overlay on the
// block content to visually signal proposed removal. Type/attr swaps
// render with only the gutter bar — the user's structural change was
// reverted by the command layer, so the gutter is the sole signal.
function buildDecorations(state: EditorState): DecorationSet {
    const decos: Decoration[] = []
    state.doc.descendants((node, pos) => {
        // Block-level nodes can carry a suggestedBlockChange attribute
        // even though they aren't text. We check this branch first; the
        // remaining mark-based branches only apply to text nodes.
        const blockChange = node.attrs.suggestedBlockChange as unknown
        if (blockChange && typeof blockChange === 'object') {
            const payload = blockChange as {
                suggestionId?: unknown
                authorId?: unknown
                before?: unknown
                after?: unknown
            }
            if (
                typeof payload.suggestionId === 'string' &&
                typeof payload.authorId === 'string' &&
                payload.before &&
                typeof payload.before === 'object' &&
                payload.after &&
                typeof payload.after === 'object'
            ) {
                const authorId = payload.authorId
                const before = payload.before as BlockChangeBefore
                const after = payload.after as BlockChangeAfter
                const color = colorForUser(authorId)
                const tooltip = buildBlockChangeTooltip(authorId, before, after)
                const isCell = node.type.name === 'tableCell' || node.type.name === 'tableHeader'
                const style = buildBlockChangeStyle({
                    isCell,
                    isAdded: before.added === true,
                    isDeleted: after.deleted === true,
                    color,
                })
                const cssClass = isCell
                    ? 'tinycld-suggestion-block-change tinycld-suggestion-cell-change'
                    : 'tinycld-suggestion-block-change'
                decos.push(
                    Decoration.node(
                        pos,
                        pos + node.nodeSize,
                        {
                            class: cssClass,
                            style,
                            title: tooltip,
                        },
                        {
                            kind: 'suggestedBlockChange',
                            suggestionId: payload.suggestionId,
                            authorId,
                            before,
                            after,
                        }
                    )
                )
            }
        }
        if (!node.isText) return
        for (const mark of node.marks) {
            if (mark.type.name === 'suggestedInsert') {
                const color = colorForUser(mark.attrs.authorId as string)
                decos.push(
                    Decoration.inline(
                        pos,
                        pos + node.nodeSize,
                        {
                            class: 'tinycld-suggestion-insert',
                            // Tinted background (alpha ~0.2) + colored
                            // underline for the author marker. The text
                            // remains the document's regular color; only
                            // the background/underline shift.
                            style: `background-color: ${withAlpha(color, 0.2)}; border-bottom: 1px solid ${color}`,
                        },
                        {
                            kind: 'suggestedInsert',
                            suggestionId: mark.attrs.suggestionId,
                            authorId: mark.attrs.authorId,
                        }
                    )
                )
            } else if (mark.type.name === 'suggestedDelete') {
                const color = colorForUser(mark.attrs.authorId as string)
                decos.push(
                    Decoration.inline(
                        pos,
                        pos + node.nodeSize,
                        {
                            class: 'tinycld-suggestion-delete',
                            // Tinted background + strikethrough + colored
                            // text. The text is still accessible (it's
                            // not hidden), but strikethrough signals
                            // proposed removal.
                            style: `background-color: ${withAlpha(color, 0.2)}; text-decoration: line-through; color: ${color}`,
                        },
                        {
                            kind: 'suggestedDelete',
                            suggestionId: mark.attrs.suggestionId,
                            authorId: mark.attrs.authorId,
                        }
                    )
                )
            } else if (mark.type.name === 'suggestedFormatChange') {
                const authorId = mark.attrs.authorId as string
                const color = colorForUser(authorId)
                const before = Array.isArray(mark.attrs.before)
                    ? (mark.attrs.before as SerializedMarks)
                    : []
                const after = Array.isArray(mark.attrs.after)
                    ? (mark.attrs.after as SerializedMarks)
                    : []
                const tooltip = buildFormatChangeTooltip(authorId, before, after)
                decos.push(
                    Decoration.inline(
                        pos,
                        pos + node.nodeSize,
                        {
                            class: 'tinycld-suggestion-format-change',
                            // 1px solid underline in author color. No
                            // background tint — the raw bold/italic
                            // mark is suppressed (command layer reverts
                            // before stamping), so the only signal is
                            // the underline. Tooltip on hover surfaces
                            // the proposed change.
                            style: `border-bottom: 1px solid ${color}`,
                            title: tooltip,
                        },
                        {
                            kind: 'suggestedFormatChange',
                            suggestionId: mark.attrs.suggestionId,
                            authorId: mark.attrs.authorId,
                            before,
                            after,
                        }
                    )
                )
            }
        }
    })
    return DecorationSet.create(state.doc, decos)
}

// createSuggestionDecorationsPlugin builds the ProseMirror plugin
// without the TipTap wrapper, so unit tests can mount it against a
// raw EditorState without standing up a full Editor / DOM. The TipTap
// extension below uses this factory; both code paths share the exact
// same plugin logic.
export function createSuggestionDecorationsPlugin(): Plugin<DecorationSet> {
    return new Plugin<DecorationSet>({
        key: PLUGIN_KEY,
        state: {
            init: (_config, state) => buildDecorations(state),
            apply: (tr, decoSet, _oldState, newState) => {
                if (!tr.docChanged) return decoSet.map(tr.mapping, tr.doc)
                // Fast path for the common case: a doc with NO suggestion
                // decorations + a transaction that doesn't introduce any.
                // This is every keystroke in an editing-mode doc that
                // happens to live on a workspace where Suggesting has
                // never run. Without this gate the plugin walks
                // state.doc.descendants(...) on every keystroke, paying
                // O(n-doc-nodes) cost users will never see suggestions
                // for. The gate only fires when BOTH conditions hold —
                // we still walk eagerly whenever there's anything to
                // preserve (existing decorations need their positions
                // re-derived) or anything new to draw.
                if (decorationSetIsEmpty(decoSet) && !transactionMayIntroduceSuggestions(tr)) {
                    return DecorationSet.empty
                }
                return buildDecorations(newState)
            },
        },
        props: {
            decorations(state) {
                return PLUGIN_KEY.getState(state) ?? null
            },
        },
    })
}

// SuggestionDecorations renders suggestion marks visually. Author color
// comes from colorForUser — same deterministic hash used by Yjs
// awareness for peer cursors, so a peer's cursor + their suggestion
// match visually.
//
// The decorations recompute on every docChanged transaction; on
// non-doc-changed transactions (e.g. selection), the existing set is
// mapped through the transaction's mapping to stay positionally
// correct.
export const SuggestionDecorations = Extension.create({
    name: 'suggestionDecorations',

    addProseMirrorPlugins() {
        return [createSuggestionDecorationsPlugin()]
    },
})

// getSuggestionDecorations exposes the plugin's DecorationSet from a
// given editor state. Used by the popover (Task 11) to find which
// suggestion(s) are at a clicked position.
export function getSuggestionDecorations(state: EditorState): DecorationSet {
    return PLUGIN_KEY.getState(state) ?? DecorationSet.empty
}
