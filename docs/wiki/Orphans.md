Orphans are dead stars: things in your chart that nothing depends on anymore. That includes facts no code or artifact uses, artifacts linked to nothing, promos that expired but are still live, dependencies no file imports, and Stripe prices no artifact or code refers to. It's impact analysis run backwards. This page lists every orphan kind with its exact detection rule and the guards that keep the noise down, and shows real `starchart orphans` output. Source: [`analysis/orphans.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/analysis/orphans.ts).

## Usage

```bash
starchart orphans                  # text
starchart orphans -f json          # [{ id, kind, message }]
starchart orphans --external       # also ask adapters what exists in the real world (Stripe only)
```

`-f` takes `text` or `json`, nothing else. `-f markdown` is rejected before anything runs (exit 1):

```text
$ starchart orphans -f markdown
error: option '-f, --format <format>' argument 'markdown' is invalid. Allowed choices are text, json.
```

With nothing to report, the text format prints `✓ no orphans`.

`starchart orphans` always exits 0. It reports, it doesn't gate. To fail CI on something specific, turn it into a rule (see [Rules Engine](Rules-Engine)). The core pack already covers `fact-used` and `promo-not-expired`.

Results are sorted by kind in this order: `expired`, `external-unreferenced`, `artifact-unlinked`, `fact-unused`, `package-unused`, `env-unused`, `flag-unused`, `event-unconsumed`. Within a kind, they're sorted by id.

## Orphan kinds

| Kind | Detected when | Message |
|---|---|---|
| `expired` | An artifact isn't `status: retired` and its `validThrough` has passed (a bare date lasts through the end of that day). | `<id> expired on <date> but is not retired` |
| `external-unreferenced` | With `--external`: an **active** resource an adapter lists isn't referenced by any artifact binding or code literal. | `<adapter> <label> (<externalId>) is active but no artifact or code references it` |
| `artifact-unlinked` | An artifact has **no outgoing edges** at all. | `<id> does not embed, render, mirror or describe anything` |
| `fact-unused` | A leaf fact has no dependents, directly or through its containers or entity. | `<id> is not used by any code or artifact` |
| `package-unused` | A direct dependency of a linked package manager has no incoming `dependsOn` edge. | `<id> is a dependency but no file uses it` |
| `env-unused` | An `env` node has `meta.declaredOnly: true` and no incoming edges. | `<id> is declared but nothing reads it` |
| `flag-unused` | A `flag` node has `meta.rollout` of `100` or `"100%"`. | `<id> is rolled out to 100%; remove the flag and its dead branch` |
| `event-unconsumed` | An `event` node has no edges other than `emits`, and at least one other event does. | `<id> is emitted but no dashboard, funnel or artifact consumes it` |

### fact-unused

This uses the same check as the core pack's `fact-used` rule:

- Only **leaf** facts are considered, meaning facts with no child facts. Containers like `addon:pro.price` are skipped. Their leaves are checked instead.
- A fact is used if any edge other than `partOf` points at the fact, **or at any of its containers or its entity**. A change to a leaf propagates up through `partOf`, so an artifact that `describes: addon:pro` uses every `addon:pro.*` fact.
- The compiler-generated `<entity>.status` fact is always skipped. Nobody is expected to bind to it.
- A `partOf` edge from another entity (`of: app:nebula`) doesn't count as use. That's why the demo's four `app:nebula.*` facts show up.

### artifact-unlinked

Any outgoing edge counts: `embeds`, `renders`, `describes`, `mirrors`, `promotes`, `captures`, `derivedFrom`, even the ordering-only `after` and `blocks`. The demo's `privacy:appstore-label` declares its data types in `meta`, not as edges, so it's reported. That's expected for disclosure artifacts, and you can ignore it.

### package-unused: noise guards

Unused-dependency detection is notoriously noisy, so three guards apply:

1. **Linked package managers only.** A package is only considered if at least one package from the same package manager (the `pkg:<type>/` prefix: `npm`, `swift`, `gradle`, `go`, …) has an incoming `dependsOn` edge, which proves the code layer links files to packages there. If nothing is linked, nothing is reported for that package manager.
2. **Direct dependencies only.** Packages with `meta.transitive: true` (for example `go.mod // indirect`, or `Package.resolved` pins the project never declares) are skipped.
3. **Implicit packages.** npm packages used without an import are skipped: frameworks that own the build or runtime, toolchains and type packages. The exact list (`IMPLICIT_NPM`):

   `next`, `react`, `react-dom`, `typescript`, `@types/*`, `eslint*`, `@eslint/*`, `prettier`, `tailwindcss`, `@tailwindcss/*`, `postcss`, `autoprefixer`, `vite`, `vitest`, `jest`, `@vitejs/*`, `tsx`, `ts-node`, `turbo`, `nodemon`, `husky`, `lint-staged`

