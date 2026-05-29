// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { Table } from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { buildSuggestionEditorExtensions } from '~/tinycld/text/lib/suggestions/build-extensions'
import { bulkAccept, bulkReject } from '~/tinycld/text/lib/suggestions/bulk-resolve'
import { SuggestionsMap } from '~/tinycld/text/lib/suggestions/suggestions-map'
import {
    createEditorModeStore,
    EDITOR_MODE_EDITING,
    EDITOR_MODE_SUGGESTING,
} from '~/tinycld/text/stores/editor-mode-store'
import {
    SUGGESTION_STATUS_ACCEPTED,
    SUGGESTION_STATUS_REJECTED,
} from '~/tinycld/text/webview-editor/source/suggestions/suggestion-types'

// Phase 5 Task 17 — bulk accept/reject across every suggestion kind.
//
// The per-id resolvers (acceptSuggestion/rejectSuggestion in
// resolve.ts) already handle insert, delete, format-change,
// block-change, and cell-change individually. bulkAccept and
// bulkReject just iterate suggestionIds, so the cross-kind
// behaviour falls out of the existing per-id paths — but the
// integration is worth pinning so a future change that breaks
// ordering (e.g. cell-delete first vs. block-delete first) is
// caught.

interface BlockChangePayload {
    suggestionId: string
    authorId: string
    ts: number
    before: { type: string; attrs: Record<string, unknown>; added?: boolean }
    after: { type: string; attrs: Record<string, unknown>; deleted?: boolean }
}

