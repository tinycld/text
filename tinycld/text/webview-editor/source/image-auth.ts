import type { ImageSrcAuth } from '../../lib/image-src-auth'

// The credential the page's images are fetched with. The host sends it in
// init and again whenever it changes (a rotated file token); an image view
// reads the latest one when it renders.
let current: ImageSrcAuth | undefined

export function setImageAuth(auth: ImageSrcAuth | undefined): void {
    current = auth
}

export function currentImageAuth(): ImageSrcAuth | undefined {
    return current
}
