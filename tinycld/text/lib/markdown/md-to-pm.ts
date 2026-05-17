// Parses a CommonMark + GFM markdown string into a ProseMirror JSON
// tree that matches the editor schema (see types.ts). The walker
// consumes markdown-it's token stream directly rather than going
// through the HTML renderer — this keeps the conversion deterministic
// and lets us drop unsupported constructs (raw HTML, footnotes, etc.)
// to plain paragraphs without ever materializing the intermediate HTML.

import MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'
import {
    MARK_BOLD,
    MARK_CODE,
    MARK_ITALIC,
    MARK_LINK,
    NODE_BLOCKQUOTE,
    NODE_BULLET_LIST,
    NODE_CODE_BLOCK,
    NODE_DOC,
    NODE_HEADING,
    NODE_IMAGE,
    NODE_LIST_ITEM,
    NODE_ORDERED_LIST,
    NODE_PAGE_BREAK,
    NODE_PARAGRAPH,
    NODE_TABLE,
    NODE_TABLE_CELL,
    NODE_TABLE_ROW,
    NODE_TEXT,
    type PMMark,
    type PMNode,
} from './types'

// One-shot parser instance — markdown-it is stateless across parse()
// calls so we don't need to re-build it per invocation.
const md = new MarkdownIt({ html: false, linkify: true, typographer: false })

// Open-tag tokens map to a PM node type with no special handling
// beyond pushing a new container onto the walker's stack. The matching
// `_close` token pops the container.
const OPEN_TO_NODE: Record<string, string> = {
    paragraph_open: NODE_PARAGRAPH,
    bullet_list_open: NODE_BULLET_LIST,
    ordered_list_open: NODE_ORDERED_LIST,
    list_item_open: NODE_LIST_ITEM,
    blockquote_open: NODE_BLOCKQUOTE,
    table_open: NODE_TABLE,
    tr_open: NODE_TABLE_ROW,
    th_open: NODE_TABLE_CELL,
    td_open: NODE_TABLE_CELL,
}

// Pass-through containers — we walk through their children but emit no
// node of our own (thead/tbody are GFM structural wrappers the schema
// doesn't model).
const PASSTHROUGH_OPEN = new Set(['thead_open', 'thead_close', 'tbody_open', 'tbody_close'])

function cloneMarks(marks: PMMark[]): PMMark[] {
    return marks.map(m => ({ type: m.type, ...(m.attrs ? { attrs: { ...m.attrs } } : {}) }))
}

function textNode(text: string, marks: PMMark[]): PMNode {
    const node: PMNode = { type: NODE_TEXT, text }
    if (marks.length > 0) node.marks = cloneMarks(marks)
    return node
}

// Convert an `inline` token's `.children` stream into a flat array of
// PMNodes (text + image). Marks are tracked on a stack so nested
// strong/em/code/link compose correctly.
function walkInline(children: Token[]): PMNode[] {
    const out: PMNode[] = []
    const markStack: PMMark[] = []

    for (const token of children) {
        switch (token.type) {
            case 'text':
                if (token.content.length > 0) out.push(textNode(token.content, markStack))
                break
            case 'softbreak':
                out.push(textNode(' ', markStack))
                break
            case 'hardbreak':
                out.push(textNode('\n', markStack))
                break
            case 'strong_open':
                markStack.push({ type: MARK_BOLD })
                break
            case 'strong_close':
                popMark(markStack, MARK_BOLD)
                break
            case 'em_open':
                markStack.push({ type: MARK_ITALIC })
                break
            case 'em_close':
                popMark(markStack, MARK_ITALIC)
                break
            case 'code_inline':
                // The PM `code` mark is exclusive — StarterKit declares it
                // with `excludes: '_'`, which forbids any other mark on the
                // same text node. Markdown does allow `[a `b` c](url)` etc.,
                // so we silently drop competing marks from the stack here
                // rather than emit a (link, code) tuple that makes
                // ProseMirror reject the whole insertContent with
                // "Invalid collection of marks for node text: link,code".
                out.push(textNode(token.content, [{ type: MARK_CODE }]))
                break
            case 'link_open': {
                const href = token.attrGet('href') ?? ''
                markStack.push({ type: MARK_LINK, attrs: { href } })
                break
            }
            case 'link_close':
                popMark(markStack, MARK_LINK)
                break
            case 'image': {
                const src = token.attrGet('src') ?? ''
                if (src.length === 0) break
                const alt = token.content || token.attrGet('alt') || null
                out.push({ type: NODE_IMAGE, attrs: { src, alt } })
                break
            }
            default:
                // Unknown inline token — surface its literal content as
                // text so users at least see something readable.
                if (token.content) out.push(textNode(token.content, markStack))
                break
        }
    }

    return out
}

function popMark(stack: PMMark[], type: string): void {
    for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].type === type) {
            stack.splice(i, 1)
            return
        }
    }
}

export function markdownToPM(markdown: string): PMNode {
    if (markdown.length === 0) return { type: NODE_DOC, content: [] }

    const tokens = md.parse(markdown, {})
    const root: PMNode = { type: NODE_DOC, content: [] }
    // Container stack: the current open node is always stack[stack.length-1].
    const stack: PMNode[] = [root]

    const push = (node: PMNode): void => {
        const parent = stack[stack.length - 1]
        if (!parent.content) parent.content = []
        parent.content.push(node)
    }

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]
        const type = token.type

        if (PASSTHROUGH_OPEN.has(type)) continue

        // Heading is special because it carries a level attr.
        if (type === 'heading_open') {
            const level = parseInt(token.tag.slice(1), 10) || 1
            const node: PMNode = { type: NODE_HEADING, attrs: { level }, content: [] }
            push(node)
            stack.push(node)
            continue
        }
        if (type === 'heading_close') {
            stack.pop()
            continue
        }

        // Generic open/close handling for paragraph/list/table-row/etc.
        const mapped = OPEN_TO_NODE[type]
        if (mapped !== undefined) {
            const node: PMNode = { type: mapped, content: [] }
            push(node)
            stack.push(node)
            continue
        }
        if (type.endsWith('_close') && OPEN_TO_NODE[`${type.slice(0, -6)}_open`] !== undefined) {
            stack.pop()
            continue
        }

        if (type === 'inline') {
            const children = token.children ?? []
            for (const child of walkInline(children)) push(child)
            continue
        }

        if (type === 'fence' || type === 'code_block') {
            // markdown-it includes a trailing newline on fence content; strip one.
            const raw = token.content.endsWith('\n') ? token.content.slice(0, -1) : token.content
            const code: PMNode = {
                type: NODE_CODE_BLOCK,
                content: raw.length > 0 ? [{ type: NODE_TEXT, text: raw }] : [],
            }
            push(code)
            continue
        }

        if (type === 'hr') {
            push({ type: NODE_PAGE_BREAK })
            continue
        }

        // Unknown block — emit a paragraph carrying the raw content so
        // the user sees their input rather than silent loss.
        if (token.nesting === 0 && token.content) {
            push({
                type: NODE_PARAGRAPH,
                content: [{ type: NODE_TEXT, text: token.content }],
            })
        }
    }

    return root
}
