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
    const pasteAsMarkdown = () => {
        if (!tiptapEditor) return
        if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) return
        navigator.clipboard
            .readText()
            .then(text => {
                if (!text) return
                const doc = markdownToPM(text)
                const blocks = doc.content ?? []
                if (blocks.length === 0) return
                tiptapEditor
                    .chain()
                    .focus()
                    .insertContent(blocks as Parameters<typeof tiptapEditor.commands.insertContent>[0])
                    .run()
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
