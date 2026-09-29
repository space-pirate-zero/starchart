# STARCHART

**Every dependency. Code to cosmos.**

STARCHART is a dependency graph for everything your product touches, not just the code. It charts three layers:

```
WORLD   website · OG images · App Store listing + screenshots · Stripe · promo reels · emails
  ▲  embeds / renders / describes / mirrors / captures / promotes
FACTS   addon:pro.name · addon:pro.price.usd · addon:pro.features · product ids
  ▲  anchors / displays / publishes / emits
CODE    files · symbols · routes · screens · packages · env · flags · events · i18n · tests
```

Change anything on any layer and STARCHART walks the whole chart. It tells you what else is now wrong, explains *why*, fixes what it can, and turns the rest into a checklist.

```
$ starchart plan

Change: addon:pro.price.usd  4.99 → 5.99

  ~ auto    web:pricing-page               embeds    replace embedded value
  ~ auto    web:og-pro                     renders   regenerate from template
  ! manual  stripe:price/pro-monthly       mirrors   update in stripe (adapter is read-only)
  ! manual  appstore:screenshots/6.9/03    embeds    value is burned into media
  ✗ retire  reel:spring-2026               embeds    expired 2026-06-30
  ⌘ code    symbol:ios/Pricing.proUSD      anchors   hardcoded value anchors this fact
  ✓ test    test:ios/Tests/PaywallTests.swift        run these tests
```

A Space Pirate Zero project. Apache-2.0.

---

## Quick start

```bash
npm i -D @spz/starchart
```

```bash
npx starchart init --discover
```

```bash
npx starchart lock
```

The first command writes `.starchart/config.yaml`, detects your code scopes (Next.js, SwiftUI, Compose, Go), and proposes facts and bridges it found in your code. `lock` pins every artifact to today's facts and code; commit `starchart.lock`.

Then, whenever something changes:

```bash
npx starchart plan
```

```bash
npx starchart apply --dry-run
```

Try the bundled demo universe, a SwiftUI app plus a Next.js site with a paid Pro add-on:

```bash
cd examples/pro-universe && npx starchart impact addon:pro.price.usd
```

---

## Authoring the chart

Everything lives in `.starchart/` as YAML, reviewed in PRs like code. **Code nodes are never written by hand.** They're extracted. You only declare facts, world artifacts, and bridges.

```yaml
# .starchart/entities/pro.yaml
id: addon:pro
type: [schema:Offer, sc:AddOn]
of: app:nebula
status: active
facts:
  name: Nebula Pro
  price: { usd: 4.99, eur: 4.99 }
  productId: { value: nebula_pro_monthly, authority: appstore }
  features: { authority: code, source: { symbol: ios/Entitlements.proFeatures } }
```

```yaml
# .starchart/artifacts/web.yaml
artifacts:
  - id: web:pricing-page
    binding: { adapter: fs, path: apps/web/app/pricing/page.tsx }
    publishedBy: route:web/pricing
    embeds: [addon:pro.name, addon:pro.price.usd]
    describes: [addon:pro.features]

  - id: web:og-pro
    type: schema:ImageObject
    binding: { adapter: fs, path: apps/web/public/og/pro.png }
    renders: { template: apps/web/og/pro.svg, with: [addon:pro.name, addon:pro.price.usd] }

  - id: appstore:screenshots/6.9/03
    type: schema:ImageObject
    binding: { adapter: appstore, app: "6450000000", set: "6.9", index: 3 }
    captures: screen:ios/Paywall        # a UI code change makes this screenshot stale
```

Bridge from code with annotations:

```swift
enum Pricing {
    // @starchart anchors addon:pro.price.usd
    static let proUSD = 4.99
}
```

Or generate the constants from facts so they can never drift (`starchart codegen`).

### Edge types

| Layer | Edges |
|---|---|
| Code (extracted) | `imports` `references` `dependsOn` `tests` `serves` `readsEnv` `readsFlag` `contains` |
| Bridge | `anchors` `displays` `captures` `publishes` `emits` |
| World | `embeds` `renders` `describes` `promotes` `mirrors` `derivedFrom` `after` `blocks` |
| Fact | `partOf` |

### Node ids

