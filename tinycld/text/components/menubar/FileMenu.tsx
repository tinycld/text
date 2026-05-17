import { captureException } from '@tinycld/core/lib/errors'
import { useOrgHref } from '@tinycld/core/lib/org-routes'
import { pb } from '@tinycld/core/lib/pocketbase'
import { Menu, MenuBarMenu, MenuShortcut, Separator } from '@tinycld/core/ui/menubar'
import { router } from 'expo-router'
import { pmToMarkdown } from '../../lib/markdown/pm-to-md'
import type { PMNode } from '../../lib/markdown/types'
import type { MenuBarProps } from './MenuBar'

export function FileMenu(props: MenuBarProps) {
    const orgHref = useOrgHref()

    const promptThen = (label: string, defaultValue: string, run: (v: string) => void) => () => {
        const v = typeof window !== 'undefined' ? window.prompt(label, defaultValue) : null
        if (v != null && v.trim() !== '') run(v.trim())
    }

    const confirmThen = (msg: string, run: () => void) => () => {
        const ok = typeof window !== 'undefined' ? window.confirm(msg) : true
        if (ok) run()
    }

    const downloadSource = () => {
        if (!props.sourceFile) return
        const url = pb.files.getURL({ collectionId: 'drive_items', id: props.documentId }, props.sourceFile)
        if (typeof window !== 'undefined') {
            window.open(url, '_blank')
        }
    }

    // Tiptap's getJSON returns the editor's current PM JSON tree. We
    // hand it straight to pmToMarkdown — the supported subset matches
    // what the .docx exporter handles, and unsupported nodes (comments,
    // footnotes, color/font/size, alignment, image dims/wrap, cell
    // shading) degrade silently. Users wanting full fidelity should
    // use Download (.docx). Help topic: text:markdown.
    const downloadMarkdown = () => {
        if (typeof window === 'undefined') return
        const editor = props.tiptapEditor
        if (!editor) return
        try {
            const md = pmToMarkdown(editor.getJSON() as unknown as PMNode)
            const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            const base = props.documentName?.trim() || 'document'
            a.download = base.endsWith('.md') ? base : `${base}.md`
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            // Defer revoke so Safari finishes the download before the
            // object URL is invalidated.
            setTimeout(() => URL.revokeObjectURL(url), 0)
        } catch (err) {
            captureException('text.downloadMarkdown', err)
        }
    }

    return (
        <MenuBarMenu menuId="file" label="File">
            <Menu.Item onPress={() => router.push(orgHref('text'))}>
                <Menu.ItemTitle>New document</Menu.ItemTitle>
            </Menu.Item>
            <Menu.Item onPress={() => router.push(orgHref('drive'))}>
                <Menu.ItemTitle>Open</Menu.ItemTitle>
            </Menu.Item>
            <Menu.Item
                onPress={promptThen('Copy name', `${props.documentName} (copy)`, v =>
                    props.fileActions.makeCopy(v)
                )}
            >
                <Menu.ItemTitle>Make a copy</Menu.ItemTitle>
            </Menu.Item>
            <Separator />
            <Menu.Item onPress={downloadSource} isDisabled={!props.sourceFile}>
                <Menu.ItemTitle>Download (.docx)</Menu.ItemTitle>
            </Menu.Item>
            <Menu.Item onPress={downloadMarkdown} isDisabled={!props.tiptapEditor}>
                <Menu.ItemTitle>Download (.md)</Menu.ItemTitle>
            </Menu.Item>
            <Separator />
            <Menu.Item
                onPress={promptThen('Rename', props.documentName, v =>
                    props.fileActions.rename(v)
                )}
            >
                <Menu.ItemTitle>Rename</Menu.ItemTitle>
            </Menu.Item>
            <Menu.Item
                onPress={confirmThen('Move this document to trash?', () =>
                    props.fileActions.moveToTrash()
                )}
            >
                <Menu.ItemTitle>Move to trash</Menu.ItemTitle>
            </Menu.Item>
            <Menu.Item onPress={props.fileActions.openDriveDetails}>
                <Menu.ItemTitle>Details</Menu.ItemTitle>
            </Menu.Item>
            <Separator />
            <Menu.Item onPress={props.onPrint}>
                <Menu.ItemTitle>Print</Menu.ItemTitle>
                <MenuShortcut keys="⌘P" />
            </Menu.Item>
        </MenuBarMenu>
    )
}
