# STARCHART

[![CI](https://github.com/space-pirate-zero/starchart/actions/workflows/ci.yml/badge.svg)](https://github.com/space-pirate-zero/starchart/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-ff1493)](LICENSE) [![Wiki](https://img.shields.io/badge/docs-wiki-00ff41)](https://github.com/space-pirate-zero/starchart/wiki)

```text
  ·      ✦          ·        ★            ·          ✦         ·       ·
███████╗████████╗ █████╗ ██████╗  ██████╗██╗  ██╗ █████╗ ██████╗ ████████╗
██╔════╝╚══██╔══╝██╔══██╗██╔══██╗██╔════╝██║  ██║██╔══██╗██╔══██╗╚══██╔══╝
███████╗   ██║   ███████║██████╔╝██║     ███████║███████║██████╔╝   ██║
╚════██║   ██║   ██╔══██║██╔══██╗██║     ██╔══██║██╔══██║██╔══██╗   ██║
███████║   ██║   ██║  ██║██║  ██║╚██████╗██║  ██║██║  ██║██║  ██║   ██║
╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝
☠ EVERY DEPENDENCY. CODE TO COSMOS. ────────── A SPACE PIRATE ZERO JOINT ☠
     ·         ·         ✦           ·          ★          ·         ·
```

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

```text
$ starchart plan

Change: addon:pro.price.usd  4.99 → 5.99

  ! manual  appstore:screenshots/6.9/03                         embeds     value is burned into media
  ! manual  stripe:price/pro-monthly                            mirrors    update in stripe (adapter is read-only)
  ~ auto    web:og-pro                                          renders    regenerate from template
  ~ auto    web:pricing-page                                    embeds     replace embedded value
  ~ auto    symbol:web/lib/starchart-facts#ADDON_PRO_PRICE_USD  anchors    regenerate fact constants (codegen)
  ? review  web:landing-hero                                    describes  describes this semantically
  ⌘ code    symbol:ios/Pricing.proUSD                           anchors    hardcoded value anchors this fact; update or switch to codegen
  ✗ retire  reel:spring-2026                                    embeds     expired 2026-06-30
  ✓ tests   test:ios/Tests/PaywallTests.swift                   tests      run these tests
  …

Plan: 5 manual · 6 auto · 1 review · 2 code · 1 retire · 1 tests
```

(Trimmed from the real output for the demo universe. The full walkthrough is in the [wiki tutorial](https://github.com/space-pirate-zero/starchart/wiki/Tutorial-Pro-Universe).)

A Space Pirate Zero project. Apache-2.0.

---

## Quick start

> **Not on npm yet.** `@space-pirate-zero/starchart` isn't published. Until it is, run it from source (below). Always use the scoped name: the unscoped `starchart` package on npm belongs to someone else.

```bash
git clone https://github.com/space-pirate-zero/starchart.git && cd starchart
```

```bash
pnpm install && pnpm build
```

```bash
alias starchart="node $PWD/packages/starchart/dist/cli/bin.js"
```

Then, in your project:

```bash
starchart init --discover
```

```bash
starchart lock
```

`init` writes `.starchart/config.yaml` and detects your code scopes (Next.js, SwiftUI, Compose, Go). `--discover` proposes facts and bridges from your code in `.starchart/proposals/discovered.yaml`; review it and move it into `.starchart/`. `lock` pins every artifact to today's facts and code; commit `starchart.lock`.

Whenever something changes:

```bash
starchart plan
```

```bash
starchart apply --dry-run
```

Try the bundled demo universe (a SwiftUI app plus a Next.js site with a paid Pro add-on):

```bash
starchart -C examples/pro-universe impact addon:pro.price.usd
```

Once published, `npx @space-pirate-zero/starchart <command>` will work everywhere.

📖 **Full documentation: the [STARCHART wiki](https://github.com/space-pirate-zero/starchart/wiki).**

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
| `starchart orphans [--external]` | Dead stars: unused facts, unlinked artifacts; `--external` adds unreferenced Stripe prices |
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
| `starchart adapters` | List adapters and whether each may write |
| `starchart about` | The Jolly Roger, version and links |

Use `sc` as a short alias. Global options: `-C <dir>`, `--no-color`, `-q`. See the [CLI reference](https://github.com/space-pirate-zero/starchart/wiki/CLI-Reference) for every flag.

---

## Integrations

**Claude Code hook.** Every file an agent edits gets its world impact injected back into the conversation. Add this to `.claude/settings.json` (until the package is published, replace `npx @space-pirate-zero/starchart` with `node /path/to/starchart/packages/starchart/dist/cli/bin.js`):

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit|NotebookEdit", "hooks": [{ "type": "command", "command": "npx @space-pirate-zero/starchart hook claude" }] }
    ]
  }
}
```

**MCP.**

```bash
claude mcp add starchart -- npx @space-pirate-zero/starchart mcp
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

---

```text
        ·              ✦                ·
    ★               _________               ·
                .-'           '-.
     ·         /                 \         ✦
              |   .---.   .---.   |
              |   ( ✦ )   ( ✦ )   |
      ✦        \  '---'   '---'  /        ·
                '.     /_\     .'
                  |'|'|'|'|'|'|
                  '-._______.-'
                        ·
      \\\\\\                         //////
           >=======   S P Z   =======<
      //////                         \\\\\\
            ·           ★           ·
```

<p align="center"><b>STARCHART</b> · a Space Pirate Zero joint · <code>starchart about</code></p>
