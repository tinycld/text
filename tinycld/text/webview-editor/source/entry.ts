// Phase 3 entry: just enough to confirm the bundle pipeline lands.
// Phase 4 replaces this with the real TipTap + Yjs editor.

const root = document.getElementById('root')
if (root) {
    root.innerHTML = [
        '<div class="hello-world">',
        '<h1>tinycld text editor</h1>',
        '<p>Hello World — Phase 3 bundle is alive.</p>',
        '<p>This view is replaced by a TipTap + Yjs editor in Phase 4.</p>',
        '</div>',
    ].join('')
}

// Tell native we're ready. Mirrors TenTap's existing
// CoreEditorActionType.EditorReady so the host's useBridgeState
// observes isReady=true. The exact string matches the value of
// CoreEditorActionType.EditorReady in TenTap's source.
const message = { type: 'editor-ready', payload: undefined }
const w = window as unknown as { ReactNativeWebView?: { postMessage: (s: string) => void } }
w.ReactNativeWebView?.postMessage(JSON.stringify(message))
