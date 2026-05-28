import { Extension } from '@tiptap/core'
import type { EditorState } from '@tiptap/pm/state'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { colorForUser } from '../color-for-user'

const PLUGIN_KEY = new PluginKey<DecorationSet>('tinycld:suggestion-decorations')

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
// every text node carrying suggestedInsert or suggestedDelete marks.
// Co-existing marks (the spec's Case 2b layered scenario) produce
// stacked decorations — both render on the same range with their own
// spec.kind for later querying.
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
