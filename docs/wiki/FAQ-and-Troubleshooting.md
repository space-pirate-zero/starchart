Real questions with answers taken from what the code actually does. If your question is "why is this red?", start with the first section. If it's "is this thing safe to point at my repo?", jump to [Does it send my code anywhere?](#does-it-send-my-code-anywhere).

## Staleness and drift

### Why is X stale?

`starchart check` tells you exactly which pinned dependency moved:

```text
  ✗ stale     appstore:listing/description
                changed: addon:pro.price.usd
```

An artifact is stale when the hash of any fact or code node it depends on differs from the hash recorded in `starchart.lock`, or when it gained a dependency it didn't have at lock time. Dependencies are found by walking the graph backwards from the artifact:

- facts it `embeds`, `renders`, `mirrors`, `describes` or `promotes` (and every leaf under a container fact)
- screens it `captures` and routes that `publish` it, plus the code those depend on, up to `code.maxCodeDepth` consecutive code hops (default 4; the lock records the value it used)
- code symbols that `anchor` any of those facts, because `anchors` propagates both ways

Two variants you'll see:

- `? unlocked  web:new-page  never synced; run starchart lock once it is correct`: a new artifact that has never been locked.
- A code id in `changed:` (for example `symbol:ios/StarchartFacts.AddonPro.Price.usd`): the code value that anchors a fact changed. Fix is the same: handle it, then `starchart ack <artifact>` or `starchart lock <artifact>`.

Symbol hashes are computed from whitespace-normalized declaration text, so reformatting a declaration doesn't make anything stale. File-level hashes use the raw text.

### I fixed the hardcoded constant and now *more* things are stale

Expected. `symbol:ios/Pricing.proUSD` anchors `addon:pro.price.usd`, and `anchors` propagates both ways: the constant is a dependency of every artifact that embeds the price. When you edit it, its hash moves, and those artifacts are flagged again. Once you've confirmed the world matches, `starchart lock`.

Codegen output doesn't cause this any more: `apply` regenerates the `codegen:` targets itself and relocks against the new constants. Running `starchart codegen` by hand after changing a fact (outside `apply`) still moves those symbols' hashes, so lock afterwards.

### Why does `plan` still list items after `apply`?

Because they're still not done. `apply`, `ack` and `lock <ids>` relock only the artifacts they handled and keep the previous value of every fact a still-stale artifact depends on. `plan` is seeded from those changed facts plus the changed dependencies of stale artifacts, and drops artifacts that are already in sync. So after an apply, `plan` and `check` agree: the Stripe price, the store screenshot, the hardcoded constant and the rest stay listed until you `ack` them (or fix the code and `lock`).

```text
$ starchart plan
Change: addon:pro.price  {"usd":4.99,"eur":4.99} → {"usd":5.99,"eur":4.99}
Change: addon:pro.price.usd  4.99 → 5.99
Change: symbol:ios/StarchartFacts.AddonPro.Price.usd  ∅ → 5.99
Change: symbol:web/lib/starchart-facts#ADDON_PRO_PRICE_USD  ∅ → 5.99

  ! manual  appstore:iap/pro-monthly                 mirrors    update in appstore (adapter is read-only)
  …
Plan: 5 manual · 1 review · 2 code · 1 retire · 1 tests
```

The `∅ → 5.99` lines are the constants `apply` just regenerated. A plain `starchart lock` with no ids re-pins everything and clears the list, so only use it once the world really matches.

### `apply` printed `aborted` in CI

Without a TTY the confirmation prompt answers "no" and exits 1. Pass `--yes` in scripts. `--dry-run` never prompts.

### `ack` says "not an artifact"

`ack` only takes world artifacts (`starchart: not an artifact: symbol:ios/Pricing.proUSD`, exit 2). Items classified `code` (a hardcoded constant) or `test` aren't acked: you change the code or run the tests, then relock. Under "Still needs a human", `apply` prints `mark artifacts done with: starchart ack <id…>` for artifacts and a separate `code items: edit the constant, or generate it with starchart codegen` line for code items.

## Bridges and anchors

### Why doesn't my symbol anchor?

Check it with `starchart node <symbol-id>`. If there's no `--anchors-->` line, one of these is usually why:

