import { useEditorMount } from '@tinycld/core/lib/editor/editor-mount'
import { captureException } from '@tinycld/core/lib/errors'
import { useOrgHref } from '@tinycld/core/lib/org-routes'
import { ConfirmDialog } from '@tinycld/core/ui/ConfirmDialog'
import { Menu, MenuBarMenu, MenuShortcut, Separator } from '@tinycld/core/ui/menubar'
import { PromptDialog } from '@tinycld/core/ui/PromptDialog'
import { TemplatePickerDialog } from '@tinycld/drive/components/TemplatePickerDialog'
import { useHasTemplates } from '@tinycld/drive/hooks/use-template-items'
import { useCopyDriveItem } from '@tinycld/drive/lib/copy-drive-item'
import {
    fromTemplateName,
    isTemplateName,
    TEMPLATE_EXTENSIONS,
    toTemplateName,
} from '@tinycld/drive/lib/template-naming'
import { router } from 'expo-router'
import { lazy, Suspense, useState } from 'react'
import type { PMNode } from '../../lib/markdown/types'
import type { MenuBarProps } from './MenuBar'
import { SaveVersionDialog } from './SaveVersionDialog'

// Lazy: ShareDialogConnected → ShareDialog → use-contact-suggestions →
// use-packages → static-registry, which reads tinycldConfig at module init.
// Importing it eagerly from this file creates a cycle: tinycld.config.ts
// pulls @tinycld/text/provider, the provider eagerly imports screens/[id]
// for share-route dispatch, [id] imports this menu, and the menu would then
// re-enter tinycld.config.ts before its exports are bound. Deferring with
// React.lazy breaks the chain — the import doesn't fire until the user
// actually opens the Share dialog.
const ShareDialogConnected = lazy(() => import('@tinycld/drive/components/ShareDialogConnected'))

