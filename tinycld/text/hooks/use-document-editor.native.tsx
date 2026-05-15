import { WebView } from 'react-native-webview'
import { View } from 'react-native'
import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'
import type { EditorResult } from '@tinycld/core/lib/editor/types'
import { editorHtml } from '../webview-editor/build/editorHtml'

export interface UseDocumentEditorOptions {
    yDoc: Y.Doc
    awareness: Awareness
    user?: { name: string; color: string }
    editable?: boolean
    placeholder?: string
}

// useDocumentEditor (native) — Phase 3 stage: prove the bundle pipeline.
// This wires a bare WebView with our customSource HTML, no TenTap, no
// Yjs hookup, no message bus. iPad users see a "Hello World — Phase 3
// bundle is alive" message inside the WebView. Phase 4 swaps this for
// useWebViewEditor + the real TipTap+Yjs config.
//
// (Previously this file was a "Document editing on mobile is coming
// soon" RN placeholder; see git history for that version.)
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
        EditorComponent: function Phase3HelloWorld() {
            return (
                <View style={{ flex: 1 }}>
                    <WebView
                        originWhitelist={['*']}
                        source={{ html: editorHtml }}
                        style={{ flex: 1, backgroundColor: 'transparent' }}
                    />
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
