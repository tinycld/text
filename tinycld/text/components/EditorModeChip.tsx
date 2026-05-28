// EditorModeChip — visible only in Suggesting mode. Shows the current
// user's author color as the chip background so the writer can't
// confuse "my changes go in directly" with "my changes are proposals".
// The author color is derived deterministically from the user-org id
// (the same identifier that names suggestions inside the suggestions
// map), so the chip and the highlighted suggestion ranges in the doc
// share one color per user.
//
// The chip renders nothing in Editing / Viewing modes, and nothing
// before identity is set on the store — the screen sets identity via
// useEffect once useCurrentRole() resolves, so the chip flashes in
// only after the user-org id is known.

import { Text, View } from 'react-native'
import { useStore } from 'zustand'
import { colorForUser } from '../lib/color-for-user'
import { EDITOR_MODE_SUGGESTING, type EditorModeStore } from '../stores/editor-mode-store'

interface EditorModeChipProps {
    modeStore: EditorModeStore
}

// Chip foreground is hard-locked to white via Tailwind's text-white
// utility. colorForUser returns HSL at 45% lightness, dark enough
// that white text hits AA contrast across the full hue range — same
// convention PresenceAvatars uses when rendering an initial on a
// per-user color disc. Theme tokens like text-foreground / text-background
// would flip with the user's mode and break contrast against the
// (theme-independent) author color.

export function EditorModeChip({ modeStore }: EditorModeChipProps) {
    const mode = useStore(modeStore, s => s.mode)
    const identity = useStore(modeStore, s => s.identity)

    if (mode !== EDITOR_MODE_SUGGESTING) return null
    if (!identity) return null

    const bgColor = colorForUser(identity.userOrgId)

    return (
        <View className="px-3 py-1 border-b border-border flex-row">
            <View
                accessibilityLabel="Suggesting mode"
                style={{
                    paddingHorizontal: 8,
                    paddingVertical: 2,
                    borderRadius: 4,
                    backgroundColor: bgColor,
                    alignSelf: 'flex-start',
                }}
            >
                <Text className="text-white" style={{ fontSize: 12, fontWeight: '600' }}>
                    Suggesting
                </Text>
            </View>
        </View>
    )
}
