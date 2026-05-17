import { describe, expect, it, vi } from 'vitest'
import {
    createSlashMenuBridgeRender,
    serializeSlashMenuItems,
    toAnchoredSlashMenuRect,
} from '../tinycld/text/lib/editor/slash-menu'
import {
    SLASH_MENU_COMMANDS,
    type SlashMenuCommand,
} from '../tinycld/text/lib/editor/slash-menu-commands'

// slash-menu-bridge tests: the bridge render strategy is the WebView
// side of the anchored-overlay protocol. We test the wire-shape
// contracts by stubbing the deps the factory accepts (postToHost,
// newRequestId, exitSuggestion) and driving the returned lifecycle
// callbacks (onStart, onUpdate, onKeyDown, onExit) with synthetic
// SuggestionProps shapes. The full Tiptap-suggestion-plugin wiring is
// Playwright's job; here we lock the message contract.

function makeRect(over: Partial<DOMRect> = {}): DOMRect {
    return {
        top: 200,
        left: 50,
        right: 58,
        bottom: 218,
        width: 8,
        height: 18,
        x: 50,
        y: 200,
        toJSON: () => ({}),
        ...over,
    } as DOMRect
}

function makeProps(over: Record<string, unknown> = {}) {
    return {
        editor: { view: {} as unknown },
        items: SLASH_MENU_COMMANDS.slice(0, 3),
        query: '',
        text: '/',
        range: { from: 1, to: 2 },
        clientRect: () => makeRect(),
        command: vi.fn(),
        decorationNode: null,
        ...over,
    }
}

describe('serializeSlashMenuItems', () => {
    it('strips icon refs and run handlers, keeps id/label/iconName', () => {
        const out = serializeSlashMenuItems(SLASH_MENU_COMMANDS.slice(0, 2))
        expect(out).toEqual([
            { id: 'heading-1', label: 'Heading 1', iconName: 'Heading1' },
            { id: 'heading-2', label: 'Heading 2', iconName: 'Heading2' },
        ])
    })
})

describe('toAnchoredSlashMenuRect', () => {
    it('returns null when no rect is provided', () => {
        expect(toAnchoredSlashMenuRect(null)).toBeNull()
        expect(toAnchoredSlashMenuRect(undefined)).toBeNull()
    })

    it('preserves viewport coords and adds scroll snapshot', () => {
        const out = toAnchoredSlashMenuRect(makeRect({ top: 10, left: 20, width: 8, height: 18 }))
        expect(out).toEqual({
            top: 10,
            left: 20,
            width: 8,
            height: 18,
            // scrollX/scrollY pulled from window — in node test env
            // window is undefined under environment:'node', so the
            // fallbacks fire (0 / 0).
            scrollX: 0,
            scrollY: 0,
        })
    })
})

