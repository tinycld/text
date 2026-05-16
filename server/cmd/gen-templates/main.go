// gen-templates synthesizes the four shipping document templates
// (blank / letter / resume / report) as .docx files plus a TS module
// holding the same bytes base64-encoded so the client can construct a
// Blob without touching the filesystem.
//
// Each template is defined here as a ProseMirror JSON tree, then run
// through the same translate.PMJSONToDocx pipeline a normal save would
// use — that way every shipping template is guaranteed to be one we
// can round-trip on import without warnings.
//
// Run:  go run ./cmd/gen-templates
//
// Output paths (relative to package root):
//   ../tinycld/text/assets/templates/<id>.docx
//   ../tinycld/text/lib/templates/templates.generated.ts
//
// The .docx files are the shippable artifact (the client reads from
// the embedded base64, but committing the raw files lets reviewers
// open them in Word to spot-check). The .generated.ts is what the
// runtime registry imports — base64 inside a TS module keeps Metro out
// of the asset-extension business and works identically on web /
// native without any expo-asset plumbing.
package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"tinycld.org/packages/text/translate"
)

// templateSpec describes one shipping template. The PMNode tree is the
// authoritative content — everything else (.docx bytes, base64 string,
// .ts entry) derives from it.
type templateSpec struct {
	ID          string
	Name        string
	Description string
	Build       func() translate.PMNode
}

// templates is the canonical ordered list. The runtime registry on the
// client mirrors this order so the picker shows Blank first, then
// Letter / Resume / Report. Add new templates here; the generator + ts
// emit will pick them up automatically.
var templates = []templateSpec{
	{
		ID:          "blank",
		Name:        "Blank",
		Description: "Start with an empty document.",
		Build:       buildBlank,
	},
	{
		ID:          "letter",
		Name:        "Letter",
		Description: "Formal letter with sender, recipient, salutation, and signature.",
		Build:       buildLetter,
	},
	{
		ID:          "resume",
		Name:        "Resume",
		Description: "Basic CV layout with experience, education, and skills.",
		Build:       buildResume,
	},
	{
		ID:          "report",
		Name:        "Report",
		Description: "Business report with summary, background, findings, and recommendations.",
		Build:       buildReport,
	},
}

func main() {
	// Walk up from CWD to find manifest.ts so the user can run
	// `go run ./cmd/gen-templates` from either the package root or
	// inside server/.
	pkgRoot := mustFindPackageRoot()
	assetsDir := filepath.Join(pkgRoot, "tinycld", "text", "assets", "templates")
	libDir := filepath.Join(pkgRoot, "tinycld", "text", "lib", "templates")

	if err := os.MkdirAll(assetsDir, 0o755); err != nil {
		die("mkdir %s: %v", assetsDir, err)
	}
	if err := os.MkdirAll(libDir, 0o755); err != nil {
		die("mkdir %s: %v", libDir, err)
	}

	// Map<id, base64> built alongside the .docx writes so emitTSModule
	// has both view of the world.
	encoded := map[string]string{}

	for _, spec := range templates {
		node := spec.Build()
		pmJSON, err := json.Marshal(node)
		if err != nil {
			die("marshal %s: %v", spec.ID, err)
		}
		bytes, warnings, err := translate.PMJSONToDocxWithWarnings(pmJSON)
		if err != nil {
			die("emit %s docx: %v", spec.ID, err)
		}
		for _, w := range warnings {
			fmt.Fprintf(os.Stderr, "warning emitting %s: %s (%s)\n", spec.ID, w.Code, w.Detail)
		}
		path := filepath.Join(assetsDir, spec.ID+".docx")
		if err := os.WriteFile(path, bytes, 0o644); err != nil {
			die("write %s: %v", path, err)
		}
		encoded[spec.ID] = base64.StdEncoding.EncodeToString(bytes)
		fmt.Printf("wrote %s (%d bytes)\n", path, len(bytes))
	}

	tsPath := filepath.Join(libDir, "templates.generated.ts")
	if err := os.WriteFile(tsPath, []byte(renderTSModule(encoded)), 0o644); err != nil {
		die("write %s: %v", tsPath, err)
	}
	fmt.Printf("wrote %s\n", tsPath)
}