export function FileMenu(props: MenuBarProps) {
    const orgHref = useOrgHref()
    const { capabilities } = useEditorMount()
    const copyTemplate = useCopyDriveItem()
    const hasTemplates = useHasTemplates(TEMPLATE_EXTENSIONS.docx)
    const [isSaveVersionOpen, setSaveVersionOpen] = useState(false)
    const [isCopyOpen, setCopyOpen] = useState(false)
    const [isRenameOpen, setRenameOpen] = useState(false)
    const [isTrashOpen, setTrashOpen] = useState(false)
    const [isShareOpen, setShareOpen] = useState(false)
    const [isTemplatePickerOpen, setTemplatePickerOpen] = useState(false)

    const handleCopy = (name: string) => {
        props.fileActions.makeCopy(name)
        setCopyOpen(false)
    }

    // "New from template" copies a `.tmpl.docx` file into a fresh doc and
    // opens it — same flow as the index-screen picker, available from the
    // menu so a user editing one doc can start another from a template.
    const handlePickTemplate = (item: { id: string; name: string }) => {
        copyTemplate.mutate(
            {
                sourceItemId: item.id,
                newName: fromTemplateName(item.name, TEMPLATE_EXTENSIONS.docx),
            },
            {
                onSuccess: result => {
                    setTemplatePickerOpen(false)
                    router.push(orgHref('text/[id]', { id: result.itemId }))
                },
            }
        )
    }

    // "Export as template" reuses the folder-picker copy flow (which
    // force-flushes the live room first), saving the current doc as a
    // `.tmpl.docx`. Hidden when the doc is already a template so we never
    // double-suffix.
    const isAlreadyTemplate = isTemplateName(props.documentName, TEMPLATE_EXTENSIONS.docx)
    const handleExportTemplate = () => {
        props.fileActions.exportAsTemplate(
            toTemplateName(props.documentName, TEMPLATE_EXTENSIONS.docx)
        )
    }

    const handleRename = (name: string) => {
        props.fileActions.rename(name)
        setRenameOpen(false)
    }

    const handleTrash = () => {
        props.fileActions.moveToTrash()
        setTrashOpen(false)
    }

    // Dynamic-imported to break a require cycle: pocketbase.ts imports the
    // generated tinycld-config (to register collections), tinycld-config
    // imports text/provider, the provider eagerly imports screens/[id] for
    // share-route dispatch, and the screen pulls this menu — completing the
    // loop if FileMenu imports pb at module scope. Pulling pb only at click
    // time keeps the cycle open.
    const downloadSource = async () => {
        if (!props.sourceFile) return
        const { pb } = await import('@tinycld/core/lib/pocketbase')
        const url = pb.files.getURL(
            { collectionId: 'drive_items', id: props.documentId },
            props.sourceFile
        )
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
    //
    // Dynamic-imported because pmToMarkdown lives in a module that
    // transitively pulls markdown-it; markdown-it ships ESM .mjs files
    // that crash on Hermes when evaluated at module init. The download
    // path is web-only anyway (it builds a Blob + clicks an <a>), so
    // moving the markdown imports into the handler keeps them off the
    // native module-init path.
    const downloadMarkdown = async () => {
        if (typeof window === 'undefined') return
        const editor = props.tiptapEditor
        if (!editor) return
        try {
            const { pmToMarkdown } = await import('../../lib/markdown/pm-to-md')
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
        <>
            <MenuBarMenu menuId="file" label="File">
                <Menu.Item onPress={() => router.push(orgHref('text'))}>
                    <Menu.ItemTitle>New document</Menu.ItemTitle>
                </Menu.Item>
                {hasTemplates && (
                    <Menu.Item onPress={() => setTemplatePickerOpen(true)}>
                        <Menu.ItemTitle>New from template…</Menu.ItemTitle>
                    </Menu.Item>
                )}
                <Menu.Item onPress={() => router.push(orgHref('drive'))}>
                    <Menu.ItemTitle>Open</Menu.ItemTitle>
                </Menu.Item>
                <Menu.Item onPress={() => setCopyOpen(true)}>
                    <Menu.ItemTitle>Make a copy</Menu.ItemTitle>
                </Menu.Item>
                {!isAlreadyTemplate && (
                    <Menu.Item onPress={handleExportTemplate}>
                        <Menu.ItemTitle>Export as template…</Menu.ItemTitle>
                    </Menu.Item>
                )}
                {capabilities.canUseFileActions && (
                    <Menu.Item onPress={() => setShareOpen(true)}>
                        <Menu.ItemTitle>Share</Menu.ItemTitle>
                    </Menu.Item>
                )}
                <Menu.Item onPress={() => setSaveVersionOpen(true)}>
                    <Menu.ItemTitle>Save version</Menu.ItemTitle>
                </Menu.Item>
                <Separator />
                <Menu.Item onPress={downloadSource} isDisabled={!props.sourceFile}>
                    <Menu.ItemTitle>Download (.docx)</Menu.ItemTitle>
                </Menu.Item>
                <Menu.Item onPress={downloadMarkdown} isDisabled={!props.tiptapEditor}>
                    <Menu.ItemTitle>Download (.md)</Menu.ItemTitle>
                </Menu.Item>
                <Separator />
                <Menu.Item onPress={() => setRenameOpen(true)}>
                    <Menu.ItemTitle>Rename</Menu.ItemTitle>
                </Menu.Item>
                <Menu.Item onPress={() => setTrashOpen(true)}>
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
            <TemplatePickerDialog
                open={isTemplatePickerOpen}
                extension={TEMPLATE_EXTENSIONS.docx}
                onClose={() => setTemplatePickerOpen(false)}
                onPick={handlePickTemplate}
                isPending={copyTemplate.isPending}
            />
            <SaveVersionDialog
                isOpen={isSaveVersionOpen}
                onClose={() => setSaveVersionOpen(false)}
                documentId={props.documentId}
            />
            <PromptDialog
                isOpen={isCopyOpen}
                onClose={() => setCopyOpen(false)}
                onSubmit={handleCopy}
                title="Make a copy"
                placeholder="Copy name"
                defaultValue={`${props.documentName} (copy)`}
                confirmLabel="Create copy"
                required
            />
            <PromptDialog
                isOpen={isRenameOpen}
                onClose={() => setRenameOpen(false)}
                onSubmit={handleRename}
                title="Rename"
                defaultValue={props.documentName}
                confirmLabel="Rename"
                required
            />
            <ConfirmDialog
                isOpen={isTrashOpen}
                onClose={() => setTrashOpen(false)}
                onConfirm={handleTrash}
                title="Move to trash"
                message="This document will be moved to the trash. You can restore it from Drive within the retention window."
                confirmLabel="Move to trash"
                isDestructive
            />
            {capabilities.canUseFileActions && isShareOpen && (
                <Suspense fallback={null}>
                    <ShareDialogConnected
                        open={isShareOpen}
                        itemId={props.documentId}
                        itemName={props.documentName}
                        onClose={() => setShareOpen(false)}
                    />
                </Suspense>
            )}
        </>
    )
}
