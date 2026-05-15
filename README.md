# text

Plain-text and rich-text documents.

Feature package for the [tinycld](https://github.com/tinycld/tinycld) ecosystem. Lives as a standalone git repo alongside the [`tinycld`](https://github.com/tinycld/tinycld) app shell and other sibling packages (`contacts`, `mail`, `calendar`, `drive`, `google-takeout-import`). The app shell bundles `@tinycld/core` inside it — there is no separate core repo to clone.

## Development

```sh
# Clone the app shell and this package as siblings
cd ~/code/tinycld
git clone git@github.com:tinycld/tinycld.git
git clone git@github.com:tinycld/text.git

# Install deps in the app shell
cd tinycld
pnpm install

# Link this package into the app shell
pnpm run packages:link ../text

# Run the full stack
pnpm run start
```

## Standalone checks

Lint and typecheck both run from the app shell — biome and TypeScript live
there, and the app shell's tsconfig pulls in `expo`'s base config, `uniwind`
type augments, and the live `~/types/pbSchema` generated from PocketBase,
none of which a standalone invocation in this package can see. Biome's
config lives in `tinycld/biome.json` and applies to every linked package
(there is no `biome.json` in this repo).

```sh
cd ../tinycld
pnpm run packages:link ../text   # only needed once per checkout
pnpm run lint                            # scans this package via the app's biome rules
pnpm run typecheck                       # full app-shell tsc
```

## CI

`.github/workflows/ci.yml` runs lint, typecheck, and vitest on every push to
`main` and every PR. It clones `tinycld/tinycld@main` into a sibling
directory, installs the app shell's deps, links this package in, and runs
the checks — exactly what a developer does locally.

## Package anatomy

- `manifest.ts` — the single source of truth for this package's capabilities
- `package.json` — name, exports map, peer deps
- `tsconfig.json` — typecheck config (lint config lives in the app shell's `biome.json`)
- `tests/` — vitest unit tests
