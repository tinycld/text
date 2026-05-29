import type * as Y from 'yjs'

export interface AuthorshipRun {
    // null = unknown / no entry in clientAuthors (anonymous or pre-stamping)
    authorId: string | null
    // 0-based char offset within the current (post-delete) text of the YText
    from: number
    // exclusive
    to: number
}

// walkParagraphAuthors walks the internal item linked-list of a
// Y.XmlText and returns ordered runs attributed to the producing Yjs
// clientID, resolved through the supplied clientAuthors map.
//
// Internal API: this relies on Y.XmlText's `_start` field and each
// Item's `.right` chain, which are internal to yjs. They are not part
// of the published public API but have been stable for years and are
// the only way to surface per-character authorship — the public
// `.toDelta()` / `.toJSON()` outputs strip clientID metadata. Every
// blame-style implementation built on yjs reaches for these fields.
//
// Tombstoned items (`deleted === true`) are skipped: they represent
// characters removed by another op, do not contribute to the current
// text, and the offset counter only advances on surviving items. The
// runs returned therefore describe positions WITHIN the current
// (post-delete) text, not historical positions.
//
// A clientID with no entry in clientAuthors yields `authorId: null`,
// which renders as "anonymous" upstream.
export function walkParagraphAuthors(
    yText: Y.XmlText,
    clientAuthors: Map<number, string>
): AuthorshipRun[] {
    type ItemLike = {
        deleted: boolean
        length: number
        id: { client: number }
        right: ItemLike | null
    }
    const out: AuthorshipRun[] = []
    let offset = 0
    let item = (yText as unknown as { _start: ItemLike | null })._start
    // `undefined` distinguishes "no run started yet" from "current run
    // is authored by null (anonymous)". null is a valid authorId.
    let currentAuthor: string | null | undefined
    let runStart = 0
    while (item !== null) {
        if (!item.deleted) {
            const author = clientAuthors.get(item.id.client) ?? null
            if (currentAuthor === undefined) {
                currentAuthor = author
                runStart = offset
            } else if (author !== currentAuthor) {
                out.push({ authorId: currentAuthor, from: runStart, to: offset })
                currentAuthor = author
                runStart = offset
            }
            offset += item.length
        }
        item = item.right
    }
    if (currentAuthor !== undefined && offset > runStart) {
        out.push({ authorId: currentAuthor, from: runStart, to: offset })
    }
    return out
}
