The `fs` adapter owns every file inside your repo: source code with a hardcoded price, a JSON string table, a Markdown email, an OG image rendered from an SVG template. It is the only adapter that writes by default. This page covers binding fields and selectors, the exact text-matching rules, what `audit` reports, how `apply` replaces values (and when it refuses), template renders including SVG→PNG, revert, and worked examples.

Source: [`adapters/fs.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/adapters/fs.ts) and the shared matcher [`adapters/text.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/adapters/text.ts).

## Binding

```yaml
binding: { adapter: fs, path: apps/web/messages/en.json, selector: "json:$.pricing.pro" }
```

| Field | Required | Meaning |
|---|---|---|
| `adapter` | yes | `fs` |
| `path` | yes (unless the artifact has a template with `out`) | Root-relative file path. Paths that escape the project root are refused: `path "../x" is outside the project root`. |
| `selector` | no | Narrows where values are searched and replaced. `json:<path>` or `regex:<pattern>`. |

If `path` is missing but the artifact declares `renders: { template, out }`, the `out` path is used. With neither, you get `<id>: fs binding needs a "path"`.

### Selectors

| Selector | Example | Scope |
|---|---|---|
| none | | The whole file |
| `json:` | `json:$.plans.pro.price`, `json:$.plans[0].price`, `json:$["pro plan"].price` | Only the scalars under that JSON path. The file must parse as JSON. |
| `regex:` | `regex:price:\s*"([^"]+)"` | Only the regions the regex matches. If the pattern has a capture group, only group 1 counts. Compiled with flags `gmd`. |

JSON paths accept `$`, `.key`, `[0]` and `["quoted key"]`. A leading `$` is optional. Anything else is `invalid JSON path`.

