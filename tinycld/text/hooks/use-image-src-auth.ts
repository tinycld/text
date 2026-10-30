import { useFileToken } from '@tinycld/core/file-viewer/use-authed-file-url'
import { useEditorMountOptional } from '@tinycld/core/lib/editor/editor-mount'
import { pb } from '@tinycld/core/lib/pocketbase'
import { useMemo } from 'react'
import type { ImageSrcAuth } from '../lib/image-src-auth'

// The credential this viewer fetches the document's drive images with: the
// share session for an anonymous share visitor, otherwise the file token.
// Memoized on its values: the native host posts it to the WebView on change.
export function useImageSrcAuth(): ImageSrcAuth | undefined {
    const credential = useEditorMountOptional()?.realtimeCredential
    const sessionToken = credential?.kind === 'shareSession' ? credential.token : undefined
    const { data: token } = useFileToken()
    return useMemo(() => {
        if (sessionToken) return { kind: 'share', baseURL: pb.baseURL, sessionToken }
        return token ? { kind: 'token', baseURL: pb.baseURL, token } : undefined
    }, [sessionToken, token])
}
