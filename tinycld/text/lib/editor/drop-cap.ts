import { Extension } from '@tiptap/core'

// DropCap adds a boolean `dropCap` attribute to paragraphs. When set,
// the paragraph's first letter is enlarged and floated so the body text
// wraps around it (the classic magazine / illuminated-manuscript drop
// cap). The visual is owned entirely by CSS — editor-content-styles.ts
// matches `p[data-drop-cap='true']::first-letter` for the live editor,
// and the print / server-render path tags the paragraph with the
// `tinycld-text-p-drop-cap` class (see pm_to_html.go + print-css-web.ts).
//
// We keep it a boolean (always ~3 lines tall) rather than carrying
// Word's `w:lines` count: the CSS render fakes the height with a font
// scale, and a single fixed scale covers the common case. The OOXML
// round-trip (server/translate) reads/writes <w:framePr w:dropCap="drop"
// w:lines="3"/> — Word's native drop cap is a two-paragraph construct
// (a frame paragraph holding the cap, then the body paragraph), so the
// 1:1 PM-paragraph ⇄ 2 OOXML-paragraph translation lives there, not here.
//
// Only paragraphs carry the attr — a drop-cap heading is not a thing
// Word produces, and excluding headings keeps the global-attribute set
// minimal (matches BlockIndent excluding list items).

interface DropCapOptions {
    // Node names the dropCap attribute is added to. Defaults to
    // paragraph only; headings are deliberately excluded.
    types: string[]
}

// Module augmentation so editor.chain().setDropCap() / unsetDropCap() /
// toggleDropCap() resolve on the ChainedCommands surface. Mirrors the
// pattern BlockIndent uses for indentBlock / outdentBlock.
declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        dropCap: {
            setDropCap: () => ReturnType
            unsetDropCap: () => ReturnType
            toggleDropCap: () => ReturnType
        }
    }
}

export const DropCap = Extension.create<DropCapOptions>({
    name: 'dropCap',

    addOptions() {
        return {
            types: ['paragraph'],
        }
    },

    addGlobalAttributes() {
        return [
            {
                types: this.options.types,
                attributes: {
                    dropCap: {
                        default: false,
                        // data-drop-cap="true" is the only serialized
                        // form we read back; any other / absent value is
                        // false. Keeping the parse strict means a copy
                        // of a non-drop-cap paragraph never accidentally
                        // gains the attr.
                        parseHTML: el => el.getAttribute('data-drop-cap') === 'true',
                        renderHTML: attrs => {
                            if (!attrs.dropCap) return {}
                            return { 'data-drop-cap': 'true' }
                        },
                    },
                },
            },
        ]
    },

    addCommands() {
        return {
            setDropCap:
                () =>
                ({ commands }) =>
                    setDropCapOnTypes(commands, this.options.types, true),
            unsetDropCap:
                () =>
                ({ commands }) =>
                    setDropCapOnTypes(commands, this.options.types, false),
            toggleDropCap:
                () =>
                ({ editor, commands }) => {
                    // Toggle off when any configured type at the caret
                    // already carries dropCap; otherwise toggle on. We
                    // check each type so the command works regardless of
                    // which node the caret sits in.
                    const active = this.options.types.some(type =>
                        editor.isActive(type, { dropCap: true })
                    )
                    return setDropCapOnTypes(commands, this.options.types, !active)
                },
        }
    },
})

// setDropCapOnTypes writes the dropCap attr onto whichever configured
// node type is active at the caret. updateAttributes is a no-op (returns
// false) for a type that isn't the active node, so we OR the results and
// report success if any type accepted the change.
function setDropCapOnTypes(
    commands: { updateAttributes: (typeOrName: string, attrs: Record<string, unknown>) => boolean },
    types: string[],
    value: boolean
): boolean {
    let touched = false
    for (const type of types) {
        if (commands.updateAttributes(type, { dropCap: value })) {
            touched = true
        }
    }
    return touched
}
