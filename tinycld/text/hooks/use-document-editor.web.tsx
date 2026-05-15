import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import { Table } from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useMemo } from 'react'
import { View } from 'react-native'
import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'
import { useThemeColor } from '../use-app-theme'
import type { EditorCommands, EditorHandle, EditorResult, EditorToolbarState } from './types'

export interface UseDocumentEditorOptions {
    // Required: the Collaboration extension (yjs binding via Tiptap's
    // bundled y-tiptap, a fork of y-prosemirror) binds to a
    // Y.XmlFragment named "prosemirror" inside this Y.Doc. Caller must
    // hold the Y.Doc open for the lifetime of the editor.
    yDoc: Y.Doc
    // Required: shared awareness for the same room. Cursor positions
    // and presence info ride on this. Use the `user` option below to
    // set the local user identity for collaboration cursors —
    // CollaborationCaret writes its `user` option into awareness.user
    // on mount, so any pre-mount awareness.setLocalStateField('user', ...)
    // would be clobbered.
    awareness: Awareness
    // Optional: local user identity to display in collaboration cursors
    // (the floating cursor labels other peers see). The CollaborationCaret
    // extension writes this into awareness.user on mount; if omitted,
    // peers see anonymous cursors.
    user?: { name: string; color: string }
    // editable=false renders the editor in read-only mode. Tiptap's
    // editable property can be flipped after mount, but for v1 we set it
    // at construction time (consumers pass `editable: !readOnly` from
    // the room's serverHello).
    editable?: boolean
    // Optional placeholder shown when the doc is empty.
    placeholder?: string
}

