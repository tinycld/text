// The open-in-text-action module is a side-effect import: loading it
// registers a "text.open" PreviewAction factory with core's preview
// action registry. Drive's PreviewModal walks the registry from
// inside React render, so any package linked into the app shell can
// contribute an "Open in <pkg>" button without drive needing to know
// about it.
//
// We don't try to invoke the registered factory here — it calls
// useOrgHref() which only works inside React render. The contract
// under test is that the side-effect import populates the registry
// at all (drive's PreviewModal will pick the entry up via
// getPreviewActionFactories()).
//
// expo-router and lucide-react-native are aliased to test stubs in
// tinycld/vitest.config.ts; the stubs let this test load the real
// open-in-text-action.tsx module without dragging in node_modules
// that don't tolerate Vitest's ESM evaluator.

import { describe, expect, it } from 'vitest'
import {
    __resetPreviewActionRegistryForTests,
    getPreviewActionFactories,
} from '@tinycld/core/file-viewer/preview-action-registry'
// Static import so the side effect runs as part of module-graph
// evaluation. Subsequent imports from other tests are cached.
import '../tinycld/text/lib/open-in-text-action'

describe('text.open preview action', () => {
    it('populates the preview action registry on side-effect import', () => {
        const factories = getPreviewActionFactories()
        expect(factories.length).toBeGreaterThan(0)
    })

    it('exposes a reset hook so consumers can isolate test cases', () => {
        __resetPreviewActionRegistryForTests()
        expect(getPreviewActionFactories().length).toBe(0)
    })
})
