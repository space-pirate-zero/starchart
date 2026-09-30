This page takes you from zero to a working chart: install (or run from source), scaffold `.starchart/` with `init --discover`, review what it found, write your first entity and artifact by hand, lock, and settle into the daily loop of plan, apply, ack and check. It ends with pointers for wiring STARCHART into CI and coding agents.

## Requirements

| Need | Why |
|---|---|
| Node.js **20 or newer** | `engines.node` is `>=20` in `packages/starchart/package.json`. |
| git | `impact --diff` and `history` shell out to `git`. Everything else works without it. |
| pnpm 10 | Only when running from source (`packageManager: pnpm@10.33.0`). |

No server, no database, no account. Everything lives in your repo.

## Install

> **Heads up:** `@space-pirate-zero/starchart` is not published to npm yet. Until it is, `npm i` and `npx @space-pirate-zero/starchart` fail. [Run from source](#run-from-source) instead.

Once the package is on npm:

```bash
npm i -D @space-pirate-zero/starchart
npx @space-pirate-zero/starchart --help
```

The package installs two CLI names, `starchart` and the short alias `sc`, plus `starchart-mcp` for agents. Always spell the npx form `npx @space-pirate-zero/starchart …`. Bare `npx starchart` fetches the unscoped `starchart` package, which belongs to someone else.

### Run from source

```bash
git clone https://github.com/space-pirate-zero/starchart.git
cd starchart
pnpm install
pnpm build
node packages/starchart/dist/cli/bin.js --help
```

Point it at any project with `-C` (short for `--cwd`):

```bash
node /path/to/starchart/packages/starchart/dist/cli/bin.js -C ~/code/my-app check
```

A shell alias saves typing:

```bash
alias starchart="node /path/to/starchart/packages/starchart/dist/cli/bin.js"
```

Every example in this wiki writes `starchart …`; with the alias above they work as shown.

## `starchart init`

`init` creates `.starchart/config.yaml`, `.starchart/entities/` and `.starchart/artifacts/`. It walks up to three directory levels looking for app roots (`package.json`, `Package.swift`/`Package.resolved`/`*.xcodeproj`, `build.gradle(.kts)`, `go.mod`) and turns each leaf into a code scope. Scope names become the prefix of every code node id (`symbol:ios/…`, `route:web/…`).

Plain `init` stops there and tells you what to do next. It refuses to overwrite an existing `config.yaml` unless you pass `--force`. `init --discover` on a project that already has a config keeps it and just re-runs discovery, rewriting `.starchart/proposals/discovered.yaml`.

### `init --discover`

`--discover` also ingests your code, proposes facts from constants that look like product facts (non-integer numbers named like prices, product-id-shaped strings named like products, string arrays named like feature lists, Stripe `price_…` ids), then scans the whole repo for those values and proposes artifacts for the content files that contain them.

Here it is on a copy of the demo with `.starchart/`, `starchart.lock` and the generated facts files removed, exactly like the `init` case in `test/e2e.test.ts`:

```bash
D=$(mktemp -d)/pro-universe && cp -R examples/pro-universe "$D" && cd "$D"
rm -rf .starchart starchart.lock apps/web/lib/starchart-facts.ts apps/ios/Sources/Core/StarchartFacts.swift
starchart init --discover
```

```text
✓ wrote .starchart/config.yaml
  scope ios → apps/ios
  scope web → apps/web
✓ charted 53 nodes / 61 edges from code
✓ proposed 2 facts, 4 artifacts, 4 bridges → .starchart/proposals/discovered.yaml
  review it, rename ids, delete what's wrong, move it into .starchart/, then run: starchart lock
```

The generated config:

```yaml
# STARCHART config — https://github.com/space-pirate-zero/starchart
# Adapters that write to external systems (stripe, appstore) are read-only until you set write: true.
name: pro-universe
code:
  scopes:
    ios: apps/ios
    web: apps/web
adapters:
  fs: {}
packs:
  - core
  - privacy
  - appstore
  - seo
```

`name` is the lowercased directory name. See [Configuration](Configuration) for every field.

## Review `discovered.yaml`

Discovery is heuristic by design. No LLM, no network. Everything it proposes lands in one file, `.starchart/proposals/discovered.yaml`, with a provenance header. The 4 bridges are three code anchors to facts plus the anchor from the Stripe price-id constant to the proposed Stripe artifact:

```yaml
# Proposed by `starchart init --discover`. Everything here is a guess: review, rename, delete.
# This file is ignored until you move it into .starchart/ (e.g. .starchart/entities/offer.yaml).
# Where each proposal came from:
#   offer:main.features ← apps/ios/Sources/Core/Entitlements.swift:5
#   offer:main.price.usd ← apps/ios/Sources/Core/Pricing.swift:5
#   stripe:price/price-pro-monthly ← apps/web/lib/stripe.ts:4

entities:
  - id: offer:main
    type:
      - schema:Offer
    label: Discovered offer — rename me
    facts:
      features:
        authority: code
        source:
          symbol: ios/Entitlements.proFeatures
      price:
        usd: 4.99
artifacts:
  - id: stripe:price/price-pro-monthly
    label: Stripe price referenced at apps/web/lib/stripe.ts:4
    binding:
      adapter: stripe
      price: price_1NebulaPro499
  - id: content:apps/web/app/pricing/page
    binding:
      adapter: fs
      path: apps/web/app/pricing/page.tsx
    embeds:
      - offer:main.price.usd
  # … content:apps/web/messages/en, content:marketing/emails/onboarding-day-3
edges:
  - from: symbol:ios/Pricing.proUSD
    to: offer:main.price.usd
    type: anchors
  # … symbol:web/lib/pricing#PRO_FEATURES, #PRO_PRICE_USD, symbol:web/lib/stripe#PRICE_PRO_MONTHLY
```

Things to know before you lock:

- **It is inert until you move it.** STARCHART loads every `*.yaml` under `.starchart/` except `config.yaml`, `preview/`, `journal/` and `proposals/`. So `check` and `plan` ignore the proposal until you move the file (or pieces of it) into `.starchart/`, e.g. `.starchart/entities/offer.yaml`. Re-running `init --discover` overwrites the proposal, not your chart.
- **Rename ids.** `offer:main` becomes something meaningful like `addon:pro`. Update the `edges` and `embeds` that point at it. Ids are forever-ish: see [Node IDs](Node-IDs).
- **Delete what's wrong.** A number named `yearlyDiscount` might not be a price.
- **Move it.** When you're happy, move it into `.starchart/`, or split it into `entities/*.yaml` and `artifacts/*.yaml`. File layout is free-form. Then `starchart lock`.

Details of the heuristics: [Bridges and Discovery](Bridges-and-Discovery).

## Your first entity and artifact by hand

A minimal chart for a Next.js site whose pricing page says "$9.00". `init` detected one scope, `site`:

```yaml
# .starchart/entities/pro.yaml
id: plan:pro
type: [schema:Offer]
label: Pro plan
facts:
  name: Pro
  price: { usd: 9.00 }
```

```yaml
# .starchart/artifacts/web.yaml
artifacts:
  - id: web:pricing
    type: schema:WebPage
    binding: { adapter: fs, path: site/app/pricing/page.tsx }
    publishedBy: route:site/pricing
    embeds: [plan:pro.price.usd]
```

`plan:pro` owns facts; nested keys flatten into `plan:pro.price` and `plan:pro.price.usd`. The artifact `embeds` the price (it literally contains the value), is bound to a file through the `fs` adapter, and is published by the extracted Next.js route. More: [Facts and Entities](Facts-and-Entities), [Artifacts and Bindings](Artifacts-and-Bindings), [Authoring YAML](Authoring-YAML).

## `starchart lock`

```text
$ starchart lock
✓ starchart.lock: 1 artifacts, 3 facts, 2 code pins
$ starchart check
✓ every artifact is in sync
```

The lock pins each artifact to the hash of every fact and code node it depends on. Commit it, like `package-lock.json`. `lock <ids…>` relocks only those artifacts. How drift is computed: [Lockfile and Drift](Lockfile-and-Drift).

## The daily loop

Change a fact (`usd: 9.00` → `usd: 12.00`), then:

```text
$ starchart plan
Change: plan:pro.price  {"usd":9} → {"usd":12}
Change: plan:pro.price.usd  9 → 12

  ~ auto  web:pricing  embeds  replace embedded value

Order: web:pricing

Plan: 1 auto
(1 informational item hidden; use --verbose)
```

```text
$ starchart apply --yes
✓ web:pricing [fs] plan:pro.price.usd: 9 → 12
journal: .starchart/journal/2026-09-29T22-55-03-327Z-ce032e.json (undo with: starchart revert .starchart/journal/2026-09-29T22-55-03-327Z-ce032e.json)
$ starchart check
✓ every artifact is in sync
```

The page now reads `$12.00 a month`: the `fs` adapter found the old value in its formatted form and replaced it in place.

| Step | Command | What it does |
|---|---|---|
| 1 | `starchart plan` | Everything that changed since `starchart.lock`, classified (`auto`, `manual`, `review`, `retire`, `break`, `code`, `test`) and ordered. `-v` adds the "why" path for each line. |
| 2 | `starchart apply --dry-run` | Shows what each `auto` step would write. Nothing is touched. |
| 3 | `starchart apply` | Runs the `auto` steps through adapters, writes a journal to `.starchart/journal/`, relocks what it applied. Asks for confirmation; `--yes` skips the prompt. |
| 4 | `starchart ack <artifact…>` | After you do a manual or review item yourself, marks it done by relocking it. Only artifact ids are accepted. |
| 5 | `starchart check` | Exit 1 if anything is still stale. This is your CI gate. |

Worth knowing:

- **Non-interactive shells need `--yes`.** Without a TTY the confirmation prompt answers "no", prints `aborted` and exits 1.
- **`apply` regenerates [Codegen](Codegen) output.** Generated constants show up as `auto` in the plan; `apply` rewrites the `codegen:` targets once and relocks against the new code. No separate `starchart codegen` run needed. Codegen output isn't journaled, so `revert` leaves it alone (git undoes it).
- **`plan` keeps the leftovers.** After an apply, `plan` still lists the manual, review, code and retire items until you `ack` or fix them, and `check` stays red for the same artifacts.
- **`code` items are yours.** A hardcoded constant that anchors a fact shows as `⌘ code`. Edit it (or switch it to codegen), then `starchart lock`.
- **Undo** with `starchart revert <journal>`. See [Apply, Revert and Journals](Apply-Revert-and-Journals).

For the full tour on a realistic project, do the [Pro Universe tutorial](Tutorial-Pro-Universe).

## Wire it into CI and agents

- **CI:** run `starchart check` as a required step. Until the package is on npm, build STARCHART from source in the job (clone, `pnpm install`, `pnpm build`) and run `node <starchart>/packages/starchart/dist/cli/bin.js -C <your-project> check`. The [GitHub Action](GitHub-Action) (sticky PR comment with the cross-layer blast radius) needs the published package, so it won't run yet.
- **Claude Code:** the [Claude Code Hook](Claude-Code-Hook) injects the world impact of every file an agent edits back into its context.
- **Any MCP client:** `starchart mcp` exposes impact, plan and friends as tools (`claude mcp add starchart -- npx @space-pirate-zero/starchart mcp` once published). See [MCP Server](MCP-Server).

## See also

- [Tutorial: Pro Universe](Tutorial-Pro-Universe)
- [Configuration](Configuration)
- [CLI Reference](CLI-Reference)
- [FAQ and Troubleshooting](FAQ-and-Troubleshooting)
