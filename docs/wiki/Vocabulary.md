The JSON-LD export is STARCHART's interchange format: the whole chart as linked data, readable by any RDF or JSON-LD tool. This page documents the vocabulary: the `@context` produced by `jsonLdContext()`, the `sc:` namespace, how graph nodes and edges map to JSON-LD, which schema.org types STARCHART understands, and the quirks of using raw node ids as `@id`. Source: [`render/jsonld.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/render/jsonld.ts). For publishable schema.org markup for a single entity (`emit jsonld --entity`), see [JSON-LD and SEO](JSON-LD-and-SEO).

## Getting the export

```bash
starchart emit jsonld           # fact + world layers
starchart emit jsonld --code    # also the code layer
```

The output is `{ "@context": …, "@graph": [ … ] }` with one node object per graph node, sorted by id. Both forms ingest code, so `authority: code` facts carry their values; `--code` only decides whether code nodes are written into `@graph`.

## The @context

This is the real `@context` block from `starchart emit jsonld` (unabridged):

```json
{
  "@context": {
    "@version": 1.1,
    "@vocab": "https://schema.org/",
    "schema": "https://schema.org/",
    "sc": "https://starchart.spacepiratezero.com/vocab#",
    "sc:imports": {
      "@id": "sc:imports",
      "@type": "@id"
    },
    "sc:references": {
      "@id": "sc:references",
      "@type": "@id"
    },
    "sc:dependsOn": {
      "@id": "sc:dependsOn",
      "@type": "@id"
    },
    "sc:tests": {
      "@id": "sc:tests",
      "@type": "@id"
    },
    "sc:serves": {
      "@id": "sc:serves",
      "@type": "@id"
    },
    "sc:readsEnv": {
      "@id": "sc:readsEnv",
      "@type": "@id"
    },
    "sc:readsFlag": {
      "@id": "sc:readsFlag",
      "@type": "@id"
    },
    "sc:contains": {
      "@id": "sc:contains",
      "@type": "@id"
    },
    "sc:anchors": {
      "@id": "sc:anchors",
      "@type": "@id"
    },
    "sc:displays": {
      "@id": "sc:displays",
      "@type": "@id"
    },
    "sc:captures": {
      "@id": "sc:captures",
      "@type": "@id"
    },
    "sc:publishes": {
      "@id": "sc:publishes",
      "@type": "@id"
    },
    "sc:emits": {
      "@id": "sc:emits",
      "@type": "@id"
    },
    "sc:embeds": {
      "@id": "sc:embeds",
      "@type": "@id"
    },
    "sc:renders": {
      "@id": "sc:renders",
      "@type": "@id"
    },
    "sc:describes": {
      "@id": "sc:describes",
      "@type": "@id"
    },
    "sc:promotes": {
      "@id": "sc:promotes",
      "@type": "@id"
    },
    "sc:mirrors": {
      "@id": "sc:mirrors",
      "@type": "@id"
    },
    "sc:derivedFrom": {
      "@id": "sc:derivedFrom",
      "@type": "@id"
    },
    "sc:after": {
      "@id": "sc:after",
      "@type": "@id"
    },
    "sc:blocks": {
      "@id": "sc:blocks",
      "@type": "@id"
    },
    "sc:partOf": {
      "@id": "sc:partOf",
      "@type": "@id"
    }
  }
}
```

- **`@vocab` is schema.org.** Any bare term (`name`, `validThrough`, `keywords`) is a schema.org property.
- **`schema:`** is also declared as a prefix, so `schema:Offer` and `Offer` expand to the same IRI.
- **`sc:`** is the STARCHART namespace: `https://starchart.spacepiratezero.com/vocab#` (`SC_VOCAB`).
- **Every edge type** from `EDGE_TYPES` gets a term `sc:<type>` with `"@type": "@id"`, so edge targets are read as node references, not strings. The list is generated from the source, so new edge types appear automatically.

