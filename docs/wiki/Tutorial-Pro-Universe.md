A long, hands-on tour of `examples/pro-universe`, the demo that ships with STARCHART: a SwiftUI app and a Next.js site selling a paid "Nebula Pro" add-on through Stripe and the App Store. You'll inspect the chart, change the price and watch it ripple, apply and revert the fix, trace a Swift code change to a store screenshot, then run the rules, privacy, scan, score, cost, orphans, JSON-LD, codegen and viewer commands. Every output below is real, captured from the built CLI on a temp copy.

## Setup

Work on a copy. `apply` writes files and the git steps need a repo of their own.

```bash
D=$(mktemp -d)/u && cp -R examples/pro-universe "$D" && cd "$D"
git init -q && git add -A && git commit -qm base
```

The `git init` is throwaway. You need it for `impact --diff` and `history`; nothing else cares. If you're running from source, alias `starchart` to `node <repo>/packages/starchart/dist/cli/bin.js` first (see [Getting Started](Getting-Started#run-from-source)).

## 1. Tour of the files

```text
.starchart/
  config.yaml              scopes, adapters, rule packs, codegen targets
  entities/app.yaml        app:nebula
  entities/pro.yaml        addon:pro: name, price {usd, eur}, billing, productId, features
  artifacts/web.yaml       pricing page, web copy, OG image, live pricing URL, landing hero
  artifacts/appstore.yaml  listing description, screenshot 6.9"/03
  artifacts/money.yaml     Stripe price, App Store subscription
  artifacts/marketing.yaml promo reel, onboarding email, App Store privacy label
  rules.yaml               two project invariants
starchart.lock             pins every artifact to facts + code hashes
apps/ios/                  SwiftUI: Pricing, ProductID, Entitlements, PaywallView, Telemetry (Sentry), tests
apps/web/                  Next.js: /pricing page, /api/checkout route, lib/pricing.ts, lib/stripe.ts, messages/en.json, og/pro.svg
marketing/emails/          onboarding-day-3.md
```

The heart of it is one entity:

```yaml
# .starchart/entities/pro.yaml
id: addon:pro
type: [schema:Offer, sc:AddOn]
label: Nebula Pro
of: app:nebula
status: active
owners: ["@zero"]
facts:
  name: Nebula Pro
  price:
    usd: 4.99
    eur: 4.99
  billing: monthly
  productId: { value: nebula_pro_monthly, authority: appstore }
  features: { authority: code, source: { symbol: ios/Entitlements.proFeatures } }
```

`features` has `authority: code`: its value is read from the Swift array `Entitlements.proFeatures`, not written in YAML. See [Code-Authority Facts](Code-Authority-Facts).

A few artifacts worth reading:

```yaml
# .starchart/artifacts/web.yaml (excerpt)
  - id: web:pricing-page
    type: schema:WebPage
    binding: { adapter: fs, path: apps/web/app/pricing/page.tsx }
    publishedBy: route:web/pricing
    embeds: [addon:pro.price.usd]
    describes: [addon:pro.features]

  - id: web:og-pro
    type: schema:ImageObject
    binding: { adapter: fs, path: apps/web/public/og/pro.png }
    renders: { template: apps/web/og/pro.svg, with: [addon:pro.name, addon:pro.price.usd] }
```

```yaml
# .starchart/artifacts/appstore.yaml (excerpt)
  - id: appstore:screenshots/6.9/03
    type: schema:ImageObject
    binding: { adapter: appstore, app: "6450000000", set: "6.9", index: 3 }
    captures: screen:ios/Paywall
    embeds: [addon:pro.price.usd]
```

And the code bridges: `Pricing.swift` carries `// @starchart anchors addon:pro.price.usd`, `lib/stripe.ts` anchors `stripe:price/pro-monthly`, and the two `StarchartFacts` files are codegen output marked `// @starchart generated`.

## 2. Is it in sync?

```text
$ starchart check
✓ every artifact is in sync
```

Exit code 0. This is what CI runs.

## 3. Query the chart

```text
$ starchart query --kind screen
screen   screen:ios/Paywall
$ starchart query --kind package
package  pkg:npm/@sentry/nextjs
package  pkg:npm/next
package  pkg:npm/posthog-js
package  pkg:npm/react
package  pkg:npm/stripe
package  pkg:swift/purchases-ios
package  pkg:swift/sentry-cocoa
$ starchart query --kind route
route    route:web/
route    route:web/api/checkout
route    route:web/pricing
```

Nobody wrote those. `screen:ios/Paywall` comes from the SwiftUI `View`, the routes from the Next.js `app/` tree, the packages from `package.json` and `Package.resolved`. Other kinds: `symbol`, `file`, `test`, `env`, `flag`, `event`, `i18n`, `fact`, `entity`, `artifact`. Filters combine: `--layer`, `--prefix`, `--text`, `--edge` with `--to`. The whole demo is 111 nodes and 182 edges (`starchart emit graph`).

## 4. Inspect one node

```text
$ starchart node symbol:ios/Entitlements.proFeatures
{
  "id": "symbol:ios/Entitlements.proFeatures",
  "kind": "symbol",
  "label": "proFeatures",
  "location": {
    "file": "apps/ios/Sources/Core/Entitlements.swift",
    "line": 5,
    "endLine": 5
  },
  "hash": "67931739280ac34c",
  "value": [
    "Themes",
    "iCloud sync"
  ],
  "meta": { "kind": "let", "qname": "Entitlements.proFeatures", "scope": "ios", "lang": "swift", "static": true, "parent": "symbol:ios/Entitlements" },
  "layer": "code"
}
  --anchors--> addon:pro.features
  <--contains-- file:ios/Sources/Core/Entitlements.swift
  <--references-- symbol:ios/Entitlements
  <--references-- symbol:ios/PaywallView.body
```