The implicit list covers npm only. A package that's wired in through config instead of an import (for example, Sentry's Next.js integration set up in `next.config`) can still be reported. The demo's `@sentry/nextjs` is one.

### event-unconsumed: consumption guard

An event is consumed when it has any incoming or outgoing edge other than `emits`, for example a dashboard artifact that `describes` or `embeds` it. The kind is only reported **once the project models at least one consumer**. If no event has a consumer, nothing is reported. Otherwise every analytics event would be an orphan on day one.

### env-unused and flag-unused

Both depend on metadata that no built-in ingestor sets today. Code ingestion creates `env` nodes only for variables the code reads, and `flag` nodes only for flags the code checks. Neither sets `declaredOnly` or `rollout`. In practice:

- **flag-unused** fires when you add `meta.rollout: 100` to a flag node. Code nodes can't be declared in YAML directly, but a YAML document with the same id (`id: flag:new_paywall`, `meta: { rollout: 100 }`) is merged into the ingested node. This is the same mechanism as privacy overrides (see [Privacy Drift](Privacy-Drift#per-package-overrides)).
- **env-unused** needs an `env` node with `meta.declaredOnly: true` that nothing reads. Since ingestion never creates unread env nodes, this is only reachable through the [Library API](Library-API) today.

### external-unreferenced

With `--external`, STARCHART collects every adapter used by at least one artifact binding. For each adapter that supports `list`, it calls `list()` to enumerate live resources. Only the **Stripe** adapter lists today (active prices), and it needs `STRIPE_SECRET_KEY`. **Not supported yet:** App Store in-app purchases, url targets and fs files are never enumerated, so `--external` finds nothing for them. For each **active** listed resource, it's referenced if:

- any code-layer node's string value equals its external id (for example, a `price_…` literal in `stripe.ts`), or
- an artifact bound to the same adapter has any binding value equal to the external id, or
- an artifact's binding matches all of the listed resource's binding keys.

Unreferenced resources are reported with the id `<adapter>:<externalId>`. If an adapter's `list()` fails (for example, missing credentials), a warning goes to stderr and that adapter is skipped:

```text
warn stripe: Stripe secret key not found: set the STRIPE_SECRET_KEY environment variable
```

The `starchart_orphans` [MCP tool](MCP-Server) never runs external listing.

## Real output

From a temp copy of `examples/pro-universe`:

```text
$ starchart orphans
expired                reel:spring-2026  reel:spring-2026 expired on 2026-06-30 but is not retired
artifact-unlinked      privacy:appstore-label  privacy:appstore-label does not embed, render, mirror or describe anything
fact-unused            app:nebula.appStoreId  app:nebula.appStoreId is not used by any code or artifact
fact-unused            app:nebula.category  app:nebula.category is not used by any code or artifact
fact-unused            app:nebula.name  app:nebula.name is not used by any code or artifact
fact-unused            app:nebula.operatingSystem  app:nebula.operatingSystem is not used by any code or artifact
package-unused         pkg:npm/@sentry/nextjs  pkg:npm/@sentry/nextjs is a dependency but no file uses it
```

`starchart orphans --external` without Stripe credentials prints the warning above, then the same list.

JSON (first two of the seven entries):

```json
[
  {
    "id": "reel:spring-2026",
    "kind": "expired",
    "message": "reel:spring-2026 expired on 2026-06-30 but is not retired"
  },
  {
    "id": "privacy:appstore-label",
    "kind": "artifact-unlinked",
    "message": "privacy:appstore-label does not embed, render, mirror or describe anything"
  }
]
```

## What to do with them

| Kind | Typical fix |
|---|---|
| `expired` | Take it down and set `status: retired` (it then leaves the [Reality Score](Reality-Score) too), or extend `validThrough`. |
| `external-unreferenced` | Archive the Stripe price, or add the artifact that should mirror it. |
| `artifact-unlinked` | Add `embeds` / `describes` / `mirrors` so changes reach it, or delete it. |
| `fact-unused` | Bind it (an artifact embeds it, code anchors it) or delete it. |
| `package-unused` | Remove the dependency, or accept it if it's wired in through config. |
| `flag-unused` | Delete the flag and its dead branch. |
| `event-unconsumed` | Add the dashboard or funnel that should use it, or stop emitting it. |

## See also

- [Impact Analysis](Impact-Analysis)
- [Reality Score](Reality-Score)
- [Rule Packs](Rule-Packs)
- [Adapter Stripe](Adapter-Stripe)
- [Code Ingestion](Code-Ingestion)
