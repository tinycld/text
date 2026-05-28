// EditorModeMenu — toolbar dropdown that switches between
// Editing / Suggesting / Viewing. The current mode is owned by the
// per-document Zustand store the screen wires through DocumentToolbar
// (see screens/[id].tsx). Selecting a row calls setMode(...) on the
// store — both editor mounts subscribe through the command layer and
// pick up the new mode without re-mounting.
//
// canEdit / canSuggest gate which rows are visible:
//   - canEdit=false hides the Editing row
//   - canSuggest=false hides the Suggesting row
// Viewing is always available — anyone with read access can drop to it.
// Phase 2a hard-codes canEdit = canSuggest = true at the screen call
// site; Task 9 replaces those with the real permission gate.

import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { Menu } from '@tinycld/core/ui/menu'
import { ChevronDown } from 'lucide-react-native'
import { Platform, Pressable, Text, View } from 'react-native'
import { useStore } from 'zustand'
import {
    EDITOR_MODE_EDITING,
    EDITOR_MODE_SUGGESTING,
    EDITOR_MODE_VIEWING,
    type EditorMode,
    type EditorModeStore,
} from '../stores/editor-mode-store'

interface EditorModeMenuProps {
    modeStore: EditorModeStore
    canEdit: boolean
    canSuggest: boolean
}

export const MODE_LABELS: Record<EditorMode, string> = {
    [EDITOR_MODE_EDITING]: 'Editing',
    [EDITOR_MODE_SUGGESTING]: 'Suggesting',
    [EDITOR_MODE_VIEWING]: 'Viewing',
}

// Pure helper: returns the modes that should appear in the dropdown
// given permission flags. Viewing is always available; Editing and
// Suggesting are gated on the matching capability. Exported so the
// unit test can verify the gate logic without rendering React.
export function getVisibleModes(canEdit: boolean, canSuggest: boolean): EditorMode[] {
    const modes: EditorMode[] = []
    if (canEdit) modes.push(EDITOR_MODE_EDITING)
    if (canSuggest) modes.push(EDITOR_MODE_SUGGESTING)
    modes.push(EDITOR_MODE_VIEWING)
    return modes
}

export function EditorModeMenu({ modeStore, canEdit, canSuggest }: EditorModeMenuProps) {
    const mode = useStore(modeStore, s => s.mode)
    const fgColor = useThemeColor('foreground')
    const mutedColor = useThemeColor('muted-foreground')

    const handleSelect = (next: EditorMode) => {
        modeStore.getState().setMode(next)
    }

    // Stop the toolbar's mousedown-focus suppression pattern from
    // applying — opening the dropdown should keep the ProseMirror
    // selection where it was without the buttons stealing focus.
    const webProps =
        Platform.OS === 'web'
            ? { onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault() }
            : {}

    return (
        <Menu>
            <Menu.Trigger>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Editor mode"
                    {...webProps}
                    className="flex-row items-center gap-1 rounded-md px-2 py-1.5"
                >
                    <Text style={{ color: fgColor, fontSize: 13, fontWeight: '500' }}>
                        {MODE_LABELS[mode]}
                    </Text>
                    <ChevronDown size={14} color={mutedColor} />
                </Pressable>
            </Menu.Trigger>
            <Menu.Portal>
                <Menu.Overlay />
                <Menu.Content placement="bottom" align="end">
                    <View
                        {...(typeof document !== 'undefined'
                            ? { 'data-tinycld-menu': 'content' }
                            : {})}
                    >
                        {getVisibleModes(canEdit, canSuggest).map(m => (
                            <Menu.Item key={m} onPress={() => handleSelect(m)}>
                                <Menu.ItemTitle>{MODE_LABELS[m]}</Menu.ItemTitle>
                            </Menu.Item>
                        ))}
                    </View>
                </Menu.Content>
            </Menu.Portal>
        </Menu>
    )
}
