Annotations are `@starchart` comments in your source and content files. They let you declare bridges right where the value lives: "this constant is the Pro price", "this view is the Paywall screen", "this HTML shows the price". The code ingestor turns them into edges with `origin: "annotation"` and confidence 1. This page covers the syntax, every comment style the ingestor understands, how an annotation picks its target node, the `screen` and `generated` directives, warnings, and examples per language. Source: [`code/annotations.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/code/annotations.ts) and [`code/ingest.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/code/ingest.ts).

## Syntax

```text
@starchart <edgeType> <target> [<target> …]
@starchart screen <Name>
```

- `<edgeType>` is any of the 22 [edge types](Edge-Types). The ones that make sense in code are `anchors`, `displays`, `emits`, `references`, `readsEnv`, `readsFlag` and `tests`, but the ingestor accepts all of them.
- Targets are separated by whitespace and/or commas. Trailing `.` or `;` is stripped.
- A target **must contain a colon or a dot** and match `[A-Za-z0-9_][A-Za-z0-9_.:/@#\-[\]+~*$]*`. Parsing stops at the first token that doesn't, so you can follow the ids with prose: `@starchart anchors addon:pro.price, addon:pro.price.usd (price)` yields two targets. Watch the first prose word after the ids: if it contains a dot or colon (`e.g.` becomes `e.g` once the trailing dot is stripped), it's read as another target. Start the prose with a plain word or a parenthesis.
- Several directives can share a comment, and even a line: each `@starchart` starts a new one.
- Closing comment tokens (`*/`, `-->`, `*/ }`) are stripped before parsing.

Edges run **from** the annotated node **to** each target: `@starchart anchors addon:pro.price.usd` on `proUSD` adds `symbol:ios/Pricing.proUSD --anchors--> addon:pro.price.usd`.

Dotted ids without a colon work, which is what [design tokens](Design-Tokens) need: `// @starchart anchors tokens.color.brand.primary` above `export const BRAND = "#7C3AED"` adds `symbol:web/components/Brand#BRAND --anchors--> tokens.color.brand.primary`, and `impact tokens.color.brand.primary` lists the constant as `code`.

## Comment styles

### Parsed languages (TS/JS, Swift, Kotlin, Go)

The ingestor reads real comments from the parser or lexer, so any comment form works: `// …`, `/* … */`, `/** … */` doc comments, and TSX `{/* … */}`. Strings that happen to contain `@starchart` are ignored.

### Everything else (text scan)

Files the ingestor doesn't parse get a line-by-line scan. That covers Markdown, MDX, HTML, YAML, CSS/SCSS/Sass/Less, XML, TOML, Vue, Svelte, Astro, SQL, GraphQL, Python, Ruby, shell, plain text, plist, properties and Gradle files. A line counts only if `@starchart` directly follows one of these comment openers (whitespace allowed):

| Opener | Typical files |
|---|---|
| `//` | JS-like configs, Gradle, SCSS |
| `#` | YAML, TOML, Python, Ruby, shell |
| `/*` | CSS |
| `<!--` | HTML, Markdown, XML, Vue, Svelte |
| `{/*` | MDX |
| `--` | SQL |
| `;` | INI-style files |
| ` * ` at line start | continuation lines of block comments |

Each matching line is a separate annotation, and text-scanned annotations always attach to the **file** node (`file:<scope>/<path>`). These files only become nodes at all if they carry an annotation (MDX files always do).

## What an annotation attaches to

For parsed languages, `annotationTarget()` picks the node in this order:

1. **Trailing comment** (code before it on the same line) → the innermost declaration starting on that line.
2. Otherwise, **the next declaration**, if only blank or comment lines separate the comment from it.
3. Otherwise, **the innermost declaration containing the comment** (an annotation inside a function body annotates the function).
4. Otherwise, **the file**.

Test files have no symbol nodes, so annotations in tests attach to the `test:` node.

```ts
// @starchart anchors addon:pro.name            ← rule 2: annotates PRO_NAME
export const PRO_NAME = "Nebula Pro";

export const X = 1; // @starchart anchors addon:pro.billing, addon:pro.productId (why)   ← rule 1: annotates X

export function CheckoutPanel() {
  return null; // @starchart displays addon:pro.name   ← rule 3: annotates CheckoutPanel
}
```

Put the comment *directly* above the declaration. A code line in between (even an unrelated one) breaks rule 2 and the annotation falls back to the enclosing declaration or the file.

## `@starchart screen <Name>`