| Kind | Example |
|---|---|
| fact / entity | `addon:pro`, `addon:pro.price.usd` |
| file | `file:web/app/pricing/page.tsx` |
| symbol | `symbol:web/lib/pricing#PRO_PRICE_USD`, `symbol:ios/Pricing.proUSD` |
| route / screen | `route:web/pricing`, `screen:ios/Paywall` |
| package | `pkg:npm/stripe`, `pkg:swift/sentry-cocoa`, `pkg:gradle/io.sentry:sentry-android` |
| env / flag / event | `env:STRIPE_SECRET_KEY`, `flag:sync_v2`, `event:pro_checkout_started` |
| i18n / test | `i18n:ios/paywall.title`, `test:ios/Tests/PaywallTests.swift` |

---

## Commands

| Command | What it does |
|---|---|
| `starchart init [--discover]` | Scaffold `.starchart/`, detect scopes, propose facts/bridges from code |
| `starchart impact <ref…>` | Blast radius of a node, file path, or id suffix across all layers |
| `starchart impact --diff <base>` | Blast radius of a git diff (PR mode) |
| `starchart plan` | Everything changed since `starchart.lock`, classified and ordered |
| `starchart apply [--dry-run] [--yes]` | Execute `auto` steps via adapters, journal undo records, relock |
| `starchart revert <journal>` / `journals` | Roll back an apply (Stripe, files, App Store text) |
| `starchart ack <artifact…>` | Mark manual/review items done |
| `starchart check` | Exit 1 if any artifact is stale (CI gate) |
| `starchart lock` | Pin all artifacts to current facts and code |
| `starchart audit` | Compare the graph with live systems (site, Stripe, App Store); detect breaks |
| `starchart rules` | Evaluate invariants and rule packs (core, appstore, privacy, seo) |
| `starchart privacy` | SDK data collection vs PrivacyInfo.xcprivacy and privacy labels |
| `starchart orphans` | Dead stars: unused facts, unlinked artifacts, unreferenced Stripe prices |
| `starchart score [--badge f.svg]` | Reality Score: % of artifacts bound, in sync, fresh |
| `starchart cost` | Change-cost heatmap and suggestions |
| `starchart why <from> <to>` | The exact path that makes `to` depend on `from` |
| `starchart query` / `node <id>` | Search and inspect the graph |
| `starchart scan` | Unbound occurrences of fact values in code and content |
| `starchart codegen` | Facts → TS / Swift / Kotlin constants |
| `starchart emit jsonld\|graph\|xray` | JSON-LD (schema.org SEO blocks or the full graph), raw graph, X-Ray payload |
| `starchart preview` | Future Universe: rendered before/after of a plan as HTML |
| `starchart history <fact>` | Time machine: a fact's values across commits |
| `starchart graph [--out f.html]` | Self-contained interactive star chart |
| `starchart serve` | Viewer + API for the X-Ray browser extension |
| `starchart hook claude` | Claude Code PostToolUse hook: impact as live agent context |
| `starchart mcp` | MCP server for agents |

Use `sc` as a short alias.

---

## Integrations

**Claude Code hook.** Every file an agent edits gets its world impact injected back into the conversation. Add this to `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit", "hooks": [{ "type": "command", "command": "npx starchart hook claude" }] }
    ]
  }
}
```

**MCP.**

```bash
claude mcp add starchart -- npx starchart mcp
```

**GitHub Action.** A sticky PR comment with the cross-layer blast radius. See [action/README.md](action/README.md).

**Reality X-Ray.** A browser extension that highlights every fact on your live site or App Store page as in sync (green) or stale (red). See [packages/xray/README.md](packages/xray/README.md).

---

## Repository layout

```
packages/starchart/   the library, CLI (starchart / sc) and MCP server (starchart-mcp)
  src/core/           graph model, impact traversal, ordering, lockfile
  src/config/         YAML schema + loader
  src/compiler/       YAML → fact and world layers
  src/code/           code layer ingestion (TS/JS, Swift, Kotlin, Go, routes, screens, packages, i18n)
  src/bridge/         literal scanner + edge discovery
  src/adapters/       fs, url, stripe, appstore
  src/engine/         audit, apply/revert journal, Future Universe preview
  src/rules/          invariant engine + packs (core, appstore, privacy, seo)
  src/analysis/       orphans, Reality Score, change cost
  src/render/         templates, OG images, JSON-LD
  src/codegen/        facts → TS / Swift / Kotlin
  src/viewer/         star chart viewer + local server
  src/mcp/ src/hooks/ agent integrations
packages/xray/        Reality X-Ray browser extension (MV3)
action/               GitHub Action
examples/pro-universe demo universe (SwiftUI + Next.js + Stripe + App Store)
```

See [PLAN.md](PLAN.md) for the full design and roadmap.
