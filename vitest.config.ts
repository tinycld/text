import path from 'node:path'
import { mergeConfig } from 'vitest/config'
import appConfig from '../app/vitest.config'

export default mergeConfig(appConfig, {
    resolve: {
        alias: [{ find: /^~\/(.+)$/, replacement: path.resolve(import.meta.dirname, '$1') }],
        // Platform-resolved hooks (e.g. use-suggestion-bridge.web.ts /
        // .native.ts) are imported by their no-extension name and Metro
        // picks the right variant via its platform-extensions resolver.
        // Vitest doesn't follow that pattern by default — we extend the
        // resolved-extensions list so a relative `./use-suggestion-bridge`
        // import lands on the .web variant in tests. Vite tries the
        // listed extensions in order, so .web.ts wins over .ts (which
        // doesn't exist for these hooks anyway). Tests that need the
        // native behavior import .native explicitly.
        extensions: ['.web.ts', '.web.tsx', '.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'],
    },
    test: {
        root: import.meta.dirname,
        include: ['tests/**/*.test.{ts,tsx}', 'tinycld/**/*.test.{ts,tsx}'],
    },
})
