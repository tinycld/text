import { describe, expect, it } from 'vitest'
import {
    BORDER_COLOR_ERROR,
    BORDER_WIDTH_ERROR,
    borderMenuSchema,
    MAX_BORDER_WIDTH_PX,
} from '../tinycld/text/components/border-menu-schema'

function parse(fields: { widthPx?: string; color?: string }) {
    return borderMenuSchema.safeParse({ style: 'solid', widthPx: '1', color: '', ...fields })
}

function firstError(fields: { widthPx?: string; color?: string }) {
    const result = parse(fields)
    return result.success ? undefined : result.error.issues[0]?.message
}

describe('borderMenuSchema', () => {
    it('produces the border setCellBorders expects', () => {
        expect(
            borderMenuSchema.parse({ style: 'dashed', widthPx: ' 3 ', color: ' #1A2B3C ' })
        ).toEqual({ style: 'dashed', widthPx: 3, color: '#1A2B3C' })
    })

    it('uses the default 1px width when the width is empty', () => {
        expect(parse({ widthPx: '' }).data?.widthPx).toBe(1)
    })

    it('accepts the widest width .docx can store', () => {
        expect(parse({ widthPx: String(MAX_BORDER_WIDTH_PX) }).data?.widthPx).toBe(
            MAX_BORDER_WIDTH_PX
        )
    })

    it.each([
        '0',
        '-1',
        '2.5',
        'abc',
        String(MAX_BORDER_WIDTH_PX + 1),
    ])('rejects width %s', widthPx => {
        expect(firstError({ widthPx })).toBe(BORDER_WIDTH_ERROR)
    })

    it('maps an empty color to null so the border follows the theme', () => {
        expect(parse({ color: '  ' }).data?.color).toBeNull()
    })

    it('expands a short hex color', () => {
        expect(parse({ color: '#0aF' }).data?.color).toBe('#00aaFF')
    })

    it.each(['red', '#12', '#12345', '#ggg', 'rgb(0,0,0)'])('rejects color %s', color => {
        expect(firstError({ color })).toBe(BORDER_COLOR_ERROR)
    })

    it('rejects a style outside the menu', () => {
        expect(borderMenuSchema.safeParse({ style: 'none', widthPx: '1', color: '' }).success).toBe(
            false
        )
    })
})
