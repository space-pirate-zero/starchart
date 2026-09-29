# STARCHART — Plan

> **Every dependency. Code to cosmos.**
> A graph that ties your code to everything it touches in the real world: website, App Store, Stripe, OG images, promo reels. Change one star and STARCHART lights up every star it drags with it.

**Name:** STARCHART, a Space Pirate Zero open source project. A pirate's map of your whole universe.
**CLI:** `starchart` (alias `sc`) · **Package:** `@spz/starchart` (the unscoped `starchart` is taken on npm) · **Vocab prefix:** `sc:`
**Alt names considered:** SHOCKWAVE (a change ripples outward), CHAINSHOT (linked cannonballs = linked deps; free on npm), TRIPWIRE (drift trips CI; taken on npm), DEADRECKON.
**Avoids collisions with the fleet:** BLACKBOX, WARPCORE, FOUNDRY, PHANTOM, WARROOM, HOLODECK, SIXSIGMA, SIGNALS, IRONCLAD, PULSE, CORTEX, VAULT, BRIDGE, GHOSTDECK, DARKWAVE.

---

## 0. Build status (v0.1.0, 2026-09-29)

**Built and tested** (278 tests, including an end-to-end suite that runs the CLI against `examples/pro-universe`):

| Area | Status |
|---|---|
| Core: three-layer graph, cross-layer impact with "why" paths, classification, rollout ordering, lockfile drift | ✅ |
| YAML authoring → graph → JSON-LD; code-authority facts; design tokens (DTCG) | ✅ |
| Code layer: TS/JS (TypeScript AST), Swift, Kotlin, Go; Next.js routes; SwiftUI/Compose screens; npm/SwiftPM/Gradle/Go packages; env, flags, events, i18n, tests; `@starchart` annotations; git diff → nodes | ✅ tree-sitter-free; name-based resolution for Swift/Kotlin/Go (SCIP not yet) |
| Bridges: literal scanner, edge discovery, `init --discover` | ✅ heuristic, no LLM |
| Adapters: fs (read/write/revert), url (audit), Stripe (audit/apply/revert/list), App Store Connect (metadata audit/apply) | ✅ external writes opt-in via `write: true` |
| Engine: audit + break detection, apply with journal, revert, ack, Future Universe preview | ✅ |
| Rules engine + packs: core, appstore, privacy (SDK catalog vs PrivacyInfo.xcprivacy and labels), seo | ✅ |
| Orphans, Reality Score + badge, change-cost advisor | ✅ |
| Codegen (TS / Swift / Kotlin), schema.org JSON-LD, time machine (`history`) | ✅ |
| Viewer (canvas star chart), `serve`, Reality X-Ray extension (MV3) | ✅ extension not yet store-published |
| MCP server, Claude Code hook, GitHub Action | ✅ |

**Not built yet:** SCIP precise indexing, Play Store / RevenueCat / PostHog / YouTube / Figma adapters, screenshot pixel-drift against published store images, LLM semantic claim checking and LLM-assisted discovery, Release choreography with approval-webhook gates, a hosted registry for rule packs, and VS Code / Xcode extensions.

---

## 1. The problem

Code has dependency graphs. The world around your code doesn't, and **nothing connects the two.**

- `dependency-cruiser`, Nx and Bazel know `Paywall.swift` imports `Pricing.swift`. They have no idea that App Store screenshot #3 shows that paywall, that the website says "$4.99", or that a promo reel burned that price into a video.
- Marketing tools know the website. They have no idea that `ProductID.proMonthly` in the iOS app has to match an App Store IAP, a Stripe price and a RevenueCat entitlement.

So you change the Pro add-on and then play whack-a-mole across code, copy, stores, images and video. Something always gets missed.

**STARCHART is one graph with three layers (code, facts and world) and bridges between them.** Change anything on any layer and it traverses every layer to show the full blast radius. Then it fixes what it can and tickets the rest.

---

## 2. The three-layer model