Use a selector when the same number means two things in one file. That is exactly the situation where STARCHART refuses to guess (see [Safety refusals](#safety-refusals)).

## Which facts an fs artifact carries

The adapter collects **leaf facts** reached through `embeds`, `mirrors` and `renders` edges. A container fact expands to its leaves: embedding `addon:pro.price` (`{usd: 4.99, eur: 4.99}`) means checking both `addon:pro.price.usd` and `addon:pro.price.eur`. Array facts contribute each string or number element. `describes` and `promotes` edges are semantic and never text-checked.

## Text matching rules

All text adapters (fs, url, appstore) share `text.ts`. The rules, verified against the code:

**Token boundaries.** A value only matches as a whole token.

| Value | Text | Match? | Why |
|---|---|---|---|
| `4.99` | `$4.99/mo` | yes | `$` is not a word character |
| `4.99` | `costs $4.99.` | yes | a trailing sentence period is fine |
| `4.99` | `14.99` | no | preceded by a digit |
| `4.99` | `v1.4.99` | no | preceded by digit + `.` |
| `4.99` | `4.995` | no | followed by a digit |
| `5` | `5.50` | no | followed by `.` + digit |
| `Pro` | `Proton` | no | followed by a letter |
| `Pro` | `Pro+` | yes | `+` is not a word character |

Word characters are Unicode letters, digits and `_`. For non-numeric strings, a boundary is only enforced on a side where the value itself starts or ends with a word character.

**Number forms.** A number matches its `String(value)` form, plus a two-decimal money form:

| Fact value | Forms searched |
|---|---|
| `5` | `5`, `5.00` |
| `4.5` | `4.5`, `4.50` |
| `4.99` | `4.99` |

**Currency.** Currency symbols are not part of the value. `$4.99`, `€4.99` and `4.99 USD` all contain the token `4.99`. Locale formats are not recognized: `4,99 €` does **not** match `4.99`. A YAML value of `5.00` is stored as the number `5`, so both `$5` and `$5.00` match it. Other renderings (`five dollars`, localized digits, thousands separators) do not.

**Strings.** Strings match literally and case-sensitively. Empty strings never match. Booleans and objects have no text form and are ignored.

**Replacement preserves style.** When the matched text was two-decimal (`5.00`) and the new value is a number, the replacement is formatted with two decimals too (`6.00`, not `6`).

## Audit

For a plain (non-template) artifact, `audit` reads the file and, for each leaf fact:

1. **Stale.** If the lock's previous value differs from the current value and any form of the old value is still in the file (inside the selector), report `stale` with the first occurrence's line: `still shows old value 4.99; expected 5.99`. Multiple hits are counted: `(3 occurrences)`.
   - An old value that is the *current* value of another fact on the same artifact is not reported as stale. If `usd` moved from 4.99 to 5.99 but `eur` is still 4.99, the remaining `4.99` belongs to `eur`.
2. **Missing.** Otherwise, if any current value is absent, report `missing`: `does not contain 5.99`.

Other outcomes:

| Situation | Diff |
|---|---|
| File doesn't exist | `missing`: `file not found: <path>` |
| JSON selector path not found | `missing`: `JSON path $.x not found` |
| File isn't valid JSON (with a `json:` selector) | thrown, reported under audit **errors** |

Real output from the demo after changing `addon:pro.price.usd` from 4.99 to 5.99 (other lines trimmed):

```text
! stale  email:onboarding-day-3 marketing/emails/onboarding-day-3.md:3  still shows old value 4.99; expected 5.99
! stale  web:messages-en apps/web/messages/en.json:4  still shows old value 4.99; expected 5.99
? missing web:og-pro apps/web/public/og/pro.png  rendered output not found: apps/web/public/og/pro.png
! stale  web:pricing-page apps/web/app/pricing/page.tsx:8  still shows old value 4.99; expected 5.99
```

## Apply

`apply` computes the new content with `computeFsUpdate()` (the same function audit and [Future Universe Preview](Future-Universe-Preview) use), then writes it.

### Replacement semantics

1. Build a replacement plan from the lock's previous values to the current values (`planReplacements`):
   - Scalar → scalar: one `old → new` pair.
   - List → list: elements removed from the old list are paired, in order, with elements added to the new list.
2. Apply every pair **in one pass** (`applyReplacements`). A chain like `4.99 → 5.99` and `5.99 → 6.99` never cascades: `was 4.99 now 5.99` becomes `was 5.99 now 6.99`. Overlapping matches keep the earliest, longest hit.
3. With a `json:` selector, the file is parsed, only scalars under the path are rewritten (numbers stay numbers), and the file is re-serialized with its detected indent and trailing newline. With `regex:`, only the matched regions are touched.
4. Verify: every changed fact must now be present. If an old value was never found, the apply fails rather than claim success.

If nothing changed, `apply` returns `ok` with no changes and writes nothing. With `--dry-run`, changes come back prefixed with `would`.

### Generated constants are not fs steps

Files produced by [Codegen](Codegen) (`// @starchart generated` symbols) are not written through fs. `apply` runs one codegen pass for all of them and reports each symbol under the `codegen` adapter:

```text
✓ symbol:web/lib/starchart-facts#ADDON_PRO_PRICE_USD [codegen] regenerated apps/web/lib/starchart-facts.ts; regenerated apps/ios/Sources/Core/StarchartFacts.swift
✓ web:pricing-page [fs] addon:pro.price.usd: 4.99 → 5.99
```

Codegen output is not journaled, so `revert` leaves it alone. Generated files are reproducible; git undoes them. With no `codegen` targets configured the step fails: `generated constants found but no codegen targets are configured`.

### Safety refusals

fs refuses rather than corrupt a file. Each refusal fails the step (and stops the apply run):

| Refusal | Message |
|---|---|
| **Ambiguous old value.** The old value is also the current value of another fact on this artifact. | `ambiguous: old value 4.99 of addon:pro.price.usd is also the current value of addon:pro.price.eur; add a selector to the binding` |
| **Unplaceable list items.** A list grew and the new items have no old counterpart to replace. | `cannot place new item(s) "c" (fact:x) by find-and-replace; edit <path> manually, then "starchart ack <id>"` |
| **Old value not found.** | `could not find old value 4.99 of addon:pro.price.usd in <path>` (plus `(within selector)` when one is set) |
| File missing, bad selector, bad JSON, JSON path not found | the corresponding message |

The ambiguity case is real. The demo's `addon:pro.price` is `{usd: 4.99, eur: 4.99}`. An artifact that embeds the whole `addon:pro.price` container and then sees `usd` move to 5.99 cannot know which `4.99` is the dollar price. Bind it with a selector, or embed `addon:pro.price.usd` only (which is what the demo does).

## Template renders

An artifact with an object-form `renders` is regenerated from a template instead of patched:

```yaml
- id: web:og-pro
  binding: { adapter: fs, path: apps/web/public/og/pro.png }
  renders: { template: apps/web/og/pro.svg, with: [addon:pro.name, addon:pro.price.usd] }
```

The compiler stores `template` and `out` in `meta.template` / `meta.templateOut` and adds a `renders` edge to each `with` fact. `renders` edges always classify as `auto` ("regenerate from template").

| Output extension | What happens |
|---|---|
| `.png` | The template must be `.svg`. It is filled with facts (XML-escaped) and rasterized with resvg at the SVG's intrinsic width (from `width` or `viewBox`), with system fonts loaded. A non-SVG template fails: `only .svg templates rasterize`. |
| `.svg`, `.html`, `.htm`, `.xml` | Rendered as text with every substituted value XML-escaped |
| anything else | Rendered as text, no escaping |

Template syntax is `{{ addon:pro.price.usd | money:USD }}`, with filters `money`, `upper`, `lower`, `join` and `default`. An unknown fact without `default` is an error. Full reference: [JSON-LD and SEO](JSON-LD-and-SEO) and [`render/template.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/render/template.ts).

Audit for template artifacts:

| Situation | Diff |
|---|---|
| Template file missing or render throws | `break` with the error |
| Output file doesn't exist | `missing`: `rendered output not found: <path>` |
| Output differs from a fresh render | `mismatch`: `out of date with template <template>` |

PNGs are compared pixel by pixel with pixelmatch (threshold 0.1), so a re-encode that looks identical doesn't count as drift. Text outputs are compared byte for byte.

## Revert

Every real write returns an undo record holding the file's previous bytes (base64) or the fact that it didn't exist:

```json
{
  "adapter": "fs",
  "artifact": "web:og-pro",
  "data": { "path": "apps/web/public/og/pro.png", "existed": false, "encoding": "base64", "content": null }
}
```

`revert` restores the old bytes exactly, or deletes a file that the apply created (`removed generated apps/web/public/og/pro.png`). Revert restores a snapshot. It does not merge: edits made to the file after the apply are overwritten.

## Examples

A JSON string table where only one key should change:

```yaml
- id: web:messages-en
  binding: { adapter: fs, path: apps/web/messages/en.json, selector: "json:$.pricing" }
  embeds: [addon:pro.name, addon:pro.price.usd]
```

A Swift file where the price appears in a comment you don't want touched:

```yaml
- id: ios:pricing-constant
  binding: { adapter: fs, path: apps/ios/Sources/Core/Pricing.swift, selector: 'regex:proUSD\s*=\s*([\d.]+)' }
  embeds: [addon:pro.price.usd]
```

Make fs read-only for a cautious first week:

```yaml
adapters:
  fs: { write: false }
```

Every fs step then plans as `manual` with the reason `adapter "fs" cannot write`.

## See also

- [Adapters Overview](Adapters-Overview)
- [Apply, Revert and Journals](Apply-Revert-and-Journals)
- [Future Universe Preview](Future-Universe-Preview)
- [Artifacts and Bindings](Artifacts-and-Bindings)
- [Adapter url](Adapter-url)
