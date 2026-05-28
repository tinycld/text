import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { ulid } from 'ulid'
import { getSuggestionDecorations } from './decorations'

// SuggestionPopover (WebView side) — installs a ProseMirror click
// handler that detects clicks landing on a suggestion decoration
// (suggestedInsert / suggestedDelete) and posts an anchored-overlay
// 'show-popover' message to the host via window.ReactNativeWebView.
// The host's AnchoredOverlayController renders <SuggestionPopover />
// as a Modal positioned over the WebView at the click rect and routes
// Accept / Reject / Dismiss back through 'popover-result' messages.
//
// Architecture mirrors the slash-menu bridge render strategy (see
// lib/editor/slash-menu-render-bridge.ts):
//   - This module runs inside the WebView's content world.
//   - It posts 'ui' namespace messages via window.ReactNativeWebView.
//   - It installs a window+document 'message' listener on demand to
//     correlate popover-result responses back to the active requestId.
// The slash-menu has a longer-lived suggestion plugin state machine
// (typing the trigger, navigating items, dismissing on space); the
// suggestion popover is purely click-triggered with no in-WebView
// state to wind down beyond the message listener.

// Plugin key — distinct from other suggestion plugins (decorations,
// command-layer) and from the slash-menu plugin. The reducer routes
// by requestId, but distinct keys keep ProseMirror's plugin lifecycle
// from confusing the popover state with the decorations state.
const PLUGIN_KEY = new PluginKey('tinycld:suggestion-popover')

// Helper to post a 'ui' namespace message out of the WebView. Mirrors
// defaultPostToHost from slash-menu-render-bridge.ts — kept local
// because the slash-menu helper is co-located with slash-menu state
// and importing it here would invert the dependency direction (the
// suggestions package would depend on the slash-menu package).
function postToHost(message: object) {
    const target = (
        globalThis as { window?: { ReactNativeWebView?: { postMessage: (s: string) => void } } }
    ).window
    target?.ReactNativeWebView?.postMessage(JSON.stringify(message))
}

// Build the anchored-overlay rect from a DOM click event. Matches
// toAnchoredSlashMenuRect's shape (viewport coords + scroll snapshot).
// We use a 0-width/height rect anchored at the click point so the
// host's resolvePopoverPosition flips above the click when there's
// not enough vertical room below.
function rectFromClick(event: MouseEvent) {
    return {
        top: event.clientY,
        left: event.clientX,
        width: 0,
        height: 0,
        scrollX: typeof window !== 'undefined' ? window.scrollX : 0,
        scrollY: typeof window !== 'undefined' ? window.scrollY : 0,
    }
}

// createSuggestionPopoverPlugin builds the ProseMirror plugin without
// the TipTap wrapper, so unit tests can mount it against a raw
// EditorState without standing up a full Editor / DOM. The TipTap
// extension below uses this factory; both code paths share the exact
// same plugin logic.
//
// Dependency-injected for testability:
//   - `post` defaults to the production window.ReactNativeWebView
//     poster but tests can stub it.
//   - `newRequestId` defaults to ulid() but tests can stub for
//     deterministic ids.
export interface SuggestionPopoverPluginDeps {
    post?: (message: object) => void
    newRequestId?: () => string
}