1. **Wrong id.** Code ids depend on language and scope name:

   | Language | Shape | Example |
   |---|---|---|
   | TS/JS | `symbol:<scope>/<path without extension>#<export>` | `symbol:web/lib/pricing#PRO_PRICE_USD` |
   | Swift | `symbol:<scope>/<Type>.<member>` | `symbol:ios/Pricing.proUSD` |
   | Kotlin | `symbol:<scope>/<Type>.<member>` | `symbol:android/Pricing.PRO_USD` |
   | Go | `symbol:<scope>/<package dir>.<Name>` | `symbol:api/internal/pricing.ProUSD` |

   Rename a scope in `config.yaml` and every code id changes with it. `starchart query --text proUSD` finds the real id. Full rules: [Node IDs](Node-IDs).

2. **The annotation isn't attached to the declaration.** A `// @starchart anchors …` comment annotates, in order: the declaration on the same line (trailing comment); else the next declaration, if only blank or comment lines sit between them; else the innermost declaration that contains it; else the whole file. A line of code between the comment and the constant sends it to the enclosing type or the file. See [Annotations](Annotations).

3. **The target isn't a node id.** Targets must contain a colon (`addon:pro.price.usd`) or a dot (a design-token id like `tokens.color.brand.primary`). Parsing stops at the first token that doesn't look like an id, so `// @starchart anchors the price` anchors nothing (and warns `@starchart anchors has no target node ids`).

4. **Test files.** Annotations in test files attach to the file, never to a symbol.

5. **Check stderr.** Every command prints code-ingest warnings as `warn …` on stderr (hidden with `-q`): unknown verbs, annotations with no target, parse failures, unreadable or oversized files.

   ```text
   warn apps/web/lib/x.ts:2: unknown @starchart edge type "anchor"
   warn apps/web/lib/x.ts:3: @starchart anchors has no target node ids
   ```

   One case is still quiet: an annotation whose target looks like an id but doesn't exist (`// @starchart anchors addon:pro.nope`). The edge is created and leads nowhere; `starchart node <symbol>` shows it.

For a code-authority fact (`authority: code`), the check is louder:

```text
warn fact addon:pro.features: code symbol symbol:ios/Entitlement.proFeatures not found
```

`source.symbol` takes the id with or without the `symbol:` prefix. The symbol's value must be a literal the parser can read: a string, number, boolean, or an array or object of those. See [Code-Authority Facts](Code-Authority-Facts).

### What are these "unknown node" warnings?

They come from edges you declared in YAML whose other end doesn't exist:

```text
warn .starchart/artifacts/web.yaml: route:web/prices --publishes--> web:pricing-page: unknown node "route:web/prices"
```

Usual causes: a typo, a renamed scope, a moved file or route, or a fact you deleted. Code ids are checked after ingestion, so a correct `route:` or `symbol:` id never warns. The edge stays in the graph but leads nowhere, so impact through it is silently lost. Fix the id. `-q` hides warnings, but don't make that a habit.

## Adapters

### Why does Stripe (or App Store) show `manual`?

External writes are opt-in. `canWrite` returns true for `fs` unless `adapters.fs.write: false`, and for every other adapter only when you set `write: true`:

```yaml
adapters:
  stripe:
    secretEnv: STRIPE_SECRET_KEY
    write: true
```

With that, the plan line becomes `~ auto  stripe:price/pro-monthly  mirrors  sync via stripe`, and `starchart adapters` shows `stripe  writes`. Stripe prices are immutable, so apply creates a replacement price, archives the old one, and rewrites the `price:` in your artifact YAML (the journal records the binding edit). It does **not** rewrite price ids hardcoded in your code; those show up as `code` items. `url` can never write.

