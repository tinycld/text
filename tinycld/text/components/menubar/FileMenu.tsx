import { downloadFromUrl } from '@tinycld/core/file-viewer/file-url'
import { useEditorMount } from '@tinycld/core/lib/editor/editor-mount'
import { captureException } from '@tinycld/core/lib/errors'
import { useOrgHref } from '@tinycld/core/lib/org-routes'
import { ConfirmDialog } from '@tinycld/core/ui/ConfirmDialog'
import { Menu, MenuBarMenu } from '@tinycld/core/ui/menubar'
import { PromptDialog } from '@tinycld/core/ui/PromptDialog'
import { TemplatePickerDialog } from '@tinycld/drive/components/TemplatePickerDialog'
import { useHasTemplates } from '@tinycld/drive/hooks/use-template-items'
import { useCopyDriveItem } from '@tinycld/drive/lib/copy-drive-item'
import { exportItem } from '@tinycld/drive/lib/export-pdf'
import { itemFileUrl } from '@tinycld/drive/lib/item-file-url'
import {
    fromTemplateName,
    isTemplateName,
    TEMPLATE_EXTENSIONS,
    toTemplateName,
} from '@tinycld/drive/lib/template-naming'
import { versionHistoryHref } from '@tinycld/drive/lib/version-history-href'
import { router } from 'expo-router'
import { lazy, Suspense, useState } from 'react'
import type { PMNode } from '../../lib/markdown/types'
import { DOCX_MIME_TYPE } from '../../lib/mime'
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

    // "Export as template" reuses the folder-picker copy flow (the copy
    // reads this room's current state through drive's stable file
    // endpoint), saving the current doc as a
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

    // Drive's stable file endpoint: the server flushes this room first, so
    // the download holds the edits on screen, and the URL has no blob name
    // in it, so it stays valid across saves. downloadFromUrl saves on web
    // and opens the share sheet on native.
    const downloadSource = async () => {
        if (!props.sourceFile) return
        const url = await itemFileUrl(props.documentId)
        downloadFromUrl(url, props.documentName, DOCX_MIME_TYPE)
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

    // Exports the stored .docx blob to PDF on the server (omnidoc). Like
    // Download (.docx), this reflects the last persisted state, not unflushed
    // live edits — the live room auto-persists on a debounce.
    const downloadPdf = () => {
        exportItem(props.documentId, props.documentName, 'pdf')
    }

    return (
        <>
            <MenuBarMenu menuId="file" label="File">
                <Menu.Item label="New document" onSelect={() => router.push(orgHref('text'))} />
                {hasTemplates && (
                    <Menu.Item
                        label="New from template…"
                        onSelect={() => setTemplatePickerOpen(true)}
                    />
                )}
                <Menu.Item label="Open" onSelect={() => router.push(orgHref('drive'))} />
                <Menu.Item label="Make a copy" onSelect={() => setCopyOpen(true)} />
                {!isAlreadyTemplate && (
                    <Menu.Item label="Export as template…" onSelect={handleExportTemplate} />
                )}
                {capabilities.canUseFileActions && (
                    <Menu.Item label="Share" onSelect={() => setShareOpen(true)} />
                )}
                <Menu.Item label="Save version" onSelect={() => setSaveVersionOpen(true)} />
                <Menu.Item
                    label="Version history"
                    onSelect={() => router.push(versionHistoryHref(props.documentId))}
                />
                <Menu.Separator />
                <Menu.Item
                    label="Download (.docx)"
                    onSelect={downloadSource}
                    isDisabled={!props.sourceFile}
                />
                <Menu.Item
                    label="Download (.md)"
                    onSelect={downloadMarkdown}
                    isDisabled={!props.tiptapEditor}
                />
                <Menu.Item
                    label="Download (.pdf)"
                    onSelect={downloadPdf}
                    isDisabled={!props.sourceFile}
                />
                <Menu.Separator />
                <Menu.Item label="Rename" onSelect={() => setRenameOpen(true)} />
                <Menu.Item label="Move to trash" onSelect={() => setTrashOpen(true)} />
                <Menu.Item label="Details" onSelect={props.fileActions.openDriveDetails} />
                <Menu.Separator />
                <Menu.Item label="Print" shortcut="⌘P" onSelect={props.onPrint} />
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
