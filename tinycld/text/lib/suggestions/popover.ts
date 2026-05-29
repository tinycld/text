import type { EditorMessage } from '@tinycld/core/lib/editor/message-bus/types'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { Decoration } from '@tiptap/pm/view'
import { ulid } from 'ulid'
import type {
    BlockChangeAfter,
    BlockChangeBefore,
    SerializedMarks,
} from '../../webview-editor/source/suggestions/suggestion-types'
import { publishUiMessage, subscribeUiMessage } from '../anchored-overlay/ui-message-bus'
import { getSuggestionDecorations } from './decorations'

// SuggestionPopover — installs a ProseMirror click handler that detects
// clicks landing on a suggestion decoration (suggestedInsert /
// suggestedDelete) and surfaces an anchored 'show-popover' request so
// the host renders <SuggestionPopover /> for Accept / Reject / Dismiss.
//
// Two delivery paths exist; the click handler picks at runtime based on
// whether window.ReactNativeWebView is present:
//
//   Native (inside the TenTap WebView): post the ui.show-popover message
//   via window.ReactNativeWebView.postMessage out to the RN host, which
//   forwards it onto the in-process ui-message-bus. Responses come back
//   into the WebView via window/document 'message' events.
//
//   Web (single JS world — the editor and host run together): publish
//   directly onto the in-process ui-message-bus (publishUiMessage) and
//   subscribe to it (subscribeUiMessage) for popover-result responses.
//   There's no postMessage bridge to round-trip through.
//
// Architecture mirrors the slash-menu bridge render strategy (see
// lib/editor/slash-menu-render-bridge.ts) for the native path; the web
// path is the suggestion-popover analogue of slash-menu's store-render
// strategy (slash-menu-render-store.ts).

// Plugin key — distinct from other suggestion plugins (decorations,
// command-layer) and from the slash-menu plugin. The reducer routes
// by requestId, but distinct keys keep ProseMirror's plugin lifecycle
// from confusing the popover state with the decorations state.
const PLUGIN_KEY = new PluginKey('tinycld:suggestion-popover')

// Default post: prefer the WebView bridge (native), fall back to the
// in-process bus (web). The WebView bridge is the canonical native
// path because the message has to cross the WebView ↔ host process
// boundary; the bus only exists in a single JS world so it works when
// the plugin and the React host are co-located (web).
function defaultPost(message: object) {
    const target = (
        globalThis as { window?: { ReactNativeWebView?: { postMessage: (s: string) => void } } }
    ).window
    if (target?.ReactNativeWebView?.postMessage) {
        target.ReactNativeWebView.postMessage(JSON.stringify(message))
        return
    }
    // Web fallback. The bus carries the same EditorMessage shape the
    // wire form encodes — cast through unknown because callsites build
    // plain object literals (the wire shape is enforced at the type
    // boundary by message-bus/types.ts, not here).
    publishUiMessage(message as unknown as EditorMessage)
}

