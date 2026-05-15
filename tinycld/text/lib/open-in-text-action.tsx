import { registerPreviewAction } from '@tinycld/core/file-viewer/preview-action-registry'
import { useOrgHref } from '@tinycld/core/lib/org-routes'
import { router } from 'expo-router'
import { ExternalLink } from 'lucide-react-native'
import { DOCX_MIME_TYPE } from './mime'

/**
 * Side-effect module: importing this file registers an "Open in Text"
 * entry with core's PreviewModal action registry. The text provider
 * imports it once at app boot so any preview surface (drive's
 * PreviewModal, mail's attachment preview, future packages) gets the
 * button when @tinycld/text is linked AND the previewed file is a
 * .docx.
 *
 * The onPress handler navigates to the full text editor at
 * /a/<orgSlug>/text/<drive_item_id>. The previewed file's recordId
 * IS the drive_item.id — text uses drive_items directly as the
 * canonical document record (see manifest.ts: `dependencies: ['drive']`),
 * so no lookup is required.
 *
 * Note: the registry's factory must run inside React (it calls hooks
 * like useOrgHref). Mail's AttachmentStrip and drive's PreviewModal
 * both call `getPreviewActionFactories().map((f) => f())` from inside
 * the component body, which provides the hook context.
 */
registerPreviewAction('text.open', () => {
    const orgHref = useOrgHref()
    return {
        id: 'text.open',
        icon: ExternalLink,
        label: 'Open in Text',
        isApplicable: source => source.mimeType === DOCX_MIME_TYPE,
        onPress: (source, ctx) => {
            router.push(orgHref('text/[id]', { id: source.recordId }))
            // Dismiss the preview modal — otherwise it sits open
            // over the destination editor.
            ctx.close()
        },
    }
})
