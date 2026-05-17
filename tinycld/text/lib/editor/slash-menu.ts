import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion, { exitSuggestion, type SuggestionOptions } from '@tiptap/suggestion'
import { useSlashMenuStore } from '../stores/slash-menu-store'
import {
    type SlashMenuCommand,
    SLASH_MENU_COMMANDS,
    filterSlashMenuCommands,
} from './slash-menu-commands'

// Unique plugin key so the store-driven `onKeyDown` bridge can target
// this suggestion instance — the editor may run other suggestion
// plugins later (mentions, emoji), and they must not share state.
export const slashMenuPluginKey = new PluginKey('tinycldSlashMenu')

// Lightweight wire shape posted to the host on show-popover /
// popover-update. The web LucideIcon refs (cmd.icon) can't ride the
// JSON-stringified message bus, so we substitute a string `iconName`
// the host maps back to the icon component via slash-menu-icon-lookup.
//
// `id` is the SlashMenuCommand.id (heading-1, bullet-list, …) — the
// host echoes it back in popover-result and the bridge looks the
// command up in SLASH_MENU_COMMANDS to invoke run().
export interface SerializedSlashMenuItem {
    id: string
    label: string
    iconName: string
}

export interface SlashMenuOptions {
    // Host-supplied side-effect for the "Image" command. The picker
    // (URL prompt, file picker, drive upload) lives at the screen
    // level — see screens/[id].tsx. Optional: when undefined, picking
    // the Image entry just removes the trigger and inserts nothing.
    openImageInsert?: () => void
    // Render strategy:
    //   'store'  - drive useSlashMenuStore. The web variant uses this;
    //              the popover (SlashMenu.web.tsx) reads the store
    //              directly and the suggestion plugin's onKeyDown
    //              handles arrow/enter/escape against the store state.
    //   'bridge' - post ui.show-popover / popover-update messages to
    //              the host via window.ReactNativeWebView. Used inside
    //              the native WebView, where the host-side overlay
    //              controller renders a Modal popover and routes
    //              selections back via popover-result.
    // Defaults to 'store'.
    renderStrategy?: 'store' | 'bridge'
}

// Serialize a command list into the lightweight wire shape the host's
// popover can render against. Strips icon refs (LucideIcon components
// can't ride JSON) and `run` (a host-side closure that lives only in
// the WebView). The host echoes `id` back in popover-result; the
// bridge looks the command up in SLASH_MENU_COMMANDS to invoke run().
export function serializeSlashMenuItems(
    items: SlashMenuCommand[]
): SerializedSlashMenuItem[] {
    return items.map(cmd => ({ id: cmd.id, label: cmd.label, iconName: cmd.iconName }))
}

// Helper to post a 'ui' namespace message out of the WebView. Mirrors
// the postToNative helper in webview-editor/source/Editor.tsx, but
// kept local to this module so the slash-menu render strategy is a
// single, self-contained file. Silently no-ops outside the WebView
// (window.ReactNativeWebView is undefined on the host side).
function defaultPostToHost(message: object) {
    const target = (globalThis as { window?: { ReactNativeWebView?: { postMessage: (s: string) => void } } })
        .window
    target?.ReactNativeWebView?.postMessage(JSON.stringify(message))
}

