What STARCHART v0.1.0 actually does today, what it doesn't, and where it's headed. Status is honest: "built" means shipped in the code and covered by tests, not "designed". The long-form design lives in [PLAN.md](https://github.com/space-pirate-zero/starchart/blob/main/PLAN.md).

## Built (v0.1.0)

| Area | Status | Notes |
|---|---|---|
| Core: three-layer graph, cross-layer impact with "why" paths, classification, rollout ordering, lockfile drift | ✅ | [Impact Analysis](Impact-Analysis) · [Lockfile and Drift](Lockfile-and-Drift) · [Rollout Ordering](Rollout-Ordering) |
| YAML authoring → graph → JSON-LD; code-authority facts; design tokens (DTCG) | ✅ | [Authoring YAML](Authoring-YAML) · [Code-Authority Facts](Code-Authority-Facts) · [Design Tokens](Design-Tokens) |
| Code layer: TS/JS (TypeScript AST), Swift, Kotlin, Go; Next.js routes; SwiftUI/Compose screens; npm/SwiftPM/Gradle/Go packages; env, flags, events, i18n, tests; `@starchart` annotations; git diff → nodes | ✅ | Tree-sitter-free. Swift, Kotlin and Go references are resolved by name; no SCIP yet. [Code Ingestion](Code-Ingestion) |
| Bridges: literal scanner, edge discovery, `init --discover` | ✅ | Heuristic, no LLM. [Bridges and Discovery](Bridges-and-Discovery) |
| Adapters: fs (read/write/revert), url (audit), Stripe (audit/apply/revert/list), App Store Connect (metadata audit/apply) | ✅ | External writes opt-in via `write: true`, and per binding via `canApply`: App Store screenshots and IAPs stay manual. Stripe and App Store are tested against mocked APIs, never live accounts. [Adapters Overview](Adapters-Overview) |
| Plugins: custom adapters and rule packs loaded from config `plugins:` | ✅ | Works from the CLI, MCP server, `serve` and the hook. [Writing an Adapter](Writing-an-Adapter) · [Rule Packs](Rule-Packs) |
| Engine: audit + break detection, apply with journal (and one codegen pass for generated constants), revert, ack, Future Universe preview | ✅ | [Apply, Revert and Journals](Apply-Revert-and-Journals) |
| Rules engine + packs: core, appstore, privacy (SDK catalog vs `PrivacyInfo.xcprivacy` and labels), seo | ✅ | [Rules Engine](Rules-Engine) · [Rule Packs](Rule-Packs) |
| Orphans, Reality Score + badge, change-cost advisor | ✅ | [Orphans](Orphans) · [Reality Score](Reality-Score) · [Change Cost](Change-Cost) |
| Codegen (TS / Swift / Kotlin), schema.org JSON-LD, time machine (`history`) | ✅ | [Codegen](Codegen) · [JSON-LD and SEO](JSON-LD-and-SEO) · [Time Machine](Time-Machine) |
| Viewer (canvas star chart), `serve`, Reality X-Ray extension (MV3) | ✅ | Extension isn't in any browser store; load it unpacked. [Viewer and Serve](Viewer-and-Serve) · [Reality X-Ray](Reality-X-Ray) |
| MCP server, Claude Code hook, GitHub Action | ✅ | [MCP Server](MCP-Server) · [Claude Code Hook](Claude-Code-Hook) · [GitHub Action](GitHub-Action) |
| npm package | ✅ | `@space-pirate-zero/starchart@0.1.0` published 2026-09-30. `npm i -D @space-pirate-zero/starchart`, then `npx starchart <command>`. [Getting Started](Getting-Started) |
| CI and docs pipeline | ✅ | `ci.yml` (typecheck, test, build on Ubuntu + macOS, then demo `check`); `wiki.yml` publishes `docs/wiki/`. [Contributing](Contributing) |

### Fixed since the first cut

These used to be listed as gaps. They're done:

- **`plan` and `check` agree.** Partial relocks (`apply`, `ack`, `lock <ids>`) keep the old values that still-stale artifacts need, so `plan` keeps listing unfinished work after an apply.
- **Codegen runs inside `apply`.** No more `starchart codegen` before `apply`; generated constants are regenerated once per apply.
- **Per-binding writes.** Adapters can say which bindings they can write (`canApply`). App Store IAPs and screenshots are planned as `manual` and no longer fail at apply time. `cost` only suggests write access where it would help.
- **Ingest warnings in the CLI.** Unknown `@starchart` verbs, parse failures and unreadable files print as `warn …` on stderr (hidden with `-q`).
- **The lock honors `code.maxCodeDepth`.**
- **Plugins load from config.** Custom adapters and packs work from the CLI, not just the library.
- **CI exists.** Typecheck, tests, build and a demo `check` on every PR.

## Known gaps in what's built

Things that exist but have sharp edges today. Each is documented where it bites.

- **Live accounts untested.** The Stripe and App Store adapters are tested against mocked APIs only; they've never run against a live account.
- **No incremental cache.** Every command re-ingests the repo.
- **App Store audit over-reports coverage.** Bindings without a `field` (IAPs, screenshots) are counted as "checked" in `audit` even though nothing is compared.
- **`orphans --external`** only works for Stripe (the only adapter with `list()`).
- **Discovery noise.** Partial `init --discover` runs can propose spurious edges from name matching.
- **No-op markers.** `@starchart id` and `@starchart ignore` annotations are accepted without a warning but do nothing.
- **Rule gaps.** The `env-unused` rule needs `meta.declaredOnly`; `maxAge` can't express "expires within N days"; `reachable` looks one hop only; duplicate rule ids between packs and `rules.yaml` aren't detected; each `*.xcprivacy` must declare every iOS SDK data type on its own.
- **Lifecycle.** An entity's `validThrough` doesn't trigger `retire` on its artifacts (artifact `validThrough` does).
- **JSON-LD `@id`s** use raw node ids, not URLs.
- **`minConfidence` isn't configurable** from config or CLI.
- **Windows** isn't in the CI matrix (Ubuntu and macOS are).

## Not built yet

Straight from PLAN.md's build status:

- **SCIP precise indexing** (symbols keyed by moniker, so refactors keep their edges)
- **Adapters:** Play Store, RevenueCat, PostHog, YouTube, Figma
- **Screenshot pixel drift** against published store images
- **LLM semantic claim checking** for `describes` artifacts, and LLM-assisted discovery
- **Release choreography** with approval-webhook gates
- **A hosted registry** for rule packs
- **VS Code / Xcode extensions**

Also designed in PLAN.md but not in the CLI today: `whatif` pre-flight, task sinks (GitHub Issues / Linear), reality tests and synthetic monitoring, natural-language "ask the chart", and outcome attribution on the time machine.

## Phases

The phase plan from PLAN.md, with where v0.1.0 actually landed:

| Phase | Deliverable | Demo moment | Status |
|---|---|---|---|
| 0: Chart the stars | Vocabulary, YAML schema, JSON-LD context; hand-model one real app with a paid tier | "Here's the whole universe of the Pro add-on" | ✅ Done. `examples/pro-universe`. |
| 1: Code layer | Core, code + lockfile ingest, Next.js routes, annotations, `impact --diff`, lockfile, `check` | A Swift diff flags the pricing page | ✅ Done, without tree-sitter. |
| 2: Bridge + reality | SCIP (TS), `authority: code`, url/stripe/appstore adapters, `audit` + break detection, GitHub Action | PR comment: "invalidates 76 screenshots"; the archived Stripe price gets caught | 🟡 Mostly. Everything except SCIP. TS uses the TypeScript compiler API instead. |
| 3: Fix | `apply`, codegen (TS/Swift/Kotlin), renderers, lifecycle, task sinks | One command updates code constants, site, OG, JSON-LD, strings | 🟡 Mostly. `apply`, codegen, OG/JSON-LD rendering and `validThrough` retire are in; task sinks aren't. |
| 4: Magic | Discover, MCP + Claude Code hook, invariants, Reality Score, orphans, viewer | "Point it at the repo and it drew the chart" | ✅ Done. Discovery is heuristic only. |
| 5: Signature | Reality X-Ray, Future Universe, privacy drift, screenshot drift | The GIF that goes viral | 🟡 Mostly. X-Ray (load-unpacked only), Future Universe and privacy drift are in; screenshot pixel drift isn't. |
| 6: Open waters | Rule packs + registry, transactions, time machine, community ingestors/adapters | Apple adds a screenshot size and every chart knows | 🟡 Started. Built-in packs, plugin loading for adapters and packs, journaled apply/revert and `history` exist; the registry and community packs don't. |

## What's next

A suggested order, derived from the gaps above. It's not a committed schedule:

1. Run the Stripe and App Store adapters against real test accounts.
2. Incremental ingest with a content-hash cache, to hit the "under 1 s warm, under 5 s in CI" targets.
3. SCIP ingest, TypeScript first.
4. Play Store and RevenueCat adapters.
5. Screenshot drift.

Want one of these sooner? [Open an issue](https://github.com/space-pirate-zero/starchart/issues) or send a PR: [Contributing](Contributing).

## See also

- [Architecture](Architecture)
- [Contributing](Contributing)
- [FAQ and Troubleshooting](FAQ-and-Troubleshooting)
- [Home](Home)
