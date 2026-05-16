import type { Editor as TiptapEditor } from '@tiptap/react'
import { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import {
    countCharacters,
    countWords,
    formatCharacterCount,
    formatWordCount,
} from '../lib/word-count'

interface WordCountBadgeProps {
    // Raw Tiptap Editor from the web variant of useDocumentEditor.
    // Passing null (native, or before the editor mounts) renders
    // nothing — the badge is web-only for v1. Native could land later
    // by exposing a textContent stream from the WebView bridge.
    editor: TiptapEditor | null
}

// Small muted chip in the document header showing the live word count.
// Subscribes directly to the editor's transaction stream rather than
// reading from toolbarState, so a keystroke only rerenders this
// component — the toolbar (which already rerenders on selection
// changes) doesn't pay extra. The character count rides along in the
// accessibility label so screen-reader users still hear it without
// crowding the visible chip.
export function WordCountBadge({ editor }: WordCountBadgeProps) {
    const counts = useEditorCounts(editor)
    if (!editor) return null

    const wordsLabel = formatWordCount(counts.words)
    const charsLabel = formatCharacterCount(counts.characters)

    return (
        <View
            accessibilityRole="text"
            accessibilityLabel={`${wordsLabel}, ${charsLabel}`}
            className="flex-row items-center gap-1.5 px-2 py-1 rounded-full"
        >
            <Text className="text-xs text-muted-foreground">{wordsLabel}</Text>
        </View>
    )
}

interface EditorCounts {
    words: number
    characters: number
}

// useState + an `update` listener is the right shape here even under
// the "avoid useState + useEffect" guideline: the Tiptap editor is a
// mutable external source (events, not React state), and isolating
// its state inside this badge is exactly what keeps a keystroke from
// rerendering the toolbar. useSyncExternalStore was considered but
// its getSnapshot returns must be reference-stable, and Tiptap doesn't
// expose a tx counter we can key on without re-reading textContent.
//
// Reading `editor.state.doc.textContent` is O(n) over the doc text and
// runs inside the transaction handler; for documents up to a few
// hundred KB this is faster than a 60Hz repaint, so no throttling is
// needed in v1. If profiling ever shows hot keystrokes, batch via
// requestAnimationFrame inside `onUpdate`.
function useEditorCounts(editor: TiptapEditor | null): EditorCounts {
    const [counts, setCounts] = useState<EditorCounts>(() => readCounts(editor))

    useEffect(() => {
        if (!editor) {
            setCounts({ words: 0, characters: 0 })
            return
        }
        setCounts(readCounts(editor))
        const onUpdate = () => setCounts(readCounts(editor))
        editor.on('update', onUpdate)
        return () => {
            editor.off('update', onUpdate)
        }
    }, [editor])

    return counts
}

function readCounts(editor: TiptapEditor | null): EditorCounts {
    if (!editor) return { words: 0, characters: 0 }
    const text = editor.state.doc.textContent
    return { words: countWords(text), characters: countCharacters(text) }
}
