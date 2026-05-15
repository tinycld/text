// Package translate converts between ProseMirror JSON (the editor's
// native format) and OOXML (.docx) bytes. The package is the heart of
// @tinycld/text: every save sends Y.Doc -> ProseMirror JSON -> OOXML
// -> Drive, and every bootstrap sends OOXML -> ProseMirror JSON -> Y.Doc.
//
// Round-trip fidelity is load-bearing: text uses the .docx file as
// canonical source of truth, so any property dropped in PM->OOXML or
// OOXML->PM compounds with every save. The supported node and mark
// sets below are the load-bearing contract; round-trip tests live in
// roundtrip_test.go.
package translate

// PMNode is a ProseMirror tree node, mirroring the JSON shape Tiptap
// emits/consumes. The Type field is restricted to a fixed enum (see
// SupportedNodeTypes); marks to SupportedMarks. Translator code must
// not produce or accept node/mark types outside this set without
// extending all four of: editor schema, translator, WordZero coverage,
// and round-trip golden tests.
type PMNode struct {
	Type    string         `json:"type"`
	Attrs   map[string]any `json:"attrs,omitempty"`
	Content []PMNode       `json:"content,omitempty"`
	Text    string         `json:"text,omitempty"`
	Marks   []PMMark       `json:"marks,omitempty"`
}

// PMMark is a ProseMirror inline mark applied to a text node — bold,
// italic, underline, or link. Attrs holds mark-specific properties
// (e.g. link href). Type is restricted to SupportedMarks.
type PMMark struct {
	Type  string         `json:"type"`
	Attrs map[string]any `json:"attrs,omitempty"`
}

// Node type constants. Keep this list in sync with the editor schema
// in @tinycld/core/lib/editor/use-document-editor.web.tsx.
const (
	NodeTypeDoc         = "doc"
	NodeTypeParagraph   = "paragraph"
	NodeTypeHeading     = "heading"
	NodeTypeBulletList  = "bulletList"
	NodeTypeOrderedList = "orderedList"
	NodeTypeListItem    = "listItem"
	NodeTypeBlockquote  = "blockquote"
	NodeTypeTable       = "table"
	NodeTypeTableRow    = "tableRow"
	NodeTypeTableCell   = "tableCell"
	NodeTypeImage       = "image"
	NodeTypeText        = "text"
)

// SupportedNodeTypes is the load-bearing contract: any node type
// outside this set is unrepresentable end-to-end. The OOXML parser
// degrades unknown elements (with WarningUnsupportedNode); the
// emitter rejects them as a programmer error.
var SupportedNodeTypes = map[string]bool{
	NodeTypeDoc: true, NodeTypeParagraph: true, NodeTypeHeading: true,
	NodeTypeBulletList: true, NodeTypeOrderedList: true, NodeTypeListItem: true,
	NodeTypeBlockquote: true, NodeTypeTable: true, NodeTypeTableRow: true,
	NodeTypeTableCell: true, NodeTypeImage: true, NodeTypeText: true,
}

// Mark type constants.
const (
	MarkTypeBold      = "bold"
	MarkTypeItalic    = "italic"
	MarkTypeUnderline = "underline"
	MarkTypeLink      = "link"
	// MarkTypeTextStyle carries the @tiptap/extension-text-style mark,
	// which currently exposes a single attribute: `color`. Word's
	// <w:color w:val="RRGGBB"> on a run flows into this mark on import,
	// and back out to <w:color> on export. Schema: requires the
	// TextStyle + Color extensions in both editor configs.
	MarkTypeTextStyle = "textStyle"
)

// SupportedMarks is the analog of SupportedNodeTypes for inline marks.
var SupportedMarks = map[string]bool{
	MarkTypeBold:      true,
	MarkTypeItalic:    true,
	MarkTypeUnderline: true,
	MarkTypeLink:      true,
	MarkTypeTextStyle: true,
}

// Warning is a typed signal that an OOXML import succeeded but
// dropped or simplified some content. Surfaced to the client via
// MsgServerHello on bootstrap; rendered as a dismissable banner.
type Warning struct {
	Code    WarningCode    `json:"code"`
	Detail  string         `json:"detail,omitempty"`
	Context map[string]any `json:"context,omitempty"`
}

// WarningCode is the string-typed enum for Warning.Code. See the
// constants below for the supported set.
type WarningCode string

const (
	WarningTrackedChanges   WarningCode = "trackedChanges"
	WarningComments         WarningCode = "comments"
	WarningContentControls  WarningCode = "contentControls"
	WarningUnsupportedStyle WarningCode = "unsupportedStyle"
	WarningUnsupportedNode  WarningCode = "unsupportedNode"
)
