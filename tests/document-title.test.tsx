// The inline title editor validates its draft with documentNameSchema
// and treats an unchanged name as a cancel. Both rules live in
// document-title-edit.ts, so they are tested here without mounting the
// component (it needs the rename mutation's pbtsdb store).

import { describe, expect, it } from 'vitest'
import {
    DOCUMENT_NAME_MAX_LENGTH,
    documentNameSchema,
    EMPTY_NAME_ERROR,
    isUnchangedName,
    RENAME_FAILED_ERROR,
} from '../tinycld/text/components/document-title-edit'

function firstError(name: string) {
    const result = documentNameSchema.safeParse({ name })
    return result.success ? undefined : result.error.issues[0]?.message
}

describe('documentNameSchema', () => {
    it('accepts a new name and trims it', () => {
        expect(documentNameSchema.parse({ name: '  My new doc  ' })).toEqual({
            name: 'My new doc',
        })
    })

    it('rejects an empty name with the empty-name copy', () => {
        expect(firstError('')).toBe(EMPTY_NAME_ERROR)
    })

    it('rejects a whitespace-only name the same as an empty one', () => {
        expect(firstError('   \t  ')).toBe(EMPTY_NAME_ERROR)
    })

    it('accepts a name at the server limit', () => {
        expect(firstError('a'.repeat(DOCUMENT_NAME_MAX_LENGTH))).toBeUndefined()
    })

    it('rejects a name over the server limit', () => {
        expect(firstError('a'.repeat(DOCUMENT_NAME_MAX_LENGTH + 1))).toBeDefined()
    })
})

describe('isUnchangedName', () => {
    it('is true when the validated name equals the current name', () => {
        expect(isUnchangedName('Untitled.docx', 'Untitled.docx')).toBe(true)
    })

    it('ignores whitespace padding on the current name', () => {
        expect(isUnchangedName('Untitled.docx', ' Untitled.docx ')).toBe(true)
    })

    it('treats whitespace-padded input as unchanged once the schema trims it', () => {
        const { name } = documentNameSchema.parse({ name: '   Untitled.docx   ' })
        expect(isUnchangedName(name, 'Untitled.docx')).toBe(true)
    })

    it('is false for a different name', () => {
        expect(isUnchangedName('Renamed', 'Untitled.docx')).toBe(false)
    })
})

describe('error copy', () => {
    it('exposes stable copy for the empty-input case', () => {
        expect(EMPTY_NAME_ERROR).toMatch(/empty/i)
    })

    it('exposes stable copy for mutation failure', () => {
        expect(RENAME_FAILED_ERROR).toMatch(/rename/i)
    })
})