The literal array was extracted as the symbol's `value`, and the `anchors` edge to `addon:pro.features` was added because the fact names this symbol as its source. `node` accepts an exact id, a file path, or a unique id suffix.

## 5. Change the price

Bump the USD price from 4.99 to 5.99:

```bash
sed -i '' 's/usd: 4.99/usd: 5.99/' .starchart/entities/pro.yaml   # GNU sed: sed -i 's/…/…/'
```

```text
$ starchart plan -v
Change: addon:pro.price  {"usd":4.99,"eur":4.99} → {"usd":5.99,"eur":4.99}
Change: addon:pro.price.usd  4.99 → 5.99

  ! manual  appstore:iap/pro-monthly                            mirrors     update in appstore (adapter is read-only)
      why: addon:pro.price --mirrors--> appstore:iap/pro-monthly  (confidence 1)
  ! manual  appstore:listing/description                        embeds      adapter "appstore" cannot write
      why: addon:pro.price.usd --embeds--> appstore:listing/description  (confidence 1)
  ! manual  appstore:screenshots/6.9/03                         embeds      value is burned into media
      why: addon:pro.price.usd --embeds--> appstore:screenshots/6.9/03  (confidence 1)
  ! manual  stripe:price/pro-monthly                            mirrors     update in stripe (adapter is read-only)
      why: addon:pro.price.usd --mirrors--> stripe:price/pro-monthly  (confidence 1)
  ! manual  web:live-pricing                                    embeds      adapter "url" cannot write
      why: addon:pro.price.usd --embeds--> web:live-pricing  (confidence 1)
  ~ auto    email:onboarding-day-3                              embeds      replace embedded value
      why: addon:pro.price.usd --embeds--> email:onboarding-day-3  (confidence 1)
  ~ auto    symbol:ios/StarchartFacts.AddonPro.Price.usd        anchors     regenerate fact constants (codegen)
      why: addon:pro.price.usd --anchors--> symbol:ios/StarchartFacts.AddonPro.Price.usd  (confidence 1)
  ~ auto    symbol:web/lib/starchart-facts#ADDON_PRO_PRICE_USD  anchors     regenerate fact constants (codegen)
      why: addon:pro.price.usd --anchors--> symbol:web/lib/starchart-facts#ADDON_PRO_PRICE_USD  (confidence 1)
  ~ auto    web:messages-en                                     embeds      replace embedded value
      why: addon:pro.price.usd --embeds--> web:messages-en  (confidence 1)
  ~ auto    web:og-pro                                          renders     regenerate from template
      why: addon:pro.price.usd --renders--> web:og-pro  (confidence 1)
  ~ auto    web:pricing-page                                    embeds      replace embedded value
      why: addon:pro.price.usd --embeds--> web:pricing-page  (confidence 1)
  ? review  web:landing-hero                                    describes   describes this semantically
      why: addon:pro.price --partOf--> addon:pro --describes--> web:landing-hero  (confidence 1)
  ⌘ code    symbol:ios/Pricing.proUSD                           anchors     hardcoded value anchors this fact; update or switch to codegen
      why: addon:pro.price.usd --anchors--> symbol:ios/Pricing.proUSD  (confidence 1)
  ⌘ code    symbol:web/lib/stripe#PRICE_PRO_MONTHLY             anchors     holds this artifact's external id; update it if the id changes
      why: addon:pro.price.usd --mirrors--> stripe:price/pro-monthly --anchors--> symbol:web/lib/stripe#PRICE_PRO_MONTHLY  (confidence 1)
  ✗ retire  reel:spring-2026                                    embeds      expired 2026-06-30
      why: addon:pro.price.usd --embeds--> reel:spring-2026  (confidence 1)
  ✓ tests   test:ios/Tests/PaywallTests.swift                   tests       run these tests
      why: addon:pro.price.usd --anchors--> symbol:ios/Pricing.proUSD --references--> symbol:ios/PaywallView.body --references--> symbol:ios/PaywallView --tests--> test:ios/Tests/PaywallTests.swift  (confidence 0.58)
  · info    addon:pro                                           partOf      derived fact changes
      why: addon:pro.price --partOf--> addon:pro  (confidence 1)
  · info    app:nebula                                          partOf      derived fact changes
      why: addon:pro.price --partOf--> addon:pro --partOf--> app:nebula  (confidence 1)
  · info    route:web/api/checkout                              serves      route affected
      why: … --anchors--> symbol:web/lib/stripe#PRICE_PRO_MONTHLY --references--> symbol:web/app/api/checkout/route#POST --serves--> route:web/api/checkout  (confidence 0.95)
  · info    screen:ios/Paywall                                  references  screen affected
      why: … --references--> symbol:ios/PaywallView --references--> screen:ios/Paywall  (confidence 0.69)

Order: stripe:price/pro-monthly → appstore:iap/pro-monthly → appstore:listing/description → appstore:screenshots/6.9/03 → symbol:ios/Pricing.proUSD → symbol:ios/StarchartFacts.AddonPro.Price.usd → symbol:web/lib/starchart-facts#ADDON_PRO_PRICE_USD → symbol:web/lib/stripe#PRICE_PRO_MONTHLY → email:onboarding-day-3 → web:landing-hero → web:messages-en → web:og-pro → web:pricing-page → web:live-pricing → reel:spring-2026

Plan: 5 manual · 6 auto · 1 review · 2 code · 1 retire · 1 tests · 4 info
```

