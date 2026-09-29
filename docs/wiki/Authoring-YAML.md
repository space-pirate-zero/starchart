The fact and world layers are plain YAML under `.starchart/`. This page covers every document shape the loader accepts (single docs, lists, section files, multi-document files), the `edges:` section, how validation errors and dangling-reference warnings look, and a complete annotated example. The loader is [`config/load.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/config/load.ts); the schemas are in [`config/schema.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/config/schema.ts).

## Where documents go

Every `*.yaml` / `*.yml` file under `.starchart/`, at any depth, except `config.yaml`/`config.yml` and anything under `preview/`, `journal/` or `proposals/`. `starchart init --discover` writes `.starchart/proposals/discovered.yaml`, which stays inert until you move it somewhere else under `.starchart/` (for example `.starchart/entities/offer.yaml`). Directory names are yours: `entities/`, `artifacts/`, `rules.yaml` and `order.yaml` are conventions, not requirements. See [Configuration](Configuration#which-files-are-loaded).

## Document shapes

Each YAML document in a file is classified like this:

1. **null / empty** → ignored.
2. **A list** → each item is classified on its own (lists can mix entities and artifacts).
3. **A mapping with any of `entities`, `artifacts`, `edges`, `rules`** → a **section document**. Each section is a single item or a list. Other keys in the mapping are ignored.
4. **A mapping with `kind: entity` or a `facts` key** → an entity.
5. **Any other mapping** → an artifact.
6. **Anything else** (a bare string or number) → error: `expected a mapping or a list`.

### Single entity

```yaml
# .starchart/entities/pro.yaml
id: addon:pro
type: [schema:Offer, sc:AddOn]
label: Nebula Pro
of: app:nebula
status: active
facts:
  name: Nebula Pro
  price: { usd: 4.99, eur: 4.99 }
```

### Single artifact

```yaml
# .starchart/artifacts/email.yaml
id: email:onboarding-day-3
binding: { adapter: fs, path: marketing/emails/onboarding-day-3.md }
describes: addon:pro
embeds: [addon:pro.price.usd]
```

### A list

```yaml
- id: web:messages-en
  binding: { adapter: fs, path: apps/web/messages/en.json }
  embeds: [addon:pro.name, addon:pro.price.usd]
- id: web:landing-hero
  binding: { adapter: fs, path: apps/web/app/page.tsx }
  describes: [addon:pro]
```

### Section file

```yaml
entities:
  - id: campaign:spring-2026
    kind: entity
    validThrough: "2026-06-30"
    facts: { headline: "Pro, now with iCloud sync" }
artifacts:
  - id: reel:spring-2026
    type: schema:VideoObject
    promotes: addon:pro
edges:
  - { from: reel:spring-2026, to: campaign:spring-2026, type: describes }
rules:
  - id: paywall-has-screenshot
    severity: warn
    select: { prefix: "screen:ios/Paywall" }
    require: { edge: { type: captures, direction: in, min: 1 } }
```

Items under `entities:` are always entities, so they don't need `kind`. Rules are only checked for being mappings here; the [Rules Engine](Rules-Engine) validates them when `starchart rules` runs.

### Multi-document files

Separate documents with `---`. Each one is classified independently:

```yaml
id: plan:team
kind: entity
of: app:nebula
facts:
  seats: 5
---
- id: web:team-page
  binding: { adapter: fs, path: team.md }
  embeds: plan:team.seats
---
edges:
  - { from: web:team-page, to: plan:team, type: describes }
```

### The artifact-by-default trap

A standalone mapping with neither `kind: entity` nor `facts` is an **artifact**:

```yaml
id: brand:nebula
label: Nebula brand
```

```text
artifact brand:nebula
```

Add `kind: entity` if you meant an entity.

## The `edges:` section

Declare any edge between any two nodes, including code nodes and facts. This is how you add bridges without touching source code, or ordering between artifacts in different files.

| Field | Type | Required | Notes |
|---|---|---|---|
| `from` | string | yes | Node id. |
| `to` | string | yes | Node id. |
| `type` | string | yes | Must be one of the 22 [edge types](Edge-Types), or the load fails. |
| `confidence` | number 0..1 | no | Stored as the edge's confidence (`0` included). Scales impact confidence along paths through it. |

```yaml
edges:
  - { from: symbol:web/lib/pricing#PRO_PRICE_USD, to: addon:pro.price.usd, type: anchors }
  - { from: web:landing-hero, to: addon:pro.features, type: describes, confidence: 0.5 }
```

All declared edges get `origin: declared`, the strongest origin, so they win merges with extracted or annotation edges on the same `(from, type, to)`.

`confidence: 0` is kept as 0. Any path through that edge drops below the default `minConfidence` (0.3), so `impact` and `plan` never follow it, while `starchart why` (which uses `minConfidence: 0`) still shows the link with `confidence 0`. Handy for recording a relationship you don't want in plans.

## Validation errors

Structural problems throw a `ConfigError`. The CLI prints it prefixed with `starchart:` and exits with code **2**. Schema errors name the file (relative to the root) and the failing path:

```text
starchart: .starchart/bad.yaml: facts: Invalid input: expected record, received number
```

```text
starchart: .starchart/bad.yaml: unknown edge type "loves"
```

YAML syntax errors come from the parser, with the file's absolute path and position:

```text
starchart: /…/.starchart/bad.yaml: Nested mappings are not allowed in compact mappings at line 1, column 5:
```

Other hard errors:

- `fact <id> has authority "code" but no source.symbol`
- `rule must be a mapping`
- `expected a mapping or a list`

## Dangling-reference warnings

A declared edge whose `from` or `to` doesn't exist after ingest is kept in the graph, but produces a warning on stderr (suppress with `-q`):

```text
warn .starchart/bad.yaml: web:landing-hero --describes--> addon:nope: unknown node "addon:nope"
```

Code-authority facts whose symbol isn't found warn too:

```text
warn fact addon:pro.features: code symbol symbol:ios/Entitlements.proFeatures not found
```

Commands that skip ingestion (`journals`, `history`, `adapters`) don't warn about missing code ids (`file:`, `symbol:`, `screen:`, `route:`, `pkg:`, `env:`, `flag:`, `event:`, `i18n:`, `test:`), because the code layer isn't loaded.

Warnings don't change exit codes.

## A complete annotated example

```yaml
# .starchart/pro.yaml: one file, both layers, three documents.

# ── Entity ─────────────────────────────────────────────────────────────
id: addon:pro                       # entity id: pick "<kind>:<name>"
type: [schema:Offer, sc:AddOn]      # JSON-LD types; schema:Offer drives SEO markup
label: Nebula Pro
of: app:nebula                      # addon:pro --partOf--> app:nebula
status: active                      # also becomes the fact addon:pro.status
owners: ["@zero"]                   # copied onto every fact below
facts:
  name: Nebula Pro                  # leaf: addon:pro.name
  price:                            # container: addon:pro.price
    usd: 4.99                       #   leaf: addon:pro.price.usd
    eur: 4.99                       #   leaf: addon:pro.price.eur
  productId:                        # fact spec: truth lives in App Store Connect
    value: nebula_pro_monthly
    authority: appstore
  features:                         # fact spec: truth lives in code
    authority: code
    source: { symbol: ios/Entitlements.proFeatures }   # short form of symbol:ios/…
---
# ── Artifacts ──────────────────────────────────────────────────────────
- id: web:pricing-page
  type: schema:WebPage
  binding: { adapter: fs, path: apps/web/app/pricing/page.tsx }   # fs writes → embeds are auto
  publishedBy: route:web/pricing    # route:web/pricing --publishes--> web:pricing-page
  embeds: [addon:pro.price.usd]
  describes: [addon:pro.features]

- id: appstore:screenshots/6.9/03
  type: schema:ImageObject          # media: embeds become manual
  binding: { adapter: appstore, app: "6450000000", set: "6.9", index: 3 }
  captures: screen:ios/Paywall      # SwiftUI PaywallView → screen:ios/Paywall
  embeds: [addon:pro.price.usd]

- id: stripe:price/pro-monthly
  binding: { adapter: stripe, price: price_1NebulaPro499 }        # read-only unless write: true
  mirrors: [addon:pro.price.usd, addon:pro.name]
  blocks: [web:pricing-page]        # Stripe first, then the page
---
# ── Extra edges ────────────────────────────────────────────────────────
edges:
  - { from: symbol:web/lib/pricing#PRO_PRICE_USD, to: addon:pro.price.usd, type: anchors }
```

Check what it compiled to:

```bash
starchart query --prefix addon:pro
starchart node web:pricing-page
starchart check
```

## See also

- [Facts and Entities](Facts-and-Entities)
- [Artifacts and Bindings](Artifacts-and-Bindings)
- [Edge Types](Edge-Types)
- [Configuration](Configuration)
- [Rules Engine](Rules-Engine)
