A rebrand is a fact change with a huge blast radius: OG images, store screenshots, email templates, marketing sites. STARCHART imports [W3C Design Tokens (DTCG)](https://design-tokens.github.io/community-group/format/) JSON as facts under a built-in `tokens` entity, so `tokens.color.brand.primary` gets impact analysis, lockfile pins and drift checks like any other fact. This page covers the config, how tokens map to fact ids, alias resolution, descriptions and types, and a worked rebrand example. Source: [`tokens.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/tokens.ts).

## Enabling it

Point `tokens` in `.starchart/config.yaml` at one or more DTCG files, relative to the project root:

```yaml
tokens: design/tokens.json
# or
tokens: [design/core.tokens.json, design/brand.tokens.json]
```

Tokens are imported right after the YAML compiles and before code ingestion, on every command, including ones that skip code.

## How tokens become facts

| DTCG | Graph |
|---|---|
| (the whole import) | entity `tokens`, label `Design tokens`, type `sc:DesignTokens`, `meta.files` = the configured files |
| a group (object without `$value`) | container fact `tokens.<group path>`, `meta.tokenGroup: true` (plus `meta.tokenType` / `meta.description` from the group's `$type` / `$description`) |
| a token (object with `$value`) | leaf fact `tokens.<token path>`, `authority: graph`, `source: { file }`, value = the resolved `$value` |
| nesting | `partOf` edges, leaf → group → … → `tokens`, exactly like YAML facts |

Leaf metadata:

| `meta` key | From |
|---|---|
| `entity` | always `"tokens"` |
| `file` | source file |
| `tokenType` | the token's `$type`, or the nearest ancestor group's `$type` |
| `description` | the token's `$description` |
| `aliasOf` | target fact id, when `$value` is exactly `{path}` |

An exact alias also gets a `derivedFrom` edge, alias → target (for example `tokens.color.brand.accent --derivedFrom--> tokens.color.brand.primary`).

Container values mirror the token tree (resolved values), so `tokens.color.brand` is `{"primary":"#7C3AED","accent":"#7C3AED"}`.

Rules enforced at import (each is a hard error):

- The file must parse as JSON and every node must be an object: `"<path>" must be a group or a token object with $value`.
- Token and group names can't contain `.`, `{` or `}`.
- A token path defined twice across the files: `duplicate token "<path>"`.
- An alias to a missing token: `token "<from>" references unknown token "{<path>}"`.
- Alias cycles: `circular token alias: a → b → a`.

Keys starting with `$` are skipped as properties, not tokens.

## Aliases

`{path}` references resolve across **all** configured files:

| `$value` | Resolved value | `meta.aliasOf` |
|---|---|---|
| `"{color.brand.primary}"` (exactly an alias) | the target's resolved value, any type | `tokens.color.brand.primary` |
| `"1px solid {color.border}"` (embedded) | string with the target's value substituted | — |
| `{ "color": "{color.brand.primary}", "width": "2px" }` (composite) | nested values resolved recursively | — |

Non-scalar targets embedded in a string are inserted as JSON.

Exact aliases follow their target. Each one gets a `derivedFrom` edge to the token it points at, so `starchart impact tokens.color.brand.primary` also lists every artifact bound to `tokens.color.brand.accent`. Embedded and composite references get no edge: only the lockfile notices when their resolved value moves.

## Worked example: rebrand blast radius

Starting from a copy of the demo, add a tokens file:

```json
{
  "color": {
    "$type": "color",
    "brand": {
      "primary": { "$value": "#7C3AED", "$description": "Nebula violet" },
      "accent": { "$value": "{color.brand.primary}" }
    },
    "text": { "onBrand": { "$value": "#FFFFFF" } }
  },
  "space": { "$type": "dimension", "md": { "$value": "16px" } }
}
```

Wire it up, and bind two artifacts to token facts:

```yaml
# .starchart/config.yaml
tokens: design/tokens.json
```

```yaml
# .starchart/artifacts/brand.yaml
artifacts:
  - id: web:og-brand
    type: schema:ImageObject
    label: OG background
    binding: { adapter: fs, path: apps/web/public/og/brand.png }
    renders: { template: apps/web/og/pro.svg, with: [tokens.color.brand.primary, addon:pro.name] }
  - id: appstore:screenshots/6.9/01
    type: schema:ImageObject
    label: Hero screenshot
    binding: { adapter: appstore, app: "6450000000", set: "6.9", index: 1 }
    embeds: [tokens.color.brand.accent]
```

The token facts:

```bash
starchart query --prefix tokens
```

```text
entity   tokens
fact     tokens.color = {"brand":{"primary":"#7C3AED","accent":"#7C3AED"},"text":{"…
fact     tokens.color.brand = {"primary":"#7C3AED","accent":"#7C3AED"}
fact     tokens.color.brand.primary = "#7C3AED"
fact     tokens.color.brand.accent = "#7C3AED"
fact     tokens.color.text = {"onBrand":"#FFFFFF"}
fact     tokens.color.text.onBrand = "#FFFFFF"
fact     tokens.space = {"md":"16px"}
fact     tokens.space.md = "16px"
```

```bash
starchart node tokens.color.brand.accent
```

```text
{
  "id": "tokens.color.brand.accent",
  "kind": "fact",
  "value": "#7C3AED",
  "authority": "graph",
  "source": {
    "file": "design/tokens.json"
  },
  "meta": {
    "entity": "tokens",
    "file": "design/tokens.json",
    "tokenType": "color",
    "aliasOf": "tokens.color.brand.primary"
  },
  "layer": "fact"
}
  --partOf--> tokens.color.brand
  --derivedFrom--> tokens.color.brand.primary
  <--embeds-- appstore:screenshots/6.9/01
```

### What-if: `impact` on the token

```bash
starchart impact tokens.color.brand.primary -v
```

```text
Change: tokens.color.brand.primary

  ! manual  appstore:screenshots/6.9/01  embeds       value is burned into media
      why: tokens.color.brand.primary --derivedFrom--> tokens.color.brand.accent --embeds--> appstore:screenshots/6.9/01  (confidence 1)
  ~ auto    web:og-brand                 renders      regenerate from template
      why: tokens.color.brand.primary --renders--> web:og-brand  (confidence 1)
  · info    tokens.color.brand           partOf       derived fact changes
      why: tokens.color.brand.primary --partOf--> tokens.color.brand  (confidence 1)
  · info    tokens.color.brand.accent    derivedFrom  derived fact changes
      why: tokens.color.brand.primary --derivedFrom--> tokens.color.brand.accent  (confidence 1)
  · info    tokens.color                 partOf       derived fact changes
      why: tokens.color.brand.primary --partOf--> tokens.color.brand --partOf--> tokens.color  (confidence 1)
  · info    tokens                       partOf       derived fact changes
      why: tokens.color.brand.primary --partOf--> tokens.color.brand --partOf--> tokens.color --partOf--> tokens  (confidence 1)

Order: appstore:screenshots/6.9/01 → web:og-brand

Plan: 1 manual · 1 auto · 4 info
```

The OG image is `auto` (templated renders regenerate). The screenshot is bound to the **alias**, and it still shows up: the path runs through the alias's `derivedFrom` edge. It's `manual` because a colour burned into an image doesn't repaint itself.

### The real change: edit the file, then `plan`

Lock, then rebrand to pink:

```bash
starchart lock
sed -i '' 's/#7C3AED/#FF2E88/' design/tokens.json
starchart plan
```

```text
Change: tokens.color  {"brand":{"primary":"#7C3AED","accent":"#7C3AED"},"text":{"… → {"brand":{"primary":"#FF2E88","accent":"#FF2E88"},"text":{"…
Change: tokens.color.brand  {"primary":"#7C3AED","accent":"#7C3AED"} → {"primary":"#FF2E88","accent":"#FF2E88"}
Change: tokens.color.brand.primary  "#7C3AED" → "#FF2E88"
Change: tokens.color.brand.accent  "#7C3AED" → "#FF2E88"

  ! manual  appstore:screenshots/6.9/01  embeds   value is burned into media
  ~ auto    web:og-brand                 renders  regenerate from template

Order: appstore:screenshots/6.9/01 → web:og-brand

Plan: 1 manual · 1 auto
(1 informational item hidden; use --verbose)
```

```text
  ✗ stale     appstore:screenshots/6.9/01
                changed: tokens.color.brand.accent
                changed: tokens.color.brand.primary
  ✗ stale     web:og-brand
                changed: tokens.color.brand.primary

Check: 2 stale
```

Both artifacts show up. The screenshot lists both tokens: it embeds the alias, and the alias derives from the primary colour. The screenshot is `manual`; the OG image regenerates.

## Tips

- Bind artifacts to the **most specific** token they use. `renders: tokens.color` would re-render on any colour change.
- Anchor code to a token with an annotation. Dotted ids work as targets, no colon needed ([Annotations](Annotations)):

  ```ts
  // apps/web/components/Brand.tsx
  // @starchart anchors tokens.color.brand.primary
  export const BRAND = "#7C3AED";
  ```

  In the example above that adds a `code` item to the impact:

  ```text
    ⌘ code    symbol:web/components/Brand#BRAND  anchors  hardcoded value anchors this fact; update or switch to codegen
  ```

  An `edges:` entry in YAML does the same job if you'd rather keep code comments clean:

  ```yaml
  edges:
    - { from: symbol:web/components/Brand#BRAND, to: tokens.color.brand.primary, type: anchors }
  ```

- Don't define your own entity called `tokens`. The import merges into it.
- Tokens don't go through `authority: code` resolution. The JSON file is the truth.

## See also

- [Facts and Entities](Facts-and-Entities)
- [Configuration](Configuration)
- [Impact Analysis](Impact-Analysis)
- [Lockfile and Drift](Lockfile-and-Drift)
- [Codegen](Codegen)