Read it class by class:

| Class | Items | Why |
|---|---|---|
| `manual` | Stripe price, App Store IAP, App Store description, live URL, screenshot | Stripe and App Store adapters are read-only until `write: true`; `url` can't write at all; the screenshot is a `schema:ImageObject`, so the price is burned into pixels. |
| `auto` | pricing page, web copy, email, OG image, two codegen constants | `fs` writes by default. `renders` regenerates from the SVG template. `apply` reruns codegen for the generated constants. |
| `review` | landing hero | It `describes` the whole add-on. A human (or a future LLM check) decides. |
| `code` | `Pricing.proUSD`, `PRICE_PRO_MONTHLY` | Code you fix by hand. `Pricing.proUSD` hardcodes the price. `PRICE_PRO_MONTHLY` holds the Stripe price id, reached through the Stripe artifact: update it if the id changes. |
| `retire` | spring reel | `validThrough: "2026-06-30"` has passed. Don't update it; kill it. |
| `test` | `PaywallTests.swift` | Reached through code references: run these. |

The `Order:` line is the rollout: money systems, then stores, then code, then web, then the rest, honoring `after:` edges (the App Store description waits for the IAP). See [Rollout Ordering](Rollout-Ordering) and [Impact Analysis](Impact-Analysis).

## 6. Dry run

```text
$ starchart apply --dry-run
· stripe:price/pro-monthly [stripe] update in stripe (adapter is read-only)
· appstore:iap/pro-monthly [appstore] update in appstore (adapter is read-only)
· appstore:listing/description [appstore] adapter "appstore" cannot write
· appstore:screenshots/6.9/03 [appstore] value is burned into media
· symbol:ios/Pricing.proUSD hardcoded value anchors this fact; update or switch to codegen
✓ symbol:ios/StarchartFacts.AddonPro.Price.usd [codegen] would regenerate apps/web/lib/starchart-facts.ts, apps/ios/Sources/Core/StarchartFacts.swift
✓ symbol:web/lib/starchart-facts#ADDON_PRO_PRICE_USD [codegen] would regenerate apps/web/lib/starchart-facts.ts, apps/ios/Sources/Core/StarchartFacts.swift
· symbol:web/lib/stripe#PRICE_PRO_MONTHLY holds this artifact's external id; update it if the id changes
✓ email:onboarding-day-3 [fs] would addon:pro.price.usd: 4.99 → 5.99
· web:landing-hero [fs] describes this semantically
✓ web:messages-en [fs] would addon:pro.price.usd: 4.99 → 5.99
✓ web:og-pro [fs] would render apps/web/og/pro.svg → apps/web/public/og/pro.png
✓ web:pricing-page [fs] would addon:pro.price.usd: 4.99 → 5.99
· web:live-pricing [url] adapter "url" cannot write
· reel:spring-2026 [youtube] expired 2026-06-30

Still needs a human:
  ! stripe:price/pro-monthly update in stripe (adapter is read-only)
  …
  ✗ reel:spring-2026 expired 2026-06-30
  mark artifacts done with: starchart ack <id…>
  code items: edit the constant, or generate it with starchart codegen
```

Nothing was written. Notice the two codegen constants: `apply` handles them itself. It runs every `codegen:` target in `config.yaml` once, the first time it reaches a generated constant, so both symbols report the same two files. No separate `starchart codegen` step needed.

## 7. Apply

```text
$ starchart apply --yes
· stripe:price/pro-monthly [stripe] update in stripe (adapter is read-only)
…
✓ symbol:ios/StarchartFacts.AddonPro.Price.usd [codegen] regenerated apps/web/lib/starchart-facts.ts; regenerated apps/ios/Sources/Core/StarchartFacts.swift
✓ symbol:web/lib/starchart-facts#ADDON_PRO_PRICE_USD [codegen] regenerated apps/web/lib/starchart-facts.ts; regenerated apps/ios/Sources/Core/StarchartFacts.swift
· symbol:web/lib/stripe#PRICE_PRO_MONTHLY holds this artifact's external id; update it if the id changes
✓ email:onboarding-day-3 [fs] addon:pro.price.usd: 4.99 → 5.99
· web:landing-hero [fs] describes this semantically
✓ web:messages-en [fs] addon:pro.price.usd: 4.99 → 5.99
✓ web:og-pro [fs] render apps/web/og/pro.svg → apps/web/public/og/pro.png
✓ web:pricing-page [fs] addon:pro.price.usd: 4.99 → 5.99
· web:live-pricing [url] adapter "url" cannot write
· reel:spring-2026 [youtube] expired 2026-06-30

Still needs a human:
  ! stripe:price/pro-monthly update in stripe (adapter is read-only)
  ! appstore:iap/pro-monthly update in appstore (adapter is read-only)
  ! appstore:listing/description adapter "appstore" cannot write
  ! appstore:screenshots/6.9/03 value is burned into media
  ⌘ symbol:ios/Pricing.proUSD hardcoded value anchors this fact; update or switch to codegen
  ⌘ symbol:web/lib/stripe#PRICE_PRO_MONTHLY holds this artifact's external id; update it if the id changes
  ? web:landing-hero describes this semantically
  ! web:live-pricing adapter "url" cannot write
  ✗ reel:spring-2026 expired 2026-06-30
  mark artifacts done with: starchart ack <id…>
  code items: edit the constant, or generate it with starchart codegen
journal: .starchart/journal/2026-09-29T23-15-08-609Z-d46588.json (undo with: starchart revert .starchart/journal/2026-09-29T23-15-08-609Z-d46588.json)
```

