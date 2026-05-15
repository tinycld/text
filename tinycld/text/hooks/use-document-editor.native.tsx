import { Text, View } from 'react-native'
import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'
import type { EditorResult } from './types'

export interface UseDocumentEditorOptions {
    yDoc: Y.Doc
    awareness: Awareness
    user?: { name: string; color: string }
    editable?: boolean
    placeholder?: string
}

// useDocumentEditor (native) — v1 stub.
//
// The native variant requires a TenTap-backed editor with custom bridge
// extensions for collaboration, tables, and images. None of those are
// wired for v1; this stub returns an EditorResult with no-op commands
// and a placeholder EditorComponent so the package's type contract holds.
//
// v1 native users see a "Document editing on mobile is coming soon"
// placeholder. The web editor is the v1 target surface.
export function useDocumentEditor(_options: UseDocumentEditorOptions): EditorResult {
    return {
        editor: {
            getHTML: () => Promise.resolve(''),
            getText: () => Promise.resolve(''),
            setContent: () => {},
            focus: () => {},
            clear: () => {},
            getSelection: () => Promise.resolve(null),
        },
        EditorComponent: function NativeDocumentEditorPlaceholder() {
            return (
                <View className="flex-1 items-center justify-center p-8">
                    <Text className="text-muted-foreground text-center">
                        Document editing on mobile is coming soon. For now, please use a desktop
                        browser.
                    </Text>
                </View>
            )
        },
        commands: {
            toggleBold: () => {},
            toggleItalic: () => {},
            toggleUnderline: () => {},
            toggleBulletList: () => {},
            toggleOrderedList: () => {},
            toggleBlockquote: () => {},
            toggleHeading: () => {},
            setLink: () => {},
            removeLink: () => {},
            undo: () => {},
            redo: () => {},
        },
        toolbarState: {
            isBoldActive: false,
            isItalicActive: false,
            isUnderlineActive: false,
            isBulletListActive: false,
            isOrderedListActive: false,
            isBlockquoteActive: false,
            isLinkActive: false,
            currentLink: null,
        },
    }
}
