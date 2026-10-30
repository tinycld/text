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

// The URL is always rebuilt on the server's own base from the drive-file
// path: whatever host the src names (absolute, protocol-relative, an earlier
// address of this server) never receives the credential.
export function resolveImageSrc(src: string, auth: ImageSrcAuth | undefined): string {
    if (!auth || src.includes('token=')) return src
    const at = src.indexOf(DRIVE_FILES)
    if (at < 0) return src
    const [itemId, fileName] = src
        .slice(at + DRIVE_FILES.length)
        .split(/[?#]/)[0]
        .split('/')
    if (!itemId || !fileName) return src
    if (auth.kind === 'share') return shareAttachmentUrl(auth.baseURL, itemId, auth.sessionToken)
    const base = auth.baseURL.replace(/\/+$/, '')
    return `${base}${DRIVE_FILES}${itemId}/${fileName}?token=${encodeURIComponent(auth.token)}`
}