// setupMixedEditor mounts a TipTap editor in suggesting mode and
// drives it through five commands — one per kind — so the doc ends
// up with one suggestedInsert, one suggestedDelete, one
// suggestedFormatChange, one suggestedBlockChange on a paragraph,
// and one suggestedBlockChange on a tableCell. Returns the editor,
// the yDoc, and the five suggestionIds the command layer minted.
//
// Each command runs in its own session-idle window (advancing time
// between them) so the command layer mints a fresh suggestionId per
// operation rather than grouping them under one session id.
function setupMixedEditor() {
    const modeStore = createEditorModeStore()
    modeStore.getState().setIdentity({ userOrgId: 'uo_alice' })
    modeStore.getState().setMode(EDITOR_MODE_SUGGESTING)
    const yDoc = new Y.Doc()
    const editor = new Editor({
        extensions: [
            StarterKit,
            Table.configure({ resizable: false }),
            TableRow,
            TableCell,
            TableHeader,
            ...buildSuggestionEditorExtensions({ modeStore, yDoc }),
        ],
        content: {
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Hello' }],
                },
                {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'kept around' }],
                },
                {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'styled' }],
                },
                {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'will become heading' }],
                },
                {
                    type: 'table',
                    content: [
                        {
                            type: 'tableRow',
                            content: [
                                {
                                    type: 'tableCell',
                                    attrs: { colspan: 1, rowspan: 1, colwidth: null },
                                    content: [
                                        {
                                            type: 'paragraph',
                                            content: [{ type: 'text', text: 'a1' }],
                                        },
                                    ],
                                },
                                {
                                    type: 'tableCell',
                                    attrs: { colspan: 1, rowspan: 1, colwidth: null },
                                    content: [
                                        {
                                            type: 'paragraph',
                                            content: [{ type: 'text', text: 'a2' }],
                                        },
                                    ],
                                },
                            ],
                        },
                        {
                            type: 'tableRow',
                            content: [
                                {
                                    type: 'tableCell',
                                    attrs: { colspan: 1, rowspan: 1, colwidth: null },
                                    content: [
                                        {
                                            type: 'paragraph',
                                            content: [{ type: 'text', text: 'b1' }],
                                        },
                                    ],
                                },
                                {
                                    type: 'tableCell',
                                    attrs: { colspan: 1, rowspan: 1, colwidth: null },
                                    content: [
                                        {
                                            type: 'paragraph',
                                            content: [{ type: 'text', text: 'b2' }],
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ],
        },
    })

    // 1. INSERT: type some text at the end of the first paragraph
    //    "Hello" → "Helloworld" with " world" carrying a
    //    suggestedInsert mark. We use commands.insertContentAt so
    //    the position is deterministic.
    editor.commands.insertContentAt(6, ' world')
    vi.advanceTimersByTime(60_000)

    // 2. DELETE: select the second paragraph's "kept around" and
    //    delete it — the command layer stamps suggestedDelete on
    //    the deleted range.
    //    Position math: first paragraph is now "Hello world" (11
    //    chars + 2 openClose tokens = 13). Second paragraph starts
    //    at 13, opening token, then text. Use a regex find on text.
    const p2Start = findParagraphPos(editor, 'kept around')
    editor.commands.setTextSelection({
        from: p2Start + 1,
        to: p2Start + 1 + 'kept around'.length,
    })
    editor.commands.deleteSelection()
    vi.advanceTimersByTime(60_000)

    // 3. FORMAT-CHANGE: select "styled" and toggleBold — the command
    //    layer stamps a suggestedFormatChange mark.
    const p3Start = findParagraphPos(editor, 'styled')
    editor.commands.setTextSelection({
        from: p3Start + 1,
        to: p3Start + 1 + 'styled'.length,
    })
    editor.commands.toggleBold()
    vi.advanceTimersByTime(60_000)

    // 4. BLOCK-CHANGE on a paragraph: turn "will become heading"
    //    into a heading 2.
    const p4Start = findParagraphPos(editor, 'will become heading')
    editor.commands.setTextSelection(p4Start + 1)
    editor.commands.toggleHeading({ level: 2 })
    vi.advanceTimersByTime(60_000)

    // 5. CELL-CHANGE: select cell a2 and run setCellAttribute to
    //    propose a colspan change — produces a single cell-scoped
    //    suggestedBlockChange (vs an add-row which makes multiple).
    const cellA2Pos = findCellPos(editor, 'a2')
    editor.commands.setTextSelection(cellA2Pos + 2)
    editor.commands.setCellAttribute('colspan', 2)
    vi.advanceTimersByTime(60_000)

    return { editor, yDoc, modeStore }
}

// findParagraphPos returns the doc position where the paragraph
// containing the given text starts (before the opening token).
// Throws if the text isn't found, so a setup failure surfaces with
// a clear error rather than a generic "out of range" downstream.
function findParagraphPos(editor: Editor, text: string): number {
    let pos = -1
    editor.state.doc.descendants((node, p) => {
        if (pos >= 0) return false
        if (node.type.name === 'paragraph' && node.textContent.includes(text)) {
            pos = p
            return false
        }
        return true
    })
    if (pos < 0) {
        throw new Error(`findParagraphPos: paragraph with text "${text}" not found`)
    }
    return pos
}

// findCellPos returns the doc position of the table cell whose
// textContent matches the given label (e.g. "a2"). Used to drive
// commands at a specific cell.
function findCellPos(editor: Editor, label: string): number {
    let pos = -1
    editor.state.doc.descendants((node, p) => {
        if (pos >= 0) return false
        if (
            (node.type.name === 'tableCell' || node.type.name === 'tableHeader') &&
            node.textContent.includes(label)
        ) {
            pos = p
            return false
        }
        return true
    })
    if (pos < 0) {
        throw new Error(`findCellPos: cell with label "${label}" not found`)
    }
    return pos
}

// collectSuggestionIds walks the doc and returns the set of all
// suggestion ids found in any suggestedInsert/Delete/FormatChange
// mark or suggestedBlockChange attribute.
function collectSuggestionIds(editor: Editor): Set<string> {
    const ids = new Set<string>()
    editor.state.doc.descendants(node => {
        const blockChange = node.attrs.suggestedBlockChange as BlockChangePayload | null
        if (blockChange && typeof blockChange === 'object') {
            ids.add(blockChange.suggestionId)
        }
        if (!node.isText) return true
        for (const m of node.marks) {
            if (
                m.type.name === 'suggestedInsert' ||
                m.type.name === 'suggestedDelete' ||
                m.type.name === 'suggestedFormatChange'
            ) {
                ids.add(m.attrs.suggestionId as string)
            }
        }
        return true
    })
    return ids
}

// hasAnyRemainingSuggestionMarks returns true iff any suggestion
// mark or suggestedBlockChange attribute is still on the doc. The
// bulk pass should leave a clean doc — no wrapper marks, no
// suggestedBlockChange attributes.
function hasAnyRemainingSuggestionMarks(editor: Editor): boolean {
    let found = false
    editor.state.doc.descendants(node => {
        if (node.attrs.suggestedBlockChange) {
            found = true
            return false
        }
        if (!node.isText) return true
        if (
            node.marks.some(
                m =>
                    m.type.name === 'suggestedInsert' ||
                    m.type.name === 'suggestedDelete' ||
                    m.type.name === 'suggestedFormatChange'
            )
        ) {
            found = true
            return false
        }
        return true
    })
    return found
}

describe('bulkAccept / bulkReject across all Phase 5 suggestion kinds', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0))
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('bulkAccept resolves every kind (insert/delete/format/block/cell) in one pass', () => {
        const { editor, yDoc, modeStore } = setupMixedEditor()

        // Sanity: five distinct suggestion ids minted from the five
        // commands above.
        const ids = Array.from(collectSuggestionIds(editor))
        expect(ids.length).toBeGreaterThanOrEqual(5)

        // Sanity: the format-change reverted the bold, so "styled"
        // is currently NOT bold (the command layer reverts the
        // user's structural/format change and stamps the wrapper).
        let stillBoldBeforeAccept = false
        editor.state.doc.descendants(node => {
            if (!node.isText) return true
            if (node.text === 'styled' && node.marks.some(m => m.type.name === 'bold')) {
                stillBoldBeforeAccept = true
            }
            return true
        })
        expect(stillBoldBeforeAccept).toBe(false)

        // Switch out of suggesting mode so the resolve writes don't
        // get re-intercepted by the command layer.
        modeStore.getState().setMode(EDITOR_MODE_EDITING)

        bulkAccept(editor, ids, { resolverUserOrgId: 'uo_carol', yDoc })

        // Every id is now ACCEPTED in the Y.Map.
        const map = new SuggestionsMap(yDoc)
        for (const id of ids) {
            expect(map.get(id)?.status).toBe(SUGGESTION_STATUS_ACCEPTED)
        }

        // Doc is free of any suggestion wrappers/attributes.
        expect(hasAnyRemainingSuggestionMarks(editor)).toBe(false)

        // Insert landed: " world" is in the doc.
        expect(editor.state.doc.textContent).toContain('Hello world')

        // Delete applied: "kept around" is gone.
        expect(editor.state.doc.textContent).not.toContain('kept around')

        // Format-change accepted: "styled" run now carries bold.
        let boldAppliedAfterAccept = false
        editor.state.doc.descendants(node => {
            if (!node.isText) return true
            if (node.text?.includes('styled')) {
                if (node.marks.some(m => m.type.name === 'bold')) {
                    boldAppliedAfterAccept = true
                }
            }
            return true
        })
        expect(boldAppliedAfterAccept).toBe(true)

        // Block-change accepted: "will become heading" is now a heading.
        let headingApplied = false
        editor.state.doc.descendants(node => {
            if (node.type.name === 'heading' && node.textContent.includes('will become heading')) {
                headingApplied = true
            }
            return true
        })
        expect(headingApplied).toBe(true)

        // Cell-change accepted: cell a2 has colspan=2.
        let cellColspan: number | null = null
        editor.state.doc.descendants(node => {
            if (
                (node.type.name === 'tableCell' || node.type.name === 'tableHeader') &&
                node.textContent.includes('a2')
            ) {
                cellColspan = node.attrs.colspan as number
            }
            return true
        })
        expect(cellColspan).toBe(2)

        editor.destroy()
    })

    it('bulkReject resolves every kind and reverts the doc to its before-state', () => {
        const { editor, yDoc, modeStore } = setupMixedEditor()

        const ids = Array.from(collectSuggestionIds(editor))
        expect(ids.length).toBeGreaterThanOrEqual(5)

        modeStore.getState().setMode(EDITOR_MODE_EDITING)
        bulkReject(editor, ids, { resolverUserOrgId: 'uo_carol', yDoc })

        const map = new SuggestionsMap(yDoc)
        for (const id of ids) {
            expect(map.get(id)?.status).toBe(SUGGESTION_STATUS_REJECTED)
        }

        // Doc is free of any suggestion wrappers/attributes.
        expect(hasAnyRemainingSuggestionMarks(editor)).toBe(false)

        // Insert rejected: " world" is gone, only "Hello" remains.
        expect(editor.state.doc.textContent).toContain('Hello')
        expect(editor.state.doc.textContent).not.toContain('Hello world')

        // Delete rejected: "kept around" stays.
        expect(editor.state.doc.textContent).toContain('kept around')

        // Format-change rejected: "styled" stays NOT bold (wrapper
        // gone, original mark set preserved).
        let boldAfterReject = false
        editor.state.doc.descendants(node => {
            if (!node.isText) return true
            if (node.text?.includes('styled')) {
                if (node.marks.some(m => m.type.name === 'bold')) {
                    boldAfterReject = true
                }
            }
            return true
        })
        expect(boldAfterReject).toBe(false)

        // Block-change rejected: "will become heading" stays a
        // paragraph (not a heading).
        let isHeading = false
        let isParagraph = false
        editor.state.doc.descendants(node => {
            if (node.textContent.includes('will become heading')) {
                if (node.type.name === 'heading') isHeading = true
                if (node.type.name === 'paragraph') isParagraph = true
            }
            return true
        })
        expect(isHeading).toBe(false)
        expect(isParagraph).toBe(true)

        // Cell-change rejected: cell a2 stays at colspan=1.
        let cellColspan: number | null = null
        editor.state.doc.descendants(node => {
            if (
                (node.type.name === 'tableCell' || node.type.name === 'tableHeader') &&
                node.textContent.includes('a2')
            ) {
                cellColspan = node.attrs.colspan as number
            }
            return true
        })
        expect(cellColspan).toBe(1)

        editor.destroy()
    })

    it('bulkAccept then bulkReject on a fresh mixed doc — sequential idempotency check', () => {
        // Independent setup to verify bulk paths don't leak state
        // across runs.
        const { editor: editorA, yDoc: yDocA, modeStore: modeA } = setupMixedEditor()
        const idsA = Array.from(collectSuggestionIds(editorA))
        modeA.getState().setMode(EDITOR_MODE_EDITING)
        bulkAccept(editorA, idsA, { resolverUserOrgId: 'uo_carol', yDoc: yDocA })
        expect(hasAnyRemainingSuggestionMarks(editorA)).toBe(false)
        editorA.destroy()

        const { editor: editorB, yDoc: yDocB, modeStore: modeB } = setupMixedEditor()
        const idsB = Array.from(collectSuggestionIds(editorB))
        modeB.getState().setMode(EDITOR_MODE_EDITING)
        bulkReject(editorB, idsB, { resolverUserOrgId: 'uo_carol', yDoc: yDocB })
        expect(hasAnyRemainingSuggestionMarks(editorB)).toBe(false)
        editorB.destroy()
    })
})
