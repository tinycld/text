import type { EditorCommands } from '@tinycld/core/lib/editor/types'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { Menu } from '@tinycld/core/ui/menu'
import { ChevronDown } from 'lucide-react-native'
import { useState } from 'react'
import { Platform, Pressable, Text } from 'react-native'
import { cssFamily, FONT_FAMILY_OPTIONS, type FontOption } from '../lib/font-options'

export { FONT_FAMILY_OPTIONS, type FontOption } from '../lib/font-options'

// cssFamily is the render-side helper that pairs a stored bare family name
// with its generic fallback. Storage on the textStyle mark is bare ("Georgia")
// so that the DOCX <w:rFonts w:ascii> attr is a single resolvable name —
// fallback chains live only in CSS output.

interface FontFamilyPickerProps {
    currentFamily: string | null
    commands: EditorCommands
    disabled?: boolean
}

const DEFAULT_LABEL = 'Default'

export function FontFamilyPicker({
    currentFamily,
    commands,
    disabled = false,
}: FontFamilyPickerProps) {
    const [open, setOpen] = useState(false)
    const muted = useThemeColor('muted-foreground')

    // Strip a CSS fallback chain ("Georgia, serif") down to just the head
    // name for the trigger label so docs imported with bare names AND docs
    // touched by older versions of this picker both render cleanly.
    const triggerLabel = currentFamily ? stripFallback(currentFamily) : DEFAULT_LABEL
    const triggerOpacity = disabled ? 0.4 : 1

    const webProps =
        Platform.OS === 'web'
            ? { onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault() }
            : {}

    return (
        <Menu
            isOpen={open}
            onOpenChange={setOpen}
            placement="bottom-start"
            width={220}
            title="Font family"
            trigger={
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Font family"
                    accessibilityState={{ expanded: open, disabled }}
                    disabled={disabled}
                    {...webProps}
                    className="flex-row items-center gap-1 px-2 py-1 rounded-md"
                    style={{ opacity: triggerOpacity }}
                >
                    <Text className="text-sm text-foreground min-w-[60px]" numberOfLines={1}>
                        {triggerLabel}
                    </Text>
                    <ChevronDown size={12} color={muted} />
                </Pressable>
            }
        >
            <FontFamilyRows currentFamily={currentFamily} commands={commands} />
        </Menu>
    )
}

/** The family rows alone, for a menu that hosts them itself — the toolbar's More submenu. */
export function FontFamilyRows({
    currentFamily,
    commands,
}: Pick<FontFamilyPickerProps, 'currentFamily' | 'commands'>) {
    const pick = (option: FontOption | null) => {
        if (option == null) {
            commands.unsetFontFamily?.()
            return
        }
        commands.setFontFamily?.(option.name)
    }
    return (
        <>
            <Menu.Item
                label={DEFAULT_LABEL}
                isSelected={currentFamily == null}
                onSelect={() => pick(null)}
            />
            {FONT_FAMILY_OPTIONS.map(option => (
                <Menu.Item
                    key={option.name}
                    label={option.name}
                    leading={<FontSample option={option} />}
                    isSelected={isOptionActive(option, currentFamily)}
                    onSelect={() => pick(option)}
                />
            ))}
        </>
    )
}

// A glyph pair set in the option's own face, so the row previews the
// font the way the old self-styled label did. Hidden from assistive
// tech: the row's accessible name is the family name alone.
function FontSample({ option }: { option: FontOption }) {
    return (
        <Text
            aria-hidden
            className="text-sm text-muted-foreground w-6"
            style={{ fontFamily: cssFamily(option.name, option.fallback) }}
        >
            Aa
        </Text>
    )
}

// Pickers since this PR write bare names ("Georgia"), but documents
// authored by an earlier build of this code, or pasted-in content from
// elsewhere, may carry a CSS fallback chain ("Georgia, serif"). Both
// should highlight the Georgia row.
function isOptionActive(option: FontOption, current: string | null): boolean {
    if (!current) return false
    return stripFallback(current) === option.name
}

// stripFallback peels a CSS font-family chain down to the head name,
// dropping any leading/trailing quotes around it. Returns the input
// unchanged when there's no comma.
function stripFallback(value: string): string {
    const head = value.split(',', 1)[0].trim()
    return head.replace(/^['"]/, '').replace(/['"]$/, '')
}
