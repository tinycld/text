// End-to-end contract test for the native document toolbar.
//
// The bug this guards against: a toolbar button calls a command on the
// object from buildWebViewEditorCommands (native side); that command
// either calls a TenTap bridge (bridge.toggleBold()) or posts a
// 'format'-namespace message. The message crosses into the WebView and
// is dispatched by installFormatBridge into a TipTap chain. The two
// halves are unit-tested in isolation elsewhere, but the WIRE FORMAT
// between them was wrong: TenTap wraps every bridge command in a
// { type: 'action', payload: <action> } envelope, and installFormatBridge
// read the outer 'action' — so every TenTap-bridge button silently
// no-oped on native. Isolated unit tests missed it because each side
// was tested against a hand-written middle shape.
//
// This test wires the REAL buildWebViewEditorCommands to the REAL
// installFormatBridge through a faithful reproduction of TenTap's
// transport, so a regression on either side (or a drift in TenTap's
// envelope) fails here. Every button on DocumentToolbar is exercised.

import { buildWebViewEditorCommands } from '@tinycld/core/lib/editor/webview-editor-commands'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFormatBridge } from '../tinycld/text/webview-editor/source/bridges/format-bridge'

// --- WebView-side listener registry ----------------------------------
// installFormatBridge attaches to window/document 'message' events.

interface ListenerRegistry {
    listeners: Map<string, Set<EventListener>>
    addEventListener: (event: string, fn: EventListener) => void
    removeEventListener: (event: string, fn: EventListener) => void
}

function makeRegistry(): ListenerRegistry {
    const listeners = new Map<string, Set<EventListener>>()
    return {
        listeners,
        addEventListener: (event, fn) => {
            if (!listeners.has(event)) listeners.set(event, new Set())
            listeners.get(event)?.add(fn)
        },
        removeEventListener: (event, fn) => {
            listeners.get(event)?.delete(fn)
        },
    }
}

let stubWindow: ListenerRegistry
let stubDocument: ListenerRegistry

// Deliver a JSON string into the WebView's message listeners, exactly
// as react-native-webview does when the host calls webview.postMessage.
function deliverToWebView(json: string) {
    const evt = { data: json } as unknown as MessageEvent
    for (const fn of stubWindow.listeners.get('message') ?? new Set<EventListener>()) {
        fn(evt as unknown as Event)
    }
}

// --- Fake TipTap editor: records the terminal chain command ----------

interface ChainCall {
    methods: Array<{ name: string; args: unknown[] }>
}

function makeFakeEditor() {
    const calls: ChainCall[] = []
    function makeChain() {
        const call: ChainCall = { methods: [] }
        const proxy: Record<string, unknown> = new Proxy(
            {},
            {
                get(_t, prop) {
                    if (prop === 'run') {
                        return () => {
                            calls.push(call)
                            return true
                        }
                    }
                    return (...args: unknown[]) => {
                        call.methods.push({ name: String(prop), args })
                        return proxy
                    }
                },
            }
        )
        return proxy
    }
    const editor = {
        chain: () => makeChain(),
        commands: { focus: () => true },
        setEditable: () => undefined,
    } as unknown as Parameters<typeof installFormatBridge>[0]
    return { editor, calls }
}

// --- The native-side bridge the toolbar's commands drive -------------
//
// buildWebViewEditorCommands needs a WebViewCommandBridge: the TenTap
// command methods (toggleBold, setLink, ...) plus webviewRef for the
// sendFormatMessage path. We reproduce TenTap's transport exactly:
//
//   - sendAction wraps the action in { type: 'action', payload } and
//     posts it (matches @10play/tentap-editor useEditorBridge.js
//     sendAction). Each TenTap command method calls sendAction with the
//     literal action string that bridge emits (matches each bridge's
//     extendEditorInstance in @10play/tentap-editor/bridges/*.js).
//   - webviewRef.current.postMessage is the raw poster the
//     sendFormatMessage path uses; TenTap uses the same one for
//     sendAction, so both land in the WebView identically.

function makeNativeBridge() {
    const post = (message: unknown) => deliverToWebView(JSON.stringify(message))
    // TenTap's sendAction envelope — reproduced from
    // @10play/tentap-editor RichText/useEditorBridge.js.
    const sendAction = (action: { type: string; payload?: unknown }) =>
        post({ type: 'action', payload: action })

    return {
        // TenTap bridge command surface. The action strings and payload
        // shapes mirror each bridge's extendEditorInstance verbatim.
        toggleBold: () => sendAction({ type: 'toggle-bold' }),
        toggleItalic: () => sendAction({ type: 'toggle-italic' }),
        toggleUnderline: () => sendAction({ type: 'toggle-underline' }),
        toggleBulletList: () => sendAction({ type: 'toggle-bulletList' }),
        toggleOrderedList: () => sendAction({ type: 'toggle-orderedList' }),
        toggleBlockquote: () => sendAction({ type: 'toggle-blockquote' }),
        toggleHeading: (level: 1 | 2 | 3 | 4 | 5 | 6) =>
            sendAction({ type: 'toggle-heading', payload: level }),
        setLink: (url: string) => sendAction({ type: 'set-link', payload: url }),
        undo: () => sendAction({ type: 'undo' }),
        redo: () => sendAction({ type: 'redo' }),
        // The sendFormatMessage path posts through here directly.
        webviewRef: { current: { postMessage: (s: string) => deliverToWebView(s) } },
    } as unknown as Parameters<typeof buildWebViewEditorCommands>[0]
}

beforeEach(() => {
    stubWindow = makeRegistry()
    stubDocument = makeRegistry()
    vi.stubGlobal('window', stubWindow)
    vi.stubGlobal('document', stubDocument)
})

