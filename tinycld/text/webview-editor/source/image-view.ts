import { resolveImageSrc } from '../../lib/image-src-auth'
import { currentImageAuth, onImageAuthChange } from './image-auth'

// The attributes WrappedImage renders: Tiptap Image's plus `wrap`.
export interface ImageViewAttrs {
    src?: string | null
    alt?: string | null
    title?: string | null
    width?: number | string | null
    height?: number | string | null
    wrap?: string | null
}

// An <img> node view for the WebView editor. The stored src is a tokenless
// drive-file URL, so the element carries the viewer's credential; a node
// view (not renderHTML) keeps that credential out of copied HTML. The
// element is updated in place: each new <img> is another fetch, and share
// visitors' image requests are rate-limited and never cached.
export function createImageView(initial: ImageViewAttrs) {
    const dom = document.createElement('img')
    let attrs = initial

    const setAttr = (name: string, value: unknown) => {
        if (value == null || value === '') dom.removeAttribute(name)
        else dom.setAttribute(name, String(value))
    }
    const render = () => {
        setAttr('alt', attrs.alt)
        setAttr('title', attrs.title)
        setAttr('width', attrs.width)
        setAttr('height', attrs.height)
        setAttr('data-wrap', attrs.wrap)
        const src = resolveImageSrc(attrs.src ?? '', currentImageAuth())
        if (dom.getAttribute('src') !== src) dom.setAttribute('src', src)
    }
    render()
    const stopFollowing = onImageAuthChange(render)

    return {
        dom,
        update(next: ImageViewAttrs): boolean {
            attrs = next
            render()
            return true
        },
        destroy: stopFollowing,
    }
}