// Returns true when running inside the TenTap WebView (native). When
// false (web), popover-result responses come via the in-process bus
// rather than window/document 'message' events.
function isInsideReactNativeWebView(): boolean {
    const target = (
        globalThis as { window?: { ReactNativeWebView?: { postMessage: (s: string) => void } } }
    ).window
    return typeof target?.ReactNativeWebView?.postMessage === 'function'
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

// toSuggestionEntry maps one decoration spec into the typed entry the
// host renders in the popover. Pulled out of createSuggestionPopoverPlugin
// so the dedupe loop can call it cleanly; same return shapes as before.
function toSuggestionEntry(d: Decoration) {
    const spec = d.spec as {
        kind: string
        suggestionId: string
        authorId?: string
        before?: SerializedMarks | BlockChangeBefore
        after?: SerializedMarks | BlockChangeAfter
    }
    const base = {
        id: spec.suggestionId,
        authorId: spec.authorId ?? 'unknown',
    }
    if (spec.kind === 'suggestedInsert') {
        return { ...base, kind: 'insert' as const }
    }
    if (spec.kind === 'suggestedDelete') {
        return { ...base, kind: 'delete' as const }
    }
    if (spec.kind === 'suggestedFormatChange') {
        return {
            ...base,
            kind: 'format-change' as const,
            beforeMarks: (spec.before as SerializedMarks) ?? [],
            afterMarks: (spec.after as SerializedMarks) ?? [],
        }
    }
    // suggestedBlockChange. Distinguish cell vs non-cell by the node
    // type carried in the before/after payload — the decoration plugin
    // tags isCell via its CSS class but doesn't expose it through the
    // spec, so we re-derive from payload.type which is the canonical
    // source.
    const before = spec.before as BlockChangeBefore | undefined
    const after = spec.after as BlockChangeAfter | undefined
    const t = before?.type ?? after?.type
    const isCell = t === 'tableCell' || t === 'tableHeader'
    return {
        ...base,
        kind: (isCell ? 'cell-change' : 'block-change') as 'cell-change' | 'block-change',
        beforeBlock: before,
        afterBlock: after,
    }
}

export function createSuggestionPopoverPlugin(deps: SuggestionPopoverPluginDeps = {}) {
    const post = deps.post ?? defaultPost
    const newRequestId = deps.newRequestId ?? (() => ulid())

    let currentRequestId: string | null = null

    // Native-side listener for popover-result responses from the host.
    // The host posts the message via WebView.postMessage; in the
    // WebView's content world that surfaces as a 'message' event on
    // window+document. Filters on currentRequestId so a stale response
    // (an older popover that has since been displaced by a newer click)
    // doesn't crash the lifecycle.
    const onHostMessage = (evt: MessageEvent) => {
        if (typeof evt.data !== 'string') return
        let parsed: { namespace?: string; type?: string; requestId?: string; payload?: unknown }
        try {
            parsed = JSON.parse(evt.data)
        } catch {
            return
        }
        handlePopoverResult(parsed)
    }

    // Web-side listener: the suggestion plugin lives in the same JS
    // world as the React host, so popover-result arrives via the
    // ui-message-bus rather than a postMessage bridge.
    const onBusMessage = (message: EditorMessage) => {
        handlePopoverResult({
            namespace: message.namespace,
            type: message.type,
            requestId: message.requestId,
            payload: message.payload,
        })
    }

    // Shared response handler — both paths funnel here. For Phase 2a
    // Task 11 the popover renders in a non-resolving state when
    // canResolve=false; the host wrapper drives the actual resolve
    // mutation, so we just clear our in-flight requestId.
    const handlePopoverResult = (parsed: {
        namespace?: string
        type?: string
        requestId?: string
        payload?: unknown
    }) => {
        if (parsed.namespace !== 'ui' || parsed.type !== 'popover-result') return
        if (!currentRequestId || parsed.requestId !== currentRequestId) return
        currentRequestId = null
    }

    let nativeListenerInstalled = false
    let busUnsubscribe: (() => void) | null = null
    const ensureListener = () => {
        // Web path: subscribe to the bus. The bus instance is module-
        // global in the same JS world; both the plugin and the host's
        // overlay mount share it.
        if (!isInsideReactNativeWebView()) {
            if (busUnsubscribe) return
            busUnsubscribe = subscribeUiMessage(onBusMessage)
            return
        }
        // Native path: install window+document 'message' listeners in
        // the WebView so the host's postMessage replies surface as DOM
        // events. iOS RN-WebView delivers to document; Android delivers
        // to window — we listen on both for parity.
        if (nativeListenerInstalled) return
        if (typeof window === 'undefined') return
        window.addEventListener('message', onHostMessage)
        document.addEventListener('message', onHostMessage as EventListener)
        nativeListenerInstalled = true
    }
    const removeListener = () => {
        if (busUnsubscribe) {
            busUnsubscribe()
            busUnsubscribe = null
        }
        if (!nativeListenerInstalled) return
        if (typeof window === 'undefined') return
        window.removeEventListener('message', onHostMessage)
        document.removeEventListener('message', onHostMessage as EventListener)
        nativeListenerInstalled = false
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

                    // Enumerate suggestion decorations at the click
                    // point and dedupe by (suggestionId, kind). One
                    // logical suggestion frequently spans many Yjs
                    // item ranges (a typing session emits one item per
                    // character or paste run), and decoSet.find returns
                    // one Decoration per item range — without dedupe
                    // the popover renders one row per character and
                    // emits duplicate React keys downstream.
                    //
                    // Case 2b/2c layered marks still produce separate
                    // rows (different suggestionIds), as do insert +
                    // delete that share a suggestionId (different
                    // kinds — the consumer can group them visually as
                    // "Replace 'X' with 'Y'" if both are present).
                    const dedupeByKey = new Map<string, ReturnType<typeof toSuggestionEntry>>()
                    for (const d of decos) {
                        const k = d.spec?.kind
                        if (
                            k !== 'suggestedInsert' &&
                            k !== 'suggestedDelete' &&
                            k !== 'suggestedFormatChange' &&
                            k !== 'suggestedBlockChange'
                        ) {
                            continue
                        }
                        const entry = toSuggestionEntry(d)
                        const dedupeKey = `${entry.id}::${entry.kind}`
                        if (!dedupeByKey.has(dedupeKey)) {
                            dedupeByKey.set(dedupeKey, entry)
                        }
                    }
                    const suggestions = Array.from(dedupeByKey.values())
                    if (suggestions.length === 0) return false

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
                            payload: { suggestions },
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
