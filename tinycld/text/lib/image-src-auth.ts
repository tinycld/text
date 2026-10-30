import { shareAttachmentUrl } from '@tinycld/drive/lib/share-attachment-url'

// How the viewer of a document may fetch the drive images inserted into it.
// The stored src is a tokenless /api/files/drive_items/<id>/<file> URL (see
// buildInsertedImageURL); every file is served behind drive_items' view
// rule, so a render surface adds the viewer's credential:
//   - token: a signed-in viewer's PocketBase file token.
//   - share: an anonymous share visitor, who has only the share session; the
//     image is fetched through drive's share-attachment endpoint.
//
// Pure (no `pb`), so the native editor's WebView bundle uses it too.
export type ImageSrcAuth =
    | { kind: 'token'; baseURL: string; token: string }
    | { kind: 'share'; baseURL: string; sessionToken: string }

const DRIVE_FILES = '/api/files/drive_items/'

export function resolveImageSrc(src: string, auth: ImageSrcAuth | undefined): string {
    if (!auth || src.includes('token=')) return src
    const at = src.indexOf(DRIVE_FILES)
    if (at < 0 || !isOwnServer(src, auth.baseURL)) return src
    if (auth.kind === 'token') {
        return `${src}${src.includes('?') ? '&' : '?'}token=${encodeURIComponent(auth.token)}`
    }
    const itemId = src.slice(at + DRIVE_FILES.length).split('/')[0]
    if (!itemId) return src
    return shareAttachmentUrl(auth.baseURL, itemId, auth.sessionToken)
}

// A root-relative src is this server's; an absolute one must share the
// server's origin, or the credential would go to whatever host wrote it.
function isOwnServer(src: string, baseURL: string): boolean {
    if (src.startsWith('/')) return true
    try {
        return new URL(src).origin === new URL(baseURL).origin
    } catch {
        return false
    }
}
