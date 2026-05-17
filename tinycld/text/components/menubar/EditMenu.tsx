import { Menu, MenuBarMenu, MenuShortcut, Separator } from '@tinycld/core/ui/menubar'
import { markdownToPM } from '../../lib/markdown/md-to-pm'
import type { MenuBarProps } from './MenuBar'

export function EditMenu(props: MenuBarProps) {
    const { commands, toolbarState, disabled, tiptapEditor } = props
    const selectionEmpty = toolbarState.selectionEmpty ?? true
    const editDisabled = disabled || selectionEmpty
    // biome-ignore lint/suspicious/noConsole: dev-only diagnostic
    console.log('[EditMenu] render', {
        disabled,
        hasEditor: !!tiptapEditor,
        pasteMdDisabled: disabled || !tiptapEditor,
    })

    // Reads plain text from the system clipboard and inserts it as
    // structured PM content. Async because navigator.clipboard.readText
    // returns a Promise; the menu handler is fire-and-forget.
    //
    // We pass the parsed doc's `content` array (not the full doc wrapper)
    // to insertContent — Tiptap inserts each top-level block at the
    // caret. The change rides one collaborative transaction so peers
    // see it as a single edit.
    //
    // The chain explicitly seeks the cursor to end-of-doc before
    // inserting. On a brand-new collaborative doc the user has often
    // never clicked into the editor, so the selection is still the
    // default <0, 0> at position 0, which is *outside* every block —
    // insertContent at that position silently rejects every block-level
    // node and the user sees nothing happen.
    //
    // Every step logs to the console so a still-broken paste in dev
    // shows where it died without attaching a debugger. These are
    // dev-only diagnostics — they don't route to Sentry (it's local
    // dev noise) and stay in the source until the feature is stable.
    const pasteAsMarkdown = () => {
        // biome-ignore lint/suspicious/noConsole: diagnostic trail for a fire-and-forget menu handler
        console.log('[pasteAsMarkdown] handler invoked', {
            hasEditor: !!tiptapEditor,
            hasNavigator: typeof navigator !== 'undefined',
            hasClipboard: typeof navigator !== 'undefined' && !!navigator.clipboard,
            hasReadText:
                typeof navigator !== 'undefined' && !!navigator.clipboard?.readText,
        })
        if (!tiptapEditor) {
            // biome-ignore lint/suspicious/noConsole: diagnostic
            console.warn('[pasteAsMarkdown] aborted: no tiptapEditor (native path?)')
            return
        }
        if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
            // biome-ignore lint/suspicious/noConsole: diagnostic
            console.warn('[pasteAsMarkdown] aborted: clipboard API unavailable')
            return
        }
        navigator.clipboard
            .readText()
            .then(text => {
                // biome-ignore lint/suspicious/noConsole: diagnostic
                console.log('[pasteAsMarkdown] readText resolved', {
                    length: text?.length ?? 0,
                    preview: text?.slice(0, 80),
                })
                if (!text) {
                    // biome-ignore lint/suspicious/noConsole: diagnostic
                    console.warn('[pasteAsMarkdown] aborted: clipboard empty')
                    return
                }
                const doc = markdownToPM(text)
                const blocks = doc.content ?? []
                // biome-ignore lint/suspicious/noConsole: diagnostic
                console.log('[pasteAsMarkdown] markdownToPM parsed', {
                    blockCount: blocks.length,
                    blockTypes: blocks.map(b => b.type),
                })
                if (blocks.length === 0) {
                    // biome-ignore lint/suspicious/noConsole: diagnostic
                    console.warn('[pasteAsMarkdown] aborted: parser produced 0 blocks')
                    return
                }
                const endPos = Math.max(0, tiptapEditor.state.doc.content.size)
                // biome-ignore lint/suspicious/noConsole: diagnostic
                console.log('[pasteAsMarkdown] inserting', {
                    endPos,
                    docSize: tiptapEditor.state.doc.content.size,
                    isEditable: tiptapEditor.isEditable,
                    isFocused: tiptapEditor.isFocused,
                })
                const ok = tiptapEditor
                    .chain()
                    .focus()
                    .setTextSelection(endPos)
                    .insertContent(
                        blocks as Parameters<typeof tiptapEditor.commands.insertContent>[0]
                    )
                    .run()
                // biome-ignore lint/suspicious/noConsole: diagnostic
                console.log('[pasteAsMarkdown] chain.run() returned', {
                    ok,
                    docSizeAfter: tiptapEditor.state.doc.content.size,
                })
            })
            .catch(err => {
                // biome-ignore lint/suspicious/noConsole: diagnostic
                console.error('[pasteAsMarkdown] promise rejected', err)
            })
    }

    return (
        <MenuBarMenu menuId="edit" label="Edit">
            <Menu.Item onPress={() => commands.undo()} isDisabled={disabled}>
                <Menu.ItemTitle>Undo</Menu.ItemTitle>
                <MenuShortcut keys="⌘Z" />
            </Menu.Item>
            <Menu.Item onPress={() => commands.redo()} isDisabled={disabled}>
                <Menu.ItemTitle>Redo</Menu.ItemTitle>
                <MenuShortcut keys="⌘Y" />
            </Menu.Item>
            <Separator />
            <Menu.Item onPress={() => commands.cut?.()} isDisabled={editDisabled}>
                <Menu.ItemTitle>Cut</Menu.ItemTitle>
                <MenuShortcut keys="⌘X" />
            </Menu.Item>
            <Menu.Item onPress={() => commands.copy?.()} isDisabled={editDisabled}>
                <Menu.ItemTitle>Copy</Menu.ItemTitle>
                <MenuShortcut keys="⌘C" />
            </Menu.Item>
            <Menu.Item onPress={() => commands.paste?.()} isDisabled={disabled}>
                <Menu.ItemTitle>Paste</Menu.ItemTitle>
                <MenuShortcut keys="⌘V" />
            </Menu.Item>
            <Menu.Item onPress={pasteAsMarkdown} isDisabled={disabled || !tiptapEditor}>
                <Menu.ItemTitle>Paste as Markdown</Menu.ItemTitle>
            </Menu.Item>
            <Separator />
            <Menu.Item onPress={() => commands.selectAll?.()} isDisabled={disabled}>
                <Menu.ItemTitle>Select all</Menu.ItemTitle>
                <MenuShortcut keys="⌘A" />
            </Menu.Item>
            <Menu.Item onPress={() => commands.deleteSelection?.()} isDisabled={editDisabled}>
                <Menu.ItemTitle>Delete</Menu.ItemTitle>
            </Menu.Item>
        </MenuBarMenu>
    )
}
