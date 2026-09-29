Impact analysis answers one question: *if this changes, what else has to change?* STARCHART walks the graph from the changed nodes across all three layers, then classifies each thing it reaches: fix automatically, fix by hand, review, retire, update code, or run tests. This page documents the traversal step by step, the code-reporting modes, every branch of the classifier, the impact classes and their symbols, confidence, and the "why" paths. Source: [`core/impact.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/core/impact.ts) and [`api.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/api.ts).

## Where impact runs

| Entry point | Seeds |
|---|---|
| `starchart impact <refs…>` | the nodes you name (ids, file paths, unique suffixes) |
| `starchart impact --diff <base>` | code nodes touched by `git diff <base>`, plus facts changed since the lock ([Git Diff Impact](Git-Diff-Impact)) |
| `starchart plan` | every fact and code node whose hash differs from `starchart.lock`, plus the changed dependencies of artifacts that are still stale ([Lockfile and Drift](Lockfile-and-Drift)) |
| `starchart why <from> <to>` | one seed, then reports the single path to `<to>` |
| `computeImpact(graph, seeds, options)` | library ([Library API](Library-API)) |

All of them call `computeImpact`, keep the actionable items (`auto`, `review`, `manual`, `retire`, `break`, `code`) and hand those to [Rollout Ordering](Rollout-Ordering).

`plan` (`planFromLock`) does one more thing: it drops artifacts that are locked and already in sync, so `plan` and `check` always agree. After an `apply`, the artifacts it fixed are relocked and vanish from the plan, while the manual, review, code and retire items stay listed until you fix them or `starchart ack` them. It never falls back to "no changes" while something is still stale. After changing the price to 5.99 and running `starchart apply --yes`, `starchart plan` prints:

```text
Change: addon:pro.price  {"usd":4.99,"eur":4.99} → {"usd":5.99,"eur":4.99}
Change: addon:pro.price.usd  4.99 → 5.99
Change: symbol:ios/StarchartFacts.AddonPro.Price.usd  ∅ → 5.99
Change: symbol:web/lib/starchart-facts#ADDON_PRO_PRICE_USD  ∅ → 5.99

  ! manual  appstore:iap/pro-monthly                 mirrors    update in appstore (adapter is read-only)
  …
  ⌘ code    symbol:web/lib/stripe#PRICE_PRO_MONTHLY  anchors    holds this artifact's external id; update it if the id changes
  ✗ retire  reel:spring-2026                         embeds     expired 2026-06-30
  ✓ tests   test:ios/Tests/PaywallTests.swift        tests      run these tests
…
Plan: 5 manual · 1 review · 2 code · 1 retire · 1 tests
```

The `∅ → 5.99` lines are the constants `apply` just regenerated. Their hashes moved and the still-stale artifacts depend on them, so they're seeds too; the lock pins code by hash only, so there's no old value to show.

## Options and defaults

| Option | Default | Meaning |
|---|---|---|
| `maxDepth` | `12` | Maximum hops from a seed. |
| `maxCodeDepth` | `4` (or `code.maxCodeDepth` from config) | Maximum *consecutive* hops inside the code layer. Stops "everything imports everything" from swallowing the plan. The lockfile records the same value, so `check` walks the same depth. |
| `minConfidence` | `0.3` | Paths whose confidence drops below this are pruned. |
| `edgeTypes` | all | Only traverse these edge types. |
| `includeCode` | `"surface"` | Which code nodes to *report* (all are traversed): `surface`, `all`, `none`. |
| `canWrite(adapter, node)` | `adapter === "fs"` in the library; the CLI asks the adapter registry with your config and the artifact node | Decides `auto` vs `manual`, per artifact. |
| `now` | current time | Used for `validThrough` expiry. |

The CLI exposes `--all-code` (`includeCode: "all"`) and `-v/--verbose` (show `info` items and why-paths). `why` runs with `includeCode: "all"` and `minConfidence: 0`. The other options are library-only.

## The traversal, step by step

1. **Seed.** Drop seeds that aren't in the graph. Each remaining seed enters the queue at depth 0, code depth 0, confidence 1, empty path, and is marked visited.
2. **Pop** the next entry (breadth-first, FIFO). If its depth is already `maxDepth`, don't expand it.
3. **Find neighbours** that a change to this node impacts (`neighbors()`):
   - for each **incoming** edge whose propagation is `reverse` or `both`: the edge's `from`;
   - for each **outgoing** edge whose propagation is `forward` or `both`: the edge's `to`;
   - for each **incoming `contains`** edge: the containing file, with the edge confidence forced to 0.8. A changed symbol means its file changed.
