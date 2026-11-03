import type { ImageSrcAuth } from '../../lib/image-src-auth'

// The credential the page's images are fetched with. The host sends it in
// init and again whenever it changes (a rotated file token, or the first
// token arriving after init); every live image view re-resolves its src.
let current: ImageSrcAuth | undefined
const listeners = new Set<() => void>()

export function setImageAuth(auth: ImageSrcAuth | undefined): void {
    current = auth
    for (const listener of listeners) listener()
}

export function currentImageAuth(): ImageSrcAuth | undefined {
    return current
}

export function onImageAuthChange(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}
