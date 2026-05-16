// usePrintDocument is a thin orchestration hook. The reusable part —
// pull HTML from the editor handle, wrap it via renderPrintHtml, hand
// the document to handlePrint, capture errors — lives in the exported
// pure async helper `printEditorDocument`. That's what we test here,
// matching the project-wide pattern (vitest runs in `node` without
// jsdom, so the React side isn't exercised in unit tests — see
// calc/tests/pivot-banner.test.tsx for the same constraint).
//
// The hook wrapper itself is one line of useCallback and doesn't
// merit its own test.

import type { EditorHandle } from '@tinycld/core/lib/editor/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { printEditorDocument } from '../tinycld/text/hooks/use-print-document'

function makeEditor(overrides: Partial<EditorHandle> = {}): EditorHandle {
    return {
        getHTML: async () => '<p>doc body</p>',
        getText: async () => 'doc body',
        setContent: () => {},
        focus: () => {},
        clear: () => {},
        getSelection: async () => null,
        ...overrides,
    }
}

function makeDeps() {
    return {
        handlePrint: vi.fn(async (_html: string) => {}),
        captureException: vi.fn(),
    }
}

let deps: ReturnType<typeof makeDeps>
beforeEach(() => {
    deps = makeDeps()
})

describe('printEditorDocument', () => {
    it('hands the editor HTML, wrapped in a print document, to handlePrint', async () => {
        const editor = makeEditor({ getHTML: async () => '<h1>Hi</h1><p>x</p>' })
        await printEditorDocument(editor, deps)
        expect(deps.handlePrint).toHaveBeenCalledTimes(1)
        const passed = deps.handlePrint.mock.calls[0][0]
        expect(passed.startsWith('<!doctype html>')).toBe(true)
        expect(passed).toContain('<h1>Hi</h1><p>x</p>')
        expect(passed).toContain('class="print-document"')
    })

    it('reports editor.getHTML() rejections via captureException without throwing', async () => {
        const editor = makeEditor({
            getHTML: async () => {
                throw new Error('serializer crashed')
            },
        })
        await expect(printEditorDocument(editor, deps)).resolves.toBeUndefined()
        expect(deps.handlePrint).not.toHaveBeenCalled()
        expect(deps.captureException).toHaveBeenCalledTimes(1)
        const [tag, err] = deps.captureException.mock.calls[0]
        expect(tag).toBe('usePrintDocument')
        expect((err as Error).message).toBe('serializer crashed')
    })

    it('reports handlePrint rejections via captureException without throwing', async () => {
        deps.handlePrint.mockRejectedValueOnce(new Error('print failed'))
        const editor = makeEditor()
        await expect(printEditorDocument(editor, deps)).resolves.toBeUndefined()
        expect(deps.captureException).toHaveBeenCalledTimes(1)
        expect((deps.captureException.mock.calls[0][1] as Error).message).toBe('print failed')
    })

    it('produces a self-contained HTML document (no external assets)', async () => {
        const editor = makeEditor()
        await printEditorDocument(editor, deps)
        const passed = deps.handlePrint.mock.calls[0][0]
        expect(passed).not.toMatch(/<link\b/i)
        expect(passed).not.toMatch(/@import\b/i)
        expect(passed).not.toMatch(/@font-face\b/i)
    })
})
