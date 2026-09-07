import { Tooltip } from '@tinycld/core/components/Tooltip'
import { ColorPickerGrid } from '@tinycld/core/ui/color-picker'
import { useOpenMenu } from '@tinycld/core/ui/menubar'
import { Popover } from '@tinycld/core/ui/popover'
import type { ComponentType } from 'react'
import { forwardRef, useCallback } from 'react'
import { Platform, Pressable, View } from 'react-native'

interface TextColorButtonProps {
    // Lucide-style icon — `<Baseline>` for text color, `<Highlighter>`
    // for background. The icon gets a horizontal bar underline tinted
    // to the active color, matching the Google Sheets affordance.
    icon: ComponentType<{ size: number; color: string }>
    accessibilityLabel: string
    // Stable string used as the useOpenMenu key. Different keys for
    // text vs background prevent both popovers from sharing state and
    // closing each other.
    menuKey: string
    // Hex string of the currently-applied color. Undefined / empty
    // means "no override; renders with the inherited foreground".
    color: string | undefined
    disabled: boolean
    iconColor: string
    onSelect: (color: string) => void
}

// TextColorButton is the text-editor toolbar's color picker — one
// instance for text color, one for background color. Modeled on
// calc/components/toolbar/ColorPickerMenu.tsx: same shared
// ColorPickerGrid in the popover, same useOpenMenu de-dup keying,
// same accent underline bar under the icon. Differs only in the
// trigger button shape, which mirrors DocumentToolbar's FormatButton
// instead of calc's ToolbarButton.
//
// A Popover rather than a Menu: the grid is a widget, not a list of
// command rows.
export function TextColorButton({
    icon,
    accessibilityLabel,
    menuKey,
    color,
    disabled,
    iconColor,
    onSelect,
}: TextColorButtonProps) {
    const [isOpen, setIsOpen] = useOpenMenu(`text-toolbar:${menuKey}`)

    const handleSelect = useCallback(
        (value: string) => {
            onSelect(value)
            setIsOpen(false)
        },
        [onSelect, setIsOpen]
    )

    return (
        <Popover
            isOpen={isOpen}
            onOpenChange={setIsOpen}
            placement="bottom-start"
            title={accessibilityLabel}
            trigger={
                <ColorTriggerButton
                    icon={icon}
                    accessibilityLabel={accessibilityLabel}
                    color={color}
                    disabled={disabled}
                    iconColor={iconColor}
                    isOpen={isOpen}
                />
            }
        >
            <ColorPickerGrid
                selected={color}
                onSelect={handleSelect}
                showClear
                clearLabel="No color"
            />
        </Popover>
    )
}

interface ColorTriggerButtonProps {
    icon: ComponentType<{ size: number; color: string }>
    accessibilityLabel: string
    color: string | undefined
    disabled: boolean
    iconColor: string
    isOpen: boolean
    /** Injected by the Popover that clones this trigger. */
    onPress?: () => void
}

// forwardRef so the Popover can clone this element with the ref it
// measures and the onPress that toggles it, while the tooltip still
// wraps the Pressable from outside (Tooltip is a Fragment on
// native and must not sit between the surface and its trigger).
const ColorTriggerButton = forwardRef<View, ColorTriggerButtonProps>(function ColorTriggerButton(
    { icon: Icon, accessibilityLabel, color, disabled, iconColor, isOpen, onPress },
    ref
) {
    // Stop the mousedown from moving DOM focus off the ProseMirror
    // editor — same rationale as FormatButton in DocumentToolbar.tsx.
    const webProps =
        Platform.OS === 'web'
            ? { onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault() }
            : {}

    // The underline bar shows the active color; when no color is
    // applied the bar is transparent (no visible underline) so the
    // button reads as "no color set" rather than "neutral-grey
    // color set." Matches Google Docs's affordance: empty underline
    // when no color is chosen, tinted underline after one is picked.
    const underlineColor = color || 'transparent'

    return (
        <Tooltip label={accessibilityLabel}>
            <Pressable
                ref={ref}
                accessibilityRole="button"
                accessibilityLabel={accessibilityLabel}
                accessibilityState={{ disabled, expanded: isOpen }}
                disabled={disabled}
                onPress={onPress}
                {...webProps}
                className="rounded-md p-1.5"
                style={{ opacity: disabled ? 0.4 : 1 }}
                hitSlop={
                    Platform.OS === 'web' ? undefined : { top: 6, bottom: 6, left: 4, right: 4 }
                }
            >
                <View className="items-center justify-center" style={{ gap: 1 }}>
                    <Icon size={16} color={iconColor} />
                    <View
                        style={{
                            height: 3,
                            width: 16,
                            backgroundColor: underlineColor,
                            borderRadius: 1,
                        }}
                    />
                </View>
            </Pressable>
        </Tooltip>
    )
})
