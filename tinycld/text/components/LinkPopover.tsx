import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { useEffect, useState } from 'react'
import { Modal, Platform, Pressable, Text, TextInput, View } from 'react-native'

interface LinkPopoverProps {
    isOpen: boolean
    initialUrl: string
    onCancel: () => void
    onInsert: (url: string) => void
}

// Minimal link insert/edit UI. Renders as a centred Modal — popover
// positioning over a toolbar button is platform-dependent and not
// worth wiring up in v1; the modal is unambiguous and works on every
// platform. An empty URL on submit signals "remove link" to the
// caller (which calls removeLink() instead of setLink('')).
export function LinkPopover({ isOpen, initialUrl, onCancel, onInsert }: LinkPopoverProps) {
    const [url, setUrl] = useState(initialUrl)
    const fg = useThemeColor('foreground')
    const placeholderColor = useThemeColor('field-placeholder')

    // Sync the input with the toolbar's current selection whenever the
    // popover re-opens — e.g. clicking on a different link should pre-
    // populate the input with the new link's href, not the previous
    // one.
    // biome-ignore lint/correctness/useExhaustiveDependencies: only re-sync on open transitions, not when initialUrl changes mid-session
    useEffect(() => {
        if (isOpen) setUrl(initialUrl)
    }, [isOpen])

    if (!isOpen) return null

    return (
        <Modal transparent animationType="fade" visible={isOpen} onRequestClose={onCancel}>
            <Pressable
                className="flex-1 items-center justify-center bg-black/30"
                onPress={onCancel}
            >
                <Pressable className="w-[320px] gap-3 p-4 rounded-lg bg-background border border-border">
                    <Text className="text-sm font-semibold text-foreground">Insert link</Text>
                    <TextInput
                        autoFocus
                        value={url}
                        onChangeText={setUrl}
                        placeholder="https://example.com"
                        placeholderTextColor={placeholderColor}
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="url"
                        className="px-2 py-1.5 rounded-md border border-border bg-field-background"
                        style={{ color: fg }}
                    />
                    <View className="flex-row justify-end gap-2">
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Cancel"
                            onPress={onCancel}
                            className="px-3 py-1.5 rounded-md bg-surface-secondary"
                            hitSlop={
                                Platform.OS === 'web'
                                    ? undefined
                                    : { top: 6, bottom: 6, left: 4, right: 4 }
                            }
                        >
                            <Text className="text-sm text-foreground">Cancel</Text>
                        </Pressable>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Insert link"
                            onPress={() => onInsert(url.trim())}
                            className="px-3 py-1.5 rounded-md bg-accent"
                            hitSlop={
                                Platform.OS === 'web'
                                    ? undefined
                                    : { top: 6, bottom: 6, left: 4, right: 4 }
                            }
                        >
                            <Text className="text-sm font-medium text-accent-foreground">
                                Insert
                            </Text>
                        </Pressable>
                    </View>
                </Pressable>
            </Pressable>
        </Modal>
    )
}