4. **Filter** each neighbour, in order:
   - edge type not in `edgeTypes` → skip;
   - already visited → skip (the first, shortest path wins);
   - node missing → skip;
   - if both ends are code nodes, code depth + 1, else reset to 0; above `maxCodeDepth` → skip;
   - confidence = current × edge confidence (default 1) × `DECAY[type]` (default 1); below `minConfidence` → skip.
5. **Enqueue** the neighbour with depth + 1, the new code depth and confidence, and the path extended by one hop `{from: current, to: neighbour, type}`. Mark it visited.
6. When the queue drains, **report** every visited non-seed node. The item's `via` is the edge type of the path's last hop. Code nodes are filtered by `includeCode`. Everything left is classified.
7. **Sort** by depth, then id. (The text formatter re-sorts by class urgency for display.)

Because visited is set on enqueue, each item carries its *shortest* path (fewest hops). Its confidence is the confidence of that path, not the best possible path.

The decay table:

| Edge | Decay |
|---|---|
| `references` | 0.95 |
| `readsEnv`, `readsFlag` | 0.9 |
| `imports` | 0.85 |
| `dependsOn` | 0.7 |
| others | 1 |

## Code reporting: surface, all, none

Every code node is traversed, because the path to a screenshot often runs through five symbols. What gets *reported* depends on `includeCode`:

| Mode | Code nodes reported |
|---|---|
| `surface` (default) | screens, routes, tests, and any code node reached via `anchors` |
| `all` (`--all-code`) | every code node reached |
| `none` | none; only facts and world artifacts |

In surface mode, a file annotated with `@starchart displays …` is traversed but not listed. Use `--all-code` to see it:

```text
  · info    file:web/public/banner.html        displays    file affected
      why: addon:pro.price.usd --displays--> file:web/public/banner.html  (confidence 1)
```

## Classification rules

`classify()` looks at the reached node's layer, then (for artifacts) at expiry, retired entities and the last edge type. Branches in evaluation order:

