import { describe, expect, it } from 'vitest'
import { resolveImageSrc } from '../tinycld/text/lib/image-src-auth'

const driveSrc = '/api/files/drive_items/img123/photo_ab12.png'

describe('resolveImageSrc', () => {
    it('appends the file token to a drive image for a signed-in viewer', () => {
        expect(
            resolveImageSrc(driveSrc, { kind: 'token', baseURL: 'https://h.example', token: 't 1' })
        ).toBe(`${driveSrc}?token=t%201`)
    })

    it('routes a drive image through the share session for an anonymous visitor', () => {
        expect(
            resolveImageSrc(`https://h.example${driveSrc}`, {
                kind: 'share',
                baseURL: 'https://h.example/',
                sessionToken: 's.j.w',
            })
        ).toBe(
            'https://h.example/api/drive/share-session/attachments/img123?inline=1&session=s.j.w'
        )
    })

    it('leaves data URIs, foreign images and already-tokened srcs alone', () => {
        const auth = { kind: 'token', baseURL: 'https://h.example', token: 'tok' } as const
        expect(resolveImageSrc('data:image/png;base64,AAAA', auth)).toBe(
            'data:image/png;base64,AAAA'
        )
        expect(resolveImageSrc('https://cdn.example/x.png', auth)).toBe('https://cdn.example/x.png')
        expect(resolveImageSrc(`${driveSrc}?token=old`, auth)).toBe(`${driveSrc}?token=old`)
    })

    it('never sends a credential to another host', () => {
        const foreign = `https://evil.example${driveSrc}`
        expect(
            resolveImageSrc(foreign, { kind: 'token', baseURL: 'https://h.example', token: 'tok' })
        ).toBe(foreign)
        expect(
            resolveImageSrc(foreign, {
                kind: 'share',
                baseURL: 'https://h.example',
                sessionToken: 's',
            })
        ).toBe(foreign)
    })

    it('leaves the src alone before any credential is known', () => {
        expect(resolveImageSrc(driveSrc, undefined)).toBe(driveSrc)
    })
})
