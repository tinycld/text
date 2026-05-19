package translate

import (
	"strings"
	"testing"
)

// TestPMJSONToHTML_EmptyDoc verifies the renderer handles the empty
// "no content" doc — a fresh document right after creation. Output is
// a bare article wrapper.
func TestPMJSONToHTML_EmptyDoc(t *testing.T) {
	in := `{"type":"doc","content":[]}`
	out, err := PMJSONToHTML([]byte(in), HTMLRenderOpts{})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if out != `<article class="tinycld-doc"></article>` {
		t.Fatalf("unexpected empty-doc output: %q", out)
	}
}

func TestPMJSONToHTML_RejectsNonDocRoot(t *testing.T) {
	_, err := PMJSONToHTML([]byte(`{"type":"paragraph"}`), HTMLRenderOpts{})
	if err == nil {
		t.Fatal("expected error for non-doc root")
	}
	if !strings.Contains(err.Error(), "type=doc") {
		t.Fatalf("expected type=doc error, got: %v", err)
	}
}

func TestPMJSONToHTML_RejectsMalformedJSON(t *testing.T) {
	_, err := PMJSONToHTML([]byte(`{not json`), HTMLRenderOpts{})
	if err == nil {
		t.Fatal("expected error for malformed json")
	}
}

func TestPMJSONToHTML_SimpleParagraph(t *testing.T) {
	in := `{"type":"doc","content":[
        {"type":"paragraph","content":[{"type":"text","text":"Hello world"}]}
    ]}`
	out := mustRender(t, in, HTMLRenderOpts{})
	want := `<article class="tinycld-doc"><p class="tinycld-doc-p">Hello world</p></article>`
	if out != want {
		t.Fatalf("got %q\nwant %q", out, want)
	}
}

func TestPMJSONToHTML_HeadingLevels(t *testing.T) {
	for level := 1; level <= 6; level++ {
		in := `{"type":"doc","content":[{"type":"heading","attrs":{"level":` +
			itoaSimple(level) + `},"content":[{"type":"text","text":"Title"}]}]}`
		out := mustRender(t, in, HTMLRenderOpts{})
		wantTag := "<h" + itoaSimple(level) + ` class="tinycld-doc-h` + itoaSimple(level) + `">Title</h` + itoaSimple(level) + ">"
		if !strings.Contains(out, wantTag) {
			t.Fatalf("level=%d: missing %q in %q", level, wantTag, out)
		}
	}
}

func TestPMJSONToHTML_HeadingClampsLevel(t *testing.T) {
	// Out-of-range levels clamp into 1..6 (level=8 → h6).
	in := `{"type":"doc","content":[{"type":"heading","attrs":{"level":8},"content":[{"type":"text","text":"X"}]}]}`
	out := mustRender(t, in, HTMLRenderOpts{})
	if !strings.Contains(out, `<h6 class="tinycld-doc-h6">X</h6>`) {
		t.Fatalf("expected h6 fallback, got %q", out)
	}
}

func TestPMJSONToHTML_AlignAndIndent(t *testing.T) {
	in := `{"type":"doc","content":[
        {"type":"paragraph","attrs":{"textAlign":"center","indent":2},
         "content":[{"type":"text","text":"X"}]}
    ]}`
	out := mustRender(t, in, HTMLRenderOpts{})
	if !strings.Contains(out, "tinycld-doc-align--center") {
		t.Fatalf("missing center align class: %q", out)
	}
	if !strings.Contains(out, "tinycld-doc-indent--2") {
		t.Fatalf("missing indent-2 class: %q", out)
	}
}

func TestPMJSONToHTML_TextMarks(t *testing.T) {
	tests := []struct {
		name string
		mark string
		want string
	}{
		{"bold", `{"type":"bold"}`, "tinycld-doc-mark--bold"},
		{"italic", `{"type":"italic"}`, "tinycld-doc-mark--italic"},
		{"underline", `{"type":"underline"}`, "tinycld-doc-mark--underline"},
		{"strike", `{"type":"strike"}`, "tinycld-doc-mark--strike"},
		{"code", `{"type":"code"}`, "tinycld-doc-mark--code"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			in := `{"type":"doc","content":[{"type":"paragraph","content":[
                {"type":"text","text":"X","marks":[` + tc.mark + `]}
            ]}]}`
			out := mustRender(t, in, HTMLRenderOpts{})
			if !strings.Contains(out, tc.want) {
				t.Fatalf("missing %s class in %q", tc.want, out)
			}
		})
	}
}

