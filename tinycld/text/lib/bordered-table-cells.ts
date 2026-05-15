import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import {
    bordersAreEmpty,
    bordersToInlineStyleString,
    type CellBorders,
    parseBordersAttr,
} from './cell-borders'

// extendCellWithBorders adds a `borders` attribute to TableCell /
// TableHeader. The attribute is the structured CellBorders shape; we
// serialize it to:
//   - a `data-borders` JSON attribute (so HTML serialization is
//     lossless — copy/paste, save-as-HTML, etc.)
//   - an inline `style` fragment with border-top/right/bottom/left
//     declarations (so the cell renders the chosen borders without
//     needing matching CSS rules per cell).
//
// The standard CSS in editor-content-styles.ts still applies a
// default 1px solid border to every cell; per-cell inline styles
// override it (CSS specificity: inline style wins). To clear a side,
// set its CellBorder to {style:'none'} — that emits `border-top: none`
// which beats the default rule.
//
// Used both in the web editor (use-document-editor.web.tsx) and the
// native WebView editor (Editor.tsx). One implementation keeps the
// schema identical on both sides, which matters: a doc seeded by one
// must be readable by the other, and Y.Doc collab requires identical
// schemas at every peer.
function extendWithBorders<T extends typeof TableCell | typeof TableHeader>(
    extension: T
): T {
    return extension.extend({
        addAttributes() {
            return {
                ...this.parent?.(),
                borders: {
                    default: null,
                    parseHTML: (el: HTMLElement) => parseBordersAttr(el.getAttribute('data-borders')),
                    renderHTML: (attrs: { borders?: CellBorders | null }) => {
                        if (bordersAreEmpty(attrs.borders)) return {}
                        const inline = bordersToInlineStyleString(attrs.borders)
                        return {
                            'data-borders': JSON.stringify(attrs.borders),
                            style: inline,
                        }
                    },
                },
            }
        },
    }) as T
}

export const BorderedTableCell = extendWithBorders(TableCell)
export const BorderedTableHeader = extendWithBorders(TableHeader)
