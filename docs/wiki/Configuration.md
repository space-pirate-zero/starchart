Everything STARCHART knows about your project lives in a `.starchart/` directory at the project root. `config.yaml` holds project settings; every other YAML file in the directory holds entities, artifacts, edges and rules. This page is the complete `config.yaml` reference (the `ProjectConfig`, `CodeConfig` and `CodegenTarget` schemas in [`config/schema.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/config/schema.ts)), plus the discovery rules in [`config/load.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/config/load.ts): how the root is found and which files get loaded.

## Finding the project root

`findRoot(start)` walks up from the current directory (or `-C/--cwd <dir>`) to the nearest directory that contains a `.starchart/` entry. That directory is the project root:

- `starchart.lock` is read and written there;
- paths in `code.scopes`, `tokens`, `codegen[].out`, `content`, relative `plugins` and `fs` bindings are relative to it.

No `.starchart/` in any parent is an error (exit code 2):

```text
starchart: no .starchart/ found in /path/you/ran/from or any parent. Run "starchart init".
```

`starchart init` scaffolds `.starchart/config.yaml`, `.starchart/entities/` and `.starchart/artifacts/`, detecting code scopes from project markers. `init --discover` also writes `.starchart/proposals/discovered.yaml` with proposed facts, artifacts and bridges. The loader ignores it until you move it into `.starchart/` (for example `.starchart/entities/offer.yaml`).

## Which files are loaded

| File | Treated as |
|---|---|
| `.starchart/config.yaml`, or `.starchart/config.yml` if there's no `.yaml` | project config (only the first YAML document is read) |
| every other `**/*.yaml` and `**/*.yml` under `.starchart/`, recursively | entity / artifact / edge / rule documents ([Authoring YAML](Authoring-YAML)) |
| anything under `.starchart/preview/`, `.starchart/journal/` or `.starchart/proposals/` | ignored (generated output and unreviewed `init --discover` proposals) |

Files are processed in sorted path order. Subdirectory names mean nothing to the loader: `entities/` and `artifacts/` are just a convention. A missing `config.yaml` is fine; every field has a default.

> Anything else you drop into `.starchart/` as YAML is loaded. Review `proposals/discovered.yaml` before you move it in.

## Full example

The demo's config, [`examples/pro-universe/.starchart/config.yaml`](https://github.com/space-pirate-zero/starchart/blob/main/examples/pro-universe/.starchart/config.yaml):

```yaml
name: pro-universe
site: https://nebula.example.com
code:
  scopes:
    web: apps/web
    ios: apps/ios
adapters:
  fs: {}
  stripe:
    secretEnv: STRIPE_SECRET_KEY
packs: [core, appstore, privacy, seo]
codegen:
  - lang: ts
    out: apps/web/lib/starchart-facts.ts
    entities: [addon:pro]
  - lang: swift
    out: apps/ios/Sources/Core/StarchartFacts.swift
    entities: [addon:pro]
```

The `appstore` adapter has no block here. It's still registered, it just runs with default settings and reads its credentials from the environment.

> **Careful:** config values are **not** environment-interpolated. `keyId: ${ASC_KEY_ID}` would reach the App Store adapter as the literal string `${ASC_KEY_ID}`, and a setting beats the `ASC_KEY_ID` environment fallback. Keep secrets out of `config.yaml`: leave the key out and set the env var, or name the variable where an adapter supports it (`stripe.secretEnv`).

## Top-level fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | string | `"starchart"` | Project name (`init` uses the directory name). |
| `code` | `CodeConfig` | `{ scopes: { app: "." }, exclude: [] }` | Code ingestion settings (below). |
| `adapters` | map: adapter id → settings map | `{}` | Per-adapter settings, including `write`. |
| `packs` | list of strings | `["core"]` | Rule packs: `core`, `appstore`, `privacy`, `seo`, plus any pack a plugin registers. `@starchart/pack-<id>` and `pack-<id>` are accepted aliases. Unknown ids fail `rules`. `init` writes `[core, privacy, appstore, seo]`. |
| `tokens` | string or list | — | DTCG design-token JSON file(s), imported as facts under the `tokens` entity ([Design Tokens](Design-Tokens)). |
| `codegen` | list of `CodegenTarget` | `[]` | Typed fact constants to generate ([Codegen](Codegen)). |
| `content` | list of strings | code scope directories | Roots that `starchart scan` searches for unbound fact literals. |
| `site` | string | — | Base URL. Relative `url` bindings resolve against it, and it's passed to every adapter as `settings.site`. |
| `plugins` | list of strings | `[]` | Modules that add adapters and rule packs: paths relative to the project root, or package names (below). |

Unknown top-level keys are dropped silently by the schema. A typo like `codgen:` does nothing, so check with `starchart node` or `query` if something seems ignored.

## `code`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `scopes` | map: scope name → directory | `{ app: "." }` | Each scope is ingested separately. The name prefixes every code id (`symbol:ios/…`), so keep names short and stable. Nested scopes win over their parents. |
| `include` | list of globs | all files | Only these files. Globs are relative to each scope directory; root-relative globs that start with the scope directory also work. |
| `exclude` | list of globs | `[]` | Skip these files, same matching rules. |
| `maxCodeDepth` | positive integer | 4 | Consecutive code hops allowed during impact analysis ([Impact Analysis](Impact-Analysis)) and in the lock's dependency walk. `starchart lock`, `apply` and `ack` record it in `starchart.lock` as `maxCodeDepth`, and staleness checks use the recorded value. After changing it, run `starchart lock` so the lock catches up. |

Always excluded, whatever you configure: `node_modules`, `dist`, `build`, `.git`, `.next`, `DerivedData`, `Pods`, `.starchart`. Dotfiles are skipped too.

```yaml
code:
  scopes:
    web: apps/web
    ios: apps/ios
    api: services/api
  exclude: ["**/*.stories.tsx", "apps/web/legacy/**"]
  maxCodeDepth: 5
```

What the ingestor does with those files is in [Code Ingestion](Code-Ingestion); the ids it produces are in [Node IDs](Node-IDs).

## `adapters`

A map from adapter id to a free-form settings map, handed to the adapter as `settings` (with `site` merged in). The only key STARCHART itself interprets is `write`:

| Adapter | Writes when | Other settings |
|---|---|---|
| `fs` | always, unless `write: false` | — |
| `url` | never (audit only) | uses `site` |
| `stripe` | only with `write: true` | `secretEnv` (env var holding the key, default `STRIPE_SECRET_KEY`) |
| `appstore` | only with `write: true`, and only bindings with a `field` (screenshots and IAPs stay manual) | `keyId`, `issuerId`, `keyPath`; each falls back to `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY_PATH`. The key can also come from `ASC_PRIVATE_KEY` (PEM text, env only). |
| plugin adapters | only with `write: true` (every adapter except `fs` is external) | whatever the plugin reads from `settings` |

```yaml
adapters:
  fs: {}
  stripe: { secretEnv: STRIPE_LIVE_KEY, write: true }
```

`starchart adapters` lists every adapter and whether it may write with your config. Writability also decides `auto` vs `manual` in plans. Details: [Adapters Overview](Adapters-Overview).

## `plugins`

```yaml
plugins:
  - ./plugins/example.mjs      # relative: resolved from the project root
  - starchart-plugin-cms       # bare: resolved from the project's node_modules
packs: [core, house]           # a plugin pack runs only when listed here
adapters:
  jsonfile: { write: true }    # a plugin adapter is external: opt in to writes
```

Each module is an ES module that exports `adapters` and/or `packs`, named or on its default export. Plugins load inside `buildProject`, so every command, the [MCP Server](MCP-Server), `serve` and the [Claude Code Hook](Claude-Code-Hook) see them. A plugin adapter can replace a built-in adapter id; a plugin pack can't reuse `core`, `appstore`, `privacy` or `seo`. Any loading problem fails the command with exit code 2:

```text
starchart: plugin "starchart-plugin-cms" not found from /path/to/project; install it or use a relative path
starchart: plugin "./plugins/empty.mjs" exports neither "adapters" nor "packs"
starchart: rule pack "core" is built in and cannot be replaced
```

A tested example with real output is on [Writing an Adapter](Writing-an-Adapter#a-tested-plugin-jsonfile).

## `codegen`

Each entry is a `CodegenTarget`:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `lang` | `ts` \| `swift` \| `kotlin` | yes | Output language. Anything else is a schema error. |
| `out` | string | yes | Output file, relative to the project root. |
| `entities` | list of entity ids | no | Only emit facts under these entities (default: all). |
| `name` | string | no | Swift enum / Kotlin object name (default `StarchartFacts`). |
| `package` | string | no | Kotlin package. |

```yaml
codegen:
  - { lang: kotlin, out: android/app/src/main/java/com/nebula/StarchartFacts.kt, package: com.nebula, entities: [addon:pro] }
```

Generated files start with `// @starchart generated — do not edit` and carry `@starchart anchors` comments, so the ingestor marks them generated and classifies their constants `auto` in plans. See [Codegen](Codegen).

## Validation errors

Config errors fail every command with exit code 2 and the file name:

```text
starchart: .starchart/config.yaml: codegen.0.lang: Invalid option: expected one of "ts"|"swift"|"kotlin"
```

YAML syntax errors report the file's absolute path and the parser's position:

```text
starchart: /…/.starchart/config.yaml: Map keys must be unique at line 22, column 1:
```

## See also

- [Authoring YAML](Authoring-YAML)
- [Code Ingestion](Code-Ingestion)
- [Adapters Overview](Adapters-Overview)
- [Codegen](Codegen)
- [Writing an Adapter](Writing-an-Adapter)
