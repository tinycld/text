import { describe, expect, it } from 'vitest'
import { renderPrintHtml } from '../tinycld/text/lib/print/render-print-html'

describe('renderPrintHtml', () => {
    it('produces a full HTML document with doctype', () => {
        const html = renderPrintHtml('<p>hello</p>')
        expect(html.startsWith('<!doctype html>')).toBe(true)
        expect(html).toContain('<html')
        expect(html).toContain('<head>')
        expect(html).toContain('<body>')
        expect(html).toContain('</html>')
    })

    it('includes the print CSS inside a <style> block in <head>', () => {
        const html = renderPrintHtml('<p>hello</p>')
        expect(html).toMatch(/<head>[\s\S]*<style>[\s\S]*@page[\s\S]*<\/style>[\s\S]*<\/head>/)
    })

    it('wraps the body content in <article class="print-document">', () => {
        const html = renderPrintHtml('<p>hello</p>')
        expect(html).toContain('<article class="print-document">')
        expect(html).toContain('<p>hello</p>')
        expect(html).toContain('</article>')
    })

    it('forwards heading + paragraph content verbatim (already-clean ProseMirror HTML)', () => {
        const body = '<h1>Title</h1><h2>Sub</h2><p>Body text.</p>'
        const html = renderPrintHtml(body)
        expect(html).toContain('<h1>Title</h1>')
        expect(html).toContain('<h2>Sub</h2>')
        expect(html).toContain('<p>Body text.</p>')
    })

    it('forwards lists', () => {
        const body = '<ul><li>one</li><li>two</li></ul><ol><li>a</li></ol>'
        const html = renderPrintHtml(body)
        expect(html).toContain('<ul><li>one</li><li>two</li></ul>')
        expect(html).toContain('<ol><li>a</li></ol>')
    })

    it('forwards tables with bordered-cell inline styles', () => {
        const body =
            '<table><tbody><tr>' +
            '<td data-borders=\'{"top":{"style":"solid","widthPx":1}}\' style="border-top: 1px solid;">cell</td>' +
            '</tr></tbody></table>'
        const html = renderPrintHtml(body)
        expect(html).toContain('border-top: 1px solid;')
        expect(html).toContain('cell')
    })

    it('forwards images (data: src survives intact)', () => {
        const body = '<p><img src="data:image/png;base64,iVBORw0KGgo=" alt="pic"></p>'
        const html = renderPrintHtml(body)
        expect(html).toContain('data:image/png;base64,iVBORw0KGgo=')
        expect(html).toContain('alt="pic"')
    })

    it('forwards inline marks (bold, italic, underline, link, strike, color)', () => {
        const body =
            '<p><strong>b</strong><em>i</em><u>u</u><s>s</s>' +
            '<span style="color: #ff0000">red</span>' +
            '<a href="https://example.com">link</a></p>'
        const html = renderPrintHtml(body)
        expect(html).toContain('<strong>b</strong>')
        expect(html).toContain('<em>i</em>')
        expect(html).toContain('<u>u</u>')
        expect(html).toContain('<s>s</s>')
        expect(html).toContain('color: #ff0000')
        expect(html).toContain('href="https://example.com"')
    })

    it('forwards blockquotes', () => {
        const html = renderPrintHtml('<blockquote><p>quoted</p></blockquote>')
        expect(html).toContain('<blockquote><p>quoted</p></blockquote>')
    })

    it('handles empty body', () => {
        const html = renderPrintHtml('')
        expect(html).toContain('<article class="print-document">')
        expect(html).toContain('</article>')
    })

    it('emits CSS rules that target body-level elements (no .ProseMirror prefix)', () => {
        const html = renderPrintHtml('<p>x</p>')
        // The editor.getHTML() output does NOT include a .ProseMirror
        // wrapper, so print CSS must target the elements directly via
        // .print-document descendant selectors.
        expect(html).toContain('.print-document p')
        expect(html).toContain('.print-document h1')
        expect(html).not.toMatch(/\.ProseMirror\b/)
    })

    it('does not reference external assets that expo-print cannot bundle', () => {
        const html = renderPrintHtml('<p>x</p>')
        expect(html).not.toMatch(/<link\b/i)
        expect(html).not.toMatch(/@import\b/i)
        expect(html).not.toMatch(/@font-face\b/i)
    })

    it('sets portrait orientation and a sensible margin', () => {
        const html = renderPrintHtml('<p>x</p>')
        expect(html).toMatch(/@page\s*\{[^}]*size:\s*portrait/)
        expect(html).toMatch(/margin:\s*0\.75in/)
    })
})