Declares a screen node for the annotated declaration. It takes a bare name (no colon needed), or a full id:

| Directive | Creates |
|---|---|
| `@starchart screen Checkout` in scope `web` | `screen:web/Checkout` |
| `@starchart screen screen:web/Checkout` | `screen:web/Checkout` |

The screen gets a `references` edge to the annotated symbol, copies its hash and location, and any test that covers the symbol also gets a `tests` edge to the screen. This is the only way to get screens in TypeScript/React. SwiftUI views and Compose `…Screen` functions are detected automatically ([Node IDs](Node-IDs#screens)).

```tsx
/** @starchart screen Checkout */
export function CheckoutPanel() { … }
```

A `screen` directive with no name warns: `@starchart screen needs a name`.

## `@starchart generated`

Marks a file as STARCHART codegen output. What matters is the text `@starchart generated` appearing in the **first five lines** of the file. The ingestor then sets `meta.generated` on the file and all its symbols. In plans, a generated symbol reached via `anchors` is classed `auto` ("regenerate fact constants (codegen)") instead of `code`. [Codegen](Codegen) writes this header for you:

```ts
// @starchart generated — do not edit
```

As a comment directive, `generated` is a marker and adds no edge. So do `id` and `ignore`, which are reserved: they're parsed and skipped. **Not implemented:** `@starchart id` and `@starchart ignore` do nothing yet. They don't rename a node or hide it from ingestion.

## Warnings

The CLI prints ingest warnings on stderr as `warn …` before the command's output. `-q` hides them. They don't change the exit code.

| Situation | Warning |
|---|---|
| Unknown verb | `apps/web/components/Brand.tsx:10: unknown @starchart edge type "frobnicate"` |
| Edge verb with no valid targets | `apps/web/components/Brand.tsx:1: @starchart anchors has no target node ids` |
| `screen` with no name | `<file>:<line>: @starchart screen needs a name` |

A real run with a typo'd verb:

```text
$ starchart check
warn apps/web/lib/x.ts:1: unknown @starchart edge type "frobnicates"
✓ every artifact is in sync
```

The same stream carries other ingest trouble: `<file>: parse failed (…)` and `<file>: skipped (unreadable, binary or larger than 2000000 bytes)`. From the library, `buildProject` returns them in `project.warnings`. If an annotation seems to do nothing, check it with `starchart node <id>` or `starchart query --edge anchors --to <fact>`.

Annotation targets are not checked for existence. An edge to a fact id with a typo is added anyway and simply never propagates.

## Examples

### Swift

```swift
enum Pricing {
    // @starchart anchors addon:pro.price.usd
    static let proUSD = 4.99
}
```

→ `symbol:ios/Pricing.proUSD --anchors--> addon:pro.price.usd`

### TypeScript

```ts
import Stripe from "stripe";

// @starchart anchors stripe:price/pro-monthly
export const PRICE_PRO_MONTHLY = "price_1NebulaPro499";
```

→ `symbol:web/lib/stripe#PRICE_PRO_MONTHLY --anchors--> stripe:price/pro-monthly`. Anchoring to an **artifact** works too: change the Stripe price and the constant is flagged `code`.

### Kotlin

```kotlin
object Extra {
    /** @starchart anchors addon:pro.price.usd */
    const val PRICE = 4.99
    val NAME = "Nebula Pro" // @starchart anchors addon:pro.name
}
```

→ `symbol:android/Extra.PRICE` and `symbol:android/Extra.NAME` anchor their facts.

### Go

```go
package pricing

// @starchart anchors addon:pro.price.usd
const ProUSDAgain = 4.99

/*
 * @starchart anchors addon:pro.productId
 */
var ProID = "pro_monthly"
```

→ `symbol:api/internal/pricing.ProUSDAgain` and `symbol:api/internal/pricing.ProID`.

### YAML

```yaml
# @starchart readsEnv env:STRIPE_SECRET_KEY
key: x
```

→ `file:web/deploy.yaml --readsEnv--> env:STRIPE_SECRET_KEY`

### HTML

```html
<div>
<!-- @starchart displays addon:pro.price.usd -->
</div>
```

→ `file:web/public/banner.html --displays--> addon:pro.price.usd`. File nodes reached via `displays` are traversed but not listed by default. Use `impact --all-code` to see them.

## See also

- [Code Authority Facts](Code-Authority-Facts)
- [Bridges and Discovery](Bridges-and-Discovery)
- [Edge Types](Edge-Types)
- [Code Ingestion](Code-Ingestion)
- [Codegen](Codegen)
