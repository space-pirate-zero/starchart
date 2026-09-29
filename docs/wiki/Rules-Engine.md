The rules engine is ESLint for your business. You write invariants over the graph ("every paid offer is mirrored in Stripe and the App Store", "the App Store name fits 30 characters in every locale") and `starchart rules` fails CI when reality breaks them. This page is the complete reference for declarative YAML rules, generated from the zod schemas in [`rules/engine.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/rules/engine.ts). It covers what each predicate actually checks, per-locale checks, custom TypeScript rules, validation errors and the violation format. It ends with a set of recipes that were run against a copy of the demo.

## Where rules live

Put rules in any YAML file under `.starchart/`, except `config.yaml`, under a top-level `rules:` key. The loader collects `rules:` entries from every file and stamps each one with the file it came from. That file shows up in validation errors and, as a fallback, in violations.

```yaml
# .starchart/rules.yaml
rules:
  - id: offer-mirrored-in-stores
    description: Every paid offer is mirrored in Stripe and the App Store
    severity: error
    select: { kind: entity, type: schema:Offer }
    require:
      edge:
        - { type: mirrors, direction: in, adapter: stripe }
        - { type: mirrors, direction: in, adapter: appstore }
```

A bare top-level list, with no `rules:` key, is read as artifacts, not rules. Always use the `rules:` key.

`starchart rules` runs these project rules together with every rule from the packs listed under `packs:` in `config.yaml` (default `[core]`). See [Rule Packs](Rule-Packs).

## Rule shape

Every rule is a mapping with exactly these keys. Unknown keys are rejected: every object in the schema is strict.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `id` | string | required | Slug matching `^[A-Za-z0-9][\w.:/-]*$` (letters, digits, `- _ . : /`). Must be unique across your YAML rules. |
| `description` | string | none | Human description. |
| `severity` | `error` \| `warn` \| `info` | `error` | Only `error` makes `starchart rules` exit 1. |
| `select` | [Selector](#select) | `{}` (every node) | Which nodes the rule applies to. |
| `require` | [Requirements](#require) | required | What every selected node must satisfy. Needs at least one predicate. |
| `pack` | string | none | Label attached to violations. Pack rules set this for you. |
| `file` | string | set by the loader | Source file. The loader overwrites it with the real YAML path. |

Anywhere the schema accepts a list (`kind`, `type`, `prefix`, `tag`, `adapter`, `edge`, `value`, `reachable`), you can also write a single item. It is wrapped into a one-element list, so `type: schema:Offer` and `type: [schema:Offer]` are the same.

## select

A selector filters the compiled graph nodes. Every field you set must match (AND). Inside a list field, any entry may match (OR). An empty selector selects every node. Selected nodes are evaluated in id order.

| Field | Matches when | Notes |
|---|---|---|
| `kind` | `node.kind` is in the list | `entity`, `fact`, `artifact`, `file`, `symbol`, `package`, `route`, `screen`, `flag`, `env`, `event`, `i18n`, `test`. See [Node IDs](Node-IDs). |
| `type` | any of the node's JSON-LD `types` is in the list | `schema:Offer`, `sc:AppStoreListing`, `schema:WebPage`, and so on. |
| `prefix` | the node id starts with any entry | A plain string prefix, not a glob: `screen:ios/Onboarding` matches `screen:ios/OnboardingWelcome`. |
| `tag` | any node tag is in the list | Tags come from `tags:` in YAML. |
| `adapter` | `node.binding.adapter` is in the list | Unbound nodes never match. |
| `where` | every `path: expected` pair matches | See below. |
| `whereNot` | no `path: expected` pair matches | Excludes a node if any single pair matches. |

`where` and `whereNot` keys are dotted paths into the compiled node: `status`, `binding.adapter`, `binding.locale`, `meta.publishedAt`, `types`, `owners`, `validThrough`. They address the graph node, not the YAML document, so the YAML key `type:` is `types` here. Matching rules:

- Scalars compare with structural equality. Numbers compare numerically, so `"4.99"` equals `4.99`.
- A list on the rule side means "any of": `whereNot: { status: [retired, deprecated] }`.
- A list on the node side means "contains": `whereNot: { types: sc:PrivacyLabel }` excludes privacy labels.
- A missing field is `undefined`. It never equals a value you can write in YAML, `null` included.

## require

At least one predicate must be set to something other than `false`. Every selected node is checked against every predicate, and each failure is one violation.

### bound

```yaml
require: { bound: true }
```

Fails when the node has no `binding`. Message: `<id> has no binding`.

### owners

```yaml
require: { owners: true }
```

Fails when `owners` is missing or empty. Message: `<id> has no owners`.

### notExpired

```yaml
require: { notExpired: true }
```

Fails when `validThrough` is in the past. A bare date (`2026-06-30`) stays valid through the end of that day (UTC). A full timestamp expires at that instant. A missing or unparseable `validThrough` never fails. Message: `<id> expired on <validThrough>`.

### maxAge

```yaml
require:
  maxAge: { field: meta.publishedAt, days: 90 }
```

Reads the dotted `field` from the node and parses it as a date. It fails when:

- the field is missing or not a valid date: `<id> has no valid meta.publishedAt (maxAge 90d)`
- the age in whole days (floored) is greater than `days`: `<id> meta.publishedAt is 212 days old (max 90)`

`days` must be positive. `maxAge` only looks backwards. A date in the future has a negative age and always passes, so it can't say "ends within 90 days from now". That needs a [custom rule](#custom-typescript-rules).

### edge

```yaml
require:
  edge:
    - { type: mirrors, direction: in, adapter: stripe, min: 1, max: 1 }
```

Counts the distinct nodes on the other end of edges of one type.

| Field | Default | Meaning |
|---|---|---|
| `type` | required | Any edge type from [Edge Types](Edge-Types). Unknown types fail validation. |
| `direction` | `out` | `out` counts edges from the node. `in` counts edges into it. |
| `min` | `1` | Non-negative integer. |
| `max` | none | Must be `>= min`. |
| `adapter` | none | Count only other ends that are **artifacts** bound to this adapter. |
| `to` | none | Id pattern the **other end** must match: the target for `out`, the **source** for `in`. Exact id, or a prefix when it ends in `*`. Other `*` act as wildcards. |
| `via` | `true` for entities, `false` otherwise | For `direction: in` only. Also count edges into every descendant fact (through `partOf`). Accepts `true`/`false` or `"fact"`/`"none"`. |

Remember the edge direction convention: `from` depends on `to`. An artifact embeds a fact, so the edge is `artifact --embeds--> fact`. "The pricing page embeds this fact" is an **incoming** `embeds` edge on the fact.

`via` is why the demo's offer rule passes. `stripe:price/pro-monthly` mirrors `addon:pro.price.usd`, not `addon:pro`. Because `addon:pro` is an entity, incoming edges into its facts count too.

Messages:

```text
screen:ios/Paywall has 1 incoming captures from an appstore artifact (min 2)
addon:team has 0 incoming mirrors from a stripe artifact (min 1)
<id> has 3 outgoing embeds (max 2): a, b, c
```

### reachable

```yaml
require:
  reachable: { from: "symbol:ios/*", edge: anchors, min: 1 }
```

Counts distinct existing nodes whose id matches `from` (same pattern syntax as `edge.to`) with a **direct** edge of type `edge` into the selected node. Despite the name, this is not transitive: it looks one hop back. `min` defaults to 1 and must be positive. Unlike `edge`, it never looks through facts. Message: `<id> is reached by 0 symbol:ios/* node(s) via anchors (min 1)`.

### value

```yaml
require:
  value:
    - { fact: name, maxLength: 30, locales: [en-US, ja] }
```

Checks a value. Without `fact`, it checks the selected node's own `value` (leaf facts, container facts, `i18n` strings, code constants). With `fact`, it checks the node `<selected id>.<fact>`, so `fact: price.usd` on `addon:pro` reads `addon:pro.price.usd`. Each constraint needs at least one of `required`, `maxLength`, `minLength`, `pattern`, `equals`, `oneOf`.

| Field | Check | Message |
|---|---|---|
| `required: true` | The value is not missing or `null`. If the value is missing and `required` is not set, every other check is skipped silently. | `<subject> has no value` |
| `maxLength` / `minLength` | The value is text, and its length in Unicode code points (what stores count) is within bounds. | `<subject> "…" is 36 chars (max 30)` or `<subject> is 4.99, expected text` |
| `pattern` | A JavaScript regex tested against the value. Numbers are stringified (`4.99` → `"4.99"`), objects JSON-encoded. Unanchored unless you add `^…$`. | `<subject> 5.49 does not match /^\d+\.99$/` |
| `equals` | Structural equality (numeric strings equal numbers). | `<subject> is "weekly", expected "monthly"` |
| `oneOf` | Equal to any entry. | `<subject> is "weekly", expected one of "monthly", "yearly"` |
| `locales` | `all`, or a list of required locales (see below). | `<subject> is missing locale ja` |

`<subject>` is `<id>` or `<id> <fact>`, with ` [<locale>]` appended for per-locale checks. Long values are cut to 80 characters in messages.

### Per-locale checks

A value that is a non-empty mapping whose values are all strings or numbers counts as a locale map, for example `{ en-US: "Nebula", ja: "ネビュラ" }`. Localized facts and `i18n` nodes look like this. For a locale map, every check runs once per locale:

- `locales` omitted or `locales: all` checks every locale present, in sorted order.
- `locales: [en-US, ja]` checks exactly those locales and reports `is missing locale <x>` for any that are absent. Use this to enforce "all shipped locales".
- `equals` with a locale-map value and no `locales` compares the whole map instead of going per locale.

The engine can't tell locales from other keys. `price: { usd: 4.99, eur: 4.99 }` is also a "locale map", so a `maxLength` on it runs per currency. Scalar values ignore `locales`.

## Custom TypeScript rules

Some invariants aren't declarative: forward-looking dates, cross-node comparisons, reading files. A custom rule is an object with a `check` function:

```ts
interface CustomRule {
  id: string;
  severity: "error" | "warn" | "info"; // parseRules defaults a missing severity to "error"
  description?: string;
  pack?: string;
  check(graph: Graph, ctx: RuleContext): Finding[];
}

interface RuleContext {
  now: Date;
  lock?: LockFile;
  root?: string;                 // project root, for rules that read files
  cache: Map<string, unknown>;   // shared by all rules in one evaluation
  rule: { id: string; severity: Severity; pack?: string };
}

// Finding = { node, message } plus optional rule, severity, pack, file overrides
```

`defineRule(input)` validates a declarative rule written in TS and throws `invalid rule <id>: …` on bad input. Built-in packs use it.

To run custom rules from the CLI, put them in a rule pack, export it from a plugin module, and list the module under `plugins:` and the pack id under `packs:` in `config.yaml`. The module must be JavaScript (the loader uses plain `import()`). The walkthrough, with real output, is on [Rule Packs](Rule-Packs#loading-your-pack-with-plugins):

```js
// plugins/house.mjs: promoHorizon is the rule from the script below
export const packs = [{ id: "house", description: "House conventions", rules: [{ ...promoHorizon, pack: "house" }] }];
```

```yaml
packs: [core, house]
plugins: [./plugins/house.mjs]
```

Without a plugin, run them through the [Library API](Library-API). This script was run against the demo:

```ts
import { buildProject, defineRule, evaluateRules, loadPacks, parseRules } from "@spz/starchart";

const DAY = 86_400_000;

// "Promos end within 90 days" can't be declarative: maxAge only looks backwards.
const promoHorizon = {
  id: "promo-ends-within-90d",
  severity: "warn" as const,
  check(graph, ctx) {
    const horizon = ctx.now.getTime() + 90 * DAY;
    return graph
      .nodes({ kind: "artifact" })
      .filter((n) => n.status !== "retired" && graph.outgoing(n.id, "promotes").length > 0)
      .filter((n) => !n.validThrough || Date.parse(n.validThrough) > horizon)
      .map((n) => ({ node: n.id, message: `${n.id} ends ${n.validThrough ?? "never"}; promos must end within 90 days` }));
  },
};

const project = await buildProject(process.cwd());
const { rules: declared, errors } = parseRules(project.loaded.rules);
if (errors.length) throw new Error(errors.join("\n"));
const { rules: packRules } = loadPacks(project.loaded.config.packs);

const violations = evaluateRules(project.graph, [...packRules, ...declared, promoHorizon], {
  lock: project.lock,
  root: project.root,
  now: new Date("2026-03-01"),
});
```

```text
{
  rule: 'promo-ends-within-90d',
  severity: 'warn',
  node: 'reel:spring-2026',
  message: 'reel:spring-2026 ends 2026-06-30; promos must end within 90 days',
  file: '.starchart/artifacts/marketing.yaml'
}
```

`CustomRule`, `Finding` and `RuleContext` aren't re-exported from the package root. `Rule`, `RulePack` and `Violation` are. A plain object with a `check` function type-checks as a `Rule`.

## Validation errors

Invalid rules stop `starchart rules` before any evaluation. The message goes to stderr and the exit code is **2**. Each problem is `<file>: rule "<id>": <path>: <message>`, and every problem in a rule is listed. A real run with a deliberately broken file:

```text
starchart: invalid rules:
  .starchart/bad.yaml: rule "bad edge": id: rule id must be a slug (letters, digits, - _ . : /); select: Unrecognized key: "colour"; require.edge.0.type: unknown edge type; require.edge.0: max must be >= min
  .starchart/bad.yaml: rule "no-preds": require: require must list at least one predicate
  .starchart/bad.yaml: rule "bad-value": require.value.0: value needs at least one of maxLength, minLength, pattern, equals, oneOf, required
  .starchart/bad.yaml: rule "bad-regex": require.value.0.pattern: invalid regular expression
  .starchart/recipes.yaml: rule "artifact-has-owner": duplicate rule id (first declared in .starchart/bad.yaml)
```

A rule without an id is labelled by position (`rule #3`). An unknown pack in `packs:` also exits 2: `starchart: unknown rule pack(s): @starchart/pack-gdpr`.

Duplicate ids are only detected among your YAML rules. A YAML rule that reuses a pack rule id, such as `owners`, is not rejected, and both run. The same goes for two packs (built-in or from plugins) that share a rule id.

## Violations

```ts
interface Violation {
  rule: string;       // rule id
  severity: "error" | "warn" | "info";
  node: string;       // the node the finding is about
  message: string;
  pack?: string;      // e.g. "core", "privacy"
  file?: string;      // where to go fix it
}
```

`file` resolves in this order: the finding's own `file`, then the node's YAML file (`meta.file`), its source location, or `meta.path`, then the rule's YAML file. Identical findings (same rule, node and message) are deduplicated. Output is sorted by severity (error, warn, info), then rule id, node id and message.

## starchart rules

```bash
starchart rules                 # text (default)
starchart rules -f markdown     # a table for PR comments
starchart rules -f json         # Violation[]
```

Exit codes: **0** when there are no `error` violations (warnings and info are fine), **1** when any `error` violation exists, **2** on invalid rules or unknown packs.

Text output from the demo (`examples/pro-universe`, packs `core, appstore, privacy, seo`):

```text
error privacy-disclosed  pkg:swift/purchases-ios collects DeviceID but PrivacyInfo.xcprivacy (apps/ios/Resources/PrivacyInfo.xcprivacy) does not declare NSPrivacyCollectedDataTypeDeviceID  (apps/ios/Resources/PrivacyInfo.xcprivacy)
…
error promo-not-expired  reel:spring-2026 expired on 2026-06-30  (.starchart/artifacts/marketing.yaml)
warn  artifact-bound  privacy:appstore-label has no binding  (.starchart/artifacts/marketing.yaml)
warn  privacy-disclosure-exists  pkg:npm/@sentry/nextjs, pkg:npm/posthog-js collect CrashData, DeviceID, OtherDiagnosticData, PerformanceData, ProductInteraction on web but no disclosure exists; add a privacy policy (sc:PrivacyPolicy with meta.declares)
info  fact-used  app:nebula.appStoreId is not used by any code or artifact  (.starchart/entities/app.yaml)
…
9 error · 2 warn · 4 info
```

Markdown:

```text
| Severity | Rule | Finding |
|---|---|---|
| error | `privacy-disclosed` | pkg:swift/purchases-ios collects DeviceID but PrivacyInfo.xcprivacy (apps/ios/Resources/PrivacyInfo.xcprivacy) does not declare NSPrivacyCollectedDataTypeDeviceID |
…
```

JSON:

```json
[
  {
    "rule": "privacy-disclosed",
    "severity": "error",
    "node": "pkg:swift/purchases-ios",
    "message": "pkg:swift/purchases-ios collects DeviceID but PrivacyInfo.xcprivacy (apps/ios/Resources/PrivacyInfo.xcprivacy) does not declare NSPrivacyCollectedDataTypeDeviceID",
    "pack": "privacy",
    "file": "apps/ios/Resources/PrivacyInfo.xcprivacy"
  }
]
```

The same evaluation is available to agents as the `starchart_rules` [MCP tool](MCP-Server).

## The demo's rules.yaml, explained

[`examples/pro-universe/.starchart/rules.yaml`](https://github.com/space-pirate-zero/starchart/blob/main/examples/pro-universe/.starchart/rules.yaml) has two rules. Both pass on the demo.

```yaml
rules:
  - id: offer-mirrored-in-stores
    description: Every paid offer is mirrored in Stripe and the App Store
    severity: error
    select: { kind: entity, type: schema:Offer }
    require:
      edge:
        - { type: mirrors, direction: in, adapter: stripe }
        - { type: mirrors, direction: in, adapter: appstore }
```

- `select` picks every entity typed `schema:Offer`, which is `addon:pro` in the demo.
- Each `edge` entry needs at least one (default `min: 1`) incoming `mirrors` edge from an artifact bound to that adapter.
- `addon:pro` is an entity, so `via` defaults to on. `stripe:price/pro-monthly` mirrors `addon:pro.price.usd` and `appstore:iap/pro-monthly` mirrors `addon:pro.price`, and both count.
- It has no status filter. Add a retired offer and it fails (`addon:legacy has 0 incoming mirrors from a stripe artifact (min 1)`). The `offer-mirrored-once` recipe below adds `whereNot: { status: [retired, deprecated] }`.

```yaml
  - id: paywall-has-screenshot
    description: The paywall screen must appear in a store screenshot
    severity: warn
    select: { prefix: "screen:ios/Paywall" }
    require:
      edge: { type: captures, direction: in, min: 1 }
```

- `select` uses an id prefix to pick the SwiftUI screen node `screen:ios/Paywall`, which comes from code ingestion.
- `captures` edges run from the artifact to the screen, so this counts incoming `captures`. The demo has two: the App Store screenshot and the promo reel. The rule doesn't set `adapter`, so the reel counts too.

## Recipes

Every recipe below was added to a temp copy of the demo (with `packs: []` to cut noise) and run with `starchart rules`. Each one parses. The real findings are shown after the block.

```yaml
rules:
  # The pricing page describes the Pro feature list (features is a code-authority fact).
  - id: pricing-page-lists-pro-features
    description: The pricing page describes the Pro feature list
    select: { kind: fact, prefix: "addon:pro.features" }
    require:
      edge: { type: describes, direction: in, to: web:pricing-page }

  # If you model each feature as an entity: every one is on a pricing page.
  - id: feature-on-pricing-page
    description: Every feature entity is embedded (directly or via its facts) on the pricing page
    select: { kind: entity, prefix: "feature:" }
    require:
      edge: { type: embeds, direction: in, to: "web:pricing*" }

  # Promos carry a launch date and run at most 90 days past it.
  - id: promo-max-90-days
    description: Promos have an end date and run at most 90 days after launch
    severity: warn
    select: { kind: artifact, type: schema:VideoObject, whereNot: { status: retired } }
    require:
      notExpired: true
      maxAge: { field: meta.publishedAt, days: 90 }

  # Every onboarding screen has App Store screenshots: one per shipped locale (2 here).
  - id: onboarding-screens-have-screenshots
    description: Every onboarding screen appears in App Store screenshots (one per shipped locale)
    select: { kind: screen, prefix: ["screen:ios/Onboarding", "screen:ios/Paywall"] }
    require:
      edge: { type: captures, direction: in, adapter: appstore, min: 2 }

  # Every live offer: exactly one Stripe price, at least one App Store product.
  - id: offer-mirrored-once
    description: Every active offer has exactly one Stripe price and at least one App Store product
    select: { kind: entity, type: schema:Offer, whereNot: { status: [retired, deprecated] } }
    require:
      edge:
        - { type: mirrors, direction: in, adapter: stripe, min: 1, max: 1 }
        - { type: mirrors, direction: in, adapter: appstore }

  # App Store name and subtitle fit 30 chars per locale.
  - id: appstore-name-30
    description: App Store name and subtitle fit 30 characters in every shipped locale
    select: { kind: entity, type: sc:AppStoreListing }
    require:
      value:
        - { fact: name, maxLength: 30, locales: [en-US, ja] }
        - { fact: subtitle, maxLength: 30, locales: all }

  # Every world artifact has an owner (stricter than core's `owners`, which is info-level).
  - id: artifact-has-owner
    description: Every world artifact has an owner
    select: { kind: artifact }
    require: { owners: true }

  # Charm pricing: every Pro price ends in .99.
  - id: charm-pricing
    severity: info
    select: { kind: fact, prefix: "addon:pro.price." }
    require:
      value: { pattern: '^\d+\.99$' }

  # Offers bill on a known period and use the product id convention.
  - id: billing-period
    select: { kind: entity, type: schema:Offer }
    require:
      value:
        - { fact: billing, required: true, oneOf: [monthly, yearly] }
        - { fact: productId, pattern: '^nebula_[a-z_]+$' }

  # The iOS app reads the USD price from a constant that anchors the fact.
  - id: price-anchored-in-ios
    description: The iOS app reads the USD price from a constant, not a guess
    select: { kind: fact, prefix: "addon:pro.price.usd" }
    require:
      reachable: { from: "symbol:ios/*", edge: anchors, min: 1 }

  # Every UI string ships in every locale.
  - id: strings-localized
    severity: warn
    select: { kind: i18n, prefix: "i18n:" }
    require:
      value: { locales: [en, ja], minLength: 1 }

  # Every artifact is bound except privacy labels (which have no API to bind to).
  - id: bound-except-labels
    severity: warn
    select: { kind: artifact, whereNot: { types: sc:PrivacyLabel } }
    require: { bound: true }
```

To exercise `appstore-name-30`, the test copy also got a listing entity:

```yaml
# .starchart/entities/listing.yaml
id: listing:nebula
type: [sc:AppStoreListing]
facts:
  name:
    en-US: Nebula
    ja: ネビュラ
  subtitle:
    en-US: Plan your galaxy, one orbit at a time
```

Real output:

```text
error appstore-name-30  listing:nebula subtitle [en-US] "Plan your galaxy, one orbit at a time" is 37 chars (max 30)  (.starchart/entities/listing.yaml)
error onboarding-screens-have-screenshots  screen:ios/Paywall has 1 incoming captures from an appstore artifact (min 2)  (apps/ios/Sources/Paywall/PaywallView.swift)
warn  promo-max-90-days  reel:spring-2026 expired on 2026-06-30  (.starchart/artifacts/marketing.yaml)
warn  promo-max-90-days  reel:spring-2026 has no valid meta.publishedAt (maxAge 90d)  (.starchart/artifacts/marketing.yaml)
warn  strings-localized  i18n:web/pricing.cta is missing locale ja  (apps/web/messages/en.json)
warn  strings-localized  i18n:web/pricing.title is missing locale ja  (apps/web/messages/en.json)
2 error · 4 warn · 0 info
```

Notes on the recipes:

- **Screenshots per locale.** Edge rules count edges. They can't group screenshots by `binding.locale`. `min: <number of locales>` is a proxy. For a strict per-locale check, write a custom rule. The `appstore` pack's `appstore-screenshot-sets` already groups by locale for required device sizes.
- **Feature lists.** `addon:pro.features` is one fact holding a list, so a rule can check that the pricing page is linked to it, not that each list item appears on the page. For per-feature checks, model features as entities (`feature:*`) and use `feature-on-pricing-page`, which selects nothing in the demo.
- **Forward-looking expiry** ("ends within 90 days from today") needs the custom rule shown [above](#custom-typescript-rules).

## See also

- [Rule Packs](Rule-Packs)
- [Privacy Drift](Privacy-Drift)
- [Edge Types](Edge-Types)
- [Authoring YAML](Authoring-YAML)
- [GitHub Action](GitHub-Action)
