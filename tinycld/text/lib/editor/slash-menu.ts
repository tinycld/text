import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion'
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

export interface SlashMenuOptions {
    // Host-supplied side-effect for the "Image" command. The picker
    // (URL prompt, file picker, drive upload) lives at the screen
    // level — see screens/[id].tsx. Optional: when undefined, picking
    // the Image entry just removes the trigger and inserts nothing.
    openImageInsert?: () => void
}

// SlashMenu wires Tiptap's @tiptap/suggestion plugin to a Zustand store
// that a React popover reads. The suggestion plugin owns the trigger
// detection + range tracking; the store owns the popover's visible
// state. Pairing the two keeps the popover stateless and decouples
// rendering from prosemirror's transaction lifecycle.
export const SlashMenu = Extension.create<SlashMenuOptions>({
    name: 'tinycldSlashMenu',

    addOptions() {
        return {
            openImageInsert: undefined,
        }
    },

    addProseMirrorPlugins() {
        const extension = this

        // command runs the chosen entry. The suggestion plugin invokes
        // this via the store's `onSelect` indirection — we capture the
        // editor + range here so the closure can hand them to the
        // command's `run({...})`. Calling `editor.chain().focus()`
        // refocuses the editor after the popover (which lives outside
        // the editor's DOM) intercepts the Enter / click.
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

        const render: NonNullable<SuggestionOptions<SlashMenuCommand>['render']> = () => {
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
