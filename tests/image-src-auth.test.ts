import { describe, expect, it } from 'vitest'
import { resolveImageSrc } from '../tinycld/text/lib/image-src-auth'

const driveSrc = '/api/files/drive_items/img123/photo_ab12.png'

describe('resolveImageSrc', () => {
    it('appends the file token to a drive image for a signed-in viewer', () => {
        expect(
            resolveImageSrc(driveSrc, { kind: 'token', baseURL: 'https://h.example', token: 't 1' })
        ).toBe(`https://h.example${driveSrc}?token=t%201`)
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
        // The URL is rebuilt on the server's own origin from the drive-file
        // path, so a host written into the src (absolute, protocol-relative,
        // or backslash) never receives the token.
        const token = { kind: 'token', baseURL: 'https://h.example', token: 'tok' } as const
        const own = 'https://h.example/api/files/drive_items/img123/photo_ab12.png?token=tok'
        for (const src of [
            `https://evil.example${driveSrc}`,
            `//evil.example${driveSrc}`,
            `/\\evil.example${driveSrc}`,
        ]) {
            expect(resolveImageSrc(src, token)).toBe(own)
        }
        expect(
            resolveImageSrc(`//evil.example${driveSrc}`, {
                kind: 'share',
                baseURL: 'https://h.example',
                sessionToken: 's',
            })
        ).toBe('https://h.example/api/drive/share-session/attachments/img123?inline=1&session=s')
    })

    it('loads an image stored under an earlier server address from the current one', () => {
        expect(
            resolveImageSrc(`http://old-host.lan:8090${driveSrc}`, {
                kind: 'token',
                baseURL: 'https://h.example',
                token: 'tok',
            })
        ).toBe('https://h.example/api/files/drive_items/img123/photo_ab12.png?token=tok')
    })

    it('leaves the src alone before any credential is known', () => {
        expect(resolveImageSrc(driveSrc, undefined)).toBe(driveSrc)
    })
})
