import { captureException } from '@tinycld/core/lib/errors'
import { Menu, MenuBarMenu } from '@tinycld/core/ui/menubar'
import { useFindReplaceStore } from '../../lib/stores/find-replace-store'
import type { MenuBarProps } from './MenuBar'

// Stable reference — Zustand selectors don't subscribe when consumers
// only read getState(), and the menu item's onPress fires imperatively.
const openFindReplace = () => useFindReplaceStore.getState().open()

export function EditMenu(props: MenuBarProps) {
    const { commands, toolbarState, disabled, tiptapEditor } = props
    const selectionEmpty = toolbarState.selectionEmpty ?? true
    const editDisabled = disabled || selectionEmpty

    // Reads plain text from the system clipboard and inserts it as
    // structured PM content. Async because navigator.clipboard.readText
    // returns a Promise; the menu handler is fire-and-forget.
    //
    // Salvage strategy: each top-level markdown block is inserted in
    // its own chain.run(). If a block's parsed PM tree fails the
    // schema (mark exclusivity, disallowed content, ...) we fall back
    // to inserting the *original markdown source* for that block as a
    // plain paragraph — the rest of the paste survives, and the user
    // sees the failing chunk verbatim so they can hand-fix it. If
    // every per-block insert fails (catastrophe, e.g. an editor that
    // doesn't accept paragraphs either), we drop the entire markdown
    // source as a single paragraph so the user still gets something.
    //
    // The chain explicitly seeks the cursor to end-of-doc before each
    // insert. On a brand-new collaborative doc the user has often
    // never clicked into the editor, so the selection is still the
    // default <0, 0> at position 0, which is *outside* every block —
    // insertContent at that position silently rejects every block-level
    // node. After each insert we re-read docSize so the next block
    // lands after the one we just inserted, in order.
    // Paste-as-Markdown is web-only (it leans on navigator.clipboard +
    // markdown-it). Dynamic-importing the markdown modules inside the
    // handler keeps them off the native bundle's module-init path —
    // markdown-it ships ESM .mjs files that crash on Hermes when
    // evaluated at startup. The handler is also a no-op on native
    // because there's no editor handle there.
    const pasteAsMarkdown = () => {
        if (!tiptapEditor) return
        if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) return
        navigator.clipboard
            .readText()
            .then(async text => {
                if (!text) return
                const [{ markdownToPMBlocks }, { insertBlocksSequentially, insertPlaintext }] =
                    await Promise.all([
                        import('../../lib/markdown/md-to-pm'),
                        import('./paste-as-markdown'),
                    ])
                const blocks = markdownToPMBlocks(text)
                if (blocks.length === 0) {
                    insertPlaintext(tiptapEditor, text)
                    return
                }
                const { succeeded, salvaged } = insertBlocksSequentially(tiptapEditor, blocks)
                if (succeeded === 0 && salvaged === 0) {
                    // Nothing landed at all — the editor refused both the
                    // parsed PM *and* a plain paragraph fallback. Last-ditch:
                    // drop the entire markdown source as a single paragraph.
                    insertPlaintext(tiptapEditor, text)
                }
            })
            .catch(err => captureException('pasteAsMarkdown.readText', err))
    }

    return (
        <MenuBarMenu menuId="edit" label="Edit">
            <Menu.Item
                label="Undo"
                shortcut="⌘Z"
                onSelect={() => commands.undo()}
                isDisabled={disabled}
            />
            <Menu.Item
                label="Redo"
                shortcut="⌘Y"
                onSelect={() => commands.redo()}
                isDisabled={disabled}
            />
            <Menu.Separator />
            <Menu.Item
                label="Cut"
                shortcut="⌘X"
                onSelect={() => commands.cut?.()}
                isDisabled={editDisabled}
            />
            <Menu.Item
                label="Copy"
                shortcut="⌘C"
                onSelect={() => commands.copy?.()}
                isDisabled={editDisabled}
            />
            <Menu.Item
                label="Paste"
                shortcut="⌘V"
                onSelect={() => commands.paste?.()}
                isDisabled={disabled}
            />
            <Menu.Item
                label="Paste as Markdown"
                onSelect={pasteAsMarkdown}
                isDisabled={disabled || !tiptapEditor}
            />
            <Menu.Separator />
            <Menu.Item
                label="Find…"
                shortcut="⌘F"
                onSelect={openFindReplace}
                isDisabled={disabled}
            />
            <Menu.Separator />
            <Menu.Item
                label="Select all"
                shortcut="⌘A"
                onSelect={() => commands.selectAll?.()}
                isDisabled={disabled}
            />
            <Menu.Item
                label="Delete"
                onSelect={() => commands.deleteSelection?.()}
                isDisabled={editDisabled}
            />
        </MenuBarMenu>
    )
}
