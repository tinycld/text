import { captureException } from '@tinycld/core/lib/errors'
import { Menu, MenuBarMenu, MenuShortcut, Separator } from '@tinycld/core/ui/menubar'
import { markdownToPM } from '../../lib/markdown/md-to-pm'
import type { MenuBarProps } from './MenuBar'

export function EditMenu(props: MenuBarProps) {
    const { commands, toolbarState, disabled, tiptapEditor } = props
    const selectionEmpty = toolbarState.selectionEmpty ?? true
    const editDisabled = disabled || selectionEmpty

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
    const pasteAsMarkdown = () => {
        if (!tiptapEditor) return
        if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) return
        navigator.clipboard
            .readText()
            .then(text => {
                if (!text) {
                    captureException('text.pasteAsMarkdown', new Error('clipboard was empty'))
                    return
                }
                const doc = markdownToPM(text)
                const blocks = doc.content ?? []
                if (blocks.length === 0) {
                    captureException(
                        'text.pasteAsMarkdown',
                        new Error(`markdownToPM produced no blocks (input length ${text.length})`)
                    )
                    return
                }
                const endPos = Math.max(0, tiptapEditor.state.doc.content.size)
                const ok = tiptapEditor
                    .chain()
                    .focus()
                    .setTextSelection(endPos)
                    .insertContent(
                        blocks as Parameters<typeof tiptapEditor.commands.insertContent>[0]
                    )
                    .run()
                if (!ok) {
                    captureException(
                        'text.pasteAsMarkdown',
                        new Error(
                            `insertContent chain refused (${blocks.length} blocks at pos ${endPos})`
                        )
                    )
                }
            })
            .catch(err => captureException('text.pasteAsMarkdown', err))
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