```
            ┌───────────────────────────── WORLD ─────────────────────────────┐
            │ website pages · OG images · App Store listing + screenshots     │
            │ Stripe prices · RevenueCat · promo reels · emails · JSON-LD     │
            └───────────────▲───────────────────────────────▲─────────────────┘
                            │ embeds / renders / describes  │ mirrors
            ┌───────────────┴──────────── FACTS ────────────┴─────────────────┐
            │ addon:pro.name · addon:pro.price · addon:pro.features · ids     │
            └───────────────▲───────────────────────────────▲─────────────────┘
                            │ anchors (bridge edges)        │ codegen
            ┌───────────────┴──────────── CODE ─────────────┴─────────────────┐
            │ packages · modules · symbols · routes · screens · flags · env   │
            │ i18n keys · analytics events · DB enums · tests                 │
            └─────────────────────────────────────────────────────────────────┘
```

| Primitive | What it is | Example |
|---|---|---|
| **Fact** | An atomic canonical value. | `addon:pro.price.usd = 5.99` |
| **Entity** | A thing that owns facts. | `addon:pro`, `feature:themes`, `campaign:spring-2026` |
| **Code node** | Anything extracted from source. | `symbol:ios/ProductID.proMonthly`, `screen:ios/Paywall`, `route:web/pricing`, `pkg:npm/stripe` |
| **Artifact** | A thing in the world. | `web:pricing-page`, `appstore:screenshots/6.7/03`, `reel:spring-2026` |
| **Edge** | A typed relationship, on one layer or across layers. | see below |

### Edge types

**Code layer** (extracted automatically, never hand-written):

| Edge | Meaning |
|---|---|
| `imports` | module → module |
| `references` | symbol → symbol (call, type use, read) |
| `dependsOn` | package → package (from lockfiles) |
| `tests` | test → symbol / screen |
| `serves` | route → handler / page component |
| `readsEnv` / `readsFlag` | code → env var / feature flag |

**Bridge layer** (code ↔ facts ↔ world — the whole point):

| Edge | Meaning | Example |
|---|---|---|
| `anchors` | A code node *is* a fact's in-code value. | `ProductID.proMonthly = "pro_monthly"` anchors `addon:pro.productId` |
| `displays` | A screen/route visually shows facts or UI. | `screen:ios/Paywall` displays `addon:pro.price` |
| `captures` | A world artifact is a picture/recording of a screen or route. | `appstore:screenshots/6.7/03` captures `screen:ios/Paywall` |
| `publishes` | A route becomes a world artifact. | `route:web/pricing` publishes `web:pricing-page` |
| `emits` | Code sends an event/ID a world system depends on. | `track("pro_purchased")` emits to `posthog:dashboard/revenue` |

**World layer:**

| Edge | Meaning | On change |
|---|---|---|
| `embeds` | Artifact literally contains the fact value. | Auto-fix |
| `renders` | Artifact generated from template + facts. | Auto-regenerate |
| `describes` | Artifact talks about it semantically. | Review (human/AI) |
| `promotes` | Marketing asset for an entity/offer. | Review / retire |
| `mirrors` | External system must hold the same value. | Sync via adapter |
| `derivedFrom` | B is built from A. | Transitively stale |
| `after` / `blocks` | Ordering constraint. | Drives rollout order |

---

## 3. Code intelligence: how STARCHART reads code

