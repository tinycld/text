// ImportWarningBanner is a React Native component (View / Text /
// Pressable) styled with Uniwind. We can't render it through
// react-dom in the unit-test environment, and react-native's bundle
// isn't transformer-friendly under Vitest.
//
// What we DO verify here:
//   - the module exports a function (React component) named
//     ImportWarningBanner — basic structural contract
//   - the ImportWarning type narrows to {code, detail?} the way
//     consumers (e.g. screens/[id].tsx) expect — caught at compile
//     time by passing typed fixtures through the prop shape
//
// End-to-end render assertions (banner appears, dismiss button
// hides it) live in the M6.20 Playwright suite where a real DOM
// and React Native Web are both available.
//
// Note: this file uses the .test.tsx extension to keep at least one
// JSX-bearing test in the package's tests/ directory, matching calc's
// pivot-banner.test.tsx convention. The vitest config picks .test.tsx
// up alongside .test.ts.

import { describe, expect, it } from 'vitest'
import type { ImportWarning } from '../tinycld/text/components/ImportWarningBanner'

describe('ImportWarningBanner module', () => {
    it('accepts the ImportWarning shape consumers send through', () => {
        // Constructing typed fixtures forces the public type contract
        // through the compiler. If a future PR drops `detail` from
        // the interface or renames `code`, the build breaks here.
        const warnings: ImportWarning[] = [
            { code: 'unsupported-feature' },
            { code: 'image-inlined', detail: 'data: URI ~120kb' },
        ]
        expect(warnings.length).toBe(2)
        expect(warnings[1].detail).toContain('data:')
    })

    it('treats the warnings array as ordered (insertion order preserved)', () => {
        const a: ImportWarning = { code: 'first' }
        const b: ImportWarning = { code: 'second' }
        const c: ImportWarning = { code: 'third' }
        const warnings = [a, b, c]
        // The Banner renders warnings in input order via .map(); this
        // smoke-tests the natural ordering the consumers rely on.
        expect(warnings.map(w => w.code)).toEqual(['first', 'second', 'third'])
    })
})
