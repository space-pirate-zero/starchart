Artifacts are the world layer: every page, listing, screenshot, price, email or video that shows your facts. This page is the field-by-field reference for artifact documents (the `ArtifactDoc` schema in [`config/schema.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/config/schema.ts)), how each field compiles into edges ([`compiler/compile.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/compiler/compile.ts)), the three forms of `renders`, `publishedBy`, `after`/`blocks`, bindings per adapter, and how `type` changes classification.

## A complete artifact

```yaml
artifacts:
  - id: web:og-pro                       # node id (kind artifact, layer world)
    type: schema:ImageObject             # media type: embeds become manual, renders stay auto
    label: OG image for Pro
    tags: [og]
    binding: { adapter: fs, path: apps/web/public/og/pro.png }
    renders: { template: apps/web/og/pro.svg, with: [addon:pro.name, addon:pro.price.usd] }
    meta: { width: 1200, height: 630 }
    owners: ["@zero"]
```

## Field reference

Fields marked "string or list" accept a single string or a YAML list; the schema normalises both to a list.

| Field | Type | Compiles to | Notes |
|---|---|---|---|
| `id` | string, required | node id | Convention: `<system>:<path>` (`web:pricing-page`, `appstore:screenshots/6.9/03`). |
| `kind` | `"artifact"` | — | Optional. A standalone doc without `kind: entity` or `facts` is an artifact anyway. |
| `type` | string or list | `types` | JSON-LD types. Media types change classification (below). |
| `label` | string | `label` | Human name in plans and the viewer. |
| `binding` | mapping with `adapter` | `binding` | Where the artifact lives. Any extra keys are kept. See [Bindings](#bindings). |
| `owners` | list | `owners` | |
| `status` | string | `status` | Stored. The classifier reads `status: retired` on **entities** in the path, not on the artifact itself. |
| `validThrough` | string (date) | `validThrough` | Once in the past, every impact on this artifact is classed `retire`. |
| `tags` | list | `tags` | |
| `embeds` | string or list | `artifact --embeds--> target` | The value appears literally (price text on a page). |
| `renders` | string, list or `{template, with, out}` | `artifact --renders--> target` | Regenerated from a template. See [renders](#renders). |
| `describes` | string or list | `artifact --describes--> target` | Semantic mention; always `review`. |
| `promotes` | string or list | `artifact --promotes--> target` | Marketing claim; always `review` (or `retire`). |
| `mirrors` | string or list | `artifact --mirrors--> target` | A copy in an external system (Stripe price, IAP). |
| `derivedFrom` | string or list | `artifact --derivedFrom--> target` | Built from another artifact. |
| `captures` | string or list | `artifact --captures--> target` | Shows a screen (screenshot, video). Target is usually `screen:<scope>/<Name>`. |
| `after` | string or list | `artifact --after--> target` | Rollout ordering only. |
| `blocks` | string or list | `artifact --blocks--> target` | Rollout ordering only. |
| `publishedBy` | string or list | `route --publishes--> artifact` | Note the reversed direction. |
| `meta` | mapping | `meta` | Free-form. The compiler adds `meta.file`, plus `meta.template`/`meta.templateOut` for templated renders. |

Every declared edge gets `origin: "declared"` and no explicit confidence (treated as 1). Targets that don't exist after ingest produce a warning like:

```text
warn .starchart/bad.yaml: web:landing-hero --describes--> addon:nope: unknown node "addon:nope"
```

## renders

`renders` accepts three shapes:

```yaml
renders: addon:pro.name                               # one target
renders: [addon:pro.name, addon:pro.price.usd]        # several targets
renders:                                              # template form
  template: apps/web/og/pro.svg                       # stored as meta.template
  with: [addon:pro.name, addon:pro.price.usd]         # string or list → renders edges
  out: apps/web/public/og/pro.png                     # optional, stored as meta.templateOut
```

The template form is what lets the [fs adapter](Adapter-fs) regenerate the file (an `.svg` template targeting a `.png` path is rasterized). An impact that arrives via `renders` is always classed `auto`, whatever the artifact's type or adapter: the assumption is that the template can be re-run.

## publishedBy

`publishedBy: route:web/pricing` adds `route:web/pricing --publishes--> web:pricing-page`. `publishes` propagates **forward**, so a change to the route's code impacts the published artifact, which is classed `review` ("published page changed"). This is how a Next.js page edit reaches the page artifact that describes it.

## after and blocks

`A after B` and `B blocks A` both mean "B runs before A" in the rollout order. They never propagate impact and only matter when both artifacts are in the same plan. See [Rollout Ordering](Rollout-Ordering).

```yaml
- id: web:live-pricing
  binding: { adapter: url, url: /pricing }
  embeds: [addon:pro.price.usd]
  after: [web:pricing-page]          # check the live page only after the source page is fixed
```

## Bindings

A binding is a mapping with an `adapter` key plus whatever that adapter needs. STARCHART ships four adapters, and [plugins](Writing-an-Adapter) listed under `plugins:` in the config can register more. Any other name (`youtube`, `email`, …) is allowed as a label, but nothing can read or write it, so `embeds` and `mirrors` impacts on it are `manual`.

| Adapter | Binding keys | Writes by default? | Page |
|---|---|---|---|
| `fs` | `path` (root-relative), optional `selector` (`json:$.a.b` or `regex:<pattern>`) | yes (set `adapters.fs.write: false` to stop) | [Adapter fs](Adapter-fs) |
| `url` | `url` (absolute, or relative to config `site`) | no (audit only) | [Adapter url](Adapter-url) |
| `stripe` | `price` (`price_…`) and/or `product` (`prod_…`) | only with `adapters.stripe.write: true` | [Adapter Stripe](Adapter-Stripe) |
| `appstore` | `app` (numeric id), `field` (`description`, `promotionalText`, `keywords`, `whatsNew`, `name`, `subtitle`), optional `locale` (default `en-US`), `platform` (default `IOS`) | only with `adapters.appstore.write: true`, and only `field` bindings | [Adapter App Store Connect](Adapter-App-Store-Connect) |

The App Store adapter ignores bindings with `set` (screenshots) or `iap`, and bindings with no `field`. Those artifacts still live in the graph and get classified; they just aren't audited or written. (Audit still lists them under "checked", a known quirk.)

Whether an adapter "can write" is decided **per artifact** by `canWrite(id, settings, node)` in [`adapters/registry.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/adapters/registry.ts):

1. The adapter must declare `capabilities.write` and implement `apply`.
2. If it implements the optional `canApply(node)`, that must return true for this binding. The App Store adapter returns true only for bindings with a `field` and no `set`/`iap`, so screenshots and IAPs (the demo's IAP binding has `product`, no `field`) stay `manual` even with `write: true`, and `apply` leaves them for a human instead of failing.
3. `fs` writes unless told `write: false`; every other adapter, plugin adapters included, needs `write: true`.

See [Adapters Overview](Adapters-Overview).

## How type and binding change classification

When impact arrives at an artifact, the edge type of the last hop picks the rule. Two node properties matter:

- **Media types.** If `type` includes any of `schema:ImageObject`, `schema:VideoObject`, `schema:MediaObject` or `sc:Print`, an `embeds` impact is `manual` ("value is burned into media"), even when the adapter could write. `renders` stays `auto`.
- **Writable binding.** For `embeds` and `mirrors`, a binding whose adapter can write *this artifact* gives `auto`; otherwise `manual`, with the reason naming the adapter.

| Artifact | Edge | Class | Why |
|---|---|---|---|
| `web:pricing-page` (fs, `schema:WebPage`) | embeds | `auto` | fs writes |
| `web:live-pricing` (url) | embeds | `manual` | `adapter "url" cannot write` |
| `appstore:screenshots/6.9/03` (`schema:ImageObject`) | embeds | `manual` | value is burned into media |
| `web:og-pro` (fs, `schema:ImageObject`) | renders | `auto` | regenerate from template |
| `stripe:price/pro-monthly` (stripe, no `write: true`) | mirrors | `manual` | `update in stripe (adapter is read-only)` |
| `appstore:listing/description` (appstore `field` binding, `write: true`) | embeds | `auto` | appstore can apply this binding |
| `appstore:iap/pro-monthly` (appstore binding with `product`, no `field`; `write: true`) | mirrors | `manual` | `canApply` is false without a `field`, so the reason is `appstore cannot update this binding; update it by hand` |
| `reel:spring-2026` (`validThrough: 2026-06-30`) | anything | `retire` | expired |

The full decision table is in [Impact Analysis](Impact-Analysis#classification-rules).

## See also

- [Adapters Overview](Adapters-Overview)
- [Edge Types](Edge-Types)
- [Impact Analysis](Impact-Analysis)
- [Authoring YAML](Authoring-YAML)
- [Rollout Ordering](Rollout-Ordering)
