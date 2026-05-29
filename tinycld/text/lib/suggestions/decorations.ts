import { Extension } from '@tiptap/core'
import type { EditorState } from '@tiptap/pm/state'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { SerializedMarks } from '../../webview-editor/source/suggestions/suggestion-types'
import { colorForUser } from '../color-for-user'

const PLUGIN_KEY = new PluginKey<DecorationSet>('tinycld:suggestion-decorations')

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

// buildDecorations walks the doc and emits inline decorations for
// every text node carrying suggestedInsert, suggestedDelete, or
// suggestedFormatChange marks. Co-existing marks (the spec's Case 2b
// layered scenario) produce stacked decorations — they render on the
// same range with their own spec.kind for later querying.
//
// suggestedFormatChange gets a thin colored underline (the author's
// color) with a hover tooltip summarizing the before→after delta. The
// raw bold/italic/link mark itself was reverted by the command layer
// when it stamped the suggestion, so the underline is what tells the
// reader "a format change is pending here" without prematurely
// rendering the change as if accepted.
function buildDecorations(state: EditorState): DecorationSet {
    const decos: Decoration[] = []
    state.doc.descendants((node, pos) => {
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