| # | Condition | Class | Reason text |
|---|---|---|---|
| 1 | code node, `kind: test` | `test` | run these tests |
| 2 | code node reached via `anchors`, `meta.generated` set | `auto` | regenerate fact constants (codegen) |
| 3 | code node reached via `anchors` from an **artifact** (the last hop's `from` is an artifact) | `code` | holds this artifact's external id; update it if the id changes |
| 4 | code node reached via `anchors`, otherwise (from a fact) | `code` | hardcoded value anchors this fact; update or switch to codegen |
| 5 | any other code node | `info` | `<kind> affected` |
| 6 | fact-layer node (fact **or entity**) | `info` | derived fact changes |
| 7 | artifact with `validThrough` in the past | `retire` | `expired <date>` |
| 8 | a node on the path (a hop's `from`) has `status: retired`, and `via` is `promotes`, `embeds` or `describes` | `retire` | depends on a retired entity |
| 9 | via `renders` | `auto` | regenerate from template |
| 10 | via `embeds`, artifact type is media (`schema:ImageObject`, `schema:VideoObject`, `schema:MediaObject`, `sc:Print`) | `manual` | value is burned into media |
| 11 | via `embeds`, the binding's adapter can write this artifact | `auto` | replace embedded value |
| 12 | via `embeds`, otherwise | `manual` | `adapter "<id>" cannot write`, or `no binding` |
| 13 | via `mirrors`, the binding's adapter can write this artifact | `auto` | `sync via <adapter>` |
| 14 | via `mirrors`, otherwise | `manual` | `update in <adapter> (adapter is read-only)`, or `no binding` |
| 15 | via `captures` | `manual` | screen changed; re-capture |
| 16 | via `describes` | `review` | describes this semantically |
| 17 | via `promotes` | `review` | promotes this; check it still holds |
| 18 | via `derivedFrom` | `review` | derived from a changed artifact |
| 19 | via `publishes` | `review` | published page changed |
| 20 | via `emits` | `review` | emitted event/ID changed |
| 21 | via anything else | `review` | `impacted via <type>` |

Things worth knowing:

- Expiry (rule 7) beats everything, including `renders`. An expired promo reel is `retire` no matter how it was reached.
- Rule 8 checks the entity's `status` field, which comes from the entity doc's `status:`. It only fires for `promotes`, `embeds` and `describes`; an `embeds` of a leaf fact whose path doesn't pass through the entity is not retired.
- Only artifacts are checked for `validThrough`. An expired *entity* does not retire anything.
- Writability is decided **per artifact**. The CLI calls the registry's `canWrite(adapter, settings, node)`: the adapter must declare write support and implement `apply`; if it implements the optional `canApply(node)`, that must return true for this binding; then `fs` writes unless `adapters.fs.write: false`, while every other adapter (`stripe`, `appstore`, plugin adapters) needs `write: true`. `url` and unknown adapters never write.
- The App Store adapter only applies bindings with a `field` (listing text) and no `set`/`iap`. Screenshots (`set`) and IAPs (the demo's has `product`, no `field`) stay `manual` even with `adapters.appstore.write: true`, and `apply` skips them instead of failing. The IAP's reason then reads `appstore cannot update this binding; update it by hand`: the adapter can write, just not that binding. Without `write: true` it reads `update in appstore (adapter is read-only)`.
- Rules 3 and 4 split anchored code by where the change came from. `symbol:web/lib/stripe#PRICE_PRO_MONTHLY` anchors the Stripe artifact, not a fact, so it holds an external id (`price_…`) rather than the fact's value: update it only if the id changes.
- Generated constants (rule 2, symbols marked `// @starchart generated`) are `auto` because `starchart apply` regenerates every configured [Codegen](Codegen) target once when the plan contains them. No need to run `starchart codegen` first. Codegen output isn't journaled, so `revert` doesn't undo it (git does).

## Impact classes

| Class | Symbol | Meaning | In rollout order? |
|---|---|---|---|
| `break` | ✗ | Reserved. `classify()` never produces it; audits report breaks separately ([Audit and Break Detection](Audit-and-Break-Detection)). | yes |
| `manual` | ! | A human has to change it (read-only adapter, burned-in media, re-capture). | yes |
| `auto` | ~ | `starchart apply` can fix it through an adapter, a template render, or codegen. | yes |
| `review` | ? | Semantic dependency; someone should read it. | yes |
| `code` | ⌘ | A hardcoded literal anchors the fact (update it or switch to codegen), or holds an anchored artifact's external id. | yes |
| `retire` | ✗ | Expired, or depends on a retired entity; take it down. | yes |
| `test` | ✓ | Tests to run (shown as `tests`). | no |
| `info` | · | Context: derived facts, entities, affected screens/routes/files. Hidden unless `-v`. | no |

The text output lists classes in this order: break, manual, auto, review, code, retire, tests, info.

## Why paths

Every item carries its path as a list of hops. `explainPath` renders it as:

```text
<seed> --<type>--> <node> --<type>--> <node> …
```

Hops are written in **propagation order** (from the change outwards), not edge direction. `addon:pro.price.usd --embeds--> web:pricing-page` means "the price change reached the page across an `embeds` edge", even though the stored edge is `web:pricing-page --embeds--> addon:pro.price.usd`. `-v` prints the path and confidence under each item. `starchart why` prints just one:

```bash
starchart why addon:pro.price.usd test:ios/Tests/PaywallTests.swift
```

```text
addon:pro.price.usd --anchors--> symbol:ios/Pricing.proUSD --references--> symbol:ios/PaywallView.body --references--> symbol:ios/PaywallView --tests--> test:ios/Tests/PaywallTests.swift
class test · confidence 0.58 · run these tests
```

`why` exits 1 and prints `<to> does not depend on <from>` when there's no path.

## Worked example: changing the price

```bash
starchart impact addon:pro.price.usd
```

```text
Change: addon:pro.price.usd

  ! manual  appstore:listing/description                        embeds     adapter "appstore" cannot write
  ! manual  appstore:screenshots/6.9/03                         embeds     value is burned into media
  ! manual  stripe:price/pro-monthly                            mirrors    update in stripe (adapter is read-only)
  ! manual  web:live-pricing                                    embeds     adapter "url" cannot write
  ! manual  appstore:iap/pro-monthly                            mirrors    update in appstore (adapter is read-only)
  ~ auto    email:onboarding-day-3                              embeds     replace embedded value
  ~ auto    symbol:ios/StarchartFacts.AddonPro.Price.usd        anchors    regenerate fact constants (codegen)
  ~ auto    symbol:web/lib/starchart-facts#ADDON_PRO_PRICE_USD  anchors    regenerate fact constants (codegen)
  ~ auto    web:messages-en                                     embeds     replace embedded value
  ~ auto    web:og-pro                                          renders    regenerate from template
  ~ auto    web:pricing-page                                    embeds     replace embedded value
  ? review  web:landing-hero                                    describes  describes this semantically
  ⌘ code    symbol:ios/Pricing.proUSD                           anchors    hardcoded value anchors this fact; update or switch to codegen
  ⌘ code    symbol:web/lib/stripe#PRICE_PRO_MONTHLY             anchors    holds this artifact's external id; update it if the id changes
  ✗ retire  reel:spring-2026                                    embeds     expired 2026-06-30
  ✓ tests   test:ios/Tests/PaywallTests.swift                   tests      run these tests

Order: stripe:price/pro-monthly → appstore:iap/pro-monthly → appstore:listing/description → appstore:screenshots/6.9/03 → symbol:ios/Pricing.proUSD → symbol:ios/StarchartFacts.AddonPro.Price.usd → symbol:web/lib/starchart-facts#ADDON_PRO_PRICE_USD → symbol:web/lib/stripe#PRICE_PRO_MONTHLY → email:onboarding-day-3 → web:landing-hero → web:messages-en → web:og-pro → web:pricing-page → web:live-pricing → reel:spring-2026

Plan: 5 manual · 6 auto · 1 review · 2 code · 1 retire · 1 tests
(5 informational items hidden; use --verbose)
```

How some of these were reached, from `-v`:

```text
  ! manual  appstore:iap/pro-monthly                            mirrors     update in appstore (adapter is read-only)
      why: addon:pro.price.usd --partOf--> addon:pro.price --mirrors--> appstore:iap/pro-monthly  (confidence 1)
  ? review  web:landing-hero                                    describes   describes this semantically
      why: addon:pro.price.usd --partOf--> addon:pro.price --partOf--> addon:pro --describes--> web:landing-hero  (confidence 1)
  ⌘ code    symbol:web/lib/stripe#PRICE_PRO_MONTHLY             anchors     holds this artifact's external id; update it if the id changes
      why: addon:pro.price.usd --mirrors--> stripe:price/pro-monthly --anchors--> symbol:web/lib/stripe#PRICE_PRO_MONTHLY  (confidence 1)
  · info    app:nebula                                          partOf      derived fact changes
      why: addon:pro.price.usd --partOf--> addon:pro.price --partOf--> addon:pro --partOf--> app:nebula  (confidence 1)
```

Notice the Stripe price id constant: it isn't anchored to the price, it's anchored to the Stripe *artifact* (`// @starchart anchors stripe:price/pro-monthly`). Stripe prices are immutable, so a new amount usually means a new price and a new `price_…` id, and then the constant has to change too. The classifier knows the last hop came from an artifact and says so in the reason. `anchors` propagates both ways, which makes that chain possible.

## Worked example: changing a screen

```bash
starchart impact apps/ios/Sources/Paywall/PaywallView.swift -v
```

```text
Change: file:ios/Sources/Paywall/PaywallView.swift
Change: symbol:ios/PaywallView
Change: symbol:ios/PaywallView.body

  ! manual  appstore:screenshots/6.9/03        captures    screen changed; re-capture
      why: symbol:ios/PaywallView --references--> screen:ios/Paywall --captures--> appstore:screenshots/6.9/03  (confidence 0.95)
  ✗ retire  reel:spring-2026                   captures    expired 2026-06-30
      why: symbol:ios/PaywallView --references--> screen:ios/Paywall --captures--> reel:spring-2026  (confidence 0.95)
  ✓ tests   test:ios/Tests/PaywallTests.swift  tests       run these tests
      why: symbol:ios/PaywallView --tests--> test:ios/Tests/PaywallTests.swift  (confidence 0.8)
  · info    screen:ios/Paywall                 references  screen affected
      why: symbol:ios/PaywallView --references--> screen:ios/Paywall  (confidence 0.95)

Order: appstore:screenshots/6.9/03 → reel:spring-2026

Plan: 1 manual · 1 retire · 1 tests · 1 info
```

## Worked example: retiring an entity

Set `status: retired` on `addon:pro` and run `starchart plan -v`:

```text
Change: addon:pro.status  "active" → "retired"

  ~ auto    symbol:ios/StarchartFacts.AddonPro.status        anchors    regenerate fact constants (codegen)
  ~ auto    symbol:web/lib/starchart-facts#ADDON_PRO_STATUS  anchors    regenerate fact constants (codegen)
  ✗ retire  email:onboarding-day-3                           describes  depends on a retired entity
      why: addon:pro.status --partOf--> addon:pro --describes--> email:onboarding-day-3  (confidence 1)
  ✗ retire  reel:spring-2026                                 promotes   expired 2026-06-30
  ✗ retire  web:landing-hero                                 describes  depends on a retired entity
  …
Plan: 2 auto · 3 retire · 2 info
```

## Output formats

`impact` and `plan` take `-f text|markdown|json`. JSON items include `id`, `class`, `layer`, `kind`, `via`, `reason`, `confidence`, `depth`, `why` (the rendered path) and `path` (the hops). Steps include `waitsFor`. See [CLI Reference](CLI-Reference).

## Limitations

- Classification is structural. `review` means "a human should read this", not "this is wrong". LLM claim checking isn't built yet.
- Swift, Kotlin and Go references are resolved by name (no SCIP yet), hence confidence below 1 on those edges.
- The reported confidence belongs to the shortest path, not the strongest.

## See also

- [Edge Types](Edge-Types)
- [Rollout Ordering](Rollout-Ordering)
- [Lockfile and Drift](Lockfile-and-Drift)
- [Git Diff Impact](Git-Diff-Impact)
- [Change Cost](Change-Cost)
