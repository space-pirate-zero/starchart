A plan isn't just a list. It's a sequence. Change a price and you want Stripe updated before the website advertises it, and the App Store IAP before the listing that quotes it. `orderSteps` in [`core/order.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/core/order.ts) turns the actionable impact items into the `Order:` line of every plan, using explicit `after`/`blocks` edges first and a per-adapter priority second. This page covers the priority table, the edge semantics, cycle breaking and the `waitsFor` data.

## What gets ordered

Only actionable items: classes `auto`, `review`, `manual`, `retire`, `break` and `code`. Tests and info items are left out. That means code items (anchored symbols) are in the order, alongside world artifacts.

## The algorithm

1. Build a dependency set for each item from `after` and `blocks` edges **between items in this plan**. Edges that point outside the plan are ignored.
2. Repeat until every item is placed:
   - **ready** = unplaced items whose dependencies are all placed;
   - sort ready items by **priority** (lower first), then **id** (alphabetical);
   - place the first one, recording `waitsFor` = its dependencies.
3. If nothing is ready, there's a cycle. Take all remaining items, sort them the same way, place the first one anyway (its `waitsFor` keeps only dependencies already placed), and record the remaining set in `cycles`.

Only one item is placed per round, and the ready set is recomputed each time. An item unblocked by the last placement competes on priority with everything else that's ready.

## Adapter priority

Money systems first, then stores, then code, then the public web, then outbound messaging. Code-layer items always get the `code` priority; artifacts use their binding's adapter; artifacts with no binding or an unlisted adapter get **55**.

| Adapter | Priority |
|---|---|
| `stripe` | 10 |
| `revenuecat` | 20 |
| `appstore` | 30 |
| `playstore` | 30 |
| `code` (any code-layer item) | 40 |
| `fs` | 50 |
| *(no binding / unknown adapter)* | 55 |
| `url` | 60 |
| `cms` | 60 |
| `email` | 70 |
| `youtube` | 80 |
| `tiktok` | 80 |

Several of these (`revenuecat`, `playstore`, `cms`, `email`, `youtube`, `tiktok`) have no adapter yet. The priority applies anyway when you use them as binding labels.

## after and blocks

| You write | Meaning |
|---|---|
| `A after B` (on artifact A: `after: [B]`) | B runs before A. |
| `B blocks A` (on artifact B: `blocks: [A]`) | B runs before A. |

Both are edge types with propagation `none`: they never add items to a plan, only order items already in it. Declare them on artifacts or in an `edges:` section (any two node ids work, including code nodes).

## Real output

The demo has one ordering edge: `appstore:listing/description` is `after: [appstore:iap/pro-monthly]`. Impact of a price change:

```text
Order: stripe:price/pro-monthly → appstore:iap/pro-monthly → appstore:listing/description → appstore:screenshots/6.9/03 → symbol:ios/Pricing.proUSD → symbol:ios/StarchartFacts.AddonPro.Price.usd → symbol:web/lib/starchart-facts#ADDON_PRO_PRICE_USD → symbol:web/lib/stripe#PRICE_PRO_MONTHLY → email:onboarding-day-3 → web:landing-hero → web:messages-en → web:og-pro → web:pricing-page → web:live-pricing → reel:spring-2026
```

Stripe (10), App Store (30), code symbols (40), fs artifacts (50), the url-bound live page (60), the YouTube reel (80). Inside a priority band, alphabetical.

### Adding a `blocks` edge

Say the pricing page must ship before the Stripe price changes (maybe it has to announce the new price first):

```yaml
# .starchart/order.yaml
edges:
  - { from: web:pricing-page, to: stripe:price/pro-monthly, type: blocks }
```

```text
Order: appstore:iap/pro-monthly → appstore:listing/description → appstore:screenshots/6.9/03 → symbol:ios/Pricing.proUSD → symbol:ios/StarchartFacts.AddonPro.Price.usd → symbol:web/lib/starchart-facts#ADDON_PRO_PRICE_USD → symbol:web/lib/stripe#PRICE_PRO_MONTHLY → email:onboarding-day-3 → web:landing-hero → web:messages-en → web:og-pro → web:pricing-page → stripe:price/pro-monthly → web:live-pricing → reel:spring-2026
```

Stripe now waits for the pricing page. The JSON output (`-f json`) shows each step's `waitsFor`:

```json
[
  { "id": "appstore:listing/description", "class": "manual", "waitsFor": ["appstore:iap/pro-monthly"] },
  { "id": "stripe:price/pro-monthly", "class": "manual", "waitsFor": ["web:pricing-page"] },
  { "id": "web:live-pricing", "class": "manual", "waitsFor": ["web:pricing-page"] }
]
```

(Filtered to steps with a non-empty `waitsFor`.)

### Cycles

Add `web:pricing-page after web:live-pricing`, while the demo already says `web:live-pricing after web:pricing-page`:

```yaml
edges:
  - { from: web:pricing-page, to: web:live-pricing, type: after }
```

```text
Order: stripe:price/pro-monthly → … → web:og-pro → reel:spring-2026 → web:pricing-page → web:live-pricing
Cycle broken deterministically: web:pricing-page, web:live-pricing
```

Everything outside the cycle is placed first, even the priority-80 reel, because cycle breaking only kicks in once nothing is ready. Then the lowest-priority-number item in the cycle (`web:pricing-page`, fs 50) is placed with an empty `waitsFor`, which unblocks `web:live-pricing`. `cycles` in the JSON output lists the stuck set: `[["web:pricing-page","web:live-pricing"]]`.

## Where the order is used

- The `Order:` line in `impact` and `plan` text output, and `steps` in JSON and markdown.
- `starchart apply` runs `auto` steps in this order ([Apply, Revert and Journals](Apply-Revert-and-Journals)). Generated constants sit in the code band (40), so codegen runs before the fs writes; it runs once, at the first generated symbol, and later generated symbols reuse that result.
- After an apply or `ack`, `plan` drops artifacts that are already in sync, so the `Order:` line shrinks to what's left. After the demo apply: `stripe:price/pro-monthly → appstore:iap/pro-monthly → appstore:listing/description → appstore:screenshots/6.9/03 → symbol:ios/Pricing.proUSD → symbol:web/lib/stripe#PRICE_PRO_MONTHLY → web:landing-hero → web:live-pricing → reel:spring-2026`.

Release choreography with approval gates between steps isn't built yet.

## See also

- [Impact Analysis](Impact-Analysis)
- [Artifacts and Bindings](Artifacts-and-Bindings)
- [Apply, Revert and Journals](Apply-Revert-and-Journals)
- [Adapters Overview](Adapters-Overview)
