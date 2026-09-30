How to hack on STARCHART: set up the monorepo, what CI checks, how the wiki is edited, the conventions the code follows, and step-by-step recipes for the four most common contributions (a language ingestor, an adapter, a rule pack, an SDK privacy catalog entry). Read [Architecture](Architecture) first for the module map.

## Dev setup

You need Node 20+ (CI uses 22), pnpm 10 (the repo pins `pnpm@10.33.0` via `packageManager`; `corepack enable` gets you the right one) and git.

```bash
git clone https://github.com/space-pirate-zero/starchart.git && cd starchart
pnpm install && pnpm build
```

`@space-pirate-zero/starchart` isn't on npm yet, so this from-source build is also how everyone else runs it today. To use your build on another repo, alias it:

```bash
alias starchart="node $PWD/packages/starchart/dist/cli/bin.js"
```

Root scripts run across the workspace (`pnpm -r`):

| Command | What it runs |
|---|---|
| `pnpm build` | `tsc -p tsconfig.build.json` then `scripts/copy-assets.mjs` (copies viewer assets and rule-pack data into `dist/`) |
| `pnpm test` | `vitest run` |
| `pnpm typecheck` | `tsc -p tsconfig.json --noEmit` |

Inside `packages/starchart` there's also a `dev` script that runs the CLI from source with tsx, no build needed:

```bash
pnpm --filter @space-pirate-zero/starchart dev --cwd ../../examples/pro-universe impact addon:pro.price.usd
```

The script runs from `packages/starchart`, so paths are relative to it. Prefer the long `--cwd` form here, since `-C` is also a pnpm flag.

Run one test file while you work:

```bash
cd packages/starchart && pnpm vitest run src/core/core.test.ts
```

Before you open a PR, run what CI runs: `pnpm typecheck && pnpm test && pnpm build`, then make sure the demo is still in sync:

```bash
node packages/starchart/dist/cli/bin.js -C examples/pro-universe check
```

## CI

