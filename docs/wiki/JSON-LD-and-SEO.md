Your facts already say what your product costs, what it is called and which platforms it runs on. `starchart emit jsonld` turns that into two things: a full JSON-LD export of the chart (an interchange format for other tools) and clean, publishable schema.org markup for one entity (the structured data search engines read). Because the markup is generated from the same facts as your pricing page, it cannot quietly drift from it. This page covers the command's modes, the exact schema.org mappings, the HTML-safe script tag, and a Next.js build-time setup, with real output from the demo.

Source: [`render/jsonld.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/render/jsonld.ts).

## The command

```text
Usage: starchart emit jsonld [options]

schema.org JSON-LD for an entity (SEO) or the full chart

Options:
  --entity <id>  publishable schema.org markup for one entity
  --script       wrap in a <script type=application/ld+json> tag
  --code         include the code layer in the full export
  -h, --help     display help for command
```

| Invocation | Output |
|---|---|
| `emit jsonld` | full chart, fact + world layers (`toJsonLd`) |
| `emit jsonld --code` | full chart including code nodes |
| `emit jsonld --entity <id>` | schema.org markup for one entity (`schemaOrgFor`) |
| add `--script` to any of the above | the JSON wrapped in `<script type="application/ld+json">…</script>` |

Every mode ingests code, so facts with `authority: code` always carry the value read from their symbol (`addon:pro.features` exports as `["Themes","iCloud sync"]`). `--code` does one thing: it adds the code nodes (symbols, files, screens, routes…) and the edges into them to the full export. It changes nothing for `--entity`. An unknown entity id fails with `starchart: unknown node "<id>"` (exit 2).

## Full chart export (`toJsonLd`)

```ts
export function toJsonLd(graph: Graph, opts?: { ids?: string[]; includeCode?: boolean }): JsonLd
```

- `@context`: JSON-LD 1.1, `@vocab` schema.org, prefix `sc:` = `https://starchart.spacepiratezero.com/vocab#`, and every [edge type](Edge-Types) declared as `sc:<type>` with `"@type": "@id"`.
- `@graph`: one object per node, sorted by id. Code nodes (and edges pointing at them) are left out unless `includeCode` (or `ids` selects them explicitly).

Each node object:

| Property | From |
|---|---|
| `@id` | node id |
| `@type` | the node's YAML `type`s (`schema:Offer`, `sc:AddOn`), else `sc:<Kind>` (`sc:Fact`, `sc:Symbol`) |
| `sc:layer`, `sc:kind` | always |
| `name` | label |
| `sc:value` | scalars as plain literals; arrays/objects as `{ "@type": "@json", "@value": … }` so they are not read as nodes |
| `sc:authority`, `sc:status`, `validThrough`, `sc:owner`, `keywords` (tags), `sc:binding` (as `@json`), `sc:location` (`file:line`), `sc:hash` | when present |
| `sc:<edgeType>` | outgoing edges, grouped by type; one target is a string, several are a sorted array |

Real excerpt from the demo:

```json
{
  "@id": "addon:pro.price.usd",
  "@type": "sc:Fact",
  "sc:layer": "fact",
  "sc:kind": "fact",
  "sc:value": 4.99,
  "sc:authority": "graph",
  "sc:owner": ["@zero"],
  "sc:partOf": "addon:pro.price"
}
```

```json
{
  "@id": "web:pricing-page",
  "@type": "schema:WebPage",
  "sc:layer": "world",
  "sc:kind": "artifact",
  "name": "Pricing page",
  "sc:owner": ["@zero"],
  "sc:binding": { "@type": "@json", "@value": { "adapter": "fs", "path": "apps/web/app/pricing/page.tsx" } },
  "sc:describes": "addon:pro.features",
  "sc:embeds": "addon:pro.price.usd"
}
```

A code-authority fact, straight from `emit jsonld` (no `--code` needed):

```json
{
  "@id": "addon:pro.features",
  "@type": "sc:Fact",
  "sc:layer": "fact",
  "sc:kind": "fact",
  "sc:value": { "@type": "@json", "@value": ["Themes", "iCloud sync"] },
  "sc:authority": "code",
  "sc:owner": ["@zero"],
  "sc:partOf": "addon:pro"
}
```

The demo's full export is 516 lines without code and 1,519 with `--code`.

## Entity markup (`schemaOrgFor`)

```ts
export function schemaOrgFor(graph: Graph, entityId: string): JsonLd | JsonLd[]
```

The entity's facts are read as a nested object (`{ name, price: { usd, eur } }`), and the entity's `type` list decides the shape. Only `schema:`-prefixed (or `https://schema.org/…`) types count.

| Entity type contains | Output |
|---|---|
| `Offer` | one `Offer` per currency (array when more than one, single object when one) |
| `SoftwareApplication`, `MobileApplication` or `WebApplication` | one application object with `offers` |
| `FAQPage` | `FAQPage` with `mainEntity` questions |
| anything else | that type (first schema type), defaulting to `Product` when there is none |

Every output carries `"@context": "https://schema.org"` (nested offers inside an application do not repeat it).

### Common properties (every type)

| schema.org | First fact found among |
|---|---|
| `name` | `name`, `title`, else the entity label |
| `description` | `description`, `tagline`, `summary` |
| `image` | `image`, `images`, `icon`, `logo` (string or list) |
| `url` | `url`, `link`, `website` |

### Offer (multi-currency)

| Fact shape | Offers |
|---|---|
| `price: 4.99` with `priceCurrency` or `currency` | one offer in that currency (default `USD`) |
| `price: { amount: 4.99, currency: "EUR" }` (or `value`) | one offer |
| `price: { usd: 4.99, eur: 4.99 }` | one offer per 3-letter key, sorted by currency |
| no usable price | a bare `Offer` with only the common properties |

The key `prices` works like `price`. Each offer also gets:

| schema.org | From |
|---|---|
| `price` | formatted with two decimals (`"4.99"`, `"5.00"`) |
| `priceCurrency` | upper-cased currency |
| `sku` | `sku`, `productId` |
| `availability` | fact `status` or the entity's `status:`: `active`/`live`/`available` → `InStock`; `preorder`/`coming-soon`/`upcoming` → `PreOrder`; `retired`/`discontinued`/`archived` → `Discontinued` |
| `priceValidUntil` + `validThrough` | fact `validThrough` or the entity's `validThrough:` (date part for `priceValidUntil`) |
| `seller` | `seller` or `brand` → `{ "@type": "Organization", name }` |

Real output for the demo's `addon:pro` (typed `schema:Offer`, `status: active`, `price: { usd: 4.99, eur: 4.99 }`):

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

### SoftwareApplication (with offers)

| schema.org | From |
|---|---|
| `applicationCategory` | `applicationCategory`, `category` |
| `operatingSystem` | `operatingSystem`, `os`, `platforms`, `platform` (lists joined with `, `) |
| `softwareVersion` | `softwareVersion`, `version` |
| `offers` | the app's own price facts, **plus** the offers of every entity declared `of: <this app>` (add-ons, plans) |
| `aggregateRating` | `rating`/`ratingValue` + `ratingCount`/`reviewCount`/`ratings` (and `bestRating`), top level or under an `aggregateRating` fact; omitted when the count is not positive |

`@type` is `SoftwareApplication` unless the entity is only typed `MobileApplication` or `WebApplication`, in which case that type is used.

Real output for `app:nebula`, which the Pro add-on declares itself `of`:

```text
$ starchart emit jsonld --entity app:nebula
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Nebula",
  "applicationCategory": "ProductivityApplication",
  "operatingSystem": "iOS 18+",
  "offers": [
    {
      "@type": "Offer",
      "name": "Nebula Pro",
      "sku": "nebula_pro_monthly",
      "availability": "https://schema.org/InStock",
      "price": "4.99",
      "priceCurrency": "EUR"
    },
    {
      "@type": "Offer",
      "name": "Nebula Pro",
      "sku": "nebula_pro_monthly",
      "availability": "https://schema.org/InStock",
      "price": "4.99",
      "priceCurrency": "USD"
    }
  ]
}
```

### FAQPage

A `questions` (or `faq`, `faqs`) fact holding a list of objects. Each item needs a question (`q`, `question` or `name`) and an answer (`a`, `answer` or `text`); incomplete items are dropped.

```yaml
id: faq:pro
type: [schema:FAQPage]
facts:
  questions:
    - { q: "Can I cancel anytime?", a: "Yes, from Settings." }
    - { q: "Does Pro sync across devices?", a: "Yes, via iCloud." }
```

```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    { "@type": "Question", "name": "Can I cancel anytime?", "acceptedAnswer": { "@type": "Answer", "text": "Yes, from Settings." } },
    { "@type": "Question", "name": "Does Pro sync across devices?", "acceptedAnswer": { "@type": "Answer", "text": "Yes, via iCloud." } }
  ]
}
```

### Product (and any other type)

Common properties, plus `sku` (from `sku`/`productId`, only for `Product`), `brand` as `{ "@type": "Brand", name }`, `offers` (a single object when there is one currency, an array otherwise) and `aggregateRating`.

## `jsonLdScriptTag`: safe to inline

```ts
export function jsonLdScriptTag(obj: unknown): string
```

Pretty-prints the JSON and escapes `<` → `\u003c`, `>` → `\u003e`, `&` → `\u0026`, U+2028 and U+2029, then wraps it in `<script type="application/ld+json">…</script>`. A fact value containing `</script>` cannot close the tag early, and the JSON still parses to the same data.

```text
$ starchart emit jsonld --entity addon:pro --script
<script type="application/ld+json">[
  {
    "@context": "https://schema.org",
    "@type": "Offer",
    "name": "Nebula Pro",
    …
    "priceCurrency": "USD"
  }
]</script>
```

## Next.js: inject at build time

Generate the markup as a build step, then render it from a server component. No runtime dependency on STARCHART. (`@space-pirate-zero/starchart` isn't on npm yet; until it is, point the script at a from-source build: `node <starchart checkout>/packages/starchart/dist/cli/bin.js emit jsonld …`. See [Getting Started](Getting-Started).)

```json
{
  "scripts": {
    "prebuild": "npx @space-pirate-zero/starchart emit jsonld --entity app:nebula > app/(marketing)/nebula.jsonld.json",
    "build": "next build"
  }
}
```

```tsx
// app/(marketing)/page.tsx
import nebula from "./nebula.jsonld.json";

export default function Home() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(nebula).replace(/</g, "\\u003c") }}
      />
      {/* … */}
    </>
  );
}
```

Or call the library in a build script (or directly in a server component at build time) and use the escaper that ships with it:

```ts
// scripts/jsonld.mts
import { writeFileSync } from "node:fs";
import { buildProject, jsonLdScriptTag, schemaOrgFor } from "@space-pirate-zero/starchart";

const project = await buildProject(process.cwd());   // ingests code, so authority: code facts have values
writeFileSync("app/(marketing)/pro-offer.html", jsonLdScriptTag(schemaOrgFor(project.graph, "addon:pro")));
```

To keep the chart honest about it, declare the generated file as an artifact that `renders` the entity, so any change to the app or its add-ons shows it as impacted (`renders` classifies as `auto`, "regenerate from template"; your prebuild step is the regeneration):

```yaml
- id: web:jsonld-nebula
  type: sc:StructuredData
  binding: { adapter: fs, path: "app/(marketing)/nebula.jsonld.json" }
  renders: app:nebula
```

The `seo` [rule pack](Rule-Packs) has a rule for exactly this: `seo-jsonld-renders-entity` (info) flags any artifact typed `sc:JsonLd`, `sc:JSONLD` or `sc:StructuredData` (or tagged `jsonld` / `json-ld`) that does not `renders:` an entity or one of its facts.

## Limitations

- Mappings are fixed: `Offer`, `SoftwareApplication` / `MobileApplication` / `WebApplication`, `FAQPage`, and a generic fallback. No `Event`, `Article`, `Organization`, `BreadcrumbList` or `Review` builders yet.
- Offers inside an application have no `@id`s; two add-ons at the same price are two anonymous offers.
- `@id`s are raw STARCHART ids (`addon:pro.price.usd`, `web:pricing-page`), not IRIs. A JSON-LD processor reads `addon:` or `web:` as a URI scheme. Treat the full export as STARCHART interchange, not linked data you can merge with other graphs.
- Every mode pays for code ingestion, even `--entity` output that uses no code facts.
- The full export is not framed or compacted; consumers get one flat `@graph`.

## See also

- [Facts and Entities](Facts-and-Entities)
- [Authoring YAML](Authoring-YAML)
- [Vocabulary](Vocabulary)
- [Rule Packs](Rule-Packs)
- [CLI Reference](CLI-Reference)