func TestPMJSONToHTML_StrikeWithBold(t *testing.T) {
	// strike combined with bold should produce nested wrappers; bold
	// nests outside strike per markPriority (bold=3, strike=6).
	in := `{"type":"doc","content":[{"type":"paragraph","content":[
        {"type":"text","text":"X","marks":[
            {"type":"strike"},
            {"type":"bold"}
        ]}
    ]}]}`
	out := mustRender(t, in, HTMLRenderOpts{})
	if !strings.Contains(out, "tinycld-doc-mark--strike") {
		t.Fatalf("missing strike class: %q", out)
	}
	if !strings.Contains(out, "tinycld-doc-mark--bold") {
		t.Fatalf("missing bold class: %q", out)
	}
	idxBold := strings.Index(out, "mark--bold")
	idxStrike := strings.Index(out, "mark--strike")
	if !(idxBold < idxStrike) {
		t.Fatalf("expected bold to nest outside strike, got %q", out)
	}
}

func TestPMJSONToHTML_StrikeWithTextStyle(t *testing.T) {
	// strike combined with textStyle (color/font) should both surface;
	// strike (6) nests outside textStyle (8) per markPriority.
	in := `{"type":"doc","content":[{"type":"paragraph","content":[
        {"type":"text","text":"X","marks":[
            {"type":"strike"},
            {"type":"textStyle","attrs":{"color":"#ff0000"}}
        ]}
    ]}]}`
	out := mustRender(t, in, HTMLRenderOpts{})
	if !strings.Contains(out, "tinycld-doc-mark--strike") {
		t.Fatalf("missing strike class: %q", out)
	}
	if !strings.Contains(out, `data-color="#ff0000"`) {
		t.Fatalf("missing textStyle color: %q", out)
	}
	idxStrike := strings.Index(out, "mark--strike")
	idxStyle := strings.Index(out, "mark--text-style")
	if !(idxStrike < idxStyle) {
		t.Fatalf("expected strike to nest outside text-style, got %q", out)
	}
}

func TestPMJSONToHTML_LinkMark_SafeHref(t *testing.T) {
	in := `{"type":"doc","content":[{"type":"paragraph","content":[
        {"type":"text","text":"link","marks":[
            {"type":"link","attrs":{"href":"https://example.com/a"}}
        ]}
    ]}]}`
	out := mustRender(t, in, HTMLRenderOpts{})
	if !strings.Contains(out, `href="https://example.com/a"`) {
		t.Fatalf("missing href: %q", out)
	}
	if !strings.Contains(out, `rel="noopener noreferrer"`) {
		t.Fatalf("missing rel: %q", out)
	}
	if !strings.Contains(out, ">link</a>") {
		t.Fatalf("missing link text: %q", out)
	}
}

func TestPMJSONToHTML_LinkMark_RejectsJavascript(t *testing.T) {
	in := `{"type":"doc","content":[{"type":"paragraph","content":[
        {"type":"text","text":"click","marks":[
            {"type":"link","attrs":{"href":"javascript:alert(1)"}}
        ]}
    ]}]}`
	out := mustRender(t, in, HTMLRenderOpts{})
	// The link wrapper is dropped at emit time; the text remains.
	if strings.Contains(out, "<a ") || strings.Contains(out, "<a>") {
		t.Fatalf("expected no <a> wrapper for javascript: href, got %q", out)
	}
	if strings.Contains(out, "javascript:") {
		t.Fatalf("javascript: must not leak into output: %q", out)
	}
	if !strings.Contains(out, ">click<") {
		t.Fatalf("expected text to survive: %q", out)
	}
}

func TestPMJSONToHTML_LinkMark_RejectsLeadingWhitespace(t *testing.T) {
	// "\tjavascript:" parses by url.Parse with an empty scheme; reject.
	in := `{"type":"doc","content":[{"type":"paragraph","content":[
        {"type":"text","text":"X","marks":[
            {"type":"link","attrs":{"href":"\tjavascript:alert(1)"}}
        ]}
    ]}]}`
	out := mustRender(t, in, HTMLRenderOpts{})
	if strings.Contains(out, "<a ") || strings.Contains(out, "<a>") {
		t.Fatalf("expected no <a> for leading-whitespace js: href, got %q", out)
	}
}

