import type { EditorCommands } from '@tinycld/core/lib/editor/types'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { Controller, useForm, zodResolver } from '@tinycld/core/ui/form'
import {
    Grid3x3,
    type LucideIcon,
    Minus,
    Plus,
    Square,
    SquareDashed,
    SquareDot,
} from 'lucide-react-native'
import { Modal, Platform, Pressable, Text, TextInput, View } from 'react-native'
import type { CellBorderPreset, CellBorderStyle } from '../lib/cell-borders'
import { borderMenuDefaults, borderMenuSchema } from './border-menu-schema'

interface BorderMenuProps {
    isOpen: boolean
    onClose: () => void
    commands: EditorCommands
}

interface PresetButton {
    id: CellBorderPreset
    label: string
    Icon: LucideIcon
}

// The 3×3 preset grid matches the Google Docs / Word "borders" picker:
//   row 1: all          inner         outer
//   row 2: horizontal   vertical      none
//   row 3: top          bottom        left/right (paired)
//
// We use a 3×3 of buttons plus a final "side" picker row because
// Word's grid uses iconic glyphs that don't all map cleanly to lucide
// icons. The label under each button keeps it obvious which is which.
const PRESETS: PresetButton[] = [
    { id: 'all', label: 'All', Icon: Grid3x3 },
    { id: 'inner', label: 'Inner', Icon: SquareDot },
    { id: 'outer', label: 'Outer', Icon: Square },
    { id: 'horizontal', label: 'Horizontal', Icon: Minus },
    { id: 'vertical', label: 'Vertical', Icon: Plus },
    { id: 'none', label: 'None', Icon: SquareDashed },
]

const SIDE_PRESETS: PresetButton[] = [
    { id: 'top', label: 'Top', Icon: Minus },
    { id: 'bottom', label: 'Bottom', Icon: Minus },
    { id: 'left', label: 'Left', Icon: Plus },
    { id: 'right', label: 'Right', Icon: Plus },
]

const STYLES: { id: CellBorderStyle; label: string }[] = [
    { id: 'solid', label: 'Solid' },
    { id: 'dashed', label: 'Dashed' },
    { id: 'dotted', label: 'Dotted' },
    { id: 'double', label: 'Double' },
]

// BorderMenu lets the user apply a preset border configuration to the
// currently selected cells. It's a centred Modal — same rationale as
// LinkPopover / TableMenu (no platform-specific popover positioning).
//
// The user picks a preset (top row); the style/width/color fields are
// validated (see border-menu-schema.ts), then the modal closes and the
// setCellBorders command runs against the current selection. An invalid
// width or color keeps the modal open with the error under the field.
// The fields keep their values for the lifetime of the component so a
// user can experiment without re-entering them.
function useBorderMenuForm(commands: EditorCommands, onClose: () => void) {
    const {
        control,
        handleSubmit,
        formState: { errors },
    } = useForm({
        resolver: zodResolver(borderMenuSchema),
        defaultValues: borderMenuDefaults,
    })

    const apply = (preset: CellBorderPreset) =>
        handleSubmit(border => {
            commands.setCellBorders?.(preset, border)
            onClose()
        })()

    return {
        control,
        apply,
        widthError: errors.widthPx?.message,
        colorError: errors.color?.message,
    }
}

