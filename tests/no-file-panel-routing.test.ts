import { describe, expect, it } from 'vitest'
import { mimeForFile } from '../tinycld/text/screens/index'

function fakeFile(name: string, type = ''): File {
    return new File([''], name, { type })
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

describe('text mimeForFile', () => {
    it('prefers the explicit File.type when set', () => {
        expect(mimeForFile(fakeFile('Notes.docx', DOCX))).toBe(DOCX)
        expect(mimeForFile(fakeFile('Page.md', 'text/markdown'))).toBe('text/markdown')
    })

    it('infers docx from .docx extension when type is empty', () => {
        expect(mimeForFile(fakeFile('Untitled.docx'))).toBe(DOCX)
    })

    it('infers text/markdown from .md / .markdown extensions', () => {
        expect(mimeForFile(fakeFile('README.md'))).toBe('text/markdown')
        expect(mimeForFile(fakeFile('article.markdown'))).toBe('text/markdown')
    })

    it('infers text/plain from .txt extension', () => {
        expect(mimeForFile(fakeFile('notes.txt'))).toBe('text/plain')
    })

    it('falls back to application/octet-stream when nothing matches', () => {
        expect(mimeForFile(fakeFile('mystery.bin'))).toBe('application/octet-stream')
    })

    it('is case-insensitive on extensions', () => {
        expect(mimeForFile(fakeFile('NOTES.TXT'))).toBe('text/plain')
        expect(mimeForFile(fakeFile('NOTES.DOCX'))).toBe(DOCX)
    })
})
