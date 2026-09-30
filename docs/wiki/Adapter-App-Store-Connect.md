The `appstore` adapter audits and (when you opt in) edits your App Store Connect listing text: description, promotional text, keywords, What's New, name and subtitle. It signs its own ES256 JWTs, finds the right app version, and knows which fields Apple lets you change on a live app and which need a new version. Screenshots and in-app purchase prices are deliberately out of scope. This page covers credentials, the JWT, bindings, version selection, supported fields, apply rules, revert, and what stays manual.

> **Status: verified live (2026-09-30).** Besides the mocked test suite ([`adapters/appstore.test.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/adapters/appstore.test.ts)), the adapter has run against a real App Store Connect account: JWT auth, `audit` of `name`, `subtitle`, `description` and `promotionalText`, and a full `apply` → `revert` of `promotionalText` on an unreleased version (see [Live verification](#live-verification)). Other writable fields (`description`, `keywords`, `whatsNew`) share the same PATCH path but haven't been written live yet. Audit first, use `--dry-run`, and try writes on an app you can afford to fumble.

Source: [`adapters/appstore.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/adapters/appstore.ts).

## Credentials

You need an App Store Connect API key (Users and Access → Integrations → App Store Connect API): a key id, the issuer id, and the `.p8` private key file. Give the key a role that can edit app metadata if you plan to write.

Each value is read from adapter settings first, then the environment:

| Value | Setting (`adapters.appstore.*`) | Env fallback |
|---|---|---|
| Key id | `keyId` | `ASC_KEY_ID` |
| Issuer id | `issuerId` | `ASC_ISSUER_ID` |
| Private key file | `keyPath` (relative to the project root) | `ASC_PRIVATE_KEY_PATH` |
| Private key PEM, inline | none | `ASC_PRIVATE_KEY` (literal `\n` sequences become newlines) |

A key file path wins over `ASC_PRIVATE_KEY`. An unreadable file is reported as missing credentials: `App Store Connect private key not readable at secrets/AuthKey.p8`.

```yaml
# .starchart/config.yaml
adapters:
  appstore:
    keyId: ABC123DEFG
    issuerId: 00000000-0000-0000-0000-000000000000
    keyPath: secrets/AuthKey_ABC123DEFG.p8   # keep this file out of git
```

Or keep config empty and export `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_PRIVATE_KEY_PATH` in CI.

> **Config values are not environment-interpolated.** `keyId: ${ASC_KEY_ID}` in `config.yaml` is the literal string `${ASC_KEY_ID}`, and because settings win over env vars, that string is sent as the key id and the real `ASC_KEY_ID` is ignored. Put literal values in config, or leave the keys out and let the adapter read the environment. The demo has no `appstore` block at all; the adapter is still registered and reads the env vars.

Anything missing throws `MissingCredentialsError` and `audit` skips the artifact:

```text
skip  appstore:listing/description: App Store Connect credentials missing: ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY_PATH or ASC_PRIVATE_KEY
```

That is the demo, run with no ASC variables set. Only the values still missing are listed, so with `ASC_KEY_ID` and `ASC_ISSUER_ID` exported the message shrinks to `…missing: ASC_PRIVATE_KEY_PATH or ASC_PRIVATE_KEY`.

## The JWT

`createAscToken()` builds a standard App Store Connect token, signed locally with Node's `crypto`:

| Part | Value |
|---|---|
| Header | `{ "alg": "ES256", "kid": <keyId>, "typ": "JWT" }` |
| Payload | `{ "iss": <issuerId>, "iat": now, "exp": now + 1200, "aud": "appstoreconnect-v1" }` |
| Signature | ECDSA P-256 over SHA-256, in raw `r‖s` (IEEE P1363) form, base64url |

The token lives 20 minutes, and a fresh one is minted for every audit, apply or revert call. It goes to `https://api.appstoreconnect.apple.com` as `Authorization: Bearer <jwt>`.

## Binding

```yaml
- id: appstore:listing/description
  binding: { adapter: appstore, app: "6450000000", field: description, locale: en-US }
  embeds: [addon:pro.name, addon:pro.price.usd]
```

| Field | Required | Default | Meaning |
|---|---|---|---|
| `app` | yes | | Numeric App Store Connect app id (the Apple ID of the app, not the bundle id). Quote it in YAML. |
| `field` | yes, for audit and apply | | One of `description`, `promotionalText`, `keywords`, `whatsNew`, `name`, `subtitle` |
| `locale` | no | `en-US` | Localization to read and write |
| `platform` | no | `IOS` | Version platform filter (`IOS`, `MAC_OS`, `TV_OS`, `VISION_OS`) |
| `set` | | | Marks a screenshot binding. Out of scope (see below). |
| `iap` | | | Marks an in-app purchase price binding. Out of scope. (The demo binds its IAP with `product:` instead; any binding without `field` is treated the same way.) |

An unsupported `field` throws `unsupported appstore field "…"`. A non-numeric `app` throws `appstore binding needs "app" (numeric App Store Connect app id)`.

Bindings with `set`, with `iap`, **or with no `field`** get nothing from `audit`: it returns an empty list and the artifact is counted as checked. The demo's `appstore:iap/pro-monthly` (bound by `product`, no `field`) and `appstore:screenshots/6.9/03` (bound by `set` and `index`) behave this way, which is why they appear under `checked` in `audit -f json` although nothing was compared. That is a known limitation: "checked" here means "the adapter ran", not "the listing was verified".

## Fields

| Field | Lives on | Apple limit enforced on apply |
|---|---|---|
| `description` | App Store version localization | 4000 characters |
| `promotionalText` | App Store version localization | 170 |
| `keywords` | App Store version localization | 100 |
| `whatsNew` | App Store version localization | 4000 |
| `name` | App info localization | 30 |
| `subtitle` | App info localization | 30 |

Characters are counted by code point. An apply that would exceed the limit fails: `promotionalText would be 181 characters; App Store Connect allows 170`.

## Version selection and editable states

Version fields list the app's versions (`GET /v1/apps/<app>/appStoreVersions?filter[platform]=IOS&limit=5`). Info fields list app infos (`GET /v1/apps/<app>/appInfos`). The adapter picks a parent in this order:

1. The first resource in an **editable** state, trying states in this order: `PREPARE_FOR_SUBMISSION`, `DEVELOPER_REJECTED`, `REJECTED`, `METADATA_REJECTED`, `INVALID_BINARY`.
2. Otherwise the **live** one: `READY_FOR_SALE` or `READY_FOR_DISTRIBUTION`.
3. Otherwise the first one returned.

Then it loads that parent's localizations and picks the one matching `locale` (`version … has no en-US localization` if none).

So audit checks the version you're preparing when one exists, and the live listing otherwise. Only the 5 versions the API returns first are considered.

## Audit

Collects leaf facts through `embeds`, `mirrors` and `renders`, reads the field's text and runs the shared text audit (same rules as [Adapter fs](Adapter-fs#text-matching-rules)). An old value from the lock still present is `stale`. A current value absent is `missing`. `where` looks like `appstore:6450000000/en-US/description`.

API errors (`App Store Connect GET /v1/…: HTTP 401 …`) are thrown and land under audit **errors**.

## Apply

Only runs for `auto` steps, which requires `adapters.appstore.write: true` **and** a binding the adapter can write. The adapter implements `canApply(node)`: it returns true only for bindings with a supported `field` and no `set` or `iap`. Everything else fails `canApply`, so `canWrite` says no for that artifact and the planner marks it `manual` whatever the config says. Then:

1. Plan replacements from the lock's old values to current values. **Ambiguous** old values and **unplaceable** list items fail, as in fs: `ambiguous: old value 4.99 of … is also the current value of …`, `cannot place new item(s) … in description; edit it in App Store Connect`.
2. Resolve the target version or app info for writing.
3. **Editability rule:**
   - `promotionalText` can be changed on a live version. If no editable version exists, apply targets the live (`READY_FOR_SALE` / `READY_FOR_DISTRIBUTION`) version.
   - Every other field needs an editable parent. Otherwise: `description can only be changed on an editable version (current: READY_FOR_SALE); create a new version in App Store Connect first`.
4. Replace old values in the current text in one pass. If nothing matched: `could not find old value … in description (en-US)`.
5. Enforce the length limit.
6. `PATCH /v1/appStoreVersionLocalizations/<id>` or `/v1/appInfoLocalizations/<id>` with just that attribute.

Changes read `updated description (en-US): 4.99 → 5.99`, with `, live version` added to the label when the write hit a live version. With `--dry-run`: `would update …`.

Apply never creates versions and never submits for review. A fixed description sits in your prepared version until you submit it.

Because of `canApply`, screenshot and IAP artifacts never reach `apply`, and a run with `write: true` no longer fails on them: they are listed under "Still needs a human" with the other manual items. If you call the adapter directly through the library with such a binding, it still refuses: `screenshots and in-app purchase prices are updated manually`.

## Screenshots and IAP prices stay manual

Not audited, not written:

- **Screenshots** (`set` bindings) need re-capturing and re-uploading. The graph still tracks them: a screenshot that `captures` a changed screen or `embeds` a changed price plans as `manual` (`value is burned into media` or `screen changed; re-capture`).
- **In-app purchase and subscription prices** (`iap` bindings, or any binding without `field`) go through Apple's price schedules and tiers. The demo's `appstore:iap/pro-monthly` mirrors `addon:pro.price` and plans as `manual`: `update in appstore (adapter is read-only)`. With `write: true` it stays `manual` because `canApply` rejects the binding (the adapter has no price support), and the reason becomes `appstore cannot update this binding; update it by hand`.

Pixel-level drift against published store screenshots isn't built yet (see [Roadmap](Roadmap)).

## Revert

The undo record holds the localization id, scope (`version` or `info`), field and the **entire previous text**:

```json
{ "adapter": "appstore", "artifact": "appstore:listing/description",
  "data": { "scope": "version", "localizationId": "…", "field": "description", "previous": "…full old text…" } }
```

`revert` PATCHes that text back: `restored description`. Like fs, it restores a snapshot, so edits made in App Store Connect after the apply are overwritten. A version that has since gone live may reject the PATCH, in which case revert reports the failure and the lock is not restored (see [Apply, Revert and Journals](Apply-Revert-and-Journals)).

## Enabling writes

```yaml
adapters:
  appstore:
    write: true
```

`starchart adapters` then shows `appstore   writes`. That line is per adapter; per artifact, only `field` bindings become `auto`. From a copy of the demo with `appstore.write: true` and `usd` bumped to 5.99:

```text
$ starchart plan
  ! manual  appstore:iap/pro-monthly                            mirrors    appstore cannot update this binding; update it by hand
  ! manual  appstore:screenshots/6.9/03                         embeds     value is burned into media
  ~ auto    appstore:listing/description                        embeds     replace embedded value
…
``` Suggested order: audit with credentials, `apply --dry-run --only appstore:listing/description`, apply one artifact, check App Store Connect, keep the journal id handy. `write: false` also makes `apply` refuse directly: `writes to App Store Connect are disabled (adapters.appstore.write: false)`.

## Live verification

Run on 2026-09-30 against a real App Store Connect team (15 apps), on an app version in `PREPARE_FOR_SUBMISSION`, so customers never saw the test text:

| Step | Result |
|---|---|
| JWT (ES256) auth, `GET /v1/apps` | 200 with four of six team keys; the other two returned 401 |
| `audit` of `name`, `subtitle`, `description` (en-US) | name in sync; subtitle and description correctly reported `missing` for a fact they don't contain |
| `audit` after a fact change | `! stale … still shows old value "Orbit Alpha"; expected "Orbit Beta"` |
| `apply --yes` on `promotionalText` | `✓ updated promotionalText (en-US): "Orbit Alpha" → "Orbit Beta"`, confirmed at Apple, journal written, lock updated; `check` and `audit` clean afterwards |
| `revert <journal>` | text restored at Apple, `lockRestored: true` |

Two things the run surfaced:

- **Key roles matter.** App Store Connect API keys carry a team role. A key with a read-only role (e.g. Developer or Sales) audits fine but gets `403 FORBIDDEN_ERROR: The API key in use does not allow this request` on apply. Use an App Manager or Admin key when you set `write: true`.
- **STARCHART rewrites, it doesn't author.** `embeds` apply replaces the old fact value inside existing text. An empty field (promotional text is `null` until someone writes it) has nothing to replace, so apply refuses; write the first version by hand or bind the field to a template.

### Keeping credentials in Google Secret Manager

Config values aren't env-interpolated, so pass credentials through the environment. With the key stored as `ASC_ISSUER_ID`, `ASC_KEY_ID` and `ASC_PRIVATE_KEY` secrets:

```bash
for s in ASC_ISSUER_ID ASC_KEY_ID ASC_PRIVATE_KEY; do export $s="$(gcloud secrets versions access latest --secret=$s)"; done
```

```bash
npx @space-pirate-zero/starchart audit
```

`ASC_PRIVATE_KEY` holds the `.p8` contents, so no key file needs to live on disk.

## See also

- [Adapters Overview](Adapters-Overview)
- [Adapter Stripe](Adapter-Stripe)
- [Apply, Revert and Journals](Apply-Revert-and-Journals)
- [Rule Packs](Rule-Packs)
- [Privacy Drift](Privacy-Drift)
