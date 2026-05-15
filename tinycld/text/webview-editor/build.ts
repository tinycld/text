import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { bundleWebViewEditor } from '@tinycld/core/lib/editor/webview-bundler/build'

// Text's WebView-editor build entry. Called by:
//   pnpm exec tsx tinycld/text/webview-editor/build.ts
// from the @tinycld/text repo root. Produces a self-contained HTML
// string at tinycld/text/webview-editor/build/editorHtml.ts which
// the native useDocumentEditor imports and hands to TenTap's
// customSource option.

const here = dirname(fileURLToPath(import.meta.url))
const sourceDir = resolve(here, 'source')
const buildDir = resolve(here, 'build')

async function main() {
    const result = await bundleWebViewEditor({
        entryHtml: resolve(sourceDir, 'index.html'),
        entryScript: resolve(sourceDir, 'entry.ts'),
        outFile: resolve(buildDir, 'editorHtml.ts'),
    })
    console.log(
        `[text webview-editor] bundled ${result.htmlSize} bytes → ${result.outFile}`
    )
}

main().catch((err) => {
    console.error('[text webview-editor] build failed:', err)
    process.exit(1)
})
