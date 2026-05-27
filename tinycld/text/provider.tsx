import { registerPreview, registerShareEditor } from '@tinycld/core/file-viewer/registry'
import { lazy, type ReactNode } from 'react'
import { TextPreview } from './components/TextPreview'
import './lib/open-in-text-action'
import './lib/open-in-text-drive-action'
import { DOCX_MIME_TYPE } from './lib/mime'

// Lazy-import the editor screen so this provider module — eagerly loaded
// by tinycld.config.ts — doesn't pull the screen tree into core's import
// graph. Importing screens/[id] eagerly reaches DocumentToolbar →
// ImageInsertButton → drive/lib/upload-to-drive → core/lib/pocketbase,
// closing a require cycle through the generated config. The share editor
// is rendered behind a Suspense boundary in drive's share/[token] route.
const TextEditorFromMount = lazy(() =>
    import('./screens/[id]').then(m => ({ default: m.TextEditorFromMount }))
)

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