func TestPMJSONToHTML_CommentMark_PreservesId(t *testing.T) {
	in := `{"type":"doc","content":[{"type":"paragraph","content":[
        {"type":"text","text":"X","marks":[
            {"type":"comment","attrs":{"id":"c-42"}}
        ]}
    ]}]}`
	out := mustRender(t, in, HTMLRenderOpts{})
	if !strings.Contains(out, `data-comment-id="c-42"`) {
		t.Fatalf("missing data-comment-id: %q", out)
	}
}

func TestPMJSONToHTML_TextStyleMark(t *testing.T) {
	in := `{"type":"doc","content":[{"type":"paragraph","content":[
        {"type":"text","text":"X","marks":[
            {"type":"textStyle","attrs":{
                "color":"#ff0000","fontSize":18,"fontFamily":"Arial"
            }}
        ]}
    ]}]}`
	out := mustRender(t, in, HTMLRenderOpts{})
	if !strings.Contains(out, `data-color="#ff0000"`) ||
		!strings.Contains(out, `data-font-size="18"`) ||
		!strings.Contains(out, `data-font-family="Arial"`) {
		t.Fatalf("missing textStyle data-attrs: %q", out)
	}
}

func TestPMJSONToHTML_TextStyleMark_RejectsUnsafeColor(t *testing.T) {
	in := `{"type":"doc","content":[{"type":"paragraph","content":[
        {"type":"text","text":"X","marks":[
            {"type":"textStyle","attrs":{"color":"red;background:url(javascript:1)"}}
        ]}
    ]}]}`
	out := mustRender(t, in, HTMLRenderOpts{})
	if strings.Contains(out, "data-color=") {
		t.Fatalf("unsafe color must be stripped: %q", out)
	}
}

