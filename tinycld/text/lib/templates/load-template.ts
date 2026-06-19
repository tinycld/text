// Re-export entry. Metro resolves `.web.ts` on web and `.native.ts` on
// iOS/Android, so `import { loadTemplateBody } from './load-template'`
// lands on the right platform automatically. This file is the typecheck
// target and the fallback resolution (Node/Vitest), where the web Blob
// path is the correct one — see load-template.native.ts for why native
// can't use a Blob built from raw bytes.
export { loadTemplateBody } from './load-template.web'