## Node objects

Each graph node becomes:

| JSON-LD key | From | Notes |
|---|---|---|
| `@id` | node `id` | the raw STARCHART id (see [IRI quirks](#iri-quirks)) |
| `@type` | node `types` | one string or an array; if the node has no types: `sc:<Kind>` |
| `sc:layer` | `layer` | `code`, `fact` or `world` |
| `sc:kind` | `kind` | `entity`, `fact`, `artifact`, `symbol`, … |
| `name` | `label` | schema.org `name` |
| `sc:value` | `value` | scalars as plain literals; objects and arrays as `{"@type": "@json", "@value": …}` |
| `sc:authority` | `authority` | `graph`, `code`, `appstore`, … |
| `sc:status` | `status` | |
| `validThrough` | `validThrough` | schema.org `validThrough` |
| `sc:owner` | `owners` | array |
| `keywords` | `tags` | schema.org `keywords` |
| `sc:binding` | `binding` | always a `@json` literal |
| `sc:location` | `location` | `file:line` or `file` (code nodes) |
| `sc:hash` | `hash` | code nodes |
| `sc:<edgeType>` | outgoing edges | one id or a sorted array of ids |

Not exported: `meta` (so no `meta.template`, fact `description`, token metadata or file paths), `source`, and edge `confidence`/`origin`.

The `@json` literals keep structured values from being misread as nested nodes. `{usd: 4.99, eur: 4.99}` stays a value, not a blank node with `usd`/`eur` properties.

### Default types for untyped nodes

`sc:` + the capitalised kind:

| Kind | `@type` |
|---|---|
| entity | `sc:Entity` |
| fact | `sc:Fact` |
| artifact | `sc:Artifact` |
| file | `sc:File` |
| symbol | `sc:Symbol` |
| package | `sc:Package` |
| route | `sc:Route` |
| screen | `sc:Screen` |
| flag | `sc:Flag` |
| env | `sc:Env` |
| event | `sc:Event` |
| i18n | `sc:I18n` |
| test | `sc:Test` |

### Examples (from the demo)

An entity with types and a `partOf` edge:

```json
{
  "@id": "addon:pro",
  "@type": ["schema:Offer", "sc:AddOn"],
  "sc:layer": "fact",
  "sc:kind": "entity",
  "name": "Nebula Pro",
  "sc:status": "active",
  "sc:owner": ["@zero"],
  "sc:partOf": "app:nebula"
}
```

A container fact (structured value as a `@json` literal, no authority):

```json
{
  "@id": "addon:pro.price",
  "@type": "sc:Fact",
  "sc:layer": "fact",
  "sc:kind": "fact",
  "sc:value": { "@type": "@json", "@value": { "usd": 4.99, "eur": 4.99 } },
  "sc:owner": ["@zero"],
  "sc:partOf": "addon:pro"
}
```

An artifact:

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

A code node (with `--code`):

```json
{"@id":"symbol:ios/Pricing.proUSD","@type":"sc:Symbol","sc:layer":"code","sc:kind":"symbol","name":"proUSD","sc:value":4.99,"sc:location":"apps/ios/Sources/Core/Pricing.swift:5","sc:hash":"20bc1f157ce5a99f","sc:anchors":"addon:pro.price.usd"}
```

## Edges as properties

Only **outgoing** edges are written, on the `from` node: `web:pricing-page` carries `sc:embeds`, and `addon:pro.price` doesn't carry a reverse "embedded by". Direction follows the graph convention (from depends on to), see [Edge Types](Edge-Types). Multiple targets of one type become a sorted array. Edge types are written in alphabetical order.

Without `--code`, code-layer nodes aren't exported, and edges from exported nodes into the code layer are dropped. The demo's screenshot artifact exports with `sc:embeds` but no `sc:captures`, because its `captures` target is `screen:ios/Paywall`. `route --publishes--> artifact` edges are only visible with `--code`, since they're outgoing from the route.

`authority: code` facts get their values either way. From `starchart emit jsonld` without `--code`:

```json
{"@id":"addon:pro.features","@type":"sc:Fact","sc:layer":"fact","sc:kind":"fact","sc:value":{"@type":"@json","@value":["Themes","iCloud sync"]},"sc:authority":"code","sc:owner":["@zero"],"sc:partOf":"addon:pro"}
```

## The sc: vocabulary

| Term | Kind | Meaning |
|---|---|---|
| `sc:layer`, `sc:kind` | property | graph layer and node kind |
| `sc:value` | property | fact value or code literal |
| `sc:authority` | property | where a fact's truth lives |
| `sc:status`, `sc:owner` | property | lifecycle status, owners |
| `sc:binding` | property | adapter binding (JSON literal) |
| `sc:location`, `sc:hash` | property | code location and content hash |
| `sc:imports` … `sc:partOf` | property (`@id`-typed) | the 22 edge types |
| `sc:Entity`, `sc:Fact`, `sc:Artifact`, `sc:File`, `sc:Symbol`, `sc:Package`, `sc:Route`, `sc:Screen`, `sc:Flag`, `sc:Env`, `sc:Event`, `sc:I18n`, `sc:Test` | class | default node types |
| `sc:DesignTokens` | class | the `tokens` entity ([Design Tokens](Design-Tokens)) |
| `sc:Print` | class | printed media: `embeds` into it are `manual` |

You can use any other `sc:` type in `type:`. The demo uses `sc:AddOn`, `sc:AppStoreListing`, `sc:StringTable` and `sc:PrivacyLabel`. Those are labels; only `sc:Print` and `sc:DesignTokens` mean something to the code. Rule packs select on types too ([Rule Packs](Rule-Packs)).

Only the edge-type terms are declared in the context. The other `sc:` properties expand through the `sc` prefix, with no `@type` coercion.

## schema.org types STARCHART understands

| Type | Used for |
|---|---|
| `schema:ImageObject`, `schema:VideoObject`, `schema:MediaObject` | Media artifacts: `embeds` impacts are `manual` ([Impact Analysis](Impact-Analysis#classification-rules)). |
| `schema:Offer` | `emit jsonld --entity` emits one `Offer` per currency. |
| `schema:SoftwareApplication`, `schema:MobileApplication`, `schema:WebApplication` | `--entity` emits the app with offers from its `of:` children. |
| `schema:FAQPage` | `--entity` emits `Question`/`Answer` pairs. |
| any other `schema:X` | `--entity` emits a generic `X` (default `Product`). |
| `schema:WebPage` | Label only (the demo's pages). |

The SEO output also emits `Organization`, `Brand`, `AggregateRating`, `Question` and `Answer` nodes. See [JSON-LD and SEO](JSON-LD-and-SEO).

## How node ids map to @id

`@id` is the STARCHART id verbatim. No base IRI is set and ids aren't prefixed. That keeps the export round-trippable and easy to grep, but JSON-LD processors interpret the strings as IRIs:

### IRI quirks

- `addon:pro`, `web:pricing-page` and `stripe:price/pro-monthly` parse as absolute IRIs whose "scheme" is `addon`, `web` or `stripe`.
- `file:ios/Sources/Core/Pricing.swift` is a `file:` IRI. An entity id that starts with `sc:` or `schema:` would expand through the declared prefixes, so don't use those as entity prefixes.
- Ids with no colon, like `tokens.color.brand.primary` or the `tokens` entity, are **relative** IRIs and resolve against the document's base URL. With no base, they can be dropped when the export is converted to RDF.

If you load the export into a triple store, set a base (`@base`) or rewrite ids into your own namespace first.

## See also

- [JSON-LD and SEO](JSON-LD-and-SEO)
- [Edge Types](Edge-Types)
- [Node IDs](Node-IDs)
- [Facts and Entities](Facts-and-Entities)
