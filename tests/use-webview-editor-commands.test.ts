// Verifies that useWebViewEditor's `commands` surface posts the right
// `format` namespace messages over the WebView bridge. Milestone A
// added 11 new commands and a setCellShading wrapper; this test pins
// each command's wire shape so a future refactor that breaks the
// protocol fails here rather than silently no-op'ing on iOS/Android.
//
// The hook itself is hard to drive under vitest because it renders the
// native WebView host, AND per-file `@vitest-environment` directives don't
// apply to test files that are reached through a sibling-package symlink
// (which is every test in this repo). We instead test the pure
// command-builder the hook calls — buildWebViewEditorCommands(post) — by
// passing a recording poster we can assert on.

import type { EditorMessage } from '@tinycld/core/lib/editor/message-bus/types'
import { buildWebViewEditorCommands } from '@tinycld/core/lib/editor/webview-editor-commands'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type PostMessageSpy = ReturnType<typeof vi.fn<(message: EditorMessage) => boolean>>

// A poster that records every message and reports it as delivered.
function stubBridge(postMessage: PostMessageSpy) {
    return postMessage
}

let postMessage: PostMessageSpy

beforeEach(() => {
    postMessage = vi.fn(() => true)
})

// Read the most-recently-posted message off the spy. The wire format the
// in-WebView dispatcher consumes is `{ namespace, type, payload }`.
function lastPostedMessage(): { namespace: string; type: string; payload: unknown } {
    expect(postMessage).toHaveBeenCalled()
    const last = postMessage.mock.calls.at(-1)
    expect(last).toBeDefined()
    return last?.[0] as EditorMessage
}