What changed on disk:

```text
$ git diff --stat
 .starchart/entities/pro.yaml               |  2 +-
 apps/ios/Sources/Core/StarchartFacts.swift |  2 +-
 apps/web/app/pricing/page.tsx              |  2 +-
 apps/web/lib/starchart-facts.ts            |  2 +-
 apps/web/messages/en.json                  |  2 +-
 marketing/emails/onboarding-day-3.md       |  2 +-
 starchart.lock                             | 38 +++++++++++++++---------------
 7 files changed, 25 insertions(+), 25 deletions(-)
```

The file diffs:

```diff
--- a/apps/web/app/pricing/page.tsx
+++ b/apps/web/app/pricing/page.tsx
-      <p className="price">$4.99 / month</p>
+      <p className="price">$5.99 / month</p>
--- a/apps/web/messages/en.json
+++ b/apps/web/messages/en.json
-    "cta": "Get Nebula Pro for $4.99/month"
+    "cta": "Get Nebula Pro for $5.99/month"
--- a/marketing/emails/onboarding-day-3.md
+++ b/marketing/emails/onboarding-day-3.md
-Nebula Pro gives you every theme and sync across devices for $4.99 a month.
+Nebula Pro gives you every theme and sync across devices for $5.99 a month.
--- a/apps/web/lib/starchart-facts.ts
+++ b/apps/web/lib/starchart-facts.ts
-export const ADDON_PRO_PRICE_USD = 4.99;
+export const ADDON_PRO_PRICE_USD = 5.99;
```