export function createSuggestionPopoverPlugin(deps: SuggestionPopoverPluginDeps = {}) {
    const post = deps.post ?? postToHost
    const newRequestId = deps.newRequestId ?? (() => ulid())

    let currentRequestId: string | null = null

    // Listener for popover-result responses from the host. Filters on
    // currentRequestId so a stale response (an older popover that has
    // since been displaced by a newer click) doesn't crash the
    // listener's lifecycle. The listener is installed lazily on the
    // first click and torn down inside the plugin's destroy hook.
    const onHostMessage = (evt: MessageEvent) => {
        if (typeof evt.data !== 'string') return
        let parsed: { namespace?: string; type?: string; requestId?: string; payload?: unknown }
        try {
            parsed = JSON.parse(evt.data)
        } catch {
            return
        }
        if (parsed.namespace !== 'ui' || parsed.type !== 'popover-result') return
        if (!currentRequestId || parsed.requestId !== currentRequestId) return
        // For Phase 2a Task 11 the popover renders in a non-resolving
        // state (canResolve=false) so Accept / Reject buttons aren't
        // shown. Task 13 wires the real resolve mutation through the
        // payload. We currently just consume the response and clear
        // the in-flight requestId.
        currentRequestId = null
    }

    let listenerInstalled = false
    const ensureListener = () => {
        if (listenerInstalled) return
        if (typeof window === 'undefined') return
        window.addEventListener('message', onHostMessage)
        document.addEventListener('message', onHostMessage as EventListener)
        listenerInstalled = true
    }
    const removeListener = () => {
        if (!listenerInstalled) return
        if (typeof window === 'undefined') return
        window.removeEventListener('message', onHostMessage)
        document.removeEventListener('message', onHostMessage as EventListener)
        listenerInstalled = false
    }

    return new Plugin({
        key: PLUGIN_KEY,
        props: {
            handleDOMEvents: {
                // Returning `true` consumes the event; the underlying
                // ProseMirror selection-change behavior is suppressed so
                // a click on a suggestion mark surfaces the popover
                // rather than collapsing the selection to the caret.
                // Returning `false` lets other handlers and the default
                // selection logic run normally — required for clicks
                // outside a suggestion.
                click: (view, event) => {
                    // posAtCoords yields the document position of a
                    // click on the rendered DOM. Outside-document clicks
                    // (scrollbar, padding) return null.
                    const coords = view.posAtCoords({
                        left: event.clientX,
                        top: event.clientY,
                    })
                    if (!coords) return false

                    // DecorationSet.find(pos, pos) returns decorations
                    // overlapping a zero-width range at `pos`. For an
                    // inline decoration spanning [from, to), this
                    // matches when from <= pos < to.
                    const decoSet = getSuggestionDecorations(view.state)
                    const decos = decoSet.find(coords.pos, coords.pos)
                    if (decos.length === 0) return false

                    // Pick the first decoration's suggestionId. Layered
                    // marks (Case 2b) produce stacked decorations — we
                    // surface the first one for Task 11. A future phase
                    // could disambiguate (show both, or pick the most
                    // recent) but the storage layer already keys on
                    // suggestionId per mark, so the first one is
                    // sufficient for the initial click target.
                    const deco = decos[0]
                    const suggestionId = deco.spec?.suggestionId as string | undefined
                    if (!suggestionId) return false

                    // Generate a fresh requestId. Displaces any
                    // previously-in-flight request: the host's reducer
                    // accepts a new 'show' over an existing open state
                    // (see anchoredOverlayReducer's 'show' case), and
                    // any stale popover-result from the old request is
                    // filtered out by the requestId mismatch in
                    // onHostMessage above.
                    currentRequestId = newRequestId()
                    ensureListener()

                    post({
                        namespace: 'ui',
                        type: 'show-popover',
                        requestId: currentRequestId,
                        payload: {
                            kind: 'suggestion',
                            rect: rectFromClick(event),
                            payload: { suggestionId },
                        },
                    })

                    return true
                },
            },
        },
        view() {
            return {
                destroy() {
                    removeListener()
                    currentRequestId = null
                },
            }
        },
    })
}

// SuggestionPopover renders the click-triggered Accept/Reject popover
// for suggestion decorations. The Extension wrapper exists so this
// plugin is included alongside the other suggestion extensions via
// buildSuggestionEditorExtensions.
export const SuggestionPopover = Extension.create({
    name: 'suggestionPopover',

    addProseMirrorPlugins() {
        return [createSuggestionPopoverPlugin()]
    },
})
