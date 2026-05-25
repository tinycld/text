import { registerPreview, registerPublicPreview } from '@tinycld/core/file-viewer/registry'
import type { ReactNode } from 'react'
import { PREVIEW_CSS } from './components/preview-css'
import { TextPreview } from './components/TextPreview'
import './lib/open-in-text-action'
import './lib/open-in-text-drive-action'
import { DOCX_MIME_TYPE } from './lib/mime'

// Register the docx preview at module-load time. The provider module
// is imported by core's package orchestrator exactly once during
// boot, so the registry stays free of duplicate entries.
registerPreview(DOCX_MIME_TYPE, { preview: TextPreview })

// Public (anonymous share-link) preview config. Core's generic
// PublicDocumentPreview fetches via the share-session render endpoint and
// styles the fragment with this CSS — text never enters drive's frontend.
registerPublicPreview(DOCX_MIME_TYPE, {
    css: PREVIEW_CSS,
    isEmpty: html => !html.includes('tinycld-text-'),
    anchorKind: 'text_range',
})

interface TextProviderProps {
    children: ReactNode
}

export default function TextProvider({ children }: TextProviderProps) {
    return <>{children}</>
}
