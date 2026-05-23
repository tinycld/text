// Unit tests for the DropCap extension's addGlobalAttributes config —
// the parseHTML / renderHTML shape of the dropCap paragraph attribute.
// Mirrors alignment-indent.test.ts: the Tiptap extension can't be
// instantiated cheaply without a full ProseMirror schema, so we drive
// the attribute callbacks directly off the extension's config object.

import { describe, expect, it } from 'vitest'
import { DropCap } from '../tinycld/text/lib/editor/drop-cap'

type DropCapAttrCallbacks = {
    default: boolean
    parseHTML: (el: { getAttribute: (name: string) => string | null }) => boolean
    renderHTML: (attrs: { dropCap: unknown }) => Record<string, string>
}

function getDropCapAttrCallbacks(): DropCapAttrCallbacks {
    const extConfig = (DropCap as unknown as { config: Record<string, unknown> }).config
    const fn = extConfig.addGlobalAttributes as (this: {
        options: { types: string[] }
    }) => Array<{ attributes: { dropCap: DropCapAttrCallbacks } }>
    const groups = fn.call({ options: { types: ['paragraph'] } })
    const callbacks = groups[0]?.attributes?.dropCap
    if (!callbacks) {
        throw new Error('drop-cap: dropCap attribute missing from addGlobalAttributes output')
    }
    return callbacks
}

describe('drop-cap attribute round-trip', () => {
    it('defaults to false', () => {
        const cb = getDropCapAttrCallbacks()
        expect(cb.default).toBe(false)
    })

    it('renders nothing when dropCap is false', () => {
        const cb = getDropCapAttrCallbacks()
        expect(cb.renderHTML({ dropCap: false })).toEqual({})
    })

    it('emits data-drop-cap="true" when dropCap is true', () => {
        const cb = getDropCapAttrCallbacks()
        expect(cb.renderHTML({ dropCap: true })).toEqual({ 'data-drop-cap': 'true' })
    })

    it('parses data-drop-cap="true" back to true, everything else to false', () => {
        const cb = getDropCapAttrCallbacks()
        const el = (val: string | null) => ({
            getAttribute: (name: string) => (name === 'data-drop-cap' ? val : null),
        })
        expect(cb.parseHTML(el('true'))).toBe(true)
        expect(cb.parseHTML(el(null))).toBe(false)
        expect(cb.parseHTML(el('false'))).toBe(false)
        // Strict match: only the exact "true" string counts, so a copied
        // paragraph can't accidentally inherit the attr from junk values.
        expect(cb.parseHTML(el('1'))).toBe(false)
        expect(cb.parseHTML(el('TRUE'))).toBe(false)
    })

    it('round-trips: render then parse recovers the boolean', () => {
        const cb = getDropCapAttrCallbacks()
        const rendered = cb.renderHTML({ dropCap: true })
        const el = {
            getAttribute: (name: string) =>
                name === 'data-drop-cap' ? (rendered['data-drop-cap'] ?? null) : null,
        }
        expect(cb.parseHTML(el)).toBe(true)
    })
})

describe('drop-cap commands surface', () => {
    it('exposes set/unset/toggle drop-cap commands', () => {
        const extConfig = (DropCap as unknown as { config: Record<string, unknown> }).config
        const addCommands = extConfig.addCommands as (this: {
            options: { types: string[] }
            editor: unknown
        }) => Record<string, unknown>
        const commands = addCommands.call({
            options: { types: ['paragraph'] },
            editor: { isActive: () => false },
        })
        expect(Object.keys(commands).sort()).toEqual([
            'setDropCap',
            'toggleDropCap',
            'unsetDropCap',
        ])
    })

    it('toggleDropCap turns the attr ON when no paragraph is active', () => {
        const updates: Array<{ type: string; attrs: Record<string, unknown> }> = []
        const fakeCommands = {
            updateAttributes: (type: string, attrs: Record<string, unknown>) => {
                updates.push({ type, attrs })
                return true
            },
        }
        const extConfig = (DropCap as unknown as { config: Record<string, unknown> }).config
        const addCommands = extConfig.addCommands as (this: {
            options: { types: string[] }
            editor: { isActive: () => boolean }
        }) => Record<string, (...a: unknown[]) => (ctx: unknown) => boolean>
        const commands = addCommands.call({
            options: { types: ['paragraph'] },
            // isActive=false ⇒ not currently a drop cap ⇒ toggle should set true.
            editor: { isActive: () => false },
        })
        const ok = commands.toggleDropCap()({
            editor: { isActive: () => false },
            commands: fakeCommands,
        })
        expect(ok).toBe(true)
        expect(updates).toEqual([{ type: 'paragraph', attrs: { dropCap: true } }])
    })

    it('toggleDropCap turns the attr OFF when the paragraph already has it', () => {
        const updates: Array<{ type: string; attrs: Record<string, unknown> }> = []
        const fakeCommands = {
            updateAttributes: (type: string, attrs: Record<string, unknown>) => {
                updates.push({ type, attrs })
                return true
            },
        }
        const extConfig = (DropCap as unknown as { config: Record<string, unknown> }).config
        const addCommands = extConfig.addCommands as (this: {
            options: { types: string[] }
            editor: { isActive: () => boolean }
        }) => Record<string, (...a: unknown[]) => (ctx: unknown) => boolean>
        const commands = addCommands.call({
            options: { types: ['paragraph'] },
            editor: { isActive: () => true },
        })
        const ok = commands.toggleDropCap()({
            editor: { isActive: () => true },
            commands: fakeCommands,
        })
        expect(ok).toBe(true)
        expect(updates).toEqual([{ type: 'paragraph', attrs: { dropCap: false } }])
    })
})