> **As built (v0.1):** TS/JS is parsed with the TypeScript compiler API; Swift, Kotlin and Go use purpose-built lexers with name-based reference resolution. SCIP and tree-sitter below remain the plan for precise cross-file resolution. See the [Code Ingestion](https://github.com/space-pirate-zero/starchart/wiki/Code-Ingestion) wiki page.

Don't reinvent code analysis. Stand on proven indexers and normalize them into the graph.

| Source | Tool | Gives us |
|---|---|---|
| Symbols + references, any language | **SCIP** indexes (scip-typescript, scip-go, scip-java/kotlin, scip-python, scip-rust; Swift via SourceKit-LSP → SCIP) | Precise cross-file symbol graph |
| Fast fallback / unindexed langs | **tree-sitter** queries | Imports, string literals, constants, decorators |
| Packages | Lockfiles: `pnpm-lock`, `package-lock`, `Package.resolved`, Gradle version catalogs, `go.sum`, `Cargo.lock` | Package dependency graph |
| Routes | Next.js App Router file tree, Express/Hono/NestJS decorators | `route:` nodes |
| Screens | SwiftUI `View` types, Compose `@Composable` screens, React page components | `screen:` nodes |
| i18n | `.strings`/`.xcstrings`, Android `strings.xml`, i18n JSON | String keys → values → locales |
| Flags / env | PostHog/LaunchDarkly SDK calls, `process.env`, `.env.example`, Secret Manager refs | `flag:` / `env:` nodes |
| Analytics | `track()`/`capture()` call sites | `event:` nodes |
| DB | Prisma/Drizzle schema, SQL migrations | tables, enums |

**Incremental:** re-index only changed files on each commit. Cache by content hash. Target: under 5 seconds on a mid-size monorepo for a typical PR.

### Bridging: how code connects to the world

The hard, valuable part. Four mechanisms, from most precise to most magical:

1. **Codegen (graph → code) — the gold standard.** STARCHART generates typed constants from facts:
   ```ts
   // generated: @spz/starchart-facts (TS)  ·  StarchartFacts.swift  ·  StarchartFacts.kt
   export const PRO = { name: "Pro+", price: { usd: 5.99 }, productId: "pro_monthly" } as const;
   ```
   Code imports facts instead of hardcoding them. The bridge edge comes for free and is exact. Change the fact and the code updates; the type checker covers the rest.

2. **Annotations (code → graph).** Mark the anchor in place:
   ```swift
   // @starchart anchors addon:pro.productId
   static let proMonthly = "pro_monthly"
   ```
   ```ts
   export default function PricingPage() {} // @starchart publishes web:pricing-page
   ```

3. **Extraction with authority: code.** The fact's source of truth *is* the code, and STARCHART reads it via selector:
   ```yaml
   addon:pro.features:
     authority: code
     source: { adapter: scip, symbol: "ios/Entitlements.proFeatures" }
   ```
   Add a feature to that array in a PR, and the website copy, App Store description and screenshots all flag stale.

4. **Auto-discovery (heuristic + AI).** Scan for string literals that match known world IDs (Stripe `price_…`, ASC product IDs, RevenueCat entitlements, routes, event names) and propose `anchors` edges with confidence scores. Nothing enters the graph without acceptance in a PR.

---

## 4. Authoring format: YAML in, JSON-LD out

- **Author** in YAML (or `starchart.config.ts`) under `.starchart/`, committed to the repo and reviewed in PRs.
- **Code-layer nodes are never authored.** They're extracted, and only bridges and world artifacts are declared.
- **Compile** to JSON-LD, using the schema.org vocabulary (`SoftwareApplication`, `SoftwareSourceCode`, `Offer`, `WebPage`, `ImageObject`, `VideoObject`, `validThrough`) plus the `sc:` namespace for bridge and code edges.
- **No RDF tooling in core.** JSON-LD is the export/interchange boundary. Internally it's a plain in-memory graph.

```yaml
# .starchart/entities/pro.yaml
id: addon:pro
type: [schema:Offer, sc:AddOn]
of: app:main
facts:
  name: "Pro+"
  price: { usd: 5.99, eur: 5.99, gbp: 4.99 }
  productId: { value: pro_monthly, authority: appstore }
  features: { authority: code, source: { symbol: "ios/Entitlements.proFeatures" } }
  status: active
```

```yaml
# .starchart/artifacts/appstore.yaml
- id: appstore:iap/pro_monthly
  binding: { adapter: appstore, app: com.spz.app, iap: pro_monthly }
  mirrors: [addon:pro.price, addon:pro.name]

- id: appstore:screenshots/6.7/03
  type: schema:ImageObject
  binding: { adapter: appstore, set: "6.7", index: 3, locales: all }
  captures: screen:ios/Paywall        # ← bridge: UI code change = stale screenshot
  embeds: [addon:pro.price.usd]
```

---

## 5. The engine: change propagation across layers

1. **Change enters from any layer:**
   - Code: a PR diff touches symbols → map hunks to code nodes via SCIP ranges
   - Fact: a YAML edit
   - World: a webhook/watcher (a Stripe price was archived in the dashboard)
2. **Traverse** reverse edges across all three layers, transitively. Each hop carries its edge type, so the path explains *why* something is impacted.
3. **Classify:** `auto` · `review` · `manual` · `retire` · `break` (world state now incompatible with code, e.g. code references an archived Stripe price)
4. **Order:** topological sort with `after`/`blocks` (Stripe → RevenueCat → App Store → *wait for Apple* → app release → website → email).
5. **Plan** (`starchart plan`) → **Apply** (`starchart apply`) → **Lock** (`starchart.lock` pins every artifact to the fact versions *and code content hashes* it was built from).

### Example: a code change

```
$ starchart impact --diff origin/main

PR touches: ios/Features/Paywall/PaywallView.swift  (layout: price moved above CTA)
            ios/Core/Entitlements.swift             (+ feature:widgets)

CODE     screen:ios/Paywall                         modified
FACT     addon:pro.features                         [themes, sync] → [themes, sync, widgets]   (authority: code)

  ! manual  appstore:screenshots/6.7/03 (38 locales)  captures screen:ios/Paywall    UI changed; re-shoot
  ! manual  appstore:screenshots/6.1/03 (38 locales)  captures screen:ios/Paywall
  ~ auto    appstore:listing/description (38)         embeds  addon:pro.features   add "Widgets"
  ~ auto    web:pricing-page                          embeds  addon:pro.features   feature table +1 row
  ~ auto    web:jsonld/offer-pro                      renders addon:pro.features
  ? review  web:landing-hero                          describes addon:pro
  ? review  reel:spring-2026                          captures screen:ios/Paywall  old paywall on screen
  ✓ tests   ios/PaywallSnapshotTests                  tests   screen:ios/Paywall   run these

Why is reel:spring-2026 impacted?
  PaywallView.swift → screen:ios/Paywall → captures ← reel:spring-2026
```

### Example: a world change

```
$ starchart audit

✗ break   stripe:price/price_1Pro499 is ARCHIVED
          ← anchors  web/lib/stripe.ts:12  PRICE_PRO_MONTHLY
          ← references web/app/api/checkout/route.ts:31
          Checkout for Pro is broken in production.
```

---

## 6. Features

> The checkboxes below are the original plan. What actually shipped in v0.1 is tracked in [§0 Build status](#0-build-status-v010-2026-09-29).

### v0.1: "It sees" (the code layer and the bridge)
- [ ] Graph core: nodes/edges, traversal, path explanation, lockfile
- [ ] Code ingest: tree-sitter (TS/JS, Swift, Kotlin, Go) + lockfiles + Next.js routes
- [ ] SCIP ingest for TS (precise symbols)
- [ ] YAML authoring + JSON Schema, compiled to JSON-LD
- [ ] Bridges: annotations (`@starchart anchors|publishes|displays`) + `authority: code` extraction
- [ ] `starchart impact <node|--diff>` across layers, with a "why" path
- [ ] `starchart plan` / `starchart check` (CI drift gate)
- [ ] Literal scanner: flags unbound occurrences of fact values in code and content

### v0.2: "It checks the real world"
- [ ] Adapter SDK (read / diff / write / watch)
- [ ] Adapters: `fs`, `url` (live site crawl), `stripe`, `appstore`, `playstore`, `revenuecat`, `posthog`
- [ ] `starchart audit`: graph vs live systems, including `break` detection (code → dead world IDs)
- [ ] GitHub Action: a PR comment with the cross-layer blast radius
- [ ] Task sink: GitHub Issues (WARROOM-compatible labels) / Linear

### v0.3: "It fixes things"
- [ ] `starchart apply`: dry-run, per-step confirm, rollback where supported
- [ ] Codegen: facts → TS / Swift / Kotlin constants packages
- [ ] Renderers: OG images (Satori), JSON-LD blocks, i18n string files
- [ ] Localization fan-out, lifecycle (`validThrough`, retire sweeps), per-node `owners:`
- [ ] SCIP for Swift/Kotlin/Go/Python; screens for SwiftUI/Compose

### v0.4: "It's everywhere"
- [ ] MCP server (`impact`, `plan`, `apply`, `audit`, `explain`, `why`)
- [ ] VS Code / Xcode source-editor extension: hover a constant and see the world artifacts it feeds
- [ ] Web viewer: a three-layer graph (a literal star chart) with impact highlighting and a time scrubber
- [ ] Adapters: Figma, Canva, YouTube, TikTok, Notion, Klaviyo, Sanity/Contentful, Google Secret Manager

---

## 7. Super-killer features

### 🔥 1. Cross-layer blast radius on every PR
A code PR gets a comment: *"This PR changes 2 Swift files. Off-code, it invalidates 76 App Store screenshots, 1 promo reel, the pricing page feature table and 38 localized store descriptions."* Nobody else bridges a code diff to marketing reality.

### 🔥 2. Screenshot drift detection (code ↔ pixels)
`captures` edges link store screenshots and reels to real screens. STARCHART renders the current screen (snapshot tests / Playwright / XCUITest), perceptual-diffs it against the published screenshot, and flags *"App Store screenshot 3 shows a UI that no longer exists."* Then it can re-shoot via fastlane snapshot plus a frame template and push.

### 🔥 3. Facts as code (codegen)
One YAML fact becomes typed constants in TS, Swift and Kotlin. Prices, product IDs, feature lists and entitlement names are never hardcoded again, so the compiler becomes part of your marketing QA.

### 🔥 4. Break detection: the world broke your code
Stripe price archived, ASC product removed, feature flag deleted in PostHog, route deleted but still linked from emails. STARCHART finds code and content that point at dead world IDs *before* customers do.

### 🔥 5. Zero-config discovery
`starchart init --discover` indexes the repo, crawls the site, pulls the App Store listing and Stripe catalog, matches IDs and literals across them, and opens a PR with the proposed graph. The chart draws itself; you just approve the stars.

### 🔥 6. `whatif`: pre-flight a decision
`starchart whatif addon:pro.price=6.99` or `starchart whatif --delete screen:ios/Onboarding`. You get artifacts touched, manual hours, Apple review gates, affected tests, and the owners who need to sign off, before you commit to anything.

### 🔥 7. Lockfile drift = build failure
`starchart.lock` pins every artifact to fact versions *and* code hashes. Stale copy fails CI like a type error: a build system for marketing.

### 🔥 8. Semantic claim checking
An LLM reads `describes` artifacts and checks claims against facts *and code*. For example, "Landing page says 'offline sync'" when `feature:sync` is gated behind `flag:sync_v2 = off`.

### 🔥 9. Releases as choreographed launches
Bundle changes into a Release, and STARCHART builds the rollout DAG across code and world: merge → TestFlight → Stripe → RevenueCat → ASC submit → *wait for approval webhook* → app release → flip website → send email → retire old reels. Each step is gated and resumable.

### 🔥 10. Agent-native (MCP)
"Bump Pro to $5.99 and add Widgets." The agent calls `impact`, gets the three-layer plan, opens a code PR (codegen + tests), regenerates OG and JSON-LD, drafts the ASC metadata, and files WARROOM tickets for the re-shoots. STARCHART is the agent's map of the whole universe, not just the repo.

### 🔥 11. Free SEO structured data
The graph is already schema.org. `starchart emit jsonld --route /pricing` produces the exact `Offer`/`SoftwareApplication` blocks, and a Next.js helper injects them at build time.

### 🔥 12. Test impact analysis as a side effect
You already have symbol → screen → test edges, so STARCHART tells CI exactly which tests a PR needs, and which *world checks* (audits, screenshot diffs) to run.

---

## 7b. World-class tier

What turns a clever tool into the thing every product team installs:
- **instant value** — impressive in the first 60 seconds with zero config
- **trust** — never cries wolf
- **network effects** — gets better as more people use it
- **built for agents** — useful to AI coding agents, not just humans

### 🌌 A. Reality X-Ray (browser extension + overlay)
Browse your own website, App Store page, or Stripe checkout and every element lights up with its binding: green = in sync, red = stale, grey = unbound. Click an element to jump to its fact, its code anchor, and its owner. This is the demo that sells the whole project in one GIF, and it works on the live App Store page, where you can't instrument anything.

### 🌌 B. Future Universe preview
`starchart preview --release pro-plus` renders the world *as it will look after the change*:
- the pricing page as a preview deploy
- regenerated OG images
- a mock App Store listing with the new screenshots and description
- the paywall snapshot
- the email render

You get one shareable link to approve the whole release. Nobody approves a YAML diff; everyone approves a picture.

### 🌌 C. Privacy and compliance drift (the one that saves you from Apple and lawyers)
Code layer: a PR adds the Sentry SDK, which collects device IDs, or a new `track()` call that sends an email address.
World layer: the App Store privacy label, `PrivacyInfo.xcprivacy`, Info.plist usage strings, Play Data Safety form, privacy policy, and cookie banner.
STARCHART bridges the SDK's data collection (from a community rule pack per SDK) to every disclosure that now lies. **"This PR makes your App Store privacy label false."** This is a real legal risk, it causes real rejections, and no tool catches it today.

### 🌌 D. Invariants: ESLint for your business
Declarative rules over the graph, run in CI and on a schedule:
```yaml
rules:
  - every: sc:Offer
    must: { mirroredIn: [stripe, appstore, playstore], sameValue: price }
  - every: feature where tier = pro
    must: { describedBy: web:pricing-page }
  - every: sc:PromoAsset
    must: { maxAge: 90d, promotes: { status: active } }
  - every: screen in flow:onboarding
    must: { capturedBy: appstore:screenshots, locales: all }
```
Rules turn "we forgot" into "CI caught it". They're shareable, composable, and versioned.

### 🌌 E. Rule packs + the Starchart Registry (network effect)
Community-maintained packs that encode the rules of the outside world:
- `@starchart/pack-appstore`: screenshot sizes per device, character limits, required subscription disclosure text, review guideline checks
- `@starchart/pack-playstore`, `pack-stripe`, `pack-gdpr`, `pack-seo` (OG sizes, meta lengths, JSON-LD validity)
- SDK packs: `pack-sdk-sentry`, `pack-sdk-posthog`, `pack-sdk-firebase`, each declaring what data the SDK collects

When Apple adds a new required screenshot size, one pack update tells *every* STARCHART user exactly which screenshot sets they're missing. Vendors can publish their own world-facing surfaces, so a RevenueCat API deprecation shows up as impact in your chart. **Every user makes everyone's chart smarter.**

### 🌌 F. Universe transactions: atomic release + rollback
A Release is a saga across external systems, with a compensating action per step. `starchart revert pro-plus` rolls back the Stripe price, RevenueCat offering, website, OG, JSON-LD, and ASC metadata together, in reverse topological order. Rollback exists for code, but nobody has it for the world.

### 🌌 G. Coupling heatmap and change-cost advisor
STARCHART learns from history (how long manual items actually took) and scores every fact:
> `addon:pro.price` is embedded in 14 places, 9 of them hardcoded or burned into media. Change cost ≈ 6.5 hrs. Moving the paywall to codegen and templating the OG image cuts it to 20 min.

It's architecture advice for your whole business, not just your code, and a heatmap view shows the brittlest facts glowing.

### 🌌 H. Reality tests + synthetic monitoring
Tests that assert world state, running hourly like uptime checks:
```ts
test("App Store shows the real Pro price", async ({ world, fact }) => {
  expect(await world("appstore:iap/pro_monthly").price("US")).toBe(fact("addon:pro.price.usd"));
});
```
Someone edits the site CMS directly or Apple flips a price tier, and you get paged. It's Playwright for reality.

### 🌌 I. Agent hooks: impact as live context for coding agents
- A Claude Code `PostToolUse` hook runs `starchart impact` on every file an agent edits and injects the result back into context: *"You just changed `Entitlements.swift`. This affects the pricing page, 38 store descriptions, and screenshot set 03."*
- The agent fixes the downstream code/content in the same session, and files WARROOM tickets for the manual items.

This turns every coding agent from repo-blind to universe-aware. Few tools give agents this kind of context today.

### 🌌 J. Time machine + outcome attribution
The graph is versioned per commit, and world snapshots are taken on each audit. Ask:
- "What did the App Store listing, pricing page, and paywall look like on June 3?"
- Overlay PostHog/revenue metrics on the change timeline: *"Conversion −12% two days after `web:landing-hero` copy changed."*

This turns STARCHART from a hygiene tool into a growth tool, and it feeds SIGNALS.

### 🌌 K. Orphans / dead stars
The reverse of impact: things in the world that nothing depends on anymore.
- Stripe prices no code sells
- IAPs no build references
- CDN images no page uses
- feature flags stuck at 100%
- env vars nothing reads
- promo reels for dead offers

It's cleanup, cost savings, and less attack surface, from one command: `starchart orphans`.

### 🌌 L. Design token bridge: rebrand blast radius
DTCG tokens → code → OG templates, screenshot frames, app icons, reels, and email templates. Change `color.brand.primary` and see every asset that's now off-brand. That's the full rebrand plan generated in one second, and it pairs natively with the NEON/PHOSPHOR/LEOPARD systems.

### 🌌 M. Reality Score badge
One number, like test coverage: **% of world facts that are bound, in sync, and fresh.** Show it as a README badge (`reality 97%`) and a trend line in the viewer. It's a shareable, competitive number, which is free marketing for an OSS project.

### 🌌 N. Ask the chart
Natural language over the graph, backed by a real query engine so answers are exact and never hallucinated:
> "What still says $4.99?" · "What breaks if we kill the Pro annual plan?" · "Who owns everything the onboarding flow touches?" · "Which screens have no store screenshot in Japanese?"

### World-class non-negotiables (the craft bar)
- **60-second wow:** `npx @spz/starchart init --discover` against a real repo shows cross-layer impact before any YAML is written.
- **Precision over recall:** every impact line has a *why* path and a confidence score, and low-confidence items are collapsed. One false alarm a week and people uninstall.
- **Fast:** under 1s `impact` on a warm cache and under 5s on a PR in CI. The core graph can be ported to Rust later if needed.
- **Single binary + zero infra:** no server or database required. A hosted mode is optional later.
- **Beautiful viewer:** the three-layer star chart *is* the brand. NEON design system, cel-shaded, zoomable galaxies of code → facts → world.
- **Docs with a real example universe:** a public demo app with iOS, web, Stripe, and a full chart that anyone can clone and break.

### Priority cut

| Tier | Features | Why |
|---|---|---|
| **Must, for launch credibility** | I (agent hooks), D (invariants), M (Reality Score), K (orphans) | Cheap on top of the core, immediately useful, spreads virally |
| **Signature, what people tweet** | A (X-Ray), B (Future Universe), C (privacy drift) | Demo-able, unique, solve real pain |
| **Moat, what makes it hard to copy** | E (rule packs + registry), F (transactions), J (time machine) | Network effects and deep integration |
| **Later** | G, H, L, N | Great, but they build on the moat |

---

## 8. Architecture

> **As built (v0.1):** one package, `packages/starchart`, with these areas as directories under `src/` (see the [Architecture](https://github.com/space-pirate-zero/starchart/wiki/Architecture) wiki page), plus `packages/xray` and `action/`. The multi-package split below is the target once APIs settle.

TypeScript monorepo (pnpm + turborepo). Git is the database. Nothing is written to the outside world without `apply`.

```
packages/
  core/            graph, traversal, "why" paths, classification, topo order, lockfile
  schema/          JSON Schema + zod, JSON-LD @context, sc: vocabulary
  compiler/        YAML/TS config → graph → JSON-LD
  code/
    treesitter/    fast extraction: imports, literals, constants, annotations
    scip/          precise symbol graph from SCIP indexes
    lockfiles/     npm/pnpm, SwiftPM, Gradle, Go, Cargo
    frameworks/    Next.js routes, SwiftUI/Compose screens, NestJS/Hono, Prisma/Drizzle
    diff/          git diff hunks → code nodes
  bridge/          annotations, authority:code extraction, ID/literal matching, discovery
  codegen/         facts → TS / Swift / Kotlin
  adapter-sdk/
  adapters/        fs url stripe appstore playstore revenuecat posthog github linear figma youtube …
  renderers/       satori (OG), jsonld, i18n strings, screenshot frames
  visual/          screen render + perceptual diff vs published screenshots
  cli/             starchart init|impact|plan|apply|check|audit|whatif|why|emit|graph
  mcp/             MCP server
  action/          GitHub Action
  viewer/          three-layer web graph explorer
```

Key decisions:
- **Extract code, author the world.** Code nodes are always derived and never hand-maintained.
- **Stable IDs:** `layer:scope/name` (for example `symbol:ios/Entitlements.proFeatures`). Symbols are keyed by SCIP moniker, so refactors keep their edges.
- **Fact authority** (`graph | code | stripe | appstore | …`) prevents sync loops and settles who wins.
- **Secrets never touch the graph.** Adapters pull credentials from env / Google Secret Manager.
- **Capabilities per adapter:** `read`, `write`, `dryRun`, `rollback`, `watch`.

```ts
interface Adapter<B extends Binding> {
  id: string;
  capabilities: { read: true; write?: boolean; dryRun?: boolean; rollback?: boolean; watch?: boolean };
  read(binding: B, ctx: Ctx): Promise<Observed>;
  diff(binding: B, expected: FactValues): Promise<Diff[]>;
  write?(binding: B, diff: Diff[], ctx: Ctx): Promise<ApplyResult>;
  watch?(binding: B, onChange: (o: Observed) => void): Unsubscribe;
}

interface CodeIngestor {
  id: string;                                   // "scip-typescript", "treesitter-swift"
  languages: string[];
  ingest(files: FileSet, prev?: Snapshot): Promise<CodeGraphDelta>;  // incremental
}
```

---

## 9. Roadmap

| Phase | Weeks | Deliverable | Demo moment |
|---|---|---|---|
| 0: Chart the stars | 1 | Vocabulary, YAML schema, JSON-LD context; hand-model one real SPZ app with a paid tier | "Here's the whole universe of the Pro add-on" |
| 1: Code layer | 3 | core, tree-sitter + lockfile ingest, Next.js routes, annotations, `impact --diff`, lockfile, `check` | A Swift diff flags the pricing page |
| 2: Bridge + reality | 4 | SCIP (TS), `authority: code`, url/stripe/appstore adapters, `audit` + break detection, GitHub Action | PR comment: "invalidates 76 screenshots"; the archived Stripe price gets caught |
| 3: Fix | 4 | `apply`, codegen (TS/Swift/Kotlin), renderers, lifecycle, task sinks | One command updates code constants, site, OG, JSON-LD, strings |
| 4: Magic | 4+ | discover, MCP + Claude Code hook (I), invariants (D), Reality Score (M), orphans (K), viewer | "Point it at the repo and it drew the chart" |
| 5: Signature | 6+ | Reality X-Ray (A), Future Universe (B), privacy drift (C), screenshot drift | The GIF that goes viral |
| 6: Open waters | ongoing | Rule packs + registry (E), transactions (F), time machine (J), community ingestors/adapters | Apple adds a screenshot size and every chart knows |

**Dogfood:** one real SA9 app with a paid tier (iOS + web + Stripe/RevenueCat) is the integration fixture from day one.

---

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Modeling burden | Code layer is 100% extracted; discovery proposes bridges; value from a 10-node chart on day one |
| Code indexing is slow or language-spotty | tree-sitter fallback everywhere, SCIP where available, incremental hashing |
| Noisy impact (everything depends on everything) | Edge-typed traversal with depth/type filters; bridge edges required to cross layers; confidence scores |
| Writing to Stripe/ASC is dangerous | plan/apply, dry-run, write opt-in per adapter, owner approvals, audit log |
| Scope creep into a CMS or a code search engine | STARCHART never hosts content or replaces Sourcegraph. It only charts relationships and staleness |
| JSON-LD/RDF scares contributors | YAML-first; JSON-LD is an export only |

---

## 11. Open questions

1. Can we claim the `@spz` npm scope, or should we go unscoped as `chainshot` / a `starchart-cli` package?
2. License: Apache-2.0 for core (patent grant) vs MIT?
3. Swift SCIP: rely on SourceKit-LSP → SCIP conversion, or ship tree-sitter-only Swift in v0.1?
4. Screenshot drift: compare against the ASC API's published images, or against a local golden set?
5. Should `starchart.lock` be committed? (Leaning yes, like `package-lock.json`.)
