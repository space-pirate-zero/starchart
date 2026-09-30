Rule packs are named, shareable sets of rules that encode the rules of the outside world: App Store Connect limits, Open Graph sizes, privacy disclosure law, basic graph hygiene. STARCHART ships four built-in packs: `core`, `appstore`, `privacy` and `seo`. This page lists every rule in each pack: its id, severity, what it checks (read from the source), a real violation message and how to fix it. It also explains how to write your own pack and load it from the CLI with `plugins:`, and where the community registry stands (not built yet).

## Enabling packs

List pack ids under `packs:` in `.starchart/config.yaml`. The default is `[core]`.

```yaml
# .starchart/config.yaml
packs: [core, appstore, privacy, seo]
```

`loadPacks` accepts three spellings for the same pack. Duplicates are ignored and order is preserved.

| You write | Loads |
|---|---|
| `appstore` | the `appstore` pack |
| `pack-appstore` | the `appstore` pack |
| `@starchart/pack-appstore` | the `appstore` pack |

The prefixed forms are stripped before lookup, so they resolve built-in packs and packs registered by [plugins](#loading-your-pack-with-plugins). A plugin pack is also found by its exact id as written. Nothing is fetched from npm. An unknown id makes `starchart rules` and `starchart privacy` exit 2:

```text
starchart: unknown rule pack(s): @starchart/pack-gdpr
```

The `starchart_rules` [MCP tool](MCP-Server) doesn't fail on unknown packs. It returns them in an `unknownPacks` array. `packs: []` disables every pack, including `core`.

Pack rules run alongside your own YAML rules (see [Rules Engine](Rules-Engine)), and their violations carry `pack: "<id>"`. The example messages below come from real runs against temp copies of `examples/pro-universe`. Some copies were modified on purpose to trip rules the demo passes, for example a retired offer, an oversized OG image or a mismatched Swift constant.

## core

Graph hygiene. Source: [`rules/packs/core.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/rules/packs/core.ts).

| Rule | Severity | Checks |
|---|---|---|
| `artifact-bound` | warn | Every artifact has a `binding`. |
| `promo-not-expired` | error | Every artifact that isn't `status: retired` has a `validThrough` that hasn't passed. |
| `promotes-active` | error | No live artifact `promotes` a retired or deprecated entity. |
| `fact-used` | info | Leaf facts that nothing depends on. |
| `anchor-matches` | error | Hardcoded code literals that anchor a fact still equal the fact value. |
| `no-dangling-edge` | error | Every edge points at nodes that exist. |
| `owners` | info | Once any node declares owners, every artifact has one. |

### artifact-bound

Declarative: `select: { kind: artifact }`, `require: { bound: true }`. Without a binding, STARCHART can't audit or update the artifact.

```text
warn  artifact-bound  privacy:appstore-label has no binding  (.starchart/artifacts/marketing.yaml)
```

**Fix:** add `binding: { adapter: …, … }` (see [Adapters Overview](Adapters-Overview)). If there's nothing to bind to, like an App Store privacy label, which has no API, accept the warning or leave `core` out of `packs:` and write your own version with a `whereNot` (see the `bound-except-labels` recipe on [Rules Engine](Rules-Engine#recipes)).

### promo-not-expired

Declarative: `select: { kind: artifact, whereNot: { status: retired } }`, `require: { notExpired: true }`. The name says promo, but it applies to **every** artifact with a `validThrough`. A bare date is valid through the end of that day (UTC).

```text
error promo-not-expired  reel:spring-2026 expired on 2026-06-30  (.starchart/artifacts/marketing.yaml)
```

**Fix:** take the promo down and set `status: retired`, or extend `validThrough`.

### promotes-active

For every `promotes` edge whose source isn't retired, it fails if the target's `status` is `retired` or `deprecated`.

```text
error promotes-active  web:blog-launch promotes addon:legacy, which is retired  (.starchart/artifacts/extra.yaml)
```

**Fix:** retire the promoting artifact, or point `promotes:` at the replacement offer.

### fact-used

Reports leaf facts (facts with no child facts) that nothing depends on. A fact counts as used when a non-`partOf` edge points at it, or at any of its containers or its entity, because a change to a fact propagates up through `partOf`. The compiler-generated `<entity>.status` fact is skipped.

```text
info  fact-used  app:nebula.appStoreId is not used by any code or artifact  (.starchart/entities/app.yaml)
```

**Fix:** bind the fact (an artifact `embeds` it, code `anchors` it) or delete it. The same check appears as `fact-unused` in [Orphans](Orphans).

### anchor-matches

For every `anchors` edge from a code-layer node to a fact, it compares the literal value in code with the fact value, numerically for numbers. Generated constants (`meta.generated`, from [Codegen](Codegen)) are skipped. The violation carries the source file.

```text
error anchor-matches  addon:pro.price.usd: code says 3.99, fact says 4.99 (apps/ios/Sources/Core/Pricing.swift:5)  (apps/ios/Sources/Core/Pricing.swift)
```

**Fix:** decide which side is right. If the fact is right, fix the literal, or better, replace it with a generated constant. If the code is right, change the fact in `.starchart/` and run `starchart plan`. See [Code Authority Facts](Code-Authority-Facts).

### no-dangling-edge

Every edge's `from` and `to` must exist. The loader warns about unknown targets at build time, and this rule turns that into a failing check.

```text
error no-dangling-edge  web:blog-launch --describes--> addon:ghost: "addon:ghost" does not exist  (.starchart/artifacts/extra.yaml)
```

**Fix:** correct the id (typos are the usual cause; see [Node IDs](Node-IDs)) or remove the edge.

### owners

Does nothing until at least one node in the graph has `owners`. After that, every artifact without owners is reported. This is the gentle, `info`-level version of an ownership policy. For a hard gate, use the `artifact-has-owner` recipe on [Rules Engine](Rules-Engine#recipes).

```text
info  owners  web:landing-hero has no owners  (.starchart/artifacts/web.yaml)
```

**Fix:** add `owners: ["@team"]`.

## appstore

App Store Connect rules. Source: [`rules/packs/appstore.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/rules/packs/appstore.ts).

Character limits (`APPSTORE_LIMITS`), counted in Unicode code points:

| Field | Limit |
|---|---:|
| `name` | 30 |
| `subtitle` | 30 |
| `promotionalText` | 170 |
| `description` | 4000 |
| `keywords` | 100 |
| `whatsNew` | 4000 |

| Rule | Severity | Checks |
|---|---|---|
| `appstore-listing-limits` | error | Listing entity facts fit the limits, in every locale. |
| `appstore-field-limits` | error | Field artifacts (`binding.field`) fit the limits. |
| `appstore-keywords-spacing` | warn | Keywords have no spaces after commas. |
| `appstore-screenshot-sets` | error | Required iPhone and iPad screenshot sizes are present, per locale. |
| `appstore-subscription-mirrored` | warn | Recurring offers are mirrored by a store product when the app sells in-app. |

### appstore-listing-limits

Declarative. It selects entities typed `sc:AppStoreListing` and applies `maxLength` to the facts `name`, `subtitle`, `promotionalText`, `description`, `keywords` and `whatsNew`. Missing facts are skipped. Locale maps are checked per locale.

```text
error appstore-listing-limits  listing:nebula name [en-US] "Nebula: Galaxy Planner & Focus Timer" is 36 chars (max 30)  (.starchart/entities/extra.yaml)
```

**Fix:** shorten that locale's copy in the entity YAML.

### appstore-field-limits

Applies to artifacts bound to the `appstore` adapter with a `binding.field`. Accepted field names are case-insensitive: `name`/`title`, `subtitle`, `promotionalText`/`promotional_text`, `description`, `keywords`, `whatsNew`/`whats_new`/`releaseNotes`/`release_notes`. The text comes from `meta.text`, or from the **single** fact the artifact `embeds`, `mirrors` or `renders` when that fact holds text or a locale map. When `binding.locale` is set, only that locale is checked. If the artifact links to several text facts, it is skipped.

```text
error appstore-field-limits  appstore:listing/subtitle-de subtitle "Plane deine Galaxie, einen Orbit nach dem anderen" is 49 chars (max 30)  (.starchart/artifacts/extra.yaml)
```

**Fix:** shorten the text, or the fact it carries.

### appstore-keywords-spacing

Checks `keywords` facts on listing entities, plus appstore artifacts whose field is `keywords`. Every space after a comma is a wasted character from the 100-character budget. Each locale is reported separately.

```text
warn  appstore-keywords-spacing  listing:nebula keywords [en-US] has spaces after commas (3 of 100 chars wasted)  (.starchart/entities/extra.yaml)
```

**Fix:** `planner,focus,timer,galaxy`.

### appstore-screenshot-sets

Looks at appstore artifacts with a `binding.set` and groups them by `binding.locale`. Sets are normalized from `"6.9"`, `6.9`, `'6.9"'`, `"6.9in"` or display types like `APP_IPHONE_69`. Sizes under 8 inches count as iPhone, 8 and up as iPad. For each locale:

- If there are iPhone sets, one must be 6.9", 6.7" or 6.5". App Store Connect accepts 6.7" in the 6.9" slot.
- If there are iPad sets, one must be 13" or 12.9".

The violation is attached to the first app entity (typed `sc:App`, `schema:MobileApplication` or `schema:SoftwareApplication`), or to a screenshot if there is none.

```text
error appstore-screenshot-sets  missing required iPhone 6.9" (or 6.5") screenshot set for de-DE; have 5.5"  (.starchart/entities/app.yaml)
```

**Fix:** add a 6.9" (or 6.7"/6.5") screenshot artifact for that locale.

### appstore-subscription-mirrored

Only runs when the app sells in-app: a RevenueCat package node exists (`pkg:swift/purchases-ios`, `pkg:npm/react-native-purchases`, `pkg:gradle/com.revenuecat.purchases:purchases`), or any artifact is bound to `appstore`. For every `schema:Offer` entity that isn't retired or deprecated and has a `billing` fact of `weekly`, `monthly`, `bimonthly`, `quarterly`, `semiannual`, `yearly`, `annual` or `annually`, it needs an incoming `mirrors` edge from an artifact bound to `appstore` or `playstore`, on the offer or any of its facts. There is no `playstore` adapter yet, but the binding name is honored.

```text
warn  appstore-subscription-mirrored  addon:team is a yearly subscription but no App Store or Play Store product mirrors it  (.starchart/entities/extra.yaml)
```

**Fix:** add an artifact such as `appstore:iap/team-yearly` with `binding: { adapter: appstore, product: … }` and `mirrors: [addon:team.price]`.

## privacy

Privacy drift: what your SDKs collect versus what your disclosures declare. Source: [`rules/packs/privacy.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/rules/packs/privacy.ts). The detection model, the SDK catalog and the fix-it walkthrough have their own page, [Privacy Drift](Privacy-Drift).

| Rule | Severity | Checks |
|---|---|---|
| `privacy-disclosed` | error | Every default data type of every detected SDK is declared in every disclosure for that platform. Also reports manifests that can't be parsed. |
| `privacy-tracking` | error | SDKs that track (ATT sense) need `NSPrivacyTracking = true` in manifests, and labels or policies must not say `tracking: false`. |
| `privacy-disclosure-exists` | warn | Each platform where SDKs collect data has at least one disclosure. The message says "collects" for one package, "collect" for several. |

```text
error privacy-disclosed  pkg:swift/sentry-cocoa collects CrashData but PrivacyInfo.xcprivacy (apps/ios/Resources/PrivacyInfo.xcprivacy) does not declare NSPrivacyCollectedDataTypeCrashData  (apps/ios/Resources/PrivacyInfo.xcprivacy)
error privacy-disclosed  pkg:swift/sentry-cocoa collects CrashData but privacy label privacy:appstore-label does not declare CrashData  (.starchart/artifacts/marketing.yaml)
error privacy-disclosed  cannot parse PrivacyInfo.xcprivacy (apps/ios/Widget/PrivacyInfo.xcprivacy): unknown element <maybe/> at offset 41  (apps/ios/Widget/PrivacyInfo.xcprivacy)
error privacy-tracking  pkg:npm/react-native-fbsdk-next tracks users but PrivacyInfo.xcprivacy (apps/ios/Resources/PrivacyInfo.xcprivacy) sets NSPrivacyTracking to false  (apps/ios/Resources/PrivacyInfo.xcprivacy)
error privacy-tracking  pkg:npm/react-native-fbsdk-next tracks users but privacy label privacy:appstore-label declares no tracking  (.starchart/artifacts/marketing.yaml)
warn  privacy-disclosure-exists  pkg:npm/@sentry/nextjs, pkg:npm/posthog-js collect CrashData, DeviceID, OtherDiagnosticData, PerformanceData, ProductInteraction on web but no disclosure exists; add a privacy policy (sc:PrivacyPolicy with meta.declares)
```

**Fix:** declare the missing data type in the named disclosure (the message gives the exact manifest key), set the tracking flags to the truth, or add the missing disclosure. If the catalog is wrong for your setup, override it per package. All of this is covered in [Privacy Drift](Privacy-Drift#fixing-each-finding).

## seo

Source: [`rules/packs/seo.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/rules/packs/seo.ts).

| Rule | Severity | Checks |
|---|---|---|
| `seo-og-image-size` | warn | Open Graph images are 1200x630. |
| `seo-jsonld-renders-entity` | info | JSON-LD artifacts render an entity, so structured data can't drift. |
| `seo-meta-length` | warn | Web page titles fit 60 chars and meta descriptions 160 chars. |

### seo-og-image-size

Applies to artifacts typed `schema:ImageObject` that are tagged `og` or have `og` as a standalone word in their id (`web:og-pro`). It reads `meta.width` and `meta.height`, skips the artifact if both are missing, and requires exactly 1200 by 630.

```text
warn  seo-og-image-size  web:og-team is 1024x512, Open Graph images should be 1200x630  (.starchart/artifacts/extra.yaml)
```

**Fix:** re-render at 1200x630 and update `meta`.

### seo-jsonld-renders-entity

Applies to artifacts typed `sc:JsonLd`, `sc:JSONLD` or `sc:StructuredData`, or tagged `jsonld` / `json-ld`. Each needs an outgoing `renders` edge to an entity, or to a fact that belongs to an entity.

```text
info  seo-jsonld-renders-entity  web:jsonld-pro is JSON-LD but does not render any entity; add renders: <entity>  (.starchart/artifacts/extra.yaml)
```

**Fix:** `renders: addon:pro`. `starchart emit jsonld --entity addon:pro` produces the markup (see [JSON-LD and SEO](JSON-LD-and-SEO)).

### seo-meta-length

Applies to artifacts typed `schema:WebPage`. It checks `meta.title` (max 60) and `meta.description` (max 160) when they are strings.

```text
warn  seo-meta-length  web:blog-launch title "Nebula Pro is here: themes, widgets, sync and everything you asked for" is 70 chars (max 60)  (.starchart/artifacts/extra.yaml)
```

**Fix:** shorten the copy.

## Writing a pack

A pack is a plain object:

```ts
interface RulePack {
  id: string;
  description: string;
  rules: Rule[]; // declarative rules (defineRule) and/or custom rules ({ id, severity, check })
}
```

Built-in packs set `pack: "<id>"` on each rule so violations are labelled. A small example:

```ts
import { defineRule, type RulePack } from "@space-pirate-zero/starchart";

const PACK = "growth";

export const pack: RulePack = {
  id: PACK,
  description: "Growth team conventions",
  rules: [
    defineRule({
      id: "growth-promo-owned",
      pack: PACK,
      severity: "warn",
      select: { kind: "artifact", tag: "promo" },
      require: { owners: true, notExpired: true },
    }),
    {
      id: "growth-one-hero",
      pack: PACK,
      severity: "error",
      check(graph) {
        const heroes = graph.nodes({ kind: "artifact" }).filter((n) => n.tags?.includes("hero"));
        return heroes.length > 1 ? heroes.map((n) => ({ node: n.id, message: `${n.id}: more than one hero artifact` })) : [];
      },
    },
  ],
};
```

Custom rules get a `RuleContext` with `now`, `lock`, `root` and a per-evaluation `cache`. The privacy pack uses the cache to parse manifests once for all three rules. See [Rules Engine](Rules-Engine#custom-typescript-rules).

Rules in a pack don't get `pack` stamped for you. Set it on each rule, or violations come out unlabelled.

### Loading your pack with plugins

Export the pack from an ES module, list the module under `plugins:`, and add the pack id to `packs:`:

```yaml
# .starchart/config.yaml
packs: [core, appstore, privacy, seo, house]
plugins: [./plugins/example.mjs]
```

```js
// plugins/example.mjs (the rule part; the full file also ships an adapter)
const house = {
  id: "house",
  description: "House conventions",
  rules: [
    {
      id: "house-json-owned",
      pack: "house",
      severity: "warn",
      check(graph) {
        return graph
          .nodes({ kind: "artifact" })
          .filter((n) => n.binding?.adapter === "jsonfile" && !n.owners?.length)
          .map((n) => ({ node: n.id, message: `${n.id} has no owners` }));
      },
    },
  ],
};

export const packs = [house];
```

Real run on a copy of the demo with that plugin:

```text
$ starchart rules
…
warn  artifact-bound  privacy:appstore-label has no binding  (.starchart/artifacts/marketing.yaml)
warn  house-json-owned  json:pricing-pro has no owners  (.starchart/artifacts/json.yaml)
…
9 error · 3 warn · 5 info
```

The rules:

- Relative paths resolve from the project root. Bare names (`starchart-pack-house`) resolve from the project's `node_modules`, so publishing a pack is publishing an npm package that exports `packs`.
- `packs` can be a named export or live on the default export.
- The loader calls `registerPack` for each pack. A plugin pack can't take the id of a built-in (`core`, `appstore`, `privacy`, `seo`): loading fails with `rule pack "core" is built in and cannot be replaced` and exit code 2.
- A registered pack does nothing until its id is in `packs:`.
- To import `defineRule` in a pack module, the project needs `@space-pirate-zero/starchart` installed where the plugin can resolve it. A plain object with `check` needs no imports at all.
- Duplicate rule ids across packs and your YAML rules are still not detected. Both run. Prefix pack rule ids with the pack id.

Plugins load in `buildProject`, so the pack also runs in the `starchart_rules` [MCP tool](MCP-Server) and the [Claude Code Hook](Claude-Code-Hook). Details on the loader and its error messages: [Writing an Adapter](Writing-an-Adapter#plugins).

From a script you can still skip the config: `registerPack(pack)` and then `loadPacks([...config.packs, pack.id])`, or pass `pack.rules` straight to `evaluateRules` (see [Library API](Library-API#rules)).

Contributing a pack upstream (a new file in `rules/packs/` plus an entry in `PACKS`) makes it available to everyone without a plugin. See [Contributing](Contributing).

## The community registry (not built yet)

The plan is a registry of community-maintained packs that encode the outside world, so that when Apple adds a required screenshot size, one pack update tells every STARCHART user which sets they're missing. Planned packs include `pack-playstore`, `pack-stripe` and `pack-gdpr`, plus per-SDK packs that declare what each SDK collects, with vendors able to publish their own. The `@starchart/pack-<id>` naming that `loadPacks` already accepts is reserved for this.

**Status:** not built. There is no hosted registry and no remote loading. The `@starchart/pack-<id>` names map to built-in packs or to packs a plugin has already registered; STARCHART never installs anything itself. See [Roadmap](Roadmap).

## See also

- [Rules Engine](Rules-Engine)
- [Privacy Drift](Privacy-Drift)
- [Configuration](Configuration)
- [JSON-LD and SEO](JSON-LD-and-SEO)
- [Roadmap](Roadmap)