And a brand-new OG image (untracked, so it's not in the stat above), rendered from `apps/web/og/pro.svg` with `{{ addon:pro.name | upper }}` and `{{ addon:pro.price.usd | money:USD }}` filled in:

```text
$ file apps/web/public/og/pro.png
apps/web/public/og/pro.png: PNG image data, 1200 x 630, 8-bit/color RGBA, non-interlaced
```

The journal records the four fs writes. The regenerated constants are **not** journaled: generated files are reproducible, and git undoes them.

Note what did **not** change: `lib/pricing.ts` still says `PRO_PRICE_USD = 4.99` because nothing in the chart anchors that constant. `starchart scan` (step 14) is how you find strays like that.

## 8. What's left for humans

```text
$ starchart check
  ✗ stale     appstore:iap/pro-monthly
                changed: addon:pro.price
                changed: addon:pro.price.usd
                changed: symbol:ios/StarchartFacts.AddonPro.Price.usd
                changed: symbol:web/lib/starchart-facts#ADDON_PRO_PRICE_USD
  ✗ stale     appstore:listing/description
  …
  ✗ stale     web:live-pricing
                changed: addon:pro.price.usd
                changed: symbol:ios/StarchartFacts.AddonPro.Price.usd
                changed: symbol:web/lib/starchart-facts#ADDON_PRO_PRICE_USD

Check: 7 stale
```

Exit code 1. The four applied artifacts are in sync; the seven that need a person are not: the Stripe price, the IAP, the store description, the screenshot, the live site (it updates when you deploy), the landing hero and the expired reel. The regenerated constants appear as changed dependencies because `anchors` propagates both ways between a fact and its code value.

`plan` tells the same story:

```text
$ starchart plan
Change: addon:pro.price  {"usd":4.99,"eur":4.99} → {"usd":5.99,"eur":4.99}
Change: addon:pro.price.usd  4.99 → 5.99
Change: symbol:ios/StarchartFacts.AddonPro.Price.usd  ∅ → 5.99
Change: symbol:web/lib/starchart-facts#ADDON_PRO_PRICE_USD  ∅ → 5.99

  ! manual  appstore:iap/pro-monthly                 mirrors    update in appstore (adapter is read-only)
  ! manual  appstore:listing/description             embeds     adapter "appstore" cannot write
  ! manual  appstore:screenshots/6.9/03              embeds     value is burned into media
  ! manual  stripe:price/pro-monthly                 mirrors    update in stripe (adapter is read-only)
  ! manual  web:live-pricing                         embeds     adapter "url" cannot write
  ? review  web:landing-hero                         describes  describes this semantically
  ⌘ code    symbol:ios/Pricing.proUSD                anchors    hardcoded value anchors this fact; update or switch to codegen
  ⌘ code    symbol:web/lib/stripe#PRICE_PRO_MONTHLY  anchors    holds this artifact's external id; update it if the id changes
  ✗ retire  reel:spring-2026                         embeds     expired 2026-06-30
  ✓ tests   test:ios/Tests/PaywallTests.swift        tests      run these tests

Order: stripe:price/pro-monthly → appstore:iap/pro-monthly → appstore:listing/description → appstore:screenshots/6.9/03 → symbol:ios/Pricing.proUSD → symbol:web/lib/stripe#PRICE_PRO_MONTHLY → web:landing-hero → web:live-pricing → reel:spring-2026

Plan: 5 manual · 1 review · 2 code · 1 retire · 1 tests
(4 informational items hidden; use --verbose)
```

The applied artifacts are gone; everything still stale stays. That works because the relock after `apply` keeps the old 4.99 in `starchart.lock` for every fact a still-stale artifact depends on, and `plan` seeds from those stale dependencies too. The regenerated constants show up as `∅ → 5.99` changes: they're seeded as changed dependencies of the stale artifacts, and the lock only keeps before-values for facts. `plan` and `check` agree until you ack or fix the rest. See [Lockfile and Drift](Lockfile-and-Drift).

## 9. Ack what you've done

You deployed the site and reread the landing hero. Tell STARCHART:

```text
$ starchart ack web:landing-hero web:live-pricing
✓ acked web:landing-hero, web:live-pricing
$ starchart check | tail -1
Check: 5 stale
```

Both drop out of the plan as well:

```text
$ starchart plan
…
  ! manual  appstore:iap/pro-monthly                 mirrors  update in appstore (adapter is read-only)
  ! manual  appstore:listing/description             embeds   adapter "appstore" cannot write
  ! manual  appstore:screenshots/6.9/03              embeds   value is burned into media
  ! manual  stripe:price/pro-monthly                 mirrors  update in stripe (adapter is read-only)
  ⌘ code    symbol:ios/Pricing.proUSD                anchors  hardcoded value anchors this fact; update or switch to codegen
  ⌘ code    symbol:web/lib/stripe#PRICE_PRO_MONTHLY  anchors  holds this artifact's external id; update it if the id changes
  ✗ retire  reel:spring-2026                         embeds   expired 2026-06-30
  ✓ tests   test:ios/Tests/PaywallTests.swift        tests    run these tests
…
Plan: 4 manual · 2 code · 1 retire · 1 tests
```

`ack` only takes artifact ids. Code items aren't acked; you edit the constant (or generate it with `starchart codegen`):

```text
$ starchart ack symbol:ios/Pricing.proUSD
starchart: not an artifact: symbol:ios/Pricing.proUSD
```

(exit code 2)

## 10. Revert the apply

Changed your mind? The journal holds an undo record for every write. Preview it, then run it:

```text
$ starchart revert --dry-run 2026-09-29T23-15-08-609Z-d46588
{
  "journal": "/…/u/.starchart/journal/2026-09-29T23-15-08-609Z-d46588.json",
  "dryRun": true,
  "results": [
    { "artifact": "web:pricing-page", "ok": true, "changes": ["would restore apps/web/app/pricing/page.tsx"] },
    { "artifact": "web:og-pro", "ok": true, "changes": ["would restore apps/web/public/og/pro.png"] },
    …
```

```text
$ starchart revert 2026-09-29T23-15-08-609Z-d46588
{
  …
  "results": [
    { "artifact": "web:pricing-page", "ok": true, "changes": ["restored apps/web/app/pricing/page.tsx"] },
    { "artifact": "web:og-pro", "ok": true, "changes": ["removed generated apps/web/public/og/pro.png"] },
    { "artifact": "web:messages-en", "ok": true, "changes": ["restored apps/web/messages/en.json"] },
    { "artifact": "email:onboarding-day-3", "ok": true, "changes": ["restored marketing/emails/onboarding-day-3.md"] }
  ],
  "ok": true,
  "bindingEdits": [],
  "lockRestored": true
}
$ starchart journals
2026-09-29T23-15-08-609Z-d46588  2026-09-29T23:15:08.609Z  4 artifact(s) reverted 2026-09-29T23:15:23.053Z
```

Records run in reverse order. The OG PNG didn't exist before, so it's removed. The lock goes back to exactly what it was before the apply, which also drops the acks you made after it. Revert does **not** touch your fact YAML or the constants `apply` regenerated; codegen output isn't journaled, and git undoes both:

```text
$ git status --short
 M .starchart/entities/pro.yaml
 M apps/ios/Sources/Core/StarchartFacts.swift
 M apps/web/lib/starchart-facts.ts
?? .starchart/journal/
```

If any entry fails to revert, the report says `"ok": false`, the lock stays as it is, and `revert` exits 1. A journal can be reverted once. The id, a unique id prefix, or the path all work. More: [Apply, Revert and Journals](Apply-Revert-and-Journals).

Reset before the next section:

```bash
git checkout -q . && git clean -fdq
```

## 11. A code change

Add a feature to Pro, in Swift, without committing:

```swift
// apps/ios/Sources/Core/Entitlements.swift
static let proFeatures = ["Themes", "iCloud sync", "Widgets"]
```

```text
$ starchart impact --diff HEAD
Change: file:ios/Sources/Core/Entitlements.swift
Change: symbol:ios/Entitlements
Change: symbol:ios/Entitlements.proFeatures
Change: addon:pro.features  ["Themes","iCloud sync"] → ["Themes","iCloud sync","Widgets"]

  ! manual  appstore:screenshots/6.9/03                        captures   screen changed; re-capture
  ~ auto    symbol:ios/StarchartFacts.AddonPro.features        anchors    regenerate fact constants (codegen)
  ~ auto    symbol:web/lib/starchart-facts#ADDON_PRO_FEATURES  anchors    regenerate fact constants (codegen)
  ? review  appstore:listing/description                       describes  describes this semantically
  ? review  web:pricing-page                                   describes  describes this semantically
  ? review  email:onboarding-day-3                             describes  describes this semantically
  ? review  web:landing-hero                                   describes  describes this semantically
  ✗ retire  reel:spring-2026                                   promotes   expired 2026-06-30
  ✓ tests   test:ios/Tests/PaywallTests.swift                  tests      run these tests

Order: appstore:listing/description → appstore:screenshots/6.9/03 → symbol:ios/StarchartFacts.AddonPro.features → symbol:web/lib/starchart-facts#ADDON_PRO_FEATURES → email:onboarding-day-3 → web:landing-hero → web:pricing-page → reel:spring-2026

Plan: 1 manual · 2 auto · 4 review · 1 retire · 1 tests
(3 informational items hidden; use --verbose)
```

One Swift array. Two paths out of it:

1. **Through the fact.** `proFeatures` is the source of `addon:pro.features`, so every artifact that `describes` the features (or the whole add-on) needs review, and the generated constants need regenerating.
2. **Through the UI.** `PaywallView.body` reads `Entitlements.proFeatures`, the paywall screen is built from `PaywallView`, and screenshot 6.9"/03 `captures` that screen. The screenshot is stale because the UI changed, not because a value changed.

`--diff <base>` runs `git diff <base>` against the working tree, plus untracked files, and maps each hunk to the symbols it touches. `HEAD` means "what I haven't committed yet". After you commit, use `--diff HEAD~1` or `--diff origin/main`. See [Git Diff Impact](Git-Diff-Impact).

### The PR comment

The same plan as markdown, which is what the [GitHub Action](GitHub-Action) posts:

```text
$ starchart impact --diff HEAD --format markdown
```

```markdown
## 🌌 STARCHART blast radius

**4 changes:**

- `file:ios/Sources/Core/Entitlements.swift`
- `symbol:ios/Entitlements`
- `symbol:ios/Entitlements.proFeatures`
- `addon:pro.features` `["Themes","iCloud sync"]` → `["Themes","iCloud sync","Widgets"]`

| | Class | Count |
|---|---|---:|
| ! | Manual | 1 |
| ~ | Auto-fixable | 2 |
| ? | Needs review | 4 |
| ✗ | Retire | 1 |
| ✓ | Tests to run | 1 |

<details open><summary><b>! Manual</b> (1)</summary>

| Artifact | Via | Reason | Why |
|---|---|---|---|
| `appstore:screenshots/6.9/03` | captures | screen changed; re-capture | <code>symbol:ios/Entitlements.proFeatures --references--&gt; symbol:ios/PaywallView.body --references--&gt; symbol:ios/PaywallView --references--&gt; screen:ios/Paywall --captures--&gt; appstore:screenshots/6.9/03</code> |

</details>

…

### Rollout order

1. `appstore:listing/description` (review)
2. `appstore:screenshots/6.9/03` (manual)
…
```

## 12. Why?

`why <from> <to>` prints the shortest path that makes `to` depend on `from`. Both ends accept ids, file paths and unique suffixes.

```text
$ starchart why apps/ios/Sources/Paywall/PaywallView.swift appstore:screenshots/6.9/03
symbol:ios/PaywallView --references--> screen:ios/Paywall --captures--> appstore:screenshots/6.9/03
class manual · confidence 0.95 · screen changed; re-capture

$ starchart why addon:pro.price.usd symbol:web/lib/stripe#PRICE_PRO_MONTHLY
addon:pro.price.usd --mirrors--> stripe:price/pro-monthly --anchors--> symbol:web/lib/stripe#PRICE_PRO_MONTHLY
class code · confidence 1 · holds this artifact's external id; update it if the id changes

$ starchart why addon:pro.price.usd app:nebula.name
app:nebula.name does not depend on addon:pro.price.usd
```

The second path runs through the Stripe artifact, so the constant is classed `code` with the "external id" reason: it holds `price_…`, not 4.99. The last one exits 1. `why` searches every code node and ignores the confidence cutoff, so it can find paths `impact` would hide.

Reset: `git checkout -q .`

## 13. Rules and privacy

```text
$ starchart rules
error privacy-disclosed  pkg:swift/purchases-ios collects DeviceID but PrivacyInfo.xcprivacy (apps/ios/Resources/PrivacyInfo.xcprivacy) does not declare NSPrivacyCollectedDataTypeDeviceID  (apps/ios/Resources/PrivacyInfo.xcprivacy)
error privacy-disclosed  pkg:swift/purchases-ios collects UserID but PrivacyInfo.xcprivacy (…) does not declare NSPrivacyCollectedDataTypeUserID  (…)
error privacy-disclosed  pkg:swift/sentry-cocoa collects CrashData but privacy label privacy:appstore-label does not declare CrashData  (.starchart/artifacts/marketing.yaml)
error privacy-disclosed  pkg:swift/sentry-cocoa collects CrashData but PrivacyInfo.xcprivacy (…) does not declare NSPrivacyCollectedDataTypeCrashData  (…)
error privacy-disclosed  pkg:swift/sentry-cocoa collects OtherDiagnosticData but privacy label privacy:appstore-label does not declare OtherDiagnosticData  (…)
…
error promo-not-expired  reel:spring-2026 expired on 2026-06-30  (.starchart/artifacts/marketing.yaml)
warn  artifact-bound  privacy:appstore-label has no binding  (.starchart/artifacts/marketing.yaml)
warn  privacy-disclosure-exists  pkg:npm/@sentry/nextjs, pkg:npm/posthog-js collect CrashData, DeviceID, OtherDiagnosticData, PerformanceData, ProductInteraction on web but no disclosure exists; add a privacy policy (sc:PrivacyPolicy with meta.declares)
info  fact-used  app:nebula.appStoreId is not used by any code or artifact  (.starchart/entities/app.yaml)
…
9 error · 2 warn · 4 info
```

Exit 1, because there are errors. The two project rules in `rules.yaml` (offers mirrored in Stripe and the App Store, paywall captured by a screenshot) pass; everything above comes from the built-in packs listed in `config.yaml`.

`privacy` narrows it to data collection:

```text
$ starchart privacy
sentry pkg:npm/@sentry/nextjs [web]
  collects: CrashData, OtherDiagnosticData, PerformanceData  (optional: DeviceID)
posthog pkg:npm/posthog-js [web]
  collects: DeviceID, ProductInteraction  (optional: UserID)
revenuecat pkg:swift/purchases-ios [ios]
  collects: DeviceID, PurchaseHistory, UserID
sentry pkg:swift/sentry-cocoa [ios]
  collects: CrashData, OtherDiagnosticData, PerformanceData  (optional: DeviceID)

error privacy-disclosed  pkg:swift/sentry-cocoa collects CrashData but privacy label privacy:appstore-label does not declare CrashData  (.starchart/artifacts/marketing.yaml)
…
8 error · 1 warn · 0 info
```

**The Sentry finding, in plain words.** `apps/ios/Package.resolved` pins `sentry-cocoa`, so the code layer has a `pkg:swift/sentry-cocoa` node. STARCHART's SDK catalog says Sentry's iOS SDK collects crash data, diagnostics and performance data. Your two disclosures disagree:

- `PrivacyInfo.xcprivacy` declares only `NSPrivacyCollectedDataTypePurchaseHistory`.
- The App Store privacy label artifact (`privacy:appstore-label`, `meta.declares`) lists purchase history, user id and device id. No crash data.

So adding Sentry made both disclosures false, and that's the kind of thing that gets an app rejected. RevenueCat (`purchases-ios`) trips the manifest check too: it collects user and device ids the manifest doesn't declare. The catalog is a starting point, not legal advice; details and overrides in [Privacy Drift](Privacy-Drift).

## 14. Scan for strays

```text
$ starchart scan
unbound apps/ios/Resources/Localizable.xcstrings:6  Nebula Pro (addon:pro.name)  "en" : { "stringUnit" : { "state" : "translated", "value" : "Unlock Nebula Pro" } },
unbound apps/ios/Resources/Localizable.xcstrings:7  Nebula Pro (addon:pro.name)  "ja" : { "stringUnit" : { "state" : "translated", "value" : "Nebula Pro を解放" } }
unbound apps/ios/Sources/Core/Pricing.swift:5  4.99 (addon:pro.price.eur)  static let proUSD = 4.99
unbound apps/web/app/page.tsx:4  Nebula (app:nebula.name)  <h1>Nebula</h1>
unbound apps/web/app/page.tsx:5  Nebula Pro (addon:pro.name)  <p>Plan your orbit. Upgrade to Nebula Pro for themes and sync across every device.</p>
unbound apps/web/app/pricing/page.tsx:8  4.99 (addon:pro.price.eur)  <p className="price">$4.99 / month</p>
unbound apps/web/lib/pricing.ts:3  4.99 (addon:pro.price.eur)  export const PRO_PRICE_USD = 4.99;
unbound apps/web/lib/pricing.ts:3  4.99 (addon:pro.price.usd)  export const PRO_PRICE_USD = 4.99;
unbound apps/web/messages/en.json:4  4.99 (addon:pro.price.eur)  "cta": "Get Nebula Pro for $4.99/month"
```

Every occurrence of a fact value the chart doesn't account for. `lib/pricing.ts:3` is the real find: a hardcoded USD price nothing anchors, which is why `apply` skipped it in step 7. Some hits are ambiguous by nature: USD and EUR are both 4.99, so a bound USD occurrence still shows up as an unbound EUR one. `scan` exits 1 when it finds anything; `--all` includes bound occurrences (and exits 0). See [Bridges and Discovery](Bridges-and-Discovery).

## 15. Reality Score

```text
$ starchart score
reality 83%  10/12 artifacts in sync
  unbound      privacy:appstore-label
  expired      reel:spring-2026
```

`--badge reality.svg` writes a README badge, `--badge-json` a shields.io endpoint, and `--audit` folds in live audit results. See [Reality Score](Reality-Score).

## 16. Change cost

```text
$ starchart cost -n 5
████████████████████   9.4h  addon:pro.price.usd (21 impacted)
      → 1 hardcoded code anchor: generate constants with `starchart codegen` to make these auto
      → 1 image embeds this value: bind it to a template (renders) to regenerate automatically
      → 2 manual updates in appstore, stripe: enable write access for these adapters to sync automatically
      → Doing this cuts the change cost from 9.4 h to 4.85 h
████████████           5.7h  addon:pro.name (16 impacted)
      → 1 hardcoded code anchor: generate constants with `starchart codegen` to make these auto
      → 2 manual updates in appstore, stripe: enable write access for these adapters to sync automatically
      → Doing this cuts the change cost from 5.7 h to 2.6 h
███████████            5.0h  addon:pro.productId (12 impacted)
…
███████                3.1h  addon:pro.price.eur (9 impacted)
```

Hours are estimates from per-class defaults, not history. The suggestions are the useful part: they tell you which bridges to build next. They only count what would really help: `Pricing.proUSD` could be generated, but `PRICE_PRO_MONTHLY` (a Stripe price id) can't; the write-access tip counts the Stripe price and the App Store description, and skips what no adapter can write even with `write: true` (the url-bound live page, the App Store IAP). The screenshot gets the image tip instead. See [Change Cost](Change-Cost).

## 17. Orphans

```text
$ starchart orphans
expired                reel:spring-2026  reel:spring-2026 expired on 2026-06-30 but is not retired
artifact-unlinked      privacy:appstore-label  privacy:appstore-label does not embed, render, mirror or describe anything
fact-unused            app:nebula.appStoreId  app:nebula.appStoreId is not used by any code or artifact
fact-unused            app:nebula.category  app:nebula.category is not used by any code or artifact
fact-unused            app:nebula.name  app:nebula.name is not used by any code or artifact
fact-unused            app:nebula.operatingSystem  app:nebula.operatingSystem is not used by any code or artifact
package-unused         pkg:npm/@sentry/nextjs  pkg:npm/@sentry/nextjs is a dependency but no file uses it
```

Dead stars. `@sentry/nextjs` is in `package.json` but nothing imports it. `--external` also lists Stripe prices nothing references (needs `STRIPE_SECRET_KEY`). See [Orphans](Orphans).

## 18. JSON-LD

```text
$ starchart emit jsonld --entity addon:pro
[
  {
    "@context": "https://schema.org",
    "@type": "Offer",
    "name": "Nebula Pro",
    "sku": "nebula_pro_monthly",
    "availability": "https://schema.org/InStock",
    "price": "4.99",
    "priceCurrency": "EUR"
  },
  {
    "@context": "https://schema.org",
    "@type": "Offer",
    "name": "Nebula Pro",
    "sku": "nebula_pro_monthly",
    "availability": "https://schema.org/InStock",
    "price": "4.99",
    "priceCurrency": "USD"
  }
]
```

One `Offer` per currency, straight from the facts. `--script` wraps it in a `<script type="application/ld+json">` tag. Without `--entity` you get the whole chart as JSON-LD. See [JSON-LD and SEO](JSON-LD-and-SEO).

## 19. Codegen

```text
$ starchart codegen
unchanged apps/web/lib/starchart-facts.ts
unchanged apps/ios/Sources/Core/StarchartFacts.swift
```

Targets come from `codegen:` in `config.yaml`. Each constant carries its own `// @starchart anchors <fact>` comment, so generated code is bridged automatically and classified `auto` instead of `code`. `apply` runs these targets for you when a fact changes (step 7); run `codegen` yourself after adding a target or an entity. See [Codegen](Codegen).

## 20. Look at it

```text
$ starchart graph
✓ starchart.html
```

A single self-contained HTML file (about 145 KB for the demo) with the interactive star chart. Or run the local server, which also feeds the X-Ray extension:

```text
$ starchart serve
★ STARCHART at http://127.0.0.1:4477  (ctrl+c to stop)
```

```text
$ curl -s localhost:4477/health
{"ok":true,"name":"pro-universe","nodes":111,"edges":182,"live":false}
```

Endpoints: `/`, `/graph.json`, `/xray.json`, `/impact?id=…`, `/health`, `/events`. `--watch` rebuilds on file changes; `--port` and `--host` do what they say. See [Viewer and Serve](Viewer-and-Serve) and [Reality X-Ray](Reality-X-Ray).

## Bonus: preview and history

```text
$ starchart preview        # with the 5.99 edit in place
✓ 15 preview entries → .starchart/preview/index.html
```

An HTML before/after of every item in the plan. See [Future Universe Preview](Future-Universe-Preview).

Commit the lock and git becomes a time machine for every fact. Mind the timing: while anything that depends on the price is still stale, the lock keeps the old value (that's what keeps `plan` honest), so a commit right after `apply` still records 4.99. Commit once the last artifact is acked:

```text
$ starchart apply --yes && git add -A && git commit -qm 'Pro: apply $5.99'
…
$ starchart history addon:pro.price.usd
ce202cc6 2026-09-29 4.99  Zero: demo: base
$ starchart ack stripe:price/pro-monthly appstore:iap/pro-monthly appstore:listing/description appstore:screenshots/6.9/03 web:landing-hero web:live-pricing reel:spring-2026
✓ acked stripe:price/pro-monthly, appstore:iap/pro-monthly, appstore:listing/description, appstore:screenshots/6.9/03, web:landing-hero, web:live-pricing, reel:spring-2026
$ git commit -qam 'Pro: $5.99 everywhere'
$ starchart history addon:pro.price.usd
8e950394 2026-09-29 5.99  Zero: Pro: $5.99 everywhere
ce202cc6 2026-09-29 4.99  Zero: demo: base
```

See [Time Machine](Time-Machine).

## What you didn't run

`starchart audit` compares the chart with the live site, Stripe and App Store Connect. On the demo, without credentials, there isn't much to compare:

```text
$ starchart audit
? missing web:og-pro apps/web/public/og/pro.png  rendered output not found: apps/web/public/og/pro.png
error web:live-pricing [url] https://nebula.example.com/pricing: request failed: fetch failed
skip  appstore:listing/description: App Store Connect credentials missing: ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY_PATH or ASC_PRIVATE_KEY
skip  privacy:appstore-label: no binding
skip  reel:spring-2026: no adapter "youtube" is registered
skip  stripe:price/pro-monthly: Stripe secret key not found: set the STRIPE_SECRET_KEY environment variable
skip  symbol:web/lib/stripe#PRICE_PRO_MONTHLY: break detection skipped: Stripe secret key not found: set the STRIPE_SECRET_KEY environment variable
7 checked · 1 diff(s) · 1 error(s) · 5 skipped
```

Exit 1. `nebula.example.com` doesn't resolve, and an unreachable site is an audit **error**, not a `break`: STARCHART can't tell a dead link from a flaky network. Only a 404 or 410 counts as a break. The OG image is `missing` because the demo never rendered it (an `apply` would). `-f markdown` prints the same as tables for a PR comment. Try it with your own project and keys: [Audit and Break Detection](Audit-and-Break-Detection).

## See also

- [Getting Started](Getting-Started)
- [Impact Analysis](Impact-Analysis)
- [Apply, Revert and Journals](Apply-Revert-and-Journals)
- [CLI Reference](CLI-Reference)
- [FAQ and Troubleshooting](FAQ-and-Troubleshooting)
