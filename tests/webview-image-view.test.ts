// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { setImageAuth } from '../tinycld/text/webview-editor/source/image-auth'
import { createImageView } from '../tinycld/text/webview-editor/source/image-view'

// The native editor's <img> views. Each re-fetch of an image costs a request
// (share visitors are rate-limited and served no-store), so a view updates
// its element in place; and a credential that arrives after the images
// rendered must reach them.

const src = '/api/files/drive_items/img1/p.png'
const token = (t: string) => ({ kind: 'token', baseURL: 'https://h.example', token: t }) as const

afterEach(() => setImageAuth(undefined))

describe('createImageView', () => {
    it('keeps its element when the node changes', () => {
        setImageAuth(token('a'))
        const view = createImageView({ src, alt: 'one', wrap: null })
        const img = view.dom
        expect(view.update({ src, alt: 'two', wrap: 'left' })).toBe(true)
        expect(view.dom).toBe(img)
        expect(img.getAttribute('alt')).toBe('two')
        expect(img.getAttribute('data-wrap')).toBe('left')
        view.destroy()
    })

    it('picks up a credential that arrives after it rendered', () => {
        const view = createImageView({ src, wrap: null })
        expect(view.dom.getAttribute('src')).toBe(src)
        setImageAuth(token('late'))
        expect(view.dom.getAttribute('src')).toBe(
            'https://h.example/api/files/drive_items/img1/p.png?token=late'
        )
        view.destroy()
    })

    it('stops following the credential once destroyed', () => {
        setImageAuth(token('a'))
        const view = createImageView({ src, wrap: null })
        view.destroy()
        setImageAuth(token('b'))
        expect(view.dom.getAttribute('src')).toContain('token=a')
    })
})
