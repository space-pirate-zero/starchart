Every `starchart` command, subcommand and option, checked against [`cli/main.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/cli/main.ts) and the built CLI's `--help`. Each entry has the synopsis, what it does, every option with its default and choices, how it exits, and a short real example run against a copy of `examples/pro-universe`. Commands are grouped: Setup, Analyze, Sync, Check, Rules & analysis, Outputs, Viewer, Integrations.

## Binaries

| Binary | What |
|---|---|
| `starchart` | the CLI |
| `sc` | the same CLI, shorter (`sc plan`, `sc impact --diff main`) |
| `starchart-mcp` | the MCP server on stdio, same as `starchart mcp` (project root from `$STARCHART_ROOT`, else the cwd) |

The package is `@spz/starchart`, so the npx form is `npx @spz/starchart <command>`. Never bare `npx starchart`: the unscoped npm name belongs to someone else. Node 20+.

> **Not on npm yet.** `@spz/starchart` is not published. Until it is, build from source:
>
> ```bash
> git clone https://github.com/space-pirate-zero/starchart.git && cd starchart && pnpm install && pnpm build
> alias starchart="node $PWD/packages/starchart/dist/cli/bin.js"
> ```
>
> Or call `node /path/to/starchart/packages/starchart/dist/cli/bin.js <command>` directly. Every example below writes `starchart <command>`; substitute whichever form you use.

## Global options

```text
Usage: starchart [options] [command]

Options:
  -V, --version               output the version number
  -C, --cwd <dir>             run as if started in <dir>
  --no-color                  disable colors
  -q, --quiet                 hide warnings
  -h, --help                  display help for command
```

| Option | Effect |
|---|---|
| `-V, --version` | prints `0.1.0` |
| `-C, --cwd <dir>` | resolve the project from `<dir>` instead of the current directory. The project root is the nearest ancestor containing `.starchart/`. Relative output paths (`--badge`, `graph -o`) resolve against this directory |
| `--no-color` | plain output. Colors are also off when stdout is not a TTY or `NO_COLOR` is set |
| `-q, --quiet` | hide `warn …` lines on stderr: code-ingest problems (unknown `@starchart` verb, parse failures, unreadable files), unresolved code facts, edges to unknown nodes |
| `-h, --help` | help for the program or any command: `starchart help impact` works too |

Global options go **before** the command: `starchart -C apps/site plan`.

## Output formats

`-f, --format <format>` choices are per command. Anything outside the list is rejected by the parser (exit 1).

| Commands | Choices |
|---|---|
| `impact`, `plan`, `check`, `rules`, `audit` | `text` (default), `markdown`, `json` |
| `orphans`, `score`, `cost`, `query`, `scan` | `text` (default), `json` |

```text
$ starchart orphans -f markdown
error: option '-f, --format <format>' argument 'markdown' is invalid. Allowed choices are text, json.
…
```

## Exit codes

| Code | When |
|---|---|
| `0` | success, including "found things" for commands that only report |
| `1` | findings in a gating command (table below); a usage error (unknown command or option, missing argument, a `-f` value the command doesn't accept); `emit` with no subcommand |
| `2` | a runtime error, printed as `starchart: <message>`: no `.starchart/` found, invalid YAML or config, unknown or ambiguous node ref, bad git revision, unknown hook target, `init` over an existing config, … |

Commands that exit **1 on findings**:

| Command | Exits 1 when |
|---|---|
| `check` | any artifact is stale or unlocked |
| `audit` | any diff or adapter error |
| `rules` | any violation with severity `error` |
| `privacy` | any `privacy`-pack violation with severity `error` |
| `scan` | any unbound occurrence (never with `--all`) |
| `why` | `<to>` does not depend on `<from>` |
| `apply` | the confirmation was declined (or stdin is not a TTY and `--yes` is missing), or a step failed |
| `revert` | any undo step failed (`"ok": false` in the report) |

`impact`, `plan`, `orphans`, `score`, `cost` and `history` always exit 0 when they run. Gate CI with `check` and `rules`.

Piping into something that closes early (`starchart emit graph | head`) is fine: the broken pipe (EPIPE) exits quietly with the command's own exit code instead of crashing.

---

## Setup

### `init`

```text
starchart init [--discover] [--force]
```

Scaffolds `.starchart/` (`config.yaml`, `entities/`, `artifacts/`), detects code scopes from `package.json`, `Package.swift`/`Package.resolved`/`*.xcodeproj`, `build.gradle(.kts)` and `go.mod` up to three levels deep, enables the `fs` adapter and the `core`, `privacy`, `appstore`, `seo` packs.

| Option | Default | Effect |
|---|---|---|
| `--discover` | off | also build the chart and write proposed facts, artifacts and bridges to `.starchart/proposals/discovered.yaml`. Works on an existing chart without `--force` (config is left alone) |
| `--force` | off | overwrite an existing `config.yaml` |

Without `--discover`, an existing `config.yaml` is an error (exit 2): `starchart: .starchart/config.yaml already exists (use --force to overwrite)`.

```text
$ starchart init --discover
✓ wrote .starchart/config.yaml
  scope ios → apps/ios
  scope web → apps/web
✓ charted 88 nodes / 145 edges from code
✓ proposed 2 facts, 4 artifacts, 4 bridges → .starchart/proposals/discovered.yaml
  review it, rename ids, delete what's wrong, move it into .starchart/, then run: starchart lock
```

The loader ignores `.starchart/proposals/**`, so the proposal is inert: nothing changes in `check` or `plan` until you move the file into `.starchart/` (for example `.starchart/entities/offer.yaml`). See [Bridges and Discovery](Bridges-and-Discovery).

### `lock`

```text
starchart lock [ids...]
```

Pins every artifact (or only the listed ones) to the current fact values and code hashes and writes `starchart.lock`. Artifacts that no longer exist are dropped. Commit the file.

With ids it is a partial relock: the listed artifacts are pinned to the current values, and every fact or code pin that a still-stale artifact depends on keeps its previous value, so the others stay stale until handled. Without ids it re-pins everything. The lock also records `code.maxCodeDepth` from the config and uses it for dependencies and staleness.

| Argument | Meaning |
|---|---|
| `[ids...]` | only relock these artifact ids |

```text
$ starchart lock
✓ starchart.lock: 12 artifacts, 12 facts, 29 code pins
```

### `adapters`

```text
starchart adapters
```

Lists the registered adapters (built-ins plus any loaded from `plugins:` in the config), whether each may write under your config, and its capabilities. `fs` writes unless `adapters.fs.write: false`; `stripe` and `appstore` only with `write: true`. "writes" is per adapter; App Store screenshots and IAPs stay manual even with `write: true`, because only bindings with a `field` are writable.

```text
$ starchart adapters
fs         writes  read, write, dryRun, rollback
url        read-only  read
stripe     read-only  read, write, dryRun, rollback, list
appstore   read-only  read, write, dryRun, rollback
```

---

## Analyze

### `impact`

```text
starchart impact [refs...] [--diff <base>] [--all-code] [-v] [-f text|markdown|json]
```

Blast radius of nodes, files or a git diff across every layer, classified (`break`, `manual`, `auto`, `review`, `code`, `retire`, `tests`, `info`) with a rollout order.

| Argument / option | Default | Effect |
|---|---|---|
| `[refs...]` | | node ids, file paths (a file expands to its file node and every symbol it contains), or a unique id suffix / label. Required unless `--diff` |
| `--diff <base>` | | seeds from `git diff <base>` plus untracked files, plus facts changed since the lock ([Git Diff Impact](Git-Diff-Impact)). Refs are ignored |
| `--all-code` | off | report every impacted code node, not just the surface (screens, routes, tests, anchored symbols) |
| `-v, --verbose` | off | include `info` items and print the why-path and confidence under each row |
| `-f, --format` | `text` | `text`, `markdown`, `json` |

Errors (exit 2): `give node refs or --diff <base>`; `no node matches "x". Try "starchart query --text x".`

```text
$ starchart impact addon:pro.price.usd
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

Order: stripe:price/pro-monthly → appstore:iap/pro-monthly → appstore:listing/description → … → reel:spring-2026

Plan: 5 manual · 6 auto · 1 review · 2 code · 1 retire · 1 tests
(5 informational items hidden; use --verbose)
```

### `plan`

```text
starchart plan [-v] [-f text|markdown|json]
```

Everything that changed since `starchart.lock` (fact values edited in YAML, code hashes that moved, pinned code nodes that disappeared), with the full impact and rollout order. New facts that were never locked are not changes.

| Option | Default | Effect |
|---|---|---|
| `-v, --verbose` | off | include `info` items, why-paths and confidence |
| `-f, --format` | `text` | `text`, `markdown`, `json` |

It is seeded from the facts and code changed since the lock plus the changed dependencies of artifacts that are still stale, and it drops locked artifacts that are already in sync. So after a partial `apply` or `ack`, `plan` keeps listing the remaining manual, review, code and retire items until you ack or fix them. With nothing changed and nothing stale, text output is `✓ no changes since starchart.lock`. After changing the USD price to 5.99:

```text
$ starchart plan
Change: addon:pro.price  {"usd":4.99,"eur":4.99} → {"usd":5.99,"eur":4.99}
Change: addon:pro.price.usd  4.99 → 5.99

  ! manual  appstore:iap/pro-monthly                            mirrors    update in appstore (adapter is read-only)
  …
```

After `starchart apply --yes` the auto items are gone and the rest remain. Regenerated constants show up as changes from `∅`:

```text
$ starchart plan
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

### `why`

```text
starchart why <from> <to>
```

The shortest path explaining why `<to>` depends on `<from>`, with the class, confidence and reason. Both sides accept any ref; a file path tries the file and all its symbols and keeps the shortest explanation. The walk includes every code node and ignores the confidence floor. Exits 1 when there is no dependency.

```text
$ starchart why apps/ios/Sources/Core/Entitlements.swift appstore:screenshots/6.9/03
symbol:ios/Entitlements.proFeatures --references--> symbol:ios/PaywallView.body --references--> symbol:ios/PaywallView --references--> screen:ios/Paywall --captures--> appstore:screenshots/6.9/03
class manual · confidence 0.69 · screen changed; re-capture

$ starchart why app:nebula.name web:pricing-page
web:pricing-page does not depend on app:nebula.name
```

### `query`

```text
starchart query [--kind <kind>] [--layer <layer>] [--prefix <prefix>] [--text <text>] [--edge <type> [--to <id>]] [-n <n>] [-f text|markdown|json]
```

Filters nodes. All filters combine with AND.

| Option | Default | Effect |
|---|---|---|
| `--kind <kind>` | | exact node kind: `entity`, `fact`, `artifact`, `file`, `symbol`, `screen`, `route`, `package`, `env`, `flag`, `event`, `i18n`, `test`, … (not validated) |
| `--layer <layer>` | | `code`, `fact` or `world` |
| `--prefix <prefix>` | | id starts with |
| `--text <text>` | | case-insensitive match on id, label or JSON value |
| `--edge <type>` | | has an outgoing edge of this type |
| `--to <id>` | | …whose target equals or starts with this (only with `--edge`) |
| `-n, --limit <n>` | `50` | max results |
| `-f, --format` | `text` | `json` prints full node objects |

```text
$ starchart query --edge anchors --to addon:pro --limit 3
symbol   symbol:ios/Entitlements.proFeatures = ["Themes","iCloud sync"]
symbol   symbol:ios/Pricing.proUSD = 4.99
symbol   symbol:ios/ProductID.proMonthly = "nebula_pro_monthly"
```

### `node`

```text
starchart node <ref>
```

One node as JSON, followed by its outgoing (`--type-->`, with confidence when below 1) and incoming (`<--type--`) edges. The ref must resolve to exactly one node, so a file path that contains symbols is ambiguous (exit 2); use the `file:` id.

```text
$ starchart node env:STRIPE_SECRET_KEY
{
  "id": "env:STRIPE_SECRET_KEY",
  "kind": "env",
  "label": "STRIPE_SECRET_KEY",
  "layer": "code"
}
  <--readsEnv-- symbol:web/lib/stripe#stripe
```

### `scan`

```text
starchart scan [--all] [-f text|markdown|json]
```

Finds fact values (strings, long integers, decimals) written as text in code and content, and says whether the chart already covers each one. Roots: `content:` from the config, else the code scope directories. Exits 1 when anything unbound is printed.

| Option | Default | Effect |
|---|---|---|
| `--all` | off | also list bound occurrences (exit 0) |
| `-f, --format` | `text` | `json` prints `LiteralOccurrence[]` |

```text
$ starchart scan
unbound apps/ios/Resources/Localizable.xcstrings:6  Nebula Pro (addon:pro.name)  "en" : { "stringUnit" : { "state" : "translated", "value" : "Unlock Nebula Pro" } },
…
unbound apps/web/lib/pricing.ts:3  4.99 (addon:pro.price.usd)  export const PRO_PRICE_USD = 4.99;
unbound apps/web/messages/en.json:4  4.99 (addon:pro.price.eur)  "cta": "Get Nebula Pro for $4.99/month"
```

Details in [Bridges and Discovery](Bridges-and-Discovery).

### `history`

```text
starchart history <fact> [-n <n>]
```

A fact's value across commits that touched `starchart.lock`, newest first, consecutive equal values collapsed. See [Time Machine](Time-Machine).

| Option | Default | Effect |
|---|---|---|
| `-n, --limit <n>` | `200` | lock commits to scan |

An unknown fact, or a repo where `starchart.lock` was never committed, prints `no history for <fact> (unknown fact, or starchart.lock not committed yet)` and exits 0.

```text
$ starchart history addon:pro.price.usd
b56c056e 2026-09-20 5.99  Zero: Raise Pro to 5.99
cb75b9e2 2026-09-01 4.99  Zero: Launch Pro at 4.99
```

---

## Sync

### `apply`

```text
starchart apply [--dry-run] [-y] [--only <ids...>]
```

Runs the plan's `auto` steps through adapters in rollout order, writes an undo journal, and relocks what it applied. Generated constants (`// @starchart generated` symbols) are handled by regenerating the config's `codegen:` targets once, reported as `✓ <symbol> [codegen] regenerated …` (`would regenerate …` on a dry run); you don't need to run `starchart codegen` first. Codegen output is not journaled: `revert` does not undo it, git does. Generated constants with no `codegen:` targets configured fail with `generated constants found but no codegen targets are configured`. Everything else (manual, review, code, retire) is listed under "Still needs a human", followed by `mark artifacts done with: starchart ack <id…>` when artifacts are pending and `code items: edit the constant, or generate it with starchart codegen` when code items are pending. Without `--yes` it prints the plan and asks `Apply N auto step(s)? [y/N]`; a non-TTY stdin counts as "no" (prints `aborted`, exit 1). Stops at the first failed step (exit 1).

| Option | Default | Effect |
|---|---|---|
| `--dry-run` | off | show what each adapter would change; write nothing |
| `-y, --yes` | off | skip the prompt |
| `--only <ids...>` | all | only these artifact ids |

```text
$ starchart apply --yes --only web:pricing-page web:messages-en
✓ web:messages-en [fs] addon:pro.price.usd: 4.99 → 5.99
✓ web:pricing-page [fs] addon:pro.price.usd: 4.99 → 5.99
journal: .starchart/journal/2026-09-29T23-19-54-266Z-5bce00.json (undo with: starchart revert .starchart/journal/2026-09-29T23-19-54-266Z-5bce00.json)
```

A full `apply --yes` on the same change also regenerates the constants:

```text
$ starchart apply --yes
…
✓ symbol:ios/StarchartFacts.AddonPro.Price.usd [codegen] regenerated apps/web/lib/starchart-facts.ts; regenerated apps/ios/Sources/Core/StarchartFacts.swift
✓ symbol:web/lib/starchart-facts#ADDON_PRO_PRICE_USD [codegen] regenerated apps/web/lib/starchart-facts.ts; regenerated apps/ios/Sources/Core/StarchartFacts.swift
…
✓ web:pricing-page [fs] addon:pro.price.usd: 4.99 → 5.99
…
Still needs a human:
  ! stripe:price/pro-monthly update in stripe (adapter is read-only)
  …
  ✗ reel:spring-2026 expired 2026-06-30
  mark artifacts done with: starchart ack <id…>
  code items: edit the constant, or generate it with starchart codegen
journal: .starchart/journal/2026-09-29T23-15-08-609Z-d46588.json (undo with: …)
```

See [Apply, Revert and Journals](Apply-Revert-and-Journals).

### `revert`

```text
starchart revert <journal> [--dry-run]
```

Applies a journal's undo records in reverse order and prints the `RevertReport` as JSON. Every record is attempted; the lock is restored and the journal marked reverted only when all succeed. Exits 1 when any step fails (`"ok": false`), 0 otherwise. An unknown journal is a runtime error (`journal "nope" not found in .starchart/journal`, exit 2).

| Argument / option | Effect |
|---|---|
| `<journal>` | journal id (from `starchart journals`) or path |
| `--dry-run` | show what would be restored |

```text
$ starchart revert 2026-09-29T23-19-54-266Z-5bce00 --dry-run
{
  "journal": "…/.starchart/journal/2026-09-29T23-19-54-266Z-5bce00.json",
  "dryRun": true,
  "results": [
    { "artifact": "web:pricing-page", "ok": true, "changes": ["would restore apps/web/app/pricing/page.tsx"] },
    { "artifact": "web:messages-en", "ok": true, "changes": ["would restore apps/web/messages/en.json"] }
  ],
  "ok": true,
  "bindingEdits": [],
  "lockRestored": false
}
```

### `journals`

```text
starchart journals
```

Lists apply journals under `.starchart/journal/`, newest first: id, creation time, artifact count, and when it was reverted.

```text
$ starchart journals
2026-09-29T23-19-54-266Z-5bce00  2026-09-29T23:19:54.266Z  2 artifact(s)
```

### `ack`

```text
starchart ack <ids...>
```

Marks manual or review items as done by relocking just those artifacts (a partial relock, like `lock <ids>`: other stale artifacts stay stale). Only artifact ids are accepted (`not an artifact: …` otherwise, exit 2).

```text
$ starchart ack web:live-pricing
✓ acked web:live-pricing
```

---

## Check

### `check`

```text
starchart check [-f text|markdown|json]
```

The CI gate. Exits 1 when any artifact's pinned dependencies no longer match the chart (`✗ stale`, with the changed dependency ids) or an artifact was never locked (`? unlocked`).

| Option | Default | Effect |
|---|---|---|
| `-f, --format` | `text` | `json` prints `StaleArtifact[]` (`{ id, changed, unlocked }`) |

```text
$ starchart check
  ✗ stale     appstore:iap/pro-monthly
                changed: addon:pro.price
                changed: addon:pro.price.usd
  …
  ✗ stale     web:pricing-page
                changed: addon:pro.price.usd

Check: 11 stale
```

In sync: `✓ every artifact is in sync`.

### `audit`

```text
starchart audit [--ids <ids...>] [-f text|markdown|json]
```

Reads live systems through adapters (files, URLs, Stripe, App Store Connect) and compares them with the chart. Prints one line per diff (`✗ break`, `! stale`, `? <kind>`), adapter errors, skipped artifacts, and a summary. Exits 1 on any diff or error. External adapters without credentials are skipped, not failed. A URL that can't be fetched (network failure, or any HTTP error other than 404/410) is an adapter error; 404/410 is a `break` diff.

| Option | Default | Effect |
|---|---|---|
| `--ids <ids...>` | all | only these artifacts or code symbols |
| `-f, --format` | `text` | `markdown` prints a summary line plus tables of diffs and errors; `json` prints the `AuditReport` |

```text
$ starchart audit --ids web:pricing-page web:messages-en
2 checked · 0 diff(s) · 0 error(s) · 0 skipped

$ starchart audit
? missing web:og-pro apps/web/public/og/pro.png  rendered output not found: apps/web/public/og/pro.png
error web:live-pricing [url] https://nebula.example.com/pricing: request failed: fetch failed
skip  appstore:listing/description: App Store Connect credentials missing: ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY_PATH or ASC_PRIVATE_KEY
skip  privacy:appstore-label: no binding
skip  reel:spring-2026: no adapter "youtube" is registered
skip  stripe:price/pro-monthly: Stripe secret key not found: set the STRIPE_SECRET_KEY environment variable
skip  symbol:web/lib/stripe#PRICE_PRO_MONTHLY: break detection skipped: Stripe secret key not found: set the STRIPE_SECRET_KEY environment variable
7 checked · 1 diff(s) · 1 error(s) · 5 skipped

$ starchart audit -f markdown
**STARCHART audit:** 7 checked · 1 diff(s) · 1 error(s) · 5 skipped

| Kind | Artifact | Where | Finding |
|---|---|---|---|
| missing | `web:og-pro` | apps/web/public/og/pro.png | rendered output not found: apps/web/public/og/pro.png |

| Artifact | Adapter | Error |
|---|---|---|
| `web:live-pricing` | url | https://nebula.example.com/pricing: request failed: fetch failed |
```

That run had no credentials and no network route to the demo's placeholder site. App Store bindings without a `field` (the IAP and screenshots) still land under "checked" even though nothing live was compared; that's a known gap.

See [Audit and Break Detection](Audit-and-Break-Detection).

---

## Rules & analysis

### `rules`

```text
starchart rules [-f text|markdown|json]
```

Evaluates the rule packs in `config.packs` (built-ins, plus packs from `plugins:` modules once their id is listed) plus every `rules:` block in `.starchart/`. Exits 1 on any `error`. An invalid rule or unknown pack is a runtime error (exit 2).

```text
$ starchart rules
error privacy-disclosed  pkg:swift/purchases-ios collects DeviceID but PrivacyInfo.xcprivacy (apps/ios/Resources/PrivacyInfo.xcprivacy) does not declare NSPrivacyCollectedDataTypeDeviceID  (apps/ios/Resources/PrivacyInfo.xcprivacy)
…
error promo-not-expired  reel:spring-2026 expired on 2026-06-30  (.starchart/artifacts/marketing.yaml)
warn  artifact-bound  privacy:appstore-label has no binding  (.starchart/artifacts/marketing.yaml)
info  fact-used  app:nebula.appStoreId is not used by any code or artifact  (.starchart/entities/app.yaml)
…
9 error · 2 warn · 4 info
```

See [Rules Engine](Rules-Engine) and [Rule Packs](Rule-Packs).

### `privacy`

```text
starchart privacy
```

Data-collecting SDKs detected in your packages (per platform, with tracking flags and optional data types), then the `privacy` pack's violations. Exits 1 on a privacy `error`. When `privacy` isn't in `packs:`, it lists the SDKs and then prints `! the privacy rule pack is not enabled; add "privacy" to packs in .starchart/config.yaml to check disclosures` (exit 0).

```text
$ starchart privacy
sentry pkg:npm/@sentry/nextjs [web]
  collects: CrashData, OtherDiagnosticData, PerformanceData  (optional: DeviceID)
posthog pkg:npm/posthog-js [web]
  collects: DeviceID, ProductInteraction  (optional: UserID)
revenuecat pkg:swift/purchases-ios [ios]
  collects: DeviceID, PurchaseHistory, UserID
sentry pkg:swift/sentry-cocoa [ios]
  collects: CrashData, OtherDiagnosticData, PerformanceData  (optional: DeviceID)

error privacy-disclosed  pkg:swift/purchases-ios collects DeviceID but PrivacyInfo.xcprivacy …
…
8 error · 1 warn · 0 info
```

See [Privacy Drift](Privacy-Drift).

### `orphans`

```text
starchart orphans [--external] [-f text|markdown|json]
```

Dead stars: expired artifacts not yet retired, artifacts that embed/render/mirror/describe nothing, unused leaf facts, dependencies no file imports, unread env vars, unread flags, unconsumed events.

| Option | Default | Effect |
|---|---|---|
| `--external` | off | also call `list()` on every bound adapter that supports it (Stripe) and report live resources nothing references |
| `-f, --format` | `text` | `json` prints `Orphan[]` |

```text
$ starchart orphans
expired                reel:spring-2026  reel:spring-2026 expired on 2026-06-30 but is not retired
artifact-unlinked      privacy:appstore-label  privacy:appstore-label does not embed, render, mirror or describe anything
fact-unused            app:nebula.appStoreId  app:nebula.appStoreId is not used by any code or artifact
…
package-unused         pkg:npm/@sentry/nextjs  pkg:npm/@sentry/nextjs is a dependency but no file uses it
```

See [Orphans](Orphans).

### `score`

```text
starchart score [--badge <file>] [--badge-json <file>] [--audit] [-f text|markdown|json]
```

Reality Score: the share of non-retired artifacts that are bound, in sync with the lock, not expired and (with `--audit`) passing audit.

| Option | Default | Effect |
|---|---|---|
| `--badge <file>` | | write a README badge SVG |
| `--badge-json <file>` | | write a shields.io endpoint JSON |
| `--audit` | off | include live audit results (slower, needs credentials) |
| `-f, --format` | `text` | `json` prints the `ScoreReport` |

```text
$ starchart score --badge badge.svg --badge-json badge.json
reality 83%  10/12 artifacts in sync
  unbound      privacy:appstore-label
  expired      reel:spring-2026
$ cat badge.json
{"schemaVersion":1,"label":"reality","message":"83%","color":"#ffd000"}
```

See [Reality Score](Reality-Score).

### `cost`

```text
starchart cost [facts...] [-n <n>] [-f text|markdown|json]
```

Change-cost heatmap: estimated hours to ship a change to each fact (from the impact classes) and how to cut it. The codegen suggestion only counts code items reached directly from a fact (a constant holding a Stripe price id can't be generated), and "enable write access" only names adapters that could actually write that artifact (not `url`, not App Store screenshots or IAPs).

| Argument / option | Default | Effect |
|---|---|---|
| `[facts...]` | every leaf fact and entity | fact or entity ids |
| `-n, --top <n>` | `15` | show the top N |
| `-f, --format` | `text` | `json` prints `CostReport[]` |

```text
$ starchart cost -n 1
████████████████████   9.4h  addon:pro.price.usd (21 impacted)
      → 1 hardcoded code anchor: generate constants with `starchart codegen` to make these auto
      → 1 image embeds this value: bind it to a template (renders) to regenerate automatically
      → 2 manual updates in appstore, stripe: enable write access for these adapters to sync automatically
      → Doing this cuts the change cost from 9.4 h to 4.85 h
```

See [Change Cost](Change-Cost).

---

## Outputs

### `codegen`

```text
starchart codegen
```

Writes every `codegen:` target from the config (TS / Swift / Kotlin fact constants). Files that would not change are left alone. No targets is an error (exit 2).

```text
$ starchart codegen
unchanged apps/web/lib/starchart-facts.ts
unchanged apps/ios/Sources/Core/StarchartFacts.swift
```

See [Codegen](Codegen).

### `emit`

```text
starchart emit <jsonld|graph|xray>
```

Exports the chart to stdout. `emit` alone prints its help and exits 1.

#### `emit jsonld`

```text
starchart emit jsonld [--entity <id>] [--script] [--code]
```

| Option | Default | Effect |
|---|---|---|
| `--entity <id>` | | publishable schema.org markup for one entity instead of the full chart |
| `--script` | off | wrap in `<script type="application/ld+json">`, HTML-escaped |
| `--code` | off | include the code-layer nodes in the full export. Code is always ingested either way, so code-authority facts (like `addon:pro.features`) get their values |

```text
$ starchart emit jsonld --entity app:nebula
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Nebula",
  "applicationCategory": "ProductivityApplication",
  "operatingSystem": "iOS 18+",
  "offers": [ … ]
}
```

See [JSON-LD and SEO](JSON-LD-and-SEO).

#### `emit graph`

```text
starchart emit graph
```

The raw graph (`{ nodes, edges }`, sorted) as JSON, all three layers.

```text
$ starchart emit graph
{
  "nodes": [
    {
      "id": "addon:pro",
      "kind": "entity",
      "label": "Nebula Pro",
      …
```

#### `emit xray`

```text
starchart emit xray
```

The payload the [Reality X-Ray](Reality-X-Ray) extension consumes: facts with current and locked values, artifacts with URL patterns and staleness, and every stale value.

```text
$ starchart emit xray
{
  "name": "pro-universe",
  "generatedAt": "2026-09-29T22:53:56.124Z",
  "facts": [
    {
      "id": "addon:pro.billing",
      "value": "monthly",
      "artifacts": []
    },
    …
```

### `preview`

```text
starchart preview [-o <dir>]
```

Future Universe: renders the plan's before/after (text diffs, re-rendered images, external and manual tasks) as an HTML report.

| Option | Default | Effect |
|---|---|---|
| `-o, --out <dir>` | `.starchart/preview` | output directory, relative to the project root |

```text
$ starchart preview
✓ 15 preview entries → .starchart/preview/index.html
```

See [Future Universe Preview](Future-Universe-Preview).

---

## Viewer

### `graph`

```text
starchart graph [-o <file>]
```

Writes the self-contained interactive star chart (one HTML file, no server needed).

| Option | Default | Effect |
|---|---|---|
| `-o, --out <file>` | `starchart.html` | output file, relative to the current (or `-C`) directory |

```text
$ starchart graph -o out/chart.html
✓ out/chart.html
```

### `serve`

```text
starchart serve [-p <port>] [--host <host>] [-w]
```

Serves the viewer and the X-Ray API locally until Ctrl+C.

| Option | Default | Effect |
|---|---|---|
| `-p, --port <port>` | `4477` | port (`0` picks a free one) |
| `--host <host>` | `127.0.0.1` | interface to bind |
| `-w, --watch` | off | rebuild on changes to `.starchart/`, the lock and code scopes, and live-reload open viewers |

```text
$ starchart serve --port 4499
★ STARCHART at http://127.0.0.1:4499  (ctrl+c to stop)
```

See [Viewer and Serve](Viewer-and-Serve).

---

## Integrations

### `hook`

```text
starchart hook <agent>
```

Agent hooks. The only supported agent is `claude`: reads a Claude Code `PostToolUse` event from stdin and, when the edited file has impact beyond code, prints `hookSpecificOutput.additionalContext` for the agent. Any other agent is an error (`unknown hook target "codex" (supported: claude)`, exit 2).

```text
$ echo '{"hook_event_name":"PostToolUse","tool_name":"Edit","tool_input":{"file_path":"'$PWD'/apps/ios/Sources/Core/Pricing.swift"},"cwd":"'$PWD'"}' | starchart hook claude
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"STARCHART: editing apps/ios/Sources/Core/Pricing.swift impacts 15 items beyond code (5 manual, 6 auto, 1 review, 1 code, 1 retire, 1 info):\n! manual appstore:listing/description — …"}}
```

See [Claude Code Hook](Claude-Code-Hook).

### `mcp`

```text
starchart mcp
```

Starts the MCP server on stdio. Project root: `-C` if given, else `$STARCHART_ROOT`, else the cwd. Tools: `starchart_impact`, `starchart_plan`, `starchart_diff_impact`, `starchart_check`, `starchart_why`, `starchart_query`, `starchart_node`, `starchart_audit`, `starchart_rules`, `starchart_orphans`, `starchart_score`, `starchart_apply`.

```bash
claude mcp add starchart -- npx @spz/starchart mcp
# from source, until the package is published:
claude mcp add starchart -- node /path/to/starchart/packages/starchart/dist/cli/bin.js mcp
```

See [MCP Server](MCP-Server).

## The banner

Bare `starchart` (no command), `starchart --help`, `init` and `serve` open with the SPZ banner: the STARCHART logo in hot pink, a gold-and-dim starfield, and the tagline in phosphor green. Subcommand help, `--version` and every machine-readable output (`-f json`, `emit`, `hook`, `mcp`) never print it.

- Colors only on a TTY; piped output, `--no-color` and `NO_COLOR` get the same art as plain text.
- Terminals narrower than 76 columns get the one-line mark instead: `★ STARCHART — every dependency. code to cosmos. ☠ a Space Pirate Zero joint`.

### `about`

```text
starchart about
```

The Jolly Roger, the version and the links. Exit code 0.

```text
        ·              ✦                ·
    ★               _________               ·
                .-'           '-.
     ·         /                 \         ✦
              |   .---.   .---.   |
              |   ( ✦ )   ( ✦ )   |
      ✦        \  '---'   '---'  /        ·
                '.     /_\     .'
                  |'|'|'|'|'|'|
                  '-._______.-'
                        ·
      \\\\\\                         //////
           >=======   S P Z   =======<
      //////                         \\\\\\
            ·           ★           ·

  STARCHART 0.1.0 · every dependency. code to cosmos.
  a Space Pirate Zero joint · Apache-2.0
  repo  https://github.com/space-pirate-zero/starchart
  wiki  https://github.com/space-pirate-zero/starchart/wiki
```

## See also

- [Getting Started](Getting-Started)
- [Configuration](Configuration)
- [Impact Analysis](Impact-Analysis)
- [Library API](Library-API)
- [GitHub Action](GitHub-Action)