// useDocumentEditor returns a Tiptap editor configured for collaborative
// .docx-style document editing. The hook MUST be called only after the
// caller has a Y.Doc + Awareness pair from a connected realtime room —
// Tiptap's Collaboration extension cannot be reconfigured after mount.
//
// Web variant: uses @tiptap/react directly (no WebView). Mounts
// <EditorContent /> in the DOM. Companion: use-document-editor.native.tsx
// is a v1 stub showing a "coming soon" placeholder.
export function useDocumentEditor(options: UseDocumentEditorOptions): EditorResult {
    const placeholderColor = useThemeColor('field-placeholder')
    const primaryColor = useThemeColor('primary')

    const tiptapEditor = useEditor(
        {
            editable: options.editable ?? true,
            extensions: [
                // StarterKit bundles paragraphs, headings, bold, italic,
                // underline, link, bullet/ordered lists, blockquote, and
                // undo/redo. The Collaboration extension below provides
                // yjs-aware history, so we disable StarterKit's local
                // undoRedo (was named "history" in tiptap v2) to avoid
                // both running. The `link` config flows through to
                // StarterKit's bundled Link extension; do NOT re-import
                // @tiptap/extension-link or @tiptap/extension-underline
                // separately — Tiptap's findDuplicates would warn and
                // duplicate keymaps cause flaky toolbar behavior.
                StarterKit.configure({
                    undoRedo: false,
                    link: { openOnClick: false },
                }),
                Placeholder.configure({ placeholder: options.placeholder ?? 'Start writing…' }),
                Table.configure({ resizable: false }),
                TableRow,
                TableHeader,
                TableCell,
                Image,
                Collaboration.configure({
                    document: options.yDoc,
                    field: 'prosemirror',
                }),
                CollaborationCaret.configure({
                    provider: { awareness: options.awareness },
                    user: options.user,
                }),
            ],
        },
        [options.yDoc, options.awareness, options.user?.name, options.user?.color]
    )

    const editor: EditorHandle = useMemo(
        () => ({
            getHTML: () => Promise.resolve(tiptapEditor?.getHTML() ?? ''),
            getText: () => Promise.resolve(tiptapEditor?.getText() ?? ''),
            setContent: (_html: string) => {
                // No-op on collaborative editors: directly setting content via
                // ProseMirror would trigger a destructive Yjs replace, blowing
                // away every peer's state. Seed the Y.Doc on the server side
                // (e.g. via translate.SeedFromPMJSON) instead.
                if (typeof console !== 'undefined') {
                    // biome-ignore lint/suspicious/noConsole: developer-error guard for a footgun API on collaborative editors
                    console.warn(
                        'useDocumentEditor.setContent is a no-op for collaborative editors; seed the Y.Doc instead'
                    )
                }
            },
            focus: (position?: 'start' | 'end') => {
                if (position === 'start') {
                    tiptapEditor?.chain().focus('start').run()
                } else {
                    tiptapEditor?.chain().focus('end').run()
                }
            },
            clear: () => tiptapEditor?.commands.clearContent(),
            getSelection: () => {
                const selection = tiptapEditor?.state.selection
                if (!selection) return Promise.resolve(null)
                return Promise.resolve({ from: selection.from, to: selection.to })
            },
        }),
        [tiptapEditor]
    )

    const commands: EditorCommands = useMemo(
        () => ({
            toggleBold: () => tiptapEditor?.chain().focus().toggleBold().run(),
            toggleItalic: () => tiptapEditor?.chain().focus().toggleItalic().run(),
            toggleUnderline: () => tiptapEditor?.chain().focus().toggleUnderline().run(),
            toggleBulletList: () => tiptapEditor?.chain().focus().toggleBulletList().run(),
            toggleOrderedList: () => tiptapEditor?.chain().focus().toggleOrderedList().run(),
            toggleBlockquote: () => tiptapEditor?.chain().focus().toggleBlockquote().run(),
            toggleHeading: (level: number) =>
                tiptapEditor
                    ?.chain()
                    .focus()
                    .toggleHeading({ level: level as 1 | 2 | 3 | 4 | 5 | 6 })
                    .run(),
            setLink: (url: string) => tiptapEditor?.chain().focus().setLink({ href: url }).run(),
            removeLink: () => tiptapEditor?.chain().focus().unsetLink().run(),
            undo: () => tiptapEditor?.chain().focus().undo().run(),
            redo: () => tiptapEditor?.chain().focus().redo().run(),
            insertTable: (rows: number, cols: number) =>
                tiptapEditor
                    ?.chain()
                    .focus()
                    .insertTable({ rows, cols, withHeaderRow: true })
                    .run(),
            addRowBefore: () => tiptapEditor?.chain().focus().addRowBefore().run(),
            addRowAfter: () => tiptapEditor?.chain().focus().addRowAfter().run(),
            addColumnBefore: () => tiptapEditor?.chain().focus().addColumnBefore().run(),
            addColumnAfter: () => tiptapEditor?.chain().focus().addColumnAfter().run(),
            deleteRow: () => tiptapEditor?.chain().focus().deleteRow().run(),
            deleteColumn: () => tiptapEditor?.chain().focus().deleteColumn().run(),
            deleteTable: () => tiptapEditor?.chain().focus().deleteTable().run(),
            insertImage: (src: string, alt?: string) =>
                tiptapEditor?.chain().focus().setImage({ src, alt }).run(),
        }),
        [tiptapEditor]
    )

    const toolbarState: EditorToolbarState = {
        isBoldActive: tiptapEditor?.isActive('bold') ?? false,
        isItalicActive: tiptapEditor?.isActive('italic') ?? false,
        isUnderlineActive: tiptapEditor?.isActive('underline') ?? false,
        isBulletListActive: tiptapEditor?.isActive('bulletList') ?? false,
        isOrderedListActive: tiptapEditor?.isActive('orderedList') ?? false,
        isBlockquoteActive: tiptapEditor?.isActive('blockquote') ?? false,
        isLinkActive: tiptapEditor?.isActive('link') ?? false,
        currentLink: (tiptapEditor?.getAttributes('link')?.href as string) ?? null,
        activeHeadingLevel: ((): number | null => {
            for (let level = 1; level <= 6; level++) {
                if (tiptapEditor?.isActive('heading', { level })) return level
            }
            return null
        })(),
        isInTable: tiptapEditor?.isActive('table') ?? false,
    }

    const EditorComponent = useMemo(
        () =>
            function DocumentEditorContent() {
                return (
                    <View
                        className="flex-1 min-h-[200px] tinycld-document-editor"
                        style={{
                            // @ts-expect-error CSS custom properties for web
                            '--editor-placeholder-color': placeholderColor,
                            '--editor-primary-color': primaryColor,
                        }}
                    >
                        <EditorContent editor={tiptapEditor} />
                    </View>
                )
            },
        [tiptapEditor, placeholderColor, primaryColor]
    )

    return { editor, EditorComponent, commands, toolbarState }
}