afterEach(() => {
    vi.unstubAllGlobals()
})

// Drive one command through the full native→WebView→TipTap pipeline and
// return the terminal chain method names of the single resulting chain.
function roundtrip(run: (commands: ReturnType<typeof buildWebViewEditorCommands>) => void) {
    const fake = makeFakeEditor()
    const bridge = installFormatBridge(fake.editor, () => undefined)
    const commands = buildWebViewEditorCommands(makeNativeBridge())
    run(commands)
    bridge.destroy()
    return fake.calls
}

// Every button lives in one of two groups. `chain` is the terminal
// TipTap method the WebView must invoke for that button to have effect.
// A button that produces zero chain calls is a dead button — the exact
// failure the user reported.

describe('toolbar command round-trip — TenTap-bridge buttons', () => {
    const cases: Array<{
        label: string
        run: (c: ReturnType<typeof buildWebViewEditorCommands>) => void
        chain: string
    }> = [
        { label: 'Bold', run: c => c.toggleBold(), chain: 'toggleBold' },
        { label: 'Italic', run: c => c.toggleItalic(), chain: 'toggleItalic' },
        { label: 'Underline', run: c => c.toggleUnderline(), chain: 'toggleUnderline' },
        { label: 'Bullet list', run: c => c.toggleBulletList(), chain: 'toggleBulletList' },
        { label: 'Ordered list', run: c => c.toggleOrderedList(), chain: 'toggleOrderedList' },
        { label: 'Blockquote', run: c => c.toggleBlockquote(), chain: 'toggleBlockquote' },
        { label: 'Heading 1', run: c => c.toggleHeading(1), chain: 'toggleHeading' },
        { label: 'Heading 2', run: c => c.toggleHeading(2), chain: 'toggleHeading' },
        { label: 'Heading 3', run: c => c.toggleHeading(3), chain: 'toggleHeading' },
        { label: 'Undo', run: c => c.undo(), chain: 'undo' },
        { label: 'Redo', run: c => c.redo(), chain: 'redo' },
    ]

    for (const { label, run, chain } of cases) {
        it(`${label} reaches editor.chain().${chain}()`, () => {
            const calls = roundtrip(run)
            expect(calls).toHaveLength(1)
            expect(calls[0].methods.map(m => m.name)).toContain(chain)
        })
    }

    it('Heading forwards the level to toggleHeading', () => {
        const calls = roundtrip(c => c.toggleHeading(2))
        const h = calls[0].methods.find(m => m.name === 'toggleHeading')
        expect(h?.args).toEqual([{ level: 2 }])
    })

    it('Link (set) reaches setLink with the url', () => {
        const calls = roundtrip(c => c.setLink('https://example.com'))
        const setLink = calls[0].methods.find(m => m.name === 'setLink')
        expect(setLink?.args).toEqual([{ href: 'https://example.com' }])
    })

    it('Link (remove, via empty setLink) reaches unsetLink', () => {
        const calls = roundtrip(c => c.removeLink())
        expect(calls[0].methods.map(m => m.name)).toContain('unsetLink')
    })
})

describe('toolbar command round-trip — format-namespace buttons', () => {
    const cases: Array<{
        label: string
        run: (c: ReturnType<typeof buildWebViewEditorCommands>) => void
        chain: string
    }> = [
        { label: 'Inline code', run: c => c.toggleCode?.(), chain: 'toggleCode' },
        { label: 'Code block', run: c => c.toggleCodeBlock?.(), chain: 'toggleCodeBlock' },
        { label: 'Text color (set)', run: c => c.setTextColor?.('#ff0000'), chain: 'setColor' },
        { label: 'Text color (unset)', run: c => c.unsetTextColor?.(), chain: 'unsetColor' },
        {
            label: 'Highlight (set)',
            run: c => c.setBackgroundColor?.('#ffff00'),
            chain: 'setBackgroundColor',
        },
        {
            label: 'Highlight (unset)',
            run: c => c.unsetBackgroundColor?.(),
            chain: 'unsetBackgroundColor',
        },
        { label: 'Align left', run: c => c.setTextAlign?.('left'), chain: 'setTextAlign' },
        { label: 'Align center', run: c => c.setTextAlign?.('center'), chain: 'setTextAlign' },
        { label: 'Align right', run: c => c.setTextAlign?.('right'), chain: 'setTextAlign' },
        { label: 'Justify', run: c => c.setTextAlign?.('justify'), chain: 'setTextAlign' },
        { label: 'Outdent', run: c => c.outdentBlock?.(), chain: 'outdentBlock' },
        { label: 'Indent', run: c => c.indentBlock?.(), chain: 'indentBlock' },
        { label: 'Insert table', run: c => c.insertTable?.(3, 3), chain: 'insertTable' },
        { label: 'Insert image', run: c => c.insertImage?.('https://x/y.png'), chain: 'setImage' },
        { label: 'Font size', run: c => c.setFontSize?.(18), chain: 'setFontSize' },
        { label: 'Font family', run: c => c.setFontFamily?.('Georgia'), chain: 'setFontFamily' },
    ]

    for (const { label, run, chain } of cases) {
        it(`${label} reaches editor.chain().${chain}()`, () => {
            const calls = roundtrip(run)
            expect(calls).toHaveLength(1)
            expect(calls[0].methods.map(m => m.name)).toContain(chain)
        })
    }

    it('Text color set forwards the color value', () => {
        const calls = roundtrip(c => c.setTextColor?.('#ff0000'))
        const setColor = calls[0].methods.find(m => m.name === 'setColor')
        expect(setColor?.args).toEqual(['#ff0000'])
    })
})