export function BorderMenu({ isOpen, onClose, commands }: BorderMenuProps) {
    const { control, apply, widthError, colorError } = useBorderMenuForm(commands, onClose)
    const fg = useThemeColor('foreground')
    const placeholderColor = useThemeColor('field-placeholder')

    if (!isOpen) return null

    return (
        <Modal transparent animationType="fade" visible={isOpen} onRequestClose={onClose}>
            <Pressable className="flex-1 items-center justify-center bg-black/30" onPress={onClose}>
                <Pressable className="w-[340px] gap-3 p-4 rounded-lg bg-background border border-border">
                    <Text className="text-sm font-semibold text-foreground">Cell borders</Text>

                    <View className="flex-row flex-wrap gap-2">
                        {PRESETS.map(p => (
                            <PresetTile key={p.id} preset={p} onPress={() => apply(p.id)} />
                        ))}
                    </View>

                    <Text className="text-xs font-medium text-muted-foreground mt-1">
                        Single edge
                    </Text>
                    <View className="flex-row gap-2">
                        {SIDE_PRESETS.map(p => (
                            <PresetTile key={p.id} preset={p} onPress={() => apply(p.id)} />
                        ))}
                    </View>

                    <View className="h-px bg-border my-1" />

                    <Text className="text-xs font-medium text-muted-foreground">Style</Text>
                    <Controller
                        control={control}
                        name="style"
                        render={({ field }) => (
                            <StyleChips value={field.value} onChange={field.onChange} />
                        )}
                    />

                    <View className="flex-row gap-2">
                        <View className="flex-1">
                            <Text className="text-xs text-muted-foreground mb-1">Width (px)</Text>
                            <Controller
                                control={control}
                                name="widthPx"
                                render={({ field }) => (
                                    <TextInput
                                        value={field.value}
                                        onChangeText={field.onChange}
                                        onBlur={field.onBlur}
                                        placeholder="1"
                                        placeholderTextColor={placeholderColor}
                                        keyboardType="number-pad"
                                        className="px-2 py-1.5 rounded-md border border-border bg-field-background"
                                        style={{ color: fg }}
                                    />
                                )}
                            />
                            <FieldError message={widthError} />
                        </View>
                        <View className="flex-1">
                            <Text className="text-xs text-muted-foreground mb-1">Color (CSS)</Text>
                            <Controller
                                control={control}
                                name="color"
                                render={({ field }) => (
                                    <TextInput
                                        value={field.value}
                                        onChangeText={field.onChange}
                                        onBlur={field.onBlur}
                                        placeholder="#000 or theme"
                                        placeholderTextColor={placeholderColor}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        className="px-2 py-1.5 rounded-md border border-border bg-field-background"
                                        style={{ color: fg }}
                                    />
                                )}
                            />
                            <FieldError message={colorError} />
                        </View>
                    </View>

                    <View className="flex-row justify-end gap-2 mt-1">
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Cancel"
                            onPress={onClose}
                            className="px-3 py-1.5 rounded-md bg-surface-secondary"
                        >
                            <Text className="text-sm text-foreground">Cancel</Text>
                        </Pressable>
                    </View>
                </Pressable>
            </Pressable>
        </Modal>
    )
}

function PresetTile({ preset, onPress }: { preset: PresetButton; onPress: () => void }) {
    const fg = useThemeColor('foreground')
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Apply ${preset.label} borders`}
            onPress={onPress}
            className="w-[88px] gap-1 items-center px-2 py-2 rounded-md border border-border hover:bg-surface-secondary"
            hitSlop={Platform.OS === 'web' ? undefined : { top: 6, bottom: 6, left: 4, right: 4 }}
        >
            <preset.Icon size={20} color={fg} />
            <Text className="text-xs text-foreground">{preset.label}</Text>
        </Pressable>
    )
}

function StyleChips({
    value,
    onChange,
}: {
    value: CellBorderStyle
    onChange: (style: CellBorderStyle) => void
}) {
    return (
        <View className="flex-row flex-wrap gap-1">
            {STYLES.map(s => (
                <StyleChip
                    key={s.id}
                    label={s.label}
                    isActive={value === s.id}
                    onPress={() => onChange(s.id)}
                />
            ))}
        </View>
    )
}

function FieldError({ message }: { message: string | undefined }) {
    if (message == null) return null
    return <Text className="text-xs text-danger mt-1">{message}</Text>
}

function StyleChip({
    label,
    isActive,
    onPress,
}: {
    label: string
    isActive: boolean
    onPress: () => void
}) {
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${label} style`}
            accessibilityState={{ selected: isActive }}
            onPress={onPress}
            className={`px-2.5 py-1 rounded-md border ${
                isActive ? 'border-accent bg-accent/10' : 'border-border'
            }`}
        >
            <Text className={`text-xs ${isActive ? 'text-accent' : 'text-foreground'}`}>
                {label}
            </Text>
        </Pressable>
    )
}