// Generate a request id for show-popover messages. The host echoes it
// in popover-result so we can correlate the response back to the
// in-flight suggestion-plugin instance. crypto.randomUUID would also
// work but isn't guaranteed in the WebView's content world; Date.now +
// random tail is enough to disambiguate inside one editing session.
function defaultNewRequestId(): string {
    return `slash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// Convert the suggestion plugin's clientRect (a DOMRect) into the
// shape the host's anchored-overlay protocol expects: viewport coords
// + a snapshot of the WebView's scroll offsets at capture time.
// Matches ImageSelection.rect from Milestone B exactly.
export function toAnchoredSlashMenuRect(rect: DOMRect | null | undefined) {
    if (!rect) return null
    return {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        scrollX: typeof window !== 'undefined' ? window.scrollX : 0,
        scrollY: typeof window !== 'undefined' ? window.scrollY : 0,
    }
}

// Dependency-injected factory for the bridge render strategy. Used
// both by the extension (with the production helpers) and by tests
// (with stubbed postMessage + newRequestId so the wire shape is easy
// to assert without a real WebView).
export interface SlashMenuBridgeDeps {
    postToHost: (message: object) => void
    newRequestId: () => string
    exitSuggestion: typeof exitSuggestion
}

export function createSlashMenuBridgeRender(
    deps: SlashMenuBridgeDeps
): NonNullable<SuggestionOptions<SlashMenuCommand>['render']> {
    return () => {
        let currentRequestId: string | null = null
        // SuggestionOptions.command takes { editor, range, props }; but
        // SuggestionProps.command (handed to render callbacks via the
        // props arg) is the wrapped form `(item: TSelected) => void` —
        // the suggestion plugin internally captures editor + range and
        // hands us a closure that takes only the selected item. We
        // store that wrapped form here.
        let currentCommand: ((item: SlashMenuCommand) => void) | null = null
        let currentItems: SlashMenuCommand[] = []
        let selectedIndex = 0
        let editorView: import('@tiptap/pm/view').EditorView | null = null

        const onHostMessage = (evt: MessageEvent) => {
            if (typeof evt.data !== 'string') return
            let parsed: {
                namespace?: string
                type?: string
                requestId?: string
                payload?: unknown
            }
            try {
                parsed = JSON.parse(evt.data)
            } catch {
                return
            }
            if (parsed.namespace !== 'ui' || parsed.type !== 'popover-result') return
            if (!currentRequestId || parsed.requestId !== currentRequestId) return
            const payload = parsed.payload as
                | { action?: string; payload?: { commandId?: string } }
                | null
                | undefined
            const action = payload?.action
            if (action === 'select') {
                const commandId = payload?.payload?.commandId
                const picked = currentItems.find(c => c.id === commandId)
                if (picked && currentCommand) {
                    currentCommand(picked)
                }
                currentRequestId = null
            } else if (action === 'dismiss') {
                if (editorView) {
                    try {
                        deps.exitSuggestion(editorView, slashMenuPluginKey)
                    } catch {
                        // exitSuggestion can throw if the plugin
                        // state has already been cleared by an
                        // intervening transaction. Safe to ignore.
                    }
                }
                currentRequestId = null
            }
        }

        return {
            onStart: props => {
                currentCommand = props.command
                currentItems = props.items
                selectedIndex = 0
                currentRequestId = deps.newRequestId()
                editorView = props.editor.view
                const rect = toAnchoredSlashMenuRect(props.clientRect?.() ?? null)
                if (!rect) {
                    currentRequestId = null
                    return
                }
                if (typeof window !== 'undefined') {
                    window.addEventListener('message', onHostMessage)
                    document.addEventListener('message', onHostMessage as EventListener)
                }
                deps.postToHost({
                    namespace: 'ui',
                    type: 'show-popover',
                    requestId: currentRequestId,
                    payload: {
                        kind: 'slash-menu',
                        rect,
                        payload: {
                            items: serializeSlashMenuItems(props.items),
                            query: props.query,
                            selectedIndex,
                        },
                    },
                })
            },
            onUpdate: props => {
                currentCommand = props.command
                currentItems = props.items
                if (selectedIndex >= props.items.length) {
                    selectedIndex = props.items.length === 0 ? 0 : props.items.length - 1
                }
                if (!currentRequestId) return
                deps.postToHost({
                    namespace: 'ui',
                    type: 'popover-update',
                    requestId: currentRequestId,
                    payload: {
                        items: serializeSlashMenuItems(props.items),
                        query: props.query,
                        selectedIndex,
                    },
                })
            },
            onKeyDown: ({ event }) => {
                if (!currentRequestId) return false
                if (event.key === 'ArrowDown') {
                    if (currentItems.length === 0) return false
                    selectedIndex = (selectedIndex + 1) % currentItems.length
                    deps.postToHost({
                        namespace: 'ui',
                        type: 'popover-update',
                        requestId: currentRequestId,
                        payload: {
                            items: serializeSlashMenuItems(currentItems),
                            query: '',
                            selectedIndex,
                        },
                    })
                    event.preventDefault()
                    return true
                }
                if (event.key === 'ArrowUp') {
                    if (currentItems.length === 0) return false
                    selectedIndex =
                        (selectedIndex - 1 + currentItems.length) % currentItems.length
                    deps.postToHost({
                        namespace: 'ui',
                        type: 'popover-update',
                        requestId: currentRequestId,
                        payload: {
                            items: serializeSlashMenuItems(currentItems),
                            query: '',
                            selectedIndex,
                        },
                    })
                    event.preventDefault()
                    return true
                }
                if (event.key === 'Enter') {
                    const item = currentItems[selectedIndex]
                    if (!item) return false
                    currentCommand?.(item)
                    event.preventDefault()
                    return true
                }
                if (event.key === 'Escape') {
                    if (editorView) {
                        try {
                            deps.exitSuggestion(editorView, slashMenuPluginKey)
                        } catch {
                            // see onHostMessage above.
                        }
                    }
                    event.preventDefault()
                    return true
                }
                return false
            },
            onExit: () => {
                if (currentRequestId) {
                    deps.postToHost({
                        namespace: 'ui',
                        type: 'popover-dismissed',
                        requestId: currentRequestId,
                        payload: null,
                    })
                }
                if (typeof window !== 'undefined') {
                    window.removeEventListener('message', onHostMessage)
                    document.removeEventListener('message', onHostMessage as EventListener)
                }
                currentRequestId = null
                currentCommand = null
                currentItems = []
                selectedIndex = 0
                editorView = null
            },
        }
    }
}

// SlashMenu wires Tiptap's @tiptap/suggestion plugin to one of two
// render strategies — the existing store-driven flow (web variant) or
// a bridge-driven flow that posts messages over the WebView (native).
// The suggestion plugin owns trigger detection + range tracking; the
// strategy decides where the popover state lives.
export const SlashMenu = Extension.create<SlashMenuOptions>({
    name: 'tinycldSlashMenu',

    addOptions() {
        return {
            openImageInsert: undefined,
            renderStrategy: 'store',
        }
    },

    addProseMirrorPlugins() {
        const extension = this

        // command runs the chosen entry. The suggestion plugin invokes
        // this via the host's response (bridge) or the store's
        // `onSelect` indirection (store) — we capture the editor +
        // range here so the closure can hand them to the command's
        // `run({...})`. Calling `editor.chain().focus()` refocuses the
        // editor after the popover (which lives outside the editor's
        // DOM) intercepts the Enter / click.
        const runCommand: NonNullable<SuggestionOptions<SlashMenuCommand>['command']> = ({
            editor,
            range,
            props,
        }) => {
            props.run({
                editor,
                range,
                openImageInsert: extension.options.openImageInsert,
            })
        }

        const renderStore: NonNullable<SuggestionOptions<SlashMenuCommand>['render']> = () => {
            // Helper to translate the suggestion plugin's clientRect
            // (DOMRect | null) into our serializable anchor shape. The
            // anchor lives in the Zustand store, which doesn't want to
            // hold a DOMRect reference whose values mutate between
            // frames.
            const toAnchor = (rect: DOMRect | null | undefined) =>
                rect
                    ? {
                          top: rect.top,
                          left: rect.left,
                          bottom: rect.bottom,
                          right: rect.right,
                          width: rect.width,
                          height: rect.height,
                      }
                    : null

            // The latest `command` callback from the suggestion plugin.
            // We close over a mutable reference rather than capturing
            // `onStart`'s props, because the plugin re-creates the
            // command on each transaction with an updated range — using
            // the stale closure would apply the heading at the original
            // `/` position even after the user typed more characters.
            let currentCommand: ((cmd: SlashMenuCommand) => void) | null = null

            const handleSelect = (cmd: SlashMenuCommand) => {
                currentCommand?.(cmd)
            }

            return {
                onStart: props => {
                    currentCommand = props.command
                    useSlashMenuStore.getState().open({
                        items: props.items,
                        query: props.query,
                        anchor: toAnchor(props.clientRect?.() ?? null),
                        onSelect: handleSelect,
                    })
                },
                onUpdate: props => {
                    currentCommand = props.command
                    useSlashMenuStore.getState().update({
                        items: props.items,
                        query: props.query,
                        anchor: toAnchor(props.clientRect?.() ?? null),
                    })
                },
                onKeyDown: ({ event }) => {
                    const state = useSlashMenuStore.getState()
                    if (!state.isOpen) return false

                    if (event.key === 'ArrowDown') {
                        state.moveSelection(1)
                        event.preventDefault()
                        return true
                    }
                    if (event.key === 'ArrowUp') {
                        state.moveSelection(-1)
                        event.preventDefault()
                        return true
                    }
                    if (event.key === 'Enter') {
                        const item = state.items[state.selectedIndex]
                        if (!item) return false
                        state.onSelect?.(item)
                        event.preventDefault()
                        return true
                    }
                    if (event.key === 'Escape') {
                        useSlashMenuStore.getState().close()
                        event.preventDefault()
                        return true
                    }
                    return false
                },
                onExit: () => {
                    currentCommand = null
                    useSlashMenuStore.getState().close()
                },
            }
        }

        // Bridge render strategy. The popover lives on the host (native
        // side); we communicate over the WebView message bus. The
        // factory below takes injected dependencies (postToHost,
        // newRequestId, exitSuggestion) so the bridge logic can be
        // unit-tested without needing a real WebView; in production we
        // pass the real ones.
        const renderBridge = createSlashMenuBridgeRender({
            postToHost: defaultPostToHost,
            newRequestId: defaultNewRequestId,
            exitSuggestion,
        })

        const render =
            extension.options.renderStrategy === 'bridge' ? renderBridge : renderStore

        return [
            Suggestion<SlashMenuCommand>({
                editor: this.editor,
                pluginKey: slashMenuPluginKey,
                char: '/',
                // Match `/` at the start of a node OR after whitespace.
                // The suggestion plugin's default `allowedPrefixes` is
                // `[' ']`, which already covers the "after whitespace"
                // case — we keep the default. `startOfLine: false`
                // lets the trigger fire mid-line too (e.g. after a
                // line break or in any text block beginning).
                startOfLine: false,
                allowSpaces: false,
                items: ({ query }) => filterSlashMenuCommands(query, SLASH_MENU_COMMANDS),
                command: runCommand,
                render,
            }),
        ]
    },
})