// TestIsSafeColor pins the tightened color allowlist. Each adversarial
// input either embeds a CSS function call payload (url, var, etc.)
// or pads an otherwise-valid value with hostile content. The
// previous character-set check (alphanumerics + parens) accepted all
// of these.
func TestIsSafeColor(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		// Hex, every supported width.
		{"#abc", true},
		{"#abcd", true},
		{"#abcdef", true},
		{"#abcdef12", true},
		{"#ABCDEF", true},
		{"#FFFFFF", true},
		// Hex, malformed.
		{"#ab", false},
		{"#abcde", false},
		{"#abcg12", false},
		{"#", false},
		// rgb/rgba happy path.
		{"rgb(255, 0, 0)", true},
		{"rgba(255, 0, 0, 0.5)", true},
		{"rgb(100%, 0%, 0%)", true},
		// rgb / rgba — hostile.
		{"rgb(0,0,0)/*", false},
		{"rgb(0;background:url(x))", false},
		{"url(javascript:1)", false},
		{"red;color:blue", false},
		// Named colors — whitelist.
		{"red", true},
		{"BLUE", true},
		{"transparent", true},
		// Named colors — outside whitelist.
		{"rebeccapurple", false},
		{"chartreuse", false},
		// Letters-only that pre-tightening allowed (no scheme, but a
		// hostile CSS function call shape).
		{"urlx", false},
		{"javascript", false},
		// Empty / oversized.
		{"", false},
		{strings.Repeat("a", 64), false},
	}
	for _, c := range cases {
		got := isSafeColor(c.in)
		if got != c.want {
			t.Errorf("isSafeColor(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestPMJSONToHTML_BlockquoteAndCodeBlock(t *testing.T) {
	in := `{"type":"doc","content":[
        {"type":"blockquote","content":[
            {"type":"paragraph","content":[{"type":"text","text":"quoted"}]}
        ]},
        {"type":"codeBlock","content":[{"type":"text","text":"fn main(){}"}]}
    ]}`
	out := mustRender(t, in, HTMLRenderOpts{})
	if !strings.Contains(out, `<blockquote class="tinycld-doc-blockquote">`) {
		t.Fatalf("missing blockquote: %q", out)
	}
	if !strings.Contains(out, `<pre class="tinycld-doc-pre"><code class="tinycld-doc-code-block">fn main(){}</code></pre>`) {
		t.Fatalf("missing pre/code shape: %q", out)
	}
}

func TestPMJSONToHTML_NestedLists(t *testing.T) {
	in := `{"type":"doc","content":[
        {"type":"bulletList","content":[
            {"type":"listItem","content":[
                {"type":"paragraph","content":[{"type":"text","text":"outer"}]},
                {"type":"orderedList","content":[
                    {"type":"listItem","content":[
                        {"type":"paragraph","content":[{"type":"text","text":"inner"}]}
                    ]}
                ]}
            ]}
        ]}
    ]}`
	out := mustRender(t, in, HTMLRenderOpts{})
	if !strings.Contains(out, `<ul class="tinycld-doc-ul">`) {
		t.Fatalf("missing ul: %q", out)
	}
	if !strings.Contains(out, `<ol class="tinycld-doc-ol">`) {
		t.Fatalf("missing nested ol: %q", out)
	}
	if !strings.Contains(out, "outer") || !strings.Contains(out, "inner") {
		t.Fatalf("missing list item text: %q", out)
	}
}

func TestPMJSONToHTML_TableWithMergedCells(t *testing.T) {
	in := `{"type":"doc","content":[
        {"type":"table","content":[
            {"type":"tableRow","content":[
                {"type":"tableCell","attrs":{"isHeader":true,"colspan":2},
                 "content":[{"type":"paragraph","content":[{"type":"text","text":"Hdr"}]}]}
            ]},
            {"type":"tableRow","content":[
                {"type":"tableCell","attrs":{"rowspan":2},
                 "content":[{"type":"paragraph","content":[{"type":"text","text":"A"}]}]},
                {"type":"tableCell","content":[
                    {"type":"paragraph","content":[{"type":"text","text":"B"}]}
                ]}
            ]}
        ]}
    ]}`
	out := mustRender(t, in, HTMLRenderOpts{})
	if !strings.Contains(out, `<table class="tinycld-doc-table">`) {
		t.Fatalf("missing table: %q", out)
	}
	if !strings.Contains(out, `<th class="tinycld-doc-th" colspan="2">`) {
		t.Fatalf("missing th colspan: %q", out)
	}
	if !strings.Contains(out, `<td class="tinycld-doc-td" rowspan="2">`) {
		t.Fatalf("missing td rowspan: %q", out)
	}
	if !strings.Contains(out, "Hdr") || !strings.Contains(out, "A") || !strings.Contains(out, "B") {
		t.Fatalf("missing cell text: %q", out)
	}
}

func TestPMJSONToHTML_Image_URLMode_DataURI_Passthrough(t *testing.T) {
	in := `{"type":"doc","content":[{"type":"paragraph","content":[
        {"type":"image","attrs":{"src":"data:image/png;base64,iVBORw0KGgo=","alt":"x"}}
    ]}]}`
	out := mustRender(t, in, HTMLRenderOpts{Images: ImageModeURL})
	if !strings.Contains(out, `src="data:image/png;base64,iVBORw0KGgo="`) {
		t.Fatalf("data URI passthrough failed: %q", out)
	}
	if !strings.Contains(out, `alt="x"`) {
		t.Fatalf("alt attribute lost: %q", out)
	}
}

func TestPMJSONToHTML_Image_URLMode_HTTPPassthrough(t *testing.T) {
	in := `{"type":"doc","content":[{"type":"paragraph","content":[
        {"type":"image","attrs":{"src":"https://example/file.png","width":300,"height":200}}
    ]}]}`
	out := mustRender(t, in, HTMLRenderOpts{Images: ImageModeURL})
	if !strings.Contains(out, `src="https://example/file.png"`) {
		t.Fatalf("http URL passthrough failed: %q", out)
	}
	if !strings.Contains(out, `width="300"`) || !strings.Contains(out, `height="200"`) {
		t.Fatalf("dimensions lost: %q", out)
	}
}

func TestPMJSONToHTML_Image_EmbedMode_FetchesBytes(t *testing.T) {
	fetched := []string{}
	fetcher := func(src string) (string, []byte, error) {
		fetched = append(fetched, src)
		return "image/png", []byte{0x89, 0x50, 0x4e, 0x47}, nil
	}
	in := `{"type":"doc","content":[{"type":"paragraph","content":[
        {"type":"image","attrs":{"src":"https://example/file.png"}}
    ]}]}`
	out := mustRender(t, in, HTMLRenderOpts{
		Images:       ImageModeEmbed,
		EmbedFetcher: fetcher,
	})
	if !strings.Contains(out, `src="data:image/png;base64,iVBORw==`) {
		t.Fatalf("expected base64-encoded data URI, got %q", out)
	}
	if len(fetched) != 1 || fetched[0] != "https://example/file.png" {
		t.Fatalf("unexpected fetcher calls: %v", fetched)
	}
}

func TestPMJSONToHTML_Image_EmbedMode_DataURI_Untouched(t *testing.T) {
	called := false
	fetcher := func(src string) (string, []byte, error) {
		called = true
		return "", nil, nil
	}
	in := `{"type":"doc","content":[{"type":"paragraph","content":[
        {"type":"image","attrs":{"src":"data:image/png;base64,AAA="}}
    ]}]}`
	out := mustRender(t, in, HTMLRenderOpts{
		Images:       ImageModeEmbed,
		EmbedFetcher: fetcher,
	})
	if called {
		t.Fatal("fetcher should not be called for data: URIs")
	}
	if !strings.Contains(out, `src="data:image/png;base64,AAA="`) {
		t.Fatalf("data URI lost: %q", out)
	}
}

func TestPMJSONToHTML_Image_EmbedMode_FailureDropsSilently(t *testing.T) {
	fetcher := func(src string) (string, []byte, error) {
		return "", nil, fmtError("boom")
	}
	in := `{"type":"doc","content":[{"type":"paragraph","content":[
        {"type":"image","attrs":{"src":"https://example/missing.png"}}
    ]}]}`
	out := mustRender(t, in, HTMLRenderOpts{
		Images:       ImageModeEmbed,
		EmbedFetcher: fetcher,
	})
	if strings.Contains(out, "<img") {
		t.Fatalf("expected no <img> for failed fetch, got %q", out)
	}
}

func TestPMJSONToHTML_Image_WrapMode(t *testing.T) {
	in := `{"type":"doc","content":[{"type":"paragraph","content":[
        {"type":"image","attrs":{"src":"data:image/png;base64,AAA=","wrap":"left"}}
    ]}]}`
	out := mustRender(t, in, HTMLRenderOpts{})
	if !strings.Contains(out, "tinycld-doc-img-wrap--left") {
		t.Fatalf("missing wrap--left class: %q", out)
	}
}

func TestPMJSONToHTML_PageBreak(t *testing.T) {
	in := `{"type":"doc","content":[{"type":"pageBreak"}]}`
	out := mustRender(t, in, HTMLRenderOpts{})
	if !strings.Contains(out, `<hr class="tinycld-doc-hr">`) {
		t.Fatalf("missing page break <hr>: %q", out)
	}
}

func TestPMJSONToHTML_FootnoteReference(t *testing.T) {
	in := `{"type":"doc","content":[{"type":"paragraph","content":[
        {"type":"text","text":"see"},
        {"type":"footnoteReference","attrs":{"id":"3"}}
    ]}]}`
	out := mustRender(t, in, HTMLRenderOpts{})
	if !strings.Contains(out, `<sup class="tinycld-doc-footnote-ref">[3]</sup>`) {
		t.Fatalf("missing footnote ref: %q", out)
	}
}

func TestPMJSONToHTML_TextEscapes(t *testing.T) {
	in := `{"type":"doc","content":[{"type":"paragraph","content":[
        {"type":"text","text":"<script>alert('x')</script>"}
    ]}]}`
	out := mustRender(t, in, HTMLRenderOpts{})
	if strings.Contains(out, "<script>") {
		t.Fatalf("script tag must be escaped, got %q", out)
	}
	if !strings.Contains(out, "&lt;script&gt;") {
		t.Fatalf("expected escaped script, got %q", out)
	}
}

func TestPMJSONToHTML_UnsupportedNode_SilentInProd(t *testing.T) {
	// Default (TINYCLD_DEV unset) drops unknown nodes silently.
	in := `{"type":"doc","content":[{"type":"someThingWeird"}]}`
	out := mustRender(t, in, HTMLRenderOpts{})
	if strings.Contains(out, "TODO") || strings.Contains(out, "someThingWeird") {
		t.Fatalf("expected silent drop in prod, got %q", out)
	}
}

func TestPMJSONToHTML_UnsupportedNode_TodoInDev(t *testing.T) {
	t.Setenv("TINYCLD_DEV", "1")
	in := `{"type":"doc","content":[{"type":"someThingWeird"}]}`
	out := mustRender(t, in, HTMLRenderOpts{})
	if !strings.Contains(out, "TODO: unsupported block 'someThingWeird'") {
		t.Fatalf("expected dev-mode TODO, got %q", out)
	}
}

func TestPMJSONToHTML_MarkOrdering_Deterministic(t *testing.T) {
	// Marks come in randomized order from the source; output should
	// always nest link outermost, formatting innermost. Snapshot the
	// expected nesting.
	in := `{"type":"doc","content":[{"type":"paragraph","content":[
        {"type":"text","text":"X","marks":[
            {"type":"italic"},
            {"type":"link","attrs":{"href":"https://a.example/"}},
            {"type":"bold"}
        ]}
    ]}]}`
	out := mustRender(t, in, HTMLRenderOpts{})
	// link wraps everything; then bold (3); then italic (4).
	idxA := strings.Index(out, "<a")
	idxBold := strings.Index(out, "mark--bold")
	idxItalic := strings.Index(out, "mark--italic")
	if !(idxA < idxBold && idxBold < idxItalic) {
		t.Fatalf("expected link > bold > italic nesting, got %q", out)
	}
}

func TestPMJSONToHTML_LinkMark_AllowsMailto(t *testing.T) {
	in := `{"type":"doc","content":[{"type":"paragraph","content":[
        {"type":"text","text":"mail","marks":[
            {"type":"link","attrs":{"href":"mailto:a@example.com"}}
        ]}
    ]}]}`
	out := mustRender(t, in, HTMLRenderOpts{})
	if !strings.Contains(out, `href="mailto:a@example.com"`) {
		t.Fatalf("mailto link dropped: %q", out)
	}
}

// Round-trip pairing: every fixture that pm_to_docx_test.go round-trips
// is asserted to also render cleanly here. The Go test runner discovers
// these alongside the rest of the package's tests. We don't compare the
// HTML output byte-for-byte against a golden — round-trip parity is
// asserted in roundtrip_test.go on the docx side, and the structural
// assertions above cover renderer correctness — but rendering every
// fixture without panic / error gives us a smoke test that the renderer
// keeps up with the supported-node set as new fixtures are added.
func TestPMJSONToHTML_FixtureSmokeTest(t *testing.T) {
	fixtures := []string{
		// Empty body
		`{"type":"doc","content":[]}`,
		// Paragraph with rich marks
		`{"type":"doc","content":[{"type":"paragraph","content":[
            {"type":"text","text":"Bold and italic","marks":[
                {"type":"bold"},{"type":"italic"}
            ]}
        ]}]}`,
		// Heading + alignment
		`{"type":"doc","content":[
            {"type":"heading","attrs":{"level":2,"textAlign":"right"},
             "content":[{"type":"text","text":"Right"}]}
        ]}`,
		// Mixed list
		`{"type":"doc","content":[
            {"type":"bulletList","content":[
                {"type":"listItem","content":[
                    {"type":"paragraph","content":[{"type":"text","text":"a"}]}
                ]}
            ]},
            {"type":"orderedList","content":[
                {"type":"listItem","content":[
                    {"type":"paragraph","content":[{"type":"text","text":"1"}]}
                ]}
            ]}
        ]}`,
	}
	for i, fx := range fixtures {
		if _, err := PMJSONToHTML([]byte(fx), HTMLRenderOpts{}); err != nil {
			t.Errorf("fixture %d: %v", i, err)
		}
	}
}

// mustRender renders the input and fails the test on error.
func mustRender(t *testing.T, in string, opts HTMLRenderOpts) string {
	t.Helper()
	out, err := PMJSONToHTML([]byte(in), opts)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	return out
}

// itoaSimple — keep tests dependency-free; strconv.Itoa works but
// importing it just for the heading test is busywork.
func itoaSimple(n int) string {
	if n < 0 || n > 9 {
		return ""
	}
	return string(rune('0' + n))
}

type fmtErr struct{ s string }

func (e *fmtErr) Error() string { return e.s }
func fmtError(s string) error   { return &fmtErr{s} }
