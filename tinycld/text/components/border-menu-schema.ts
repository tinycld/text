import { z } from '@tinycld/core/ui/form'

// .docx stores a border width in eighths of a point with a maximum of 96
// (12pt). The exporter writes px * 6, so 16px is the widest border that
// survives a save to .docx.
export const MAX_BORDER_WIDTH_PX = 16

export const BORDER_WIDTH_ERROR = `Enter a whole number from 1 to ${MAX_BORDER_WIDTH_PX}`
export const BORDER_COLOR_ERROR = 'Enter a hex color, like #000 or #1a2b3c'

// An empty width keeps the default 1px the placeholder shows.
const widthPx = z
    .string()
    .trim()
    .regex(/^\d*$/, BORDER_WIDTH_ERROR)
    .transform(value => (value === '' ? 1 : Number(value)))
    .pipe(z.number().int().min(1, BORDER_WIDTH_ERROR).max(MAX_BORDER_WIDTH_PX, BORDER_WIDTH_ERROR))

// Only hex colors survive the .docx export, so named colors are not
// accepted. #rgb is expanded to #rrggbb for the same reason. An empty
// color (null) follows the editor theme.
const color = z
    .string()
    .trim()
    .regex(/^(?:#[0-9a-f]{3}|#[0-9a-f]{6})?$/i, BORDER_COLOR_ERROR)
    .transform(value => (value === '' ? null : expandHexColor(value)))

function expandHexColor(hex: string) {
    if (hex.length !== 4) return hex
    const [, r, g, b] = hex
    return `#${r}${r}${g}${g}${b}${b}`
}

export const borderMenuSchema = z.object({
    style: z.enum(['solid', 'dashed', 'dotted', 'double']),
    widthPx,
    color,
})

export const borderMenuDefaults: z.input<typeof borderMenuSchema> = {
    style: 'solid',
    widthPx: '1',
    color: '',
}