The App Store adapter only writes listing text fields (description, promotional text, keywords, what's new, name, subtitle): bindings with a `field`. Screenshots and in-app purchase prices stay `manual` even with `adapters.appstore.write: true`, because the adapter says it can't apply them and the planner asks it per artifact. Details: [Adapter: Stripe](Adapter-Stripe), [Adapter: App Store Connect](Adapter-App-Store-Connect).

### `audit` says "skip … credentials missing"

Missing credentials are a skip, not an error, and don't fail the run:

```text
skip  stripe:price/pro-monthly: Stripe secret key not found: set the STRIPE_SECRET_KEY environment variable
skip  appstore:listing/description: App Store Connect credentials missing: ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY_PATH or ASC_PRIVATE_KEY
skip  reel:spring-2026: no adapter "youtube" is registered
```

| Adapter | Credentials |
|---|---|
| `stripe` | env var named by `adapters.stripe.secretEnv` (default `STRIPE_SECRET_KEY`) |
| `appstore` | `keyId`, `issuerId`, `keyPath` in `adapters.appstore`, or env `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY_PATH` / `ASC_PRIVATE_KEY` (the demo sets none of these in config) |
| `url` | none, but relative URLs need `site:` in `config.yaml` |

Config values are **not** environment-interpolated. `keyId: ${ASC_KEY_ID}` is read as that literal string, and a config value wins over the env var. Leave the key out of YAML and set the env var instead.

Break detection (code pointing at archived Stripe prices) also needs the Stripe key, which is why `audit` lists skipped `symbol:` ids. Exit code is 1 only when there are diffs or errors. See [Audit and Break Detection](Audit-and-Break-Detection).

### Audit reports an `error` for my live page

A page the `url` adapter can't fetch (DNS, timeout, connection refused, any HTTP error other than 404/410) is an adapter error, listed under errors, and fails the run (exit 1):

```text
error web:live-pricing [url] https://nebula.example.com/pricing: request failed: fetch failed
```

If you're offline, or the URL is a placeholder like the demo's, that's the reason. Only 404 and 410 count as a `break` diff: the page is really gone.

### Can I add my own adapter or rule pack?

Yes, from the CLI too. List plugin modules in `config.yaml`:

```yaml
plugins:
  - ./starchart/youtube-adapter.mjs   # relative: resolved from the project root
  - starchart-pack-acme               # bare: resolved from the project's node_modules
packs:
  - core
  - acme                              # a plugin pack is enabled by listing its id
```

A module exports `adapters` (each needs an `id` and an `audit()` function) and/or `packs` (each needs an `id` and a `rules` array), named or on the default export. Plugins load once per process in every entry point (CLI, MCP, `serve`, the hook). Load problems are config errors (exit 2), e.g. `plugin "x" not found from <root>; install it or use a relative path` or `plugin "x" exports neither "adapters" nor "packs"`. Built-in packs (`core`, `appstore`, `privacy`, `seo`) can't be replaced. See [Writing an Adapter](Writing-an-Adapter) and [Rule Packs](Rule-Packs).

## Noise

### Why so many impacted items, and how do I cut the noise?

STARCHART already filters hard. Precision over recall:

| Knob | Default | Where |
|---|---|---|
| Consecutive code hops | 4 | `code.maxCodeDepth` in `config.yaml` |
| Minimum confidence | 0.3 | library only (`ImpactOptions.minConfidence`); not in config or CLI |
| Reported code nodes | surface: screens, routes, tests, anchoring symbols | `--all-code` on `impact` shows every code node |
| Info items | hidden | `-v` shows them |

Confidence decays per hop across coarse code edges: `imports` ×0.85, `dependsOn` ×0.7, `references` ×0.95, `readsEnv`/`readsFlag` ×0.9, and symbol-to-file ×0.8. A long chain of imports falls under 0.3 and drops out. Bridge and world edges don't decay.

If it's still loud:

- **Lower `maxCodeDepth`** to 2 or 3 in big codebases where everything imports a shared barrel.
- **Narrow scopes and add `exclude` globs** for generated clients, fixtures and vendored code.
- **Use `describes` sparingly.** Every `describes` edge is a `review` item forever. Prefer `embeds` for literal values.
- **Bind to the most specific fact.** `embeds: [addon:pro.price.usd]` beats `describes: addon:pro`, which fires on every change to the add-on.

Swift, Kotlin and Go references are resolved by name, not by a type-checked index (no SCIP yet), so two types with the same member name can produce an extra `references` edge. TS/JS uses the TypeScript compiler API.

`code.maxCodeDepth` applies to both impact and the lock's dependency walk; the lock records the value so staleness uses the same depth.

## Safety and platforms

### Does it send my code anywhere?

No. There is no telemetry, no hosted service and no LLM. Ingest, discovery, impact, lock, rules, scan, codegen and the viewer run entirely on your machine.

The only outbound network calls come from adapters you bind, and only when you run a command that uses them:

| Adapter | Host | Commands |
|---|---|---|
| `url` | your `site` / binding URL | `audit`, `score --audit` |
| `stripe` | `api.stripe.com` | `audit`, `apply`, `revert`, `orphans --external`, `score --audit` |
| `appstore` | `api.appstoreconnect.apple.com` | `audit`, `apply`, `revert`, `score --audit` |

What they send is API requests about the bound resource (a price id, a listing field), never source code. `starchart serve` binds to `127.0.0.1` unless you pass `--host`. The [GitHub Action](GitHub-Action) posts the markdown blast radius as a PR comment on your own repo.

### Does it work on Windows?

Probably, but it isn't tested there: CI runs on Ubuntu and macOS only. Paths are normalized to forward slashes internally, so node ids are identical across platforms, and `resolveRef` accepts backslash paths. `impact --diff` and `history` need `git` on your `PATH`. The tutorial's `sed -i ''` is macOS syntax; edit the YAML by hand instead. Bug reports welcome.

### Monorepos and scopes?

Built for them. `code.scopes` maps a scope name to a directory:

```yaml
code:
  scopes:
    web: apps/web
    ios: apps/ios
    api: services/api
```

- Scope names prefix every code id (`symbol:web/…`, `route:web/…`), so pick short, stable ones.
- Nested scopes win: a file belongs to the most specific scope that contains it.
- `include` / `exclude` globs match relative to each scope directory (root-relative patterns that start with the scope directory work too).
- With no scopes, the whole repo is one scope named `app`.
- `init` detects scopes up to three levels deep and drops monorepo roots that contain app directories. Generic directory names (`app`, `src`, `client`, `mobile`, …) get their parent prepended, e.g. `apps/mobile` becomes `apps-mobile`.

One `.starchart/` is one chart. Commands walk up from the current directory (or `-C <dir>`) to the nearest `.starchart/`, so separate products in one repo can each have their own. See [Configuration](Configuration) and [Code Ingestion](Code-Ingestion).

### How are generated files handled?

A file with `@starchart generated` in its first five lines is treated as codegen output:

- its anchoring symbols classify as `auto` ("regenerate fact constants (codegen)") instead of `code`, and `apply` regenerates them
- `scan` counts occurrences in it as bound
- `init --discover` ignores its constants

Files STARCHART never reads, whatever you configure: anything under `node_modules`, `dist`, `build`, `.git`, `.next`, `DerivedData`, `Pods`, `.starchart`, plus dotfiles and dot-directories. `.gitignore` is **not** read; use `exclude`. Code files over 2 MB and text files over 1 MB are skipped. See [Codegen](Codegen).

### Which files does `scan` look at?

Your code scope directories by default, or the directories in `content:` if you set it. `init --discover` always scans the whole repo so it can find emails and marketing copy outside your apps. Lockfiles (`package-lock.json`, `Package.resolved`, `starchart.lock`, …) are skipped.

## Positioning

### How is this different from Nx, Bazel or dependency-cruiser?

Those chart **code**. They know `PaywallView.swift` references `Pricing.swift` and which targets to rebuild. They stop at the repo's edge.

STARCHART charts code **and** the facts it encodes **and** the world artifacts that show those facts: pages, OG images, store listings and screenshots, Stripe prices, emails, reels. It doesn't build, cache or run tasks. It isn't a code search engine or a CMS either. It's complementary: keep your build tool, add STARCHART for everything outside it.

### Can I `npx` it?

Yes: `npx @space-pirate-zero/starchart <command>`. Or `npm i -D @space-pirate-zero/starchart` and then `npx starchart <command>` runs your local copy. Never bare `npx starchart` without the local install: the unscoped `starchart` package on npm is not this project, so that fetches someone else's code. See [Getting Started](Getting-Started#install).

### Why exit code 2?

`1` means "the check found something" (`check` stale, `rules` errors, `scan` hits, `audit` diffs or errors, `why` found no path, `apply` aborted or failed, a `revert` step failed) or a usage error such as a `-f` value the command doesn't accept. `2` means STARCHART itself errored: bad YAML, unknown id, not an artifact, no `.starchart/` found. The message is printed as `starchart: <message>` on stderr.

## See also

- [Getting Started](Getting-Started)
- [Impact Analysis](Impact-Analysis)
- [Lockfile and Drift](Lockfile-and-Drift)
- [Annotations](Annotations)
- [Adapters Overview](Adapters-Overview)