describe('buildWebViewEditorCommands — Milestone A new commands', () => {
    it('toggleCode posts { format, toggle-code, null }', () => {
        const commands = buildWebViewEditorCommands(stubBridge(postMessage))
        commands.toggleCode?.()
        expect(lastPostedMessage()).toEqual({
            namespace: 'format',
            type: 'toggle-code',
            payload: null,
        })
    })

    it('toggleCodeBlock posts { format, toggle-code-block, null }', () => {
        const commands = buildWebViewEditorCommands(stubBridge(postMessage))
        commands.toggleCodeBlock?.()
        expect(lastPostedMessage()).toEqual({
            namespace: 'format',
            type: 'toggle-code-block',
            payload: null,
        })
    })

    it("setTextAlign forwards the align value as the payload (e.g. 'center')", () => {
        const commands = buildWebViewEditorCommands(stubBridge(postMessage))
        commands.setTextAlign?.('center')
        expect(lastPostedMessage()).toEqual({
            namespace: 'format',
            type: 'set-text-align',
            payload: 'center',
        })
    })

    it('setTextAlign accepts all four legal alignments', () => {
        const commands = buildWebViewEditorCommands(stubBridge(postMessage))
        for (const align of ['left', 'center', 'right', 'justify'] as const) {
            postMessage.mockClear()
            commands.setTextAlign?.(align)
            expect(lastPostedMessage().payload).toBe(align)
        }
    })

    it('unsetTextAlign posts { format, unset-text-align, null }', () => {
        const commands = buildWebViewEditorCommands(stubBridge(postMessage))
        commands.unsetTextAlign?.()
        expect(lastPostedMessage()).toEqual({
            namespace: 'format',
            type: 'unset-text-align',
            payload: null,
        })
    })

    it('indentBlock posts { format, indent-block, null }', () => {
        const commands = buildWebViewEditorCommands(stubBridge(postMessage))
        commands.indentBlock?.()
        expect(lastPostedMessage()).toEqual({
            namespace: 'format',
            type: 'indent-block',
            payload: null,
        })
    })

    it('outdentBlock posts { format, outdent-block, null }', () => {
        const commands = buildWebViewEditorCommands(stubBridge(postMessage))
        commands.outdentBlock?.()
        expect(lastPostedMessage()).toEqual({
            namespace: 'format',
            type: 'outdent-block',
            payload: null,
        })
    })

    it('setFontSize forwards the integer px value as the payload (e.g. 18)', () => {
        const commands = buildWebViewEditorCommands(stubBridge(postMessage))
        commands.setFontSize?.(18)
        expect(lastPostedMessage()).toEqual({
            namespace: 'format',
            type: 'set-font-size',
            payload: 18,
        })
    })

    it('unsetFontSize posts { format, unset-font-size, null }', () => {
        const commands = buildWebViewEditorCommands(stubBridge(postMessage))
        commands.unsetFontSize?.()
        expect(lastPostedMessage()).toEqual({
            namespace: 'format',
            type: 'unset-font-size',
            payload: null,
        })
    })

    it("setFontFamily forwards the family name as the payload (e.g. 'Georgia')", () => {
        const commands = buildWebViewEditorCommands(stubBridge(postMessage))
        commands.setFontFamily?.('Georgia')
        expect(lastPostedMessage()).toEqual({
            namespace: 'format',
            type: 'set-font-family',
            payload: 'Georgia',
        })
    })

    it('unsetFontFamily posts { format, unset-font-family, null }', () => {
        const commands = buildWebViewEditorCommands(stubBridge(postMessage))
        commands.unsetFontFamily?.()
        expect(lastPostedMessage()).toEqual({
            namespace: 'format',
            type: 'unset-font-family',
            payload: null,
        })
    })

    it("setTextColor forwards the CSS color value as the payload (e.g. '#FF0000')", () => {
        const commands = buildWebViewEditorCommands(stubBridge(postMessage))
        commands.setTextColor?.('#FF0000')
        expect(lastPostedMessage()).toEqual({
            namespace: 'format',
            type: 'set-text-color',
            payload: '#FF0000',
        })
    })

    it('unsetTextColor posts { format, unset-text-color, null }', () => {
        const commands = buildWebViewEditorCommands(stubBridge(postMessage))
        commands.unsetTextColor?.()
        expect(lastPostedMessage()).toEqual({
            namespace: 'format',
            type: 'unset-text-color',
            payload: null,
        })
    })

    it("setBackgroundColor forwards the CSS color value as the payload (e.g. '#FFFF00')", () => {
        const commands = buildWebViewEditorCommands(stubBridge(postMessage))
        commands.setBackgroundColor?.('#FFFF00')
        expect(lastPostedMessage()).toEqual({
            namespace: 'format',
            type: 'set-background-color',
            payload: '#FFFF00',
        })
    })

    it('unsetBackgroundColor posts { format, unset-background-color, null }', () => {
        const commands = buildWebViewEditorCommands(stubBridge(postMessage))
        commands.unsetBackgroundColor?.()
        expect(lastPostedMessage()).toEqual({
            namespace: 'format',
            type: 'unset-background-color',
            payload: null,
        })
    })

    it("setCellShading wraps the color in { color } so the in-WebView dispatcher's destructure works", () => {
        const commands = buildWebViewEditorCommands(stubBridge(postMessage))
        commands.setCellShading?.('#FFFF00')
        expect(lastPostedMessage()).toEqual({
            namespace: 'format',
            type: 'set-cell-shading',
            payload: { color: '#FFFF00' },
        })
    })

    it('setCellShading(null) clears shading by posting { color: null }', () => {
        const commands = buildWebViewEditorCommands(stubBridge(postMessage))
        commands.setCellShading?.(null)
        expect(lastPostedMessage()).toEqual({
            namespace: 'format',
            type: 'set-cell-shading',
            payload: { color: null },
        })
    })

    it('updateImageAttrs forwards { wrap, width, height } over format/update-image-attrs', () => {
        const commands = buildWebViewEditorCommands(stubBridge(postMessage))
        commands.updateImageAttrs?.({ wrap: 'left', width: 400, height: 300 })
        expect(lastPostedMessage()).toEqual({
            namespace: 'format',
            type: 'update-image-attrs',
            payload: { wrap: 'left', width: 400, height: 300 },
        })
    })

    it('updateImageAttrs accepts a wrap-only payload (size unchanged)', () => {
        const commands = buildWebViewEditorCommands(stubBridge(postMessage))
        commands.updateImageAttrs?.({ wrap: null })
        expect(lastPostedMessage()).toEqual({
            namespace: 'format',
            type: 'update-image-attrs',
            payload: { wrap: null },
        })
    })

    it('updateImageAttrs accepts a size-only payload (wrap unchanged)', () => {
        const commands = buildWebViewEditorCommands(stubBridge(postMessage))
        commands.updateImageAttrs?.({ width: 200, height: 150 })
        expect(lastPostedMessage()).toEqual({
            namespace: 'format',
            type: 'update-image-attrs',
            payload: { width: 200, height: 150 },
        })
    })

    it('tolerates a poster that reports no page to post to', () => {
        const absent = vi.fn(() => false)
        const commands = buildWebViewEditorCommands(absent)
        expect(() => commands.toggleCode?.()).not.toThrow()
        expect(absent).toHaveBeenCalledTimes(1)
    })
})
