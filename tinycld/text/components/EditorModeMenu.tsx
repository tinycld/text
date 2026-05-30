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
    // Theme tokens for the non-Editing highlight. `primary` is the
    // app-wide accent (teal by default); `primary-foreground` is its
    // contrast token. Using theme tokens (not the per-user author
    // color) here because the dropdown is global UI chrome — the
    // author color belongs to the document's inline decorations and
    // would clash with the toolbar's visual language.
    const primaryColor = useThemeColor('primary')
    const primaryFg = useThemeColor('primary-foreground')

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

    // Non-Editing modes (Suggesting / Viewing) get the primary-color
    // pill treatment so the writer can see at a glance that their
    // edits aren't behaving like default Editing-mode edits. The
    // dropdown trigger itself doubles as the mode indicator — replaces
    // the separate Suggesting chip we used to render below the toolbar.
    const isNonDefault = mode !== EDITOR_MODE_EDITING
    const triggerBg = isNonDefault ? primaryColor : 'transparent'
    const triggerFg = isNonDefault ? primaryFg : fgColor
    const chevronColor = isNonDefault ? primaryFg : mutedColor
    // accessibilityLabel stays "Editor mode" across modes so callers
    // (Playwright specs, screen readers) refer to the control by its
    // role consistently. The current mode is exposed via the visible
    // Text child and via accessibilityValue.text — separates "what
    // control is this" (label) from "what is its current value"
    // (mode name). data-current-mode threads the mode through to the
    // DOM so e2e specs can pin the visual state with a stable
    // selector instead of trying to read accessibilityValue.
    const dataAttrs =
        Platform.OS === 'web' ? ({ 'data-current-mode': mode } as Record<string, string>) : {}

    return (
        <Menu>
            <Menu.Trigger>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Editor mode"
                    accessibilityValue={{ text: MODE_LABELS[mode] }}
                    {...webProps}
                    {...dataAttrs}
                    className="flex-row items-center gap-1 rounded-md px-2 py-1.5"
                    style={{ backgroundColor: triggerBg }}
                >
                    <Text style={{ color: triggerFg, fontSize: 13, fontWeight: '500' }}>
                        {MODE_LABELS[mode]}
                    </Text>
                    <ChevronDown size={14} color={chevronColor} />
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
