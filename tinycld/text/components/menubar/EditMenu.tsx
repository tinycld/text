import { Menu, MenuBarMenu, MenuShortcut, Separator } from '@tinycld/core/ui/menubar'
import { markdownToPMBlocks } from '../../lib/markdown/md-to-pm'
import type { MenuBarProps } from './MenuBar'
import {
    insertBlocksSequentially,
    insertPlaintext,
} from './paste-as-markdown'

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
    //
    // Every step logs to the console so a still-broken paste in dev
    // shows where it died without attaching a debugger. These are
    // dev-only diagnostics — they don't route to Sentry (it's local
    // dev noise) and stay in the source until the feature is stable.
    const pasteAsMarkdown = () => {
        // biome-ignore lint/suspicious/noConsole: diagnostic
        console.log('[pasteAsMarkdown] handler invoked', {
            hasEditor: !!tiptapEditor,
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
                })
                if (!text) {
                    // biome-ignore lint/suspicious/noConsole: diagnostic
                    console.warn('[pasteAsMarkdown] aborted: clipboard empty')
                    return
                }
                const blocks = markdownToPMBlocks(text)
                // biome-ignore lint/suspicious/noConsole: diagnostic
                console.log('[pasteAsMarkdown] parsed', {
                    blockCount: blocks.length,
                    blockTypes: blocks.map(b => b.block.type),
                })
                if (blocks.length === 0) {
                    insertPlaintext(tiptapEditor, text)
                    // biome-ignore lint/suspicious/noConsole: diagnostic
                    console.warn('[pasteAsMarkdown] parser produced 0 blocks; fell back to plaintext')
                    return
                }
                const { succeeded, salvaged, failed } = insertBlocksSequentially(
                    tiptapEditor,
                    blocks
                )
                // biome-ignore lint/suspicious/noConsole: diagnostic
                console.log('[pasteAsMarkdown] insertion result', {
                    succeeded,
                    salvaged,
                    failed,
                    blocks: blocks.length,
                })
                if (succeeded === 0 && salvaged === 0) {
                    // Nothing landed at all — the editor refused both the
                    // parsed PM *and* a plain paragraph fallback. Last-ditch:
                    // drop the entire markdown source as a single paragraph.
                    insertPlaintext(tiptapEditor, text)
                    // biome-ignore lint/suspicious/noConsole: diagnostic
                    console.warn('[pasteAsMarkdown] every block refused; total plaintext fallback')
                }
            })
            .catch(err => {
                // biome-ignore lint/suspicious/noConsole: diagnostic
                console.error('[pasteAsMarkdown] readText rejected', err)
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