describe('createSlashMenuBridgeRender — wire shape', () => {
    it('posts ui.show-popover with kind/rect/items on onStart', () => {
        const postToHost = vi.fn()
        const newRequestId = vi.fn().mockReturnValue('req-1')
        const exitSuggestionStub = vi.fn()
        const render = createSlashMenuBridgeRender({
            postToHost,
            newRequestId,
            exitSuggestion: exitSuggestionStub,
        })
        const handlers = render()

        handlers.onStart?.(makeProps() as never)

        expect(postToHost).toHaveBeenCalledTimes(1)
        const msg = postToHost.mock.calls[0]?.[0] as {
            namespace: string
            type: string
            requestId: string
            payload: {
                kind: string
                rect: object
                payload: {
                    items: { id: string; iconName: string; label: string }[]
                    query: string
                    selectedIndex: number
                }
            }
        }
        expect(msg.namespace).toBe('ui')
        expect(msg.type).toBe('show-popover')
        expect(msg.requestId).toBe('req-1')
        expect(msg.payload.kind).toBe('slash-menu')
        expect(msg.payload.payload.selectedIndex).toBe(0)
        expect(msg.payload.payload.query).toBe('')
        expect(msg.payload.payload.items[0]?.id).toBe('heading-1')
        expect(msg.payload.payload.items[0]?.iconName).toBe('Heading1')
    })

    it('drops onStart when clientRect returns null (no anchor → no popover)', () => {
        const postToHost = vi.fn()
        const newRequestId = vi.fn().mockReturnValue('req-1')
        const render = createSlashMenuBridgeRender({
            postToHost,
            newRequestId,
            exitSuggestion: vi.fn(),
        })
        const handlers = render()
        handlers.onStart?.(makeProps({ clientRect: () => null }) as never)
        expect(postToHost).not.toHaveBeenCalled()
    })

    it('posts ui.popover-update on onUpdate with the same requestId', () => {
        const postToHost = vi.fn()
        const render = createSlashMenuBridgeRender({
            postToHost,
            newRequestId: () => 'req-2',
            exitSuggestion: vi.fn(),
        })
        const handlers = render()
        handlers.onStart?.(makeProps() as never)
        postToHost.mockClear()

        handlers.onUpdate?.(
            makeProps({
                items: SLASH_MENU_COMMANDS.filter(c => c.id.startsWith('heading')),
                query: 'h',
            }) as never
        )

        expect(postToHost).toHaveBeenCalledTimes(1)
        const msg = postToHost.mock.calls[0]?.[0] as {
            namespace: string
            type: string
            requestId: string
            payload: { items: unknown[]; query: string; selectedIndex: number }
        }
        expect(msg.namespace).toBe('ui')
        expect(msg.type).toBe('popover-update')
        expect(msg.requestId).toBe('req-2')
        expect(msg.payload.query).toBe('h')
        expect((msg.payload.items as { id: string }[]).map(i => i.id)).toEqual([
            'heading-1',
            'heading-2',
            'heading-3',
        ])
    })

    it('bumps selectedIndex on ArrowDown and posts popover-update', () => {
        const postToHost = vi.fn()
        const render = createSlashMenuBridgeRender({
            postToHost,
            newRequestId: () => 'req-3',
            exitSuggestion: vi.fn(),
        })
        const handlers = render()
        handlers.onStart?.(makeProps() as never)
        postToHost.mockClear()

        const event = {
            key: 'ArrowDown',
            preventDefault: vi.fn(),
        } as unknown as KeyboardEvent
        const consumed = handlers.onKeyDown?.({
            view: {} as never,
            event,
            range: { from: 0, to: 1 },
        })
        expect(consumed).toBe(true)
        const msg = postToHost.mock.calls[0]?.[0] as {
            type: string
            payload: { selectedIndex: number }
        }
        expect(msg.type).toBe('popover-update')
        expect(msg.payload.selectedIndex).toBe(1)
    })

    it('wraps selectedIndex on ArrowUp at the top of the list', () => {
        const postToHost = vi.fn()
        const render = createSlashMenuBridgeRender({
            postToHost,
            newRequestId: () => 'req-4',
            exitSuggestion: vi.fn(),
        })
        const handlers = render()
        handlers.onStart?.(makeProps() as never)
        postToHost.mockClear()
        const event = { key: 'ArrowUp', preventDefault: vi.fn() } as unknown as KeyboardEvent
        handlers.onKeyDown?.({ view: {} as never, event, range: { from: 0, to: 1 } })
        const msg = postToHost.mock.calls[0]?.[0] as { payload: { selectedIndex: number } }
        // From 0, ArrowUp wraps to length-1 = 2 in a 3-item list.
        expect(msg.payload.selectedIndex).toBe(2)
    })

    it('Enter invokes command with the selected item', () => {
        const command = vi.fn()
        const render = createSlashMenuBridgeRender({
            postToHost: vi.fn(),
            newRequestId: () => 'req-5',
            exitSuggestion: vi.fn(),
        })
        const handlers = render()
        handlers.onStart?.(makeProps({ command }) as never)
        const event = { key: 'Enter', preventDefault: vi.fn() } as unknown as KeyboardEvent
        const consumed = handlers.onKeyDown?.({
            view: {} as never,
            event,
            range: { from: 0, to: 1 },
        })
        expect(consumed).toBe(true)
        expect(command).toHaveBeenCalledTimes(1)
        // Selected index starts at 0 → first command from the props
        // (heading-1).
        expect((command.mock.calls[0]?.[0] as SlashMenuCommand).id).toBe('heading-1')
    })

    it('Escape calls exitSuggestion to dismiss the trigger', () => {
        const exitSuggestionStub = vi.fn()
        const render = createSlashMenuBridgeRender({
            postToHost: vi.fn(),
            newRequestId: () => 'req-6',
            exitSuggestion: exitSuggestionStub,
        })
        const handlers = render()
        handlers.onStart?.(makeProps() as never)
        const event = { key: 'Escape', preventDefault: vi.fn() } as unknown as KeyboardEvent
        handlers.onKeyDown?.({ view: {} as never, event, range: { from: 0, to: 1 } })
        expect(exitSuggestionStub).toHaveBeenCalledTimes(1)
    })

    it('posts ui.popover-dismissed on onExit', () => {
        const postToHost = vi.fn()
        const render = createSlashMenuBridgeRender({
            postToHost,
            newRequestId: () => 'req-7',
            exitSuggestion: vi.fn(),
        })
        const handlers = render()
        handlers.onStart?.(makeProps() as never)
        postToHost.mockClear()
        handlers.onExit?.(makeProps() as never)
        const msg = postToHost.mock.calls[0]?.[0] as {
            namespace: string
            type: string
            requestId: string
        }
        expect(msg.namespace).toBe('ui')
        expect(msg.type).toBe('popover-dismissed')
        expect(msg.requestId).toBe('req-7')
    })

    it('onExit without a live request does not post popover-dismissed', () => {
        // Simulates an onStart that failed early (null clientRect) so
        // the request was never opened; onExit must not post a
        // dismissal for a request that never existed.
        const postToHost = vi.fn()
        const render = createSlashMenuBridgeRender({
            postToHost,
            newRequestId: () => 'req-8',
            exitSuggestion: vi.fn(),
        })
        const handlers = render()
        handlers.onStart?.(makeProps({ clientRect: () => null }) as never)
        postToHost.mockClear()
        handlers.onExit?.(makeProps() as never)
        expect(postToHost).not.toHaveBeenCalled()
    })

    it('arrow keys are a no-op when no request is active', () => {
        const postToHost = vi.fn()
        const render = createSlashMenuBridgeRender({
            postToHost,
            newRequestId: () => 'req-9',
            exitSuggestion: vi.fn(),
        })
        const handlers = render()
        // Without onStart, the bridge has no active request — arrow keys
        // must not post anything.
        const event = { key: 'ArrowDown', preventDefault: vi.fn() } as unknown as KeyboardEvent
        const consumed = handlers.onKeyDown?.({
            view: {} as never,
            event,
            range: { from: 0, to: 1 },
        })
        expect(consumed).toBe(false)
        expect(postToHost).not.toHaveBeenCalled()
    })
})
