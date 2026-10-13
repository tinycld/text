import { describe, expect, it } from 'vitest'
import {
    INVALID_LINK_ERROR,
    linkUrlSchema,
    normalizeLinkUrl,
} from '../tinycld/text/components/link-url-schema'

function parse(url: string) {
    return linkUrlSchema.safeParse({ url })
}

describe('linkUrlSchema', () => {
    it('accepts an empty url, which means remove the link', () => {
        expect(linkUrlSchema.parse({ url: '' })).toEqual({ url: '' })
    })

    it('treats whitespace-only as empty', () => {
        expect(linkUrlSchema.parse({ url: '   ' })).toEqual({ url: '' })
    })

    it('keeps a full https url as typed, minus surrounding whitespace', () => {
        expect(linkUrlSchema.parse({ url: '  https://example.com/a?b=1#c  ' })).toEqual({
            url: 'https://example.com/a?b=1#c',
        })
    })

    it('gives a bare domain an https:// prefix', () => {
        expect(linkUrlSchema.parse({ url: 'example.com/page' })).toEqual({
            url: 'https://example.com/page',
        })
    })

    it.each([
        'http://localhost:3000/x',
        'ftp://files.example.org',
        'mailto:someone@example.com',
        'tel:+15551234567',
        '#_Toc123',
    ])('accepts %s unchanged', url => {
        expect(linkUrlSchema.parse({ url })).toEqual({ url })
    })

    it.each([
        'not a link',
        'example',
        'https://',
        'javascript:alert(1)',
        'data:text/html,hi',
        'https://exa mple.com',
    ])('rejects %s with the invalid-link copy', url => {
        const result = parse(url)
        expect(result.success).toBe(false)
        expect(result.error?.issues[0]?.message).toBe(INVALID_LINK_ERROR)
    })
})

describe('normalizeLinkUrl', () => {
    it('leaves a url with a scheme alone', () => {
        expect(normalizeLinkUrl('mailto:a@b.co')).toBe('mailto:a@b.co')
    })

    it('leaves an anchor alone', () => {
        expect(normalizeLinkUrl('#top')).toBe('#top')
    })
})