[`.github/workflows/ci.yml`](https://github.com/space-pirate-zero/starchart/blob/main/.github/workflows/ci.yml) runs on every pull request and every push to `main`:

| Step | What it runs |
|---|---|
| Matrix | `ubuntu-latest` and `macos-latest` (`fail-fast: false`), Node 22, pnpm from `packageManager` |
| Install | `pnpm install --frozen-lockfile` |
| Check | `pnpm typecheck`, `pnpm test`, `pnpm build` |
| Demo in sync | `node packages/starchart/dist/cli/bin.js -C examples/pro-universe check` |

The last step fails if a change leaves the committed demo stale against its `starchart.lock`. If you changed the demo on purpose, update its artifacts (or `starchart lock` it) and commit the new lock. A frozen lockfile means a dependency change must include the updated `pnpm-lock.yaml`.

## Editing the wiki

The wiki source lives in the repo under `docs/wiki/`, one Markdown file per page (`Impact-Analysis.md` → "Impact Analysis"). [`.github/workflows/wiki.yml`](https://github.com/space-pirate-zero/starchart/blob/main/.github/workflows/wiki.yml) copies it to the GitHub wiki on every push to `main` that touches `docs/wiki/**` (or on a manual run).

- **Edit through a PR to `docs/wiki/`**, not the wiki web editor. The sync mirrors the folder with `rsync --delete`, so anything edited only on the wiki is overwritten on the next sync.
- Link pages as `[Impact Analysis](Impact-Analysis)`, no `.md`.
- Paste real CLI output from a temp copy of the demo, never from memory.
- A behavior change without a wiki update is an incomplete PR.

## Conventions

- **ESM with NodeNext resolution.** Relative imports end in `.js` even in `.ts` files: `import { Graph } from "../core/graph.js";`.
- **Strict TypeScript**, including `noUncheckedIndexedAccess`. Index access returns `T | undefined`; handle it. Target ES2022.
- **Tests are colocated**: `foo.ts` sits next to `foo.test.ts`. End-to-end tests go in `packages/starchart/test/`. Fixtures live in `__fixtures__/` or `fixtures/` next to the tests that use them; they're excluded from the build.
- **No placeholders.** No `TODO` stubs, mock implementations or fake data in shipped code. If a feature isn't done, it isn't merged; if a limitation exists, say so in the code comment and the wiki.
- **No network in tests.** Adapters receive `fetch` through `AdapterContext`; tests pass a fake.
- **No shell.** Git and other processes are spawned with `execFile`, never through a shell string.
- **Deterministic output.** Sort anything you print or write (nodes, edges, files, findings). Diffs of the lock and of generated code must be stable across runs and machines.
- **Dependencies are few on purpose.** Current runtime deps: commander, fast-glob, picocolors, yaml, zod, typescript (for the TS parser), resvg (OG images), pngjs and pixelmatch, and the MCP SDK. Adding one needs a reason in the PR.
- **Docs live in the repo.** The wiki is published from `docs/wiki/` (see [Editing the wiki](#editing-the-wiki)), so doc changes are reviewed in PRs like code.

## Commit conventions

Short, imperative, sentence case, no prefix tags. Say what changed, not how you felt about it. From the history:

```text
Fix issues found while documenting: stale-aware plans, per-binding writes, codegen in apply, plugins, CLI polish
Add public library entry point (src/index.ts)
Point repository metadata at space-pirate-zero/starchart
```

One logical change per commit where you can. Mention the page you updated if behavior changed.

## Add a language ingestor

The code layer lives in `packages/starchart/src/code/`. TS/JS uses the TypeScript compiler API (`typescript.ts`); Swift, Kotlin and Go share a hand-written lexer (`lexer.ts`) and C-like declaration scanner (`clike.ts`, `clike-common.ts`). A new language follows the same shape:

1. **Classify files.** In `files.ts`, teach `classify()` the extension (role `code`, a new `SourceLang`) and `isTestPath()` the language's test-file conventions. Add the language to `SourceLang` in `types.ts`.
2. **Parse.** Write `parseX(file, text, generated): ParsedFile` in `code/x.ts`. A `ParsedFile` carries symbols (id, qualified name, line range, whitespace-normalized hash, optional literal `value`), env/flag/event signals, i18n key references, `@starchart` annotation comments, the set of code lines, and screens. Reuse the lexer if the language is C-like.
3. **Wire it in.** Add a branch to the `case "code"` switch in `ingest.ts`. If the language has its own name-resolution rules, extend the reference resolution in `GraphBuilder`.
4. **Manifests.** If the language has a package manifest or lockfile, add it to `MANIFESTS` in `files.ts` and parse it in `packages.ts` so `pkg:<manager>/<name>` nodes appear.
5. **Fixtures and tests.** Add a small realistic sample under `src/code/__fixtures__/universe/<scope>/`, then assert node ids, values and edges in `parsers.test.ts` and `ingest.test.ts`.
6. **Document the id shape** in [Node IDs](Node-IDs) and the coverage in [Code Ingestion](Code-Ingestion).

Keep it tree-sitter-free and dependency-free unless there's a strong case. Name-based resolution is acceptable (that's what Swift, Kotlin and Go do today), but be conservative: an extra false edge costs more than a missed one.

## Add an adapter

Start with [Writing an Adapter](Writing-an-Adapter) for the interface in depth. The checklist:

1. Implement `Adapter` (`src/adapters/types.ts`) in `src/adapters/<id>.ts`: `id`, `capabilities`, `audit()`, and if it can write, `apply()` returning an `UndoRecord` plus `revert()`. If it can write only some bindings, implement `canApply(node)` so the rest stay `manual` instead of failing at apply time (the App Store adapter only writes bindings with a `field`). `list()` enables `orphans --external` (only Stripe uses it today).
2. Read settings from `ctx.settings` (`adapters.<id>` in config) and secrets from `ctx.env`. Throw `MissingCredentialsError` when credentials are absent so `audit` skips instead of failing.
3. Use `ctx.fetch`, honor `ctx.dryRun`, and use `ctx.previousValues` to find the old value you're replacing. If the external system issues new ids (like Stripe prices), return `bindingUpdate` and the engine rewrites the YAML.
4. Register it in `builtinAdapters` in `src/adapters/registry.ts`. Writes to external systems stay opt-in automatically; only ids in `LOCAL_ADAPTERS` write by default.
5. Give it a rollout slot in `ADAPTER_PRIORITY` (`src/core/order.ts`) if the default (55) is wrong.
6. Test with a fake `fetch`, then add an `Adapter-<Name>` page.

You don't need a built-in PR to use an adapter. Out-of-tree adapters load from config: list the module under `plugins:` in `.starchart/config.yaml` (a relative path from the project root, or a package name resolved from the project's `node_modules`) and export `adapters` (named or on the default export). Every adapter needs an `id` and an `audit()` function. Library callers can also call `registerAdapter()` directly. See [Writing an Adapter](Writing-an-Adapter).

## Add a rule pack

Packs live in `src/rules/packs/`. Each exports `pack: RulePack` (`{ id, description, rules }`). Rules are either declarative (built with `defineRule()`, the same schema as `.starchart/rules.yaml`) or custom (`{ id, pack, severity, description, check(graph, ctx) }` returning findings). See `seo.ts` for a compact example.

1. Create `src/rules/packs/<id>.ts`.
2. Add it to `PACKS` in `src/rules/packs/index.ts`. Users enable it with `packs: [<id>]`; `@starchart/pack-<id>` and `pack-<id>` resolve to the same pack.
3. Test each rule's pass and fail cases in `packs.test.ts`.
4. Document it on [Rule Packs](Rule-Packs). Rule syntax: [Rules Engine](Rules-Engine).

A pack that's specific to your project doesn't need to be built in. Export `packs` (each with an `id` and a `rules` array) from a module listed under `plugins:`, then enable it by id in `packs:`. Plugin packs can't reuse a built-in id (`core`, `appstore`, `privacy`, `seo`); `registerPack` throws.

## Add a privacy catalog entry

`src/rules/packs/privacy-catalog.ts` maps SDK packages to the data they collect, in Apple's `NSPrivacyCollectedDataType` vocabulary. Play Data Safety categories are derived automatically.

```ts
sdk({
  id: "sentry",
  name: "Sentry",
  packages: ["pkg:npm/@sentry/*", "pkg:swift/sentry-cocoa", "pkg:cocoapods/Sentry", "pkg:gradle/io.sentry:*"],
  collects: [
    c("CrashData", ["AppFunctionality"]),
    c("PerformanceData", ["AppFunctionality"]),
    c("OtherDiagnosticData", ["AppFunctionality"]),
    c("DeviceID", ["AppFunctionality"], { optional: true, note: "when sendDefaultPii is enabled" }),
  ],
  tracking: false,
}),
```

Cite the vendor's privacy documentation in the PR. Mark data collected only under a config flag as `optional` with a `note`. Add a detection test in `privacy.test.ts`. The catalog is a starting point, not legal advice; see [Privacy Drift](Privacy-Drift).

## License

Apache-2.0. By contributing you agree your contribution is licensed under the same terms. See [LICENSE](https://github.com/space-pirate-zero/starchart/blob/main/LICENSE).

## See also

- [Architecture](Architecture)
- [Writing an Adapter](Writing-an-Adapter)
- [Rule Packs](Rule-Packs)
- [Privacy Drift](Privacy-Drift)
- [Roadmap](Roadmap)
