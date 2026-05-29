// SuggestionClickToFocus — installs a ProseMirror click handler on the
// editor that watches for clicks landing on a suggestion decoration
// (suggestedInsert / suggestedDelete / suggestedFormatChange /
// suggestedBlockChange) and publishes a 'suggestion-clicked' ui-bus
// message carrying the suggestionId. The screen subscribes to that
// message and opens the review drawer focused on the matching row.
//
// Earlier phases shipped an inline tooltip popover here that rendered
// Accept / Reject buttons. That UX was wrong: it forced the viewer to
// act on a single suggestion at a time, didn't resolve the author's
// human name, and competed with the drawer (the canonical
// surface). Now the click is a navigation event that mirrors the
// comments package's onTap → drawer flow.

import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { Decoration } from '@tiptap/pm/view'
import { publishUiMessage } from '../anchored-overlay/ui-message-bus'
import { getSuggestionDecorations } from './decorations'

// The wire-bus message the screen listens for. Single string field —
// the screen looks up its own driveItemId from context. Multiple
// stacked suggestions at the click point are deduped down to one ID
// (the first match in document order); the drawer focuses the
// matching row + the user can see the others in the drawer list.
export interface SuggestionClickedPayload {
    suggestionId: string
}

const PLUGIN_KEY = new PluginKey('tinycld:suggestion-click-to-focus')

// Recognised decoration kinds. Mirrors the decoration plugin's spec
// shape — any of these triggers the drawer focus.
const SUGGESTION_DECO_KINDS = new Set([
    'suggestedInsert',
    'suggestedDelete',
    'suggestedFormatChange',
    'suggestedBlockChange',
])

// firstSuggestionId scans decorations at a click position and returns
// the suggestionId of the first matching suggestion decoration, or
// null when the click missed every suggestion. Multiple decorations
// sharing the same suggestionId (Yjs item splits) collapse — the
// first occurrence wins.
function firstSuggestionId(decos: Decoration[]): string | null {
    for (const d of decos) {
        const spec = d.spec as { kind?: string; suggestionId?: string }
        if (!spec.kind || !SUGGESTION_DECO_KINDS.has(spec.kind)) continue
        if (typeof spec.suggestionId !== 'string') continue
        return spec.suggestionId
    }
    return null
}

export function createSuggestionClickToFocusPlugin(): Plugin {
    return new Plugin({
        key: PLUGIN_KEY,
        props: {
            handleClick: (view, _pos, event) => {
                // posAtCoords yields the document position of a click
                // on the rendered DOM. Outside-document clicks
                // (scrollbar, padding) return null and we fall back
                // to default selection behavior.
                const coords = view.posAtCoords({
                    left: event.clientX,
                    top: event.clientY,
                })
                if (!coords) return false

                const decoSet = getSuggestionDecorations(view.state)
                const decos = decoSet.find(coords.pos, coords.pos)
                const id = firstSuggestionId(decos)
                if (id === null) return false

                publishUiMessage({
                    namespace: 'ui',
                    type: 'suggestion-clicked',
                    payload: { suggestionId: id } satisfies SuggestionClickedPayload,
                })
                // Returning false lets PM's default selection logic
                // run alongside our publish — the caret lands at the
                // click point so the user can keep editing without an
                // extra interaction.
                return false
            },
        },
    })
}

// SuggestionClickToFocus — TipTap extension wrapping the plugin above.
// Stateless; the screen subscribes to the ui-bus event separately.
export const SuggestionClickToFocus = Extension.create({
    name: 'tinycldSuggestionClickToFocus',
    addProseMirrorPlugins() {
        return [createSuggestionClickToFocusPlugin()]
    },
})
