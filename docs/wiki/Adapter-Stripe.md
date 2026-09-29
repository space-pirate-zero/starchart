The `stripe` adapter keeps your Stripe prices and products honest against the facts they mirror. It audits amounts, currencies, product names and whether a price is still active. With writes enabled it can also create replacement prices (Stripe prices are immutable), archive the old ones, rename products, rewrite the price id in your YAML, and roll all of it back. This page covers credentials, bindings, audit, apply, the YAML rewrite, dry runs, revert, `list()` for orphans, and how to turn writes on without burning the ship down.

> **Status: tested against mocked HTTP only.** The adapter's test suite ([`adapters/stripe.test.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/adapters/stripe.test.ts)) runs every call against a fake `fetch`. It has **not yet been exercised against a live Stripe account**, test mode included. Start with a test-mode key and `--dry-run`, and read the journal before trusting it with live prices.

Source: [`adapters/stripe.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/adapters/stripe.ts).

## Credentials

The adapter reads a secret key from an environment variable. The default is `STRIPE_SECRET_KEY`. Point it elsewhere with `secretEnv`:

```yaml
# .starchart/config.yaml
adapters:
  stripe:
    secretEnv: STRIPE_TEST_KEY   # optional; default STRIPE_SECRET_KEY
```

The key is sent as `Authorization: Bearer <key>` to `https://api.stripe.com/v1`. It is never written to journals or output. No `Stripe-Version` header is sent, so requests use your account's default API version.

With no key, the adapter throws `MissingCredentialsError`. `audit` then **skips** the artifact instead of failing:

```text
skip  stripe:price/pro-monthly: Stripe secret key not found: set the STRIPE_SECRET_KEY environment variable
```

A restricted key works if it can read prices and products (audit, list) and, for apply, write prices and products.

## Binding

```yaml
- id: stripe:price/pro-monthly
  label: Stripe price — Pro monthly (USD)
  binding: { adapter: stripe, price: price_1NebulaPro499 }
  mirrors: [addon:pro.price.usd, addon:pro.name]
```

| Field | Meaning |
|---|---|
| `price` | A Stripe price id (`price_…`). Audited for existence, activity and amounts. |
| `product` | A Stripe product id (`prod_…`). Optional when `price` is set, because the product is taken from the price. |

At least one of `price` or `product` is required (`stripe binding needs "price" or "product"`).

### How mirrored facts map to Stripe fields

The adapter looks at leaf facts reached through `mirrors` edges and matches them **by the last segment of the fact id**:

| Fact id ends in | Value type | Compared with |
|---|---|---|
| a currency code (`.usd`, `.eur`, `.gbp`, `.jpy`, … 45 codes) | number | that currency's amount: `unit_amount` if it's the price's currency, else `currency_options.<cur>.unit_amount` |
| `.price` or `.amount` | number | the amount in the price's own currency |
| `.name` | string | the product's `name` |

Mirroring a container like `addon:pro.price` (`{usd, eur}`) expands to its currency leaves. Facts with other names are ignored by this adapter.

Amounts are converted to minor units: `4.99` USD is `499`. Zero-decimal currencies (`jpy`, `krw`, `vnd`, `clp` and the rest of Stripe's list) are compared as-is.

## Audit

With a `price` binding, `GET /v1/prices/<id>?expand[]=currency_options`, then:

| Check | Diff |
|---|---|
| Price returns 404 | `break`: `price price_x does not exist` (audit stops here) |
| Price is archived (`active: false`) | `break`: `price price_x is archived` |
| An amount differs | `mismatch` on `unit_amount` or `currency_options.eur.unit_amount`: `Stripe has 4.99 USD, fact says 5.99 USD` |
| A directly mirrored currency leaf the price has no amount for | `mismatch` on `currency`: `price price_x has no EUR amount (price currency is USD)` |

The last check only fires for currency leaves you mirror directly. A currency that arrived by expanding a container is skipped quietly when the price doesn't carry it. That way a USD-only price can mirror `addon:pro.price` without complaining about EUR.

Then the product (`GET /v1/products/<id>`) is fetched when a `.name` fact is mirrored, or when the binding has only a `product`:

| Check | Diff |
|---|---|
| Product returns 404 | `break`: `product prod_x does not exist` |
| Product is archived | `break`: `product prod_x is archived` |
| Name differs | `mismatch` on `name`: `product name is "Nebula Plus", fact says "Nebula Pro"` |

Non-404 API errors (401, 429, 500) are thrown and land under audit **errors**.

Stripe audit results are `mismatch` and `break`, never `stale`: the adapter compares structured values, not text.

### Break detection for code

Audit also checks price ids that **code** points at: any symbol whose literal value is a `price_…` id (even without a Stripe artifact for it), and any symbol that anchors a Stripe artifact directly (`// @starchart anchors stripe:price/pro-monthly`). A symbol that only anchors a fact the price mirrors, like a product-name constant, is not a price reference. See [Audit and Break Detection](Audit-and-Break-Detection#break-detection-for-code). It uses the same key and reports lines like `Stripe price price_1NebulaPro499 is ARCHIVED; referenced by apps/web/app/api/checkout/route.ts:3`.

## Apply

Only runs when the step is `auto`, which requires `adapters.stripe.write: true` (see [Enabling writes safely](#enabling-writes-safely)).

1. Fetch the price, compute amount deltas. If a directly mirrored currency doesn't exist on the price, fail: `addon:pro.price.eur is EUR but price price_x is USD; bind a matching price`.
2. Fetch the product if a `.name` fact is mirrored and compare names.
3. Nothing differs? Return ok, no changes.

### Prices are immutable: replace and archive

Stripe won't let you edit a price's amount. So apply:

1. **Creates a replacement price** (`POST /v1/prices`), copying from the old one: `product`, `currency`, `nickname`, `tax_behavior`, `recurring` (`interval`, `interval_count`, `usage_type`), every other `currency_options` entry (with its `tax_behavior`), and `metadata`. Changed amounts get the new values.
2. **Transfers the lookup key.** If the old price had a `lookup_key`, the new price is created with the same `lookup_key` and `transfer_lookup_key=true`. Code that resolves prices by lookup key follows automatically.
3. **Archives the old price** (`POST /v1/prices/<old>` with `active=false`).
4. **Reports the new id** as `bindingUpdate: { price: "price_new" }`.

Here is the result from a copy of the demo with `write: true`, `usd` bumped to 5.99, and Stripe simulated by an injected `fetch` (the same technique the tests use). It made exactly four calls: `GET /v1/prices/price_1NebulaPro499`, `GET /v1/products/prod_NebulaPro`, `POST /v1/prices`, `POST /v1/prices/price_1NebulaPro499`:

```json
{
  "artifact": "stripe:price/pro-monthly",
  "ok": true,
  "changes": [
    "created price price_1NebulaPro599x (addon:pro.price.usd: 4.99 USD → 5.99 USD)",
    "archived price price_1NebulaPro499",
    "newPrice: price_1NebulaPro599x"
  ],
  "undo": {
    "adapter": "stripe",
    "artifact": "stripe:price/pro-monthly",
    "data": { "oldPrice": "price_1NebulaPro499", "newPrice": "price_1NebulaPro599x", "lookupKey": "pro_monthly" }
  },
  "bindingUpdate": { "price": "price_1NebulaPro599x" }
}
```

Existing subscriptions stay on the old (now archived) price. Stripe doesn't migrate subscribers when a price is archived, and neither does STARCHART. Moving subscribers is a billing decision you make in Stripe.

### Product rename

If the mirrored `.name` differs, `POST /v1/products/<id>` with the new `name`: `renamed product prod_pro: "Nebula Plus" → "Nebula Pro"`. Products are mutable, so there's no replacement.

### Partial failure

If a call fails midway (say the price was created but archiving the old one failed), the result is `ok: false` **with** the undo record and `bindingUpdate` for what did happen. The engine journals it and rewrites the binding, so `starchart revert` can still clean up.

## bindingUpdate → YAML rewrite

When apply returns `bindingUpdate: { price: "price_new" }`, the engine opens the YAML file that declared the artifact (`meta.file`) and replaces the old id with the new one as a whole identifier token. Your `money.yaml` changes from:

```yaml
binding: { adapter: stripe, price: price_1NebulaPro499 }
```

to

```yaml
binding: { adapter: stripe, price: price_1NebulaPro599x }
```

The engine's record of that edit, from the same simulated run:

```json
{
  "artifact": "stripe:price/pro-monthly",
  "file": ".starchart/artifacts/money.yaml",
  "field": "price",
  "from": "price_1NebulaPro499",
  "to": "price_1NebulaPro599x",
  "written": true
}
```

The CLI prints it as `↻ stripe:price/pro-monthly: binding price price_1NebulaPro499 → price_1NebulaPro599x`. The edit is recorded in the journal's `bindingEdits` and reversed on revert. Only the artifact's own YAML file is edited. A hardcoded `price_…` constant in your code is not rewritten. When the constant anchors the Stripe artifact, it shows up as a `code` item in the plan with its own reason:

```text
  ⌘ code    symbol:web/lib/stripe#PRICE_PRO_MONTHLY  anchors  holds this artifact's external id; update it if the id changes
```

and as a break on the next audit once the old price is archived.

## Dry run

`starchart apply --dry-run` makes the same reads but no writes, and describes the plan:

```text
would create a replacement price (addon:pro.price.usd: 4.99 USD → 5.99 USD) and archive price_1NebulaPro499
```

(That line is from the simulated demo run, which made only the two `GET`s. A name change adds `would rename product <id>: "<old>" → "<new>"`.)

No `bindingUpdate` is returned in dry-run mode, so no YAML is touched.

## Revert

The undo record stores what's needed to go back:

```json
{ "adapter": "stripe", "artifact": "stripe:price/pro-monthly",
  "data": { "oldPrice": "price_old", "newPrice": "price_new", "lookupKey": "pro_monthly",
            "productId": "prod_pro", "oldName": "Nebula Plus", "newName": "Nebula Pro" } }
```

`revert`:

1. Reactivates the old price (`active=true`), moving the `lookup_key` back with `transfer_lookup_key=true` if there was one.
2. Archives the new price.
3. Renames the product back.
4. Returns `bindingUpdate: { price: oldPrice }`.

From the simulated run, reverting that journal gave:

```text
reactivated price price_1NebulaPro499
archived price price_1NebulaPro599x
```

and put `price_1NebulaPro499` back in `money.yaml`. The new price is archived, not deleted (Stripe can't delete prices that were used). The engine restores the YAML binding from the journal's `bindingEdits`, not from the revert's `bindingUpdate`.

## list() for orphans

`capabilities.list` is true. `starchart orphans --external` calls `list()` for every adapter that some artifact binds. The Stripe list pages through `GET /v1/prices?limit=100&active=true` and returns every **active** price:

```ts
{ externalId: "price_…", label: "Pro monthly 4.99 USD/month",
  binding: { adapter: "stripe", price: "price_…" }, active: true }
```

The label is the nickname, lookup key or product id, then the amount and interval. Active prices that no artifact binds are reported as orphans: dead stars still charging money. See [Orphans](Orphans).

## Enabling writes safely

Writes are off until you opt in. `canWrite` treats every non-fs adapter as external and requires exactly `write: true`:

```yaml
adapters:
  stripe:
    secretEnv: STRIPE_TEST_KEY
    write: true
```

A sane rollout:

1. **Audit first.** `STRIPE_SECRET_KEY=sk_test_… starchart audit --ids stripe:price/pro-monthly`. Confirm the adapter sees what you expect.
2. **Test mode.** Use a test-mode key and test-mode price ids until you've seen a full apply and revert cycle work.
3. **Dry run.** `starchart apply --dry-run --only stripe:price/pro-monthly`.
4. **Apply one artifact.** `starchart apply --only stripe:price/pro-monthly`, then look at the journal in `.starchart/journal/` and at the Stripe dashboard.
5. **Know the way back.** `starchart revert <journal-id>`.
6. **Keep it off in CI** unless you mean it. A CI job with `write: true` and a live key can create and archive real prices.

`write: false` also makes `apply` refuse outright (`writes to Stripe are disabled (adapters.stripe.write: false)`), even if the adapter is called directly through the library.

## See also

- [Adapters Overview](Adapters-Overview)
- [Audit and Break Detection](Audit-and-Break-Detection)
- [Apply, Revert and Journals](Apply-Revert-and-Journals)
- [Orphans](Orphans)
- [Adapter App Store Connect](Adapter-App-Store-Connect)