// mustFindPackageRoot walks up from CWD looking for the package
// manifest. Lets `go run ./cmd/gen-templates` work from either the
// package root or the server/ directory.
func mustFindPackageRoot() string {
	cwd, err := os.Getwd()
	if err != nil {
		die("getwd: %v", err)
	}
	dir := cwd
	for i := 0; i < 6; i++ {
		if _, err := os.Stat(filepath.Join(dir, "manifest.ts")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	die("could not locate manifest.ts walking up from %s", cwd)
	return ""
}

// renderTSModule emits the deterministic templates.generated.ts. The
// file is the authoritative source the client registry reads — we keep
// it pure data so a future generator change (e.g. adding a thumbnail
// pointer) doesn't accidentally diverge between this file and the
// runtime importer in templates/index.ts.
func renderTSModule(encoded map[string]string) string {
	// Order entries by the canonical templates slice so the file diff
	// matches the visible order in the picker.
	ordered := make([]templateSpec, 0, len(templates))
	for _, spec := range templates {
		if _, ok := encoded[spec.ID]; ok {
			ordered = append(ordered, spec)
		}
	}

	var sb strings.Builder
	sb.WriteString("// THIS FILE IS GENERATED. Do not edit by hand.\n")
	sb.WriteString("// Regenerate by running `go run ./cmd/gen-templates` from\n")
	sb.WriteString("// the @tinycld/text package's server/ directory.\n")
	sb.WriteString("//\n")
	sb.WriteString("// Each entry holds the base64-encoded bytes of a generated\n")
	sb.WriteString("// .docx in assets/templates/. The client decodes the bytes at\n")
	sb.WriteString("// upload time and ships them through useCreateDriveItem; this\n")
	sb.WriteString("// keeps the templates out of Metro's asset-extension list and\n")
	sb.WriteString("// works identically on web + native.\n\n")
	sb.WriteString("export interface GeneratedTemplateBytes {\n")
	sb.WriteString("    id: string\n")
	sb.WriteString("    base64: string\n")
	sb.WriteString("}\n\n")
	sb.WriteString("export const GENERATED_TEMPLATE_BYTES: readonly GeneratedTemplateBytes[] = [\n")
	for _, spec := range ordered {
		sb.WriteString("    {\n")
		sb.WriteString(fmt.Sprintf("        id: '%s',\n", spec.ID))
		sb.WriteString("        base64:\n")
		sb.WriteString(formatBase64Lines(encoded[spec.ID]))
		sb.WriteString("    },\n")
	}
	sb.WriteString("]\n")
	return sb.String()
}

// formatBase64Lines wraps a base64 string into 76-column quoted-string
// literal pieces joined with '+' so the generated file diffs cleanly
// and stays inside Biome's line-length preferences.
func formatBase64Lines(b64 string) string {
	const width = 76
	var sb strings.Builder
	for i := 0; i < len(b64); i += width {
		end := i + width
		if end > len(b64) {
			end = len(b64)
		}
		isLast := end == len(b64)
		sb.WriteString("            '")
		sb.WriteString(b64[i:end])
		sb.WriteString("'")
		if !isLast {
			sb.WriteString(" +")
		} else {
			sb.WriteString(",")
		}
		sb.WriteString("\n")
	}
	return sb.String()
}

func die(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}

// ---- Template content builders ---------------------------------------------
//
// Each builder returns a doc-level PMNode. We stick to the subset of
// nodes/marks the translator supports end-to-end so the resulting
// .docx files round-trip without warnings:
//
//   - paragraph
//   - heading (level 1, 2)
//   - bulletList / listItem / paragraph
//   - text + bold mark + italic mark
//
// Paragraph alignment (`<w:jc>`) is not yet wired through PMJSONToDocx
// — Adding it to the Letter template is tracked separately. For v1 the
// structure is what makes each template useful, with italic reserved
// for the date / placeholder hints that signal "fill me in".

func docOf(blocks ...translate.PMNode) translate.PMNode {
	return translate.PMNode{Type: translate.NodeTypeDoc, Content: blocks}
}

func p(content ...translate.PMNode) translate.PMNode {
	return translate.PMNode{Type: translate.NodeTypeParagraph, Content: content}
}

func emptyP() translate.PMNode {
	return translate.PMNode{Type: translate.NodeTypeParagraph}
}

func text(s string) translate.PMNode {
	return translate.PMNode{Type: translate.NodeTypeText, Text: s}
}

func boldText(s string) translate.PMNode {
	return translate.PMNode{
		Type:  translate.NodeTypeText,
		Text:  s,
		Marks: []translate.PMMark{{Type: translate.MarkTypeBold}},
	}
}

func italicText(s string) translate.PMNode {
	return translate.PMNode{
		Type:  translate.NodeTypeText,
		Text:  s,
		Marks: []translate.PMMark{{Type: translate.MarkTypeItalic}},
	}
}

func heading(level int, s string) translate.PMNode {
	return translate.PMNode{
		Type:    translate.NodeTypeHeading,
		Attrs:   map[string]any{"level": float64(level)},
		Content: []translate.PMNode{text(s)},
	}
}

func bulletList(items ...string) translate.PMNode {
	listItems := make([]translate.PMNode, 0, len(items))
	for _, item := range items {
		listItems = append(listItems, translate.PMNode{
			Type: translate.NodeTypeListItem,
			Content: []translate.PMNode{
				p(text(item)),
			},
		})
	}
	return translate.PMNode{
		Type:    translate.NodeTypeBulletList,
		Content: listItems,
	}
}

func buildBlank() translate.PMNode {
	// A single empty paragraph — Word still needs one for the cursor to
	// have something to land on, and the translator's emitter requires
	// at least one body child.
	return docOf(emptyP())
}

func buildLetter() translate.PMNode {
	return docOf(
		p(text("Your Name")),
		p(text("Your Address")),
		p(text("City, State ZIP")),
		emptyP(),
		p(italicText("[Date]")),
		emptyP(),
		p(text("Recipient Name")),
		p(text("Recipient Title")),
		p(text("Recipient Company")),
		p(text("Recipient Address")),
		p(text("City, State ZIP")),
		emptyP(),
		p(text("Dear [Recipient Name],")),
		emptyP(),
		p(text("I am writing to ...")),
		emptyP(),
		p(text(
			"[Add the body of your letter here. Replace this paragraph with the substance of your message. " +
				"Keep paragraphs focused and end with a clear ask.]",
		)),
		emptyP(),
		p(text("Thank you for your time and consideration.")),
		emptyP(),
		p(text("Sincerely,")),
		emptyP(),
		emptyP(),
		p(text("Your Name")),
	)
}

func buildResume() translate.PMNode {
	return docOf(
		heading(1, "Your Name"),
		p(text("email@example.com  ·  555-0100  ·  linkedin.com/in/you")),
		emptyP(),
		heading(2, "Experience"),
		p(boldText("Job Title — Company")),
		p(italicText("Start Date – End Date")),
		bulletList(
			"Describe a key responsibility or outcome here.",
			"Quantify an impact: shipped X, grew Y by Z%.",
			"Highlight a relevant technology or collaboration.",
		),
		emptyP(),
		p(boldText("Previous Job Title — Previous Company")),
		p(italicText("Start Date – End Date")),
		bulletList(
			"Summarize what you owned and what you shipped.",
			"Call out a concrete result you are proud of.",
		),
		emptyP(),
		heading(2, "Education"),
		p(boldText("University Name")),
		p(italicText("Degree, Field of Study — Graduation Year")),
		emptyP(),
		heading(2, "Skills"),
		p(text("Skill 1  ·  Skill 2  ·  Skill 3  ·  Skill 4  ·  Skill 5")),
	)
}

func buildReport() translate.PMNode {
	return docOf(
		heading(1, "Project Report"),
		p(italicText("[Date]  ·  [Your Name]")),
		emptyP(),
		heading(2, "Executive Summary"),
		p(text(
			"Provide a brief overview of the project's objectives, scope, and key findings. " +
				"Aim for two to four sentences a reader can absorb at a glance.",
		)),
		emptyP(),
		heading(2, "Background"),
		p(text(
			"Describe the context and motivation for the project. " +
				"Reference any prior work, constraints, or stakeholder concerns that shaped the approach.",
		)),
		emptyP(),
		heading(2, "Findings"),
		bulletList(
			"Finding 1 — describe what you observed and why it matters.",
			"Finding 2 — call out a measurement or data point that anchors the claim.",
			"Finding 3 — note any open questions or follow-up needed.",
		),
		emptyP(),
		heading(2, "Recommendations"),
		p(text(
			"Outline the recommended next steps. Tie each recommendation back to one of the findings above " +
				"and identify who would own it.",
		)),
	)
}
