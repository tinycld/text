import { create } from '@tinycld/core/lib/store'

export const EDITOR_MODE_EDITING = 'editing'
export const EDITOR_MODE_SUGGESTING = 'suggesting'
export const EDITOR_MODE_VIEWING = 'viewing'

export type EditorMode =
    | typeof EDITOR_MODE_EDITING
    | typeof EDITOR_MODE_SUGGESTING
    | typeof EDITOR_MODE_VIEWING

export interface EditorIdentity {
    userOrgId: string
}

export interface EditorModeState {
    mode: EditorMode
    identity: EditorIdentity | null
    setMode: (mode: EditorMode) => void
    setIdentity: (identity: EditorIdentity | null) => void
}

// createEditorModeStore is exported (rather than a singleton hook)
// because the editor has two mounts (web + WebView), and each one
// needs its own per-tab state. The screen wires a single store
// instance into both via React context — see use-document-editor.web
// and the WebView's message-bus bridge.
//
// Phase 2a does not persist mode across reloads — the default is
// always 'editing'. A future phase may persist it via the same
// asyncStorage pattern other text stores use (e.g. mail's compose
// store) if user research shows it's needed.
export function createEditorModeStore() {
    return create<EditorModeState>((set) => ({
        mode: EDITOR_MODE_EDITING,
        identity: null,
        setMode: (mode) => set({ mode }),
        setIdentity: (identity) => set({ identity }),
    }))
}

export type EditorModeStore = ReturnType<typeof createEditorModeStore>
