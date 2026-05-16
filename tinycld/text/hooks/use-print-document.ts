import { captureException } from '@tinycld/core/lib/errors'
import type { EditorHandle } from '@tinycld/core/lib/editor/types'
import { useCallback } from 'react'
import { handlePrint } from '../lib/print/handle-print'
import { renderPrintHtml } from '../lib/print/render-print-html'

// Pure async body, exported for unit testing in a node environment
// (no React renderer available — see tests/use-print-document.test.tsx
// and the same pattern in calc/tests/pivot-banner.test.tsx).
export async function printEditorDocument(
    editor: EditorHandle,
    deps: {
        handlePrint: (html: string) => Promise<void>
        captureException: (tag: string, err: unknown) => void
    } = { handlePrint, captureException }
): Promise<void> {
    try {
        const body = await editor.getHTML()
        const fullHtml = renderPrintHtml(body)
        await deps.handlePrint(fullHtml)
    } catch (err) {
        deps.captureException('usePrintDocument', err)
    }
}

// usePrintDocument returns a stable callback that prints the document
// currently held by the editor. The platform-resolved handlePrint
// opens the browser print dialog on web (via window.print()) or
// AirPrint / Android system print on native (via expo-print).
//
// Errors are captured (with cancellation suppressed inside the native
// handler), so callers don't need their own try/catch.
export function usePrintDocument(editor: EditorHandle) {
    return useCallback(() => printEditorDocument(editor), [editor])
}
