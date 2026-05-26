import { registerPreview, registerShareEditor } from '@tinycld/core/file-viewer/registry'
import type { ReactNode } from 'react'
import { TextPreview } from './components/TextPreview'
import './lib/open-in-text-action'
import './lib/open-in-text-drive-action'
import { DOCX_MIME_TYPE } from './lib/mime'
import { TextEditorFromMount } from './screens/[id]'

// Register the docx preview at module-load time. The provider module
// is imported by core's package orchestrator exactly once during
// boot, so the registry stays free of duplicate entries.
registerPreview(DOCX_MIME_TYPE, { preview: TextPreview })

registerShareEditor(DOCX_MIME_TYPE, { component: TextEditorFromMount })

interface TextProviderProps {
    children: ReactNode
}

export default function TextProvider({ children }: TextProviderProps) {
    return <>{children}</>
}
