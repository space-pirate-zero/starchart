`starchart.lock` pins every artifact to the exact fact values and code hashes it was last produced against. When a pinned dependency moves, the artifact is **stale**: drift, caught at PR time instead of by a customer. This page documents the lock format, the hashing, how dependencies are computed, how `lock`, `apply` and `ack` rewrite the lock (including partial relocks that keep old values), how `check` and `plan` read it and why they agree, and how to wire it into CI. Source: [`core/lock.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/core/lock.ts) and [`engine/apply.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/engine/apply.ts).

## Format

`starchart.lock` is JSON at the project root (next to `.starchart/`), written with two-space indentation and a trailing newline.

```json
{
  "version": 1,
  "facts": {
    "addon:pro.price": { "hash": "64a7596467e5e883", "value": { "usd": 4.99, "eur": 4.99 } },
    "addon:pro.price.usd": { "hash": "71b62336ac91dd67", "value": 4.99 }
  },
  "code": {
    "i18n:ios/paywall.title": "4c3f514ba283e814",
    "route:web/pricing": "1f061885d61c7365",
    "screen:ios/Paywall": "3298c1c584b4d89b"
  },
  "artifacts": {
    "stripe:price/pro-monthly": {
      "deps": {
        "addon:pro.name": "7458c2007d89f182",
        "addon:pro.price.usd": "71b62336ac91dd67",
        "symbol:ios/Pricing.proUSD": "20bc1f157ce5a99f",
        "symbol:web/lib/stripe#PRICE_PRO_MONTHLY": "c3d580064eebc169"
      }
    }
  },
  "maxCodeDepth": 2
}
```

| Key | Contents |
|---|---|
| `version` | Always `1`. Any other value is a `ConfigError` (`unsupported lock version`). |
| `maxCodeDepth` | Optional. The code-hop limit used to compute `deps` (from config `code.maxCodeDepth`). Absent means the default, 4. Written after the other keys, so it sits at the end of the file. |
| `facts` | **Every** fact in the graph: `{ hash, value }`. The value is kept so plans can show before → after and adapters can find the old text to replace. |
| `code` | Code node id → hash, but only for code nodes that at least one artifact depends on. |
| `artifacts` | Artifact id → `{ deps }`, where `deps` maps each dependency (fact or code node) to the hash it had when the artifact was last synced. |

A missing lock file reads as an empty lock (`version: 1`, all maps empty).

## Hashing

- **Facts**: `hashValue(value)` = first 16 hex characters of SHA-1 over `stableStringify(value)`.
- **Code nodes**: the node's own `hash`, set by the ingestor (content hash of the file, symbol or route source; the version for packages; the translations for i18n keys).
- **Artifacts** have no hash of their own; they're tracked through their `deps`.

`stableStringify` is JSON with object keys sorted and `undefined` properties dropped, so key order in YAML never changes a hash. `4.99` hashes to `71b62336ac91dd67`; `{usd: 4.99, eur: 4.99}` is serialised as `{"eur":4.99,"usd":4.99}` and hashes to `64a7596467e5e883`. An `undefined` value (say, an unresolved code-authority fact) hashes like `null`.

Code nodes without a hash never take part in drift tracking: env vars, flags, events, and packages with no version.

## Dependencies: the reverse walk

`dependencies(graph, artifactId)` answers "which facts and code nodes, if changed, would impact this artifact?" It's impact analysis run backwards:

1. Start at the artifact.
2. Collect upstream nodes: `to` of every **outgoing** edge whose propagation is `reverse` or `both`; `from` of every **incoming** edge whose propagation is `forward` or `both`; and, for files, every symbol they `contains`.
3. Track consecutive code hops. Skip anything past `maxCodeDepth` (default 4). A node is revisited only if it's reached with a smaller code depth.
4. Every upstream node with a current hash (a fact or a hashed code node) is a dependency. Keep walking.

So `web:landing-hero`, which `describes addon:pro`, depends on every fact under `addon:pro` (through incoming forward `partOf`) and on every symbol anchored to those facts. `web:og-pro`, which renders `addon:pro.price.usd`, depends on that leaf and its anchors, but not on the container `addon:pro.price`.

### maxCodeDepth: config vs lock

Set `code.maxCodeDepth` in `.starchart/config.yaml` and impact analysis uses it right away. The lock picks it up the next time it's written (`lock`, `apply`, `ack`), records it as `maxCodeDepth`, and walks dependencies with it. Staleness checks use the value **recorded in the lock**, not the config, so changing the config alone never makes `check` fail; relock once to apply it. If you later remove the config key, relocks keep the recorded value.

On the demo, `maxCodeDepth: 2` followed by `starchart lock` drops two deep code pins:

```text
$ starchart lock
✓ starchart.lock: 12 artifacts, 12 facts, 27 code pins
```

(29 code pins at the default depth.) `i18n:ios/paywall.title` and `symbol:ios/Pricing.display` fall out, and `appstore:screenshots/6.9/03` no longer depends on `addon:pro.features` through the paywall code.

## Building the lock

`buildLock(graph, previous, artifactIds?, { maxCodeDepth? })`:

1. Rewrites `facts` from the **current** graph (every fact, current value). Records `maxCodeDepth` (from the option, else the previous lock's value).
2. Starts `artifacts` from the previous lock, then re-pins each target artifact (default: all) to its current dependencies.
3. Rebuilds `code` from the code deps of every artifact in the lock, re-synced or not, at their current hashes.
4. Drops artifacts that no longer exist in the graph.

`starchart lock` pins everything with `buildLock`. `starchart lock <ids…>` pins only those artifacts with `relockArtifacts` (below); the others keep their old `deps`.

```bash
starchart lock
```

```text
✓ starchart.lock: 12 artifacts, 12 facts, 29 code pins
```

### Partial relocks keep old values

Step 1 is the catch. After pinning only some artifacts, `facts` would hold the *new* value of every fact, including facts that other, still-stale artifacts depend on. `check` would still flag those artifacts (their `deps` hashes are old), but `plan` would lose the fact change, and writable adapters would lose the old text they search for.

`relockArtifacts(graph, previous, ids, { maxCodeDepth })` fixes that. It runs `buildLock` for `ids`, then for every locked artifact that is **still stale**, puts the **previous** lock entry back for each changed fact it depends on. `apply`, `ack` and `starchart lock <ids…>` all use it. The fact only moves to its new value once nothing stale depends on it.

In a copy of the demo after changing `addon:pro.price.usd` to 5.99:

```bash
starchart lock web:og-pro
starchart check | tail -3
starchart plan
```

```text
✓ starchart.lock: 12 artifacts, 12 facts, 29 code pins
                changed: addon:pro.price.usd

Check: 10 stale
Change: addon:pro.price  {"usd":4.99,"eur":4.99} → {"usd":5.99,"eur":4.99}
Change: addon:pro.price.usd  4.99 → 5.99

  ! manual  appstore:iap/pro-monthly                            mirrors    update in appstore (adapter is read-only)
  …
  ~ auto    web:messages-en                                     embeds     replace embedded value
  ~ auto    web:pricing-page                                    embeds     replace embedded value
  …
Plan: 5 manual · 5 auto · 1 review · 2 code · 1 retire · 1 tests
(4 informational items hidden; use --verbose)
```

`web:og-pro` is pinned to 5.99 and gone from the plan (5 auto instead of 6); the ten still-stale artifacts keep 4.99 in the lock and stay in both `check` and `plan`. Save the bare `starchart lock` for when *everything* is in sync: it resets every pin and every fact to the current graph.

## Staleness: `staleArtifacts` and `check`

`staleArtifacts(graph, lock)` checks every artifact in the graph:

- **Unlocked**: no entry in `lock.artifacts`. Reported with `unlocked: true`.
- **Changed**: some pinned dep is gone from the graph or has a different hash, **or** the artifact now has a dependency the lock doesn't know about (you added an `embeds` edge). Current dependencies are walked with the lock's recorded `maxCodeDepth`.

```text
  ✗ stale     appstore:iap/pro-monthly
                changed: addon:pro.price
                changed: addon:pro.price.usd
  ✗ stale     web:og-pro
                changed: addon:pro.price.usd
  …
Check: 11 stale
```

```text
  ? unlocked  brand:nebula  never synced; run `starchart lock` once it is correct
  ? unlocked  web:team-page  never synced; run `starchart lock` once it is correct

Check: 2 unlocked
```

`starchart check -f json` prints `[{ id, changed, unlocked }]`; `-f markdown` prints a table for PR comments.

## Seeds for a plan: `planFromLock`

`starchart plan` (and `apply`, `preview`) build their plan with `planFromLock` in [`api.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/api.ts). The seeds are `changedSince(graph, lock)`:

- every fact whose current hash differs from `lock.facts[id].hash` (with before/after values). Facts that aren't in the lock at all are skipped; nothing was synced against them yet;
- every `lock.code` entry whose node is gone (after = undefined) or has a different hash;

plus every changed dependency of an artifact that `staleArtifacts` reports. That matters because every relock rebuilds `code` at current hashes: a code node that moved (say, a regenerated constant) is then only "changed" from the point of view of the stale artifacts that pinned its old hash. After impact analysis, locked artifacts that are **not** stale are dropped. That's why `plan` and `check` always agree: after an apply or ack, `plan` lists exactly the stale artifacts (plus the code items and tests they imply) instead of going quiet.

```text
Change: addon:pro.features  ["Themes","iCloud sync"] → ["Themes","iCloud sync","Widgets"]
Change: symbol:ios/Entitlements.proFeatures  "67931739280ac34c" → "3043a3a49728dca7"
```

Code changes show hashes; fact changes show values. Seeds that come from stale dependencies take their before value from `lock.facts`, so a code node seeded that way shows `∅ → <current value>`, as the regenerated constants do after an apply (`Change: symbol:ios/StarchartFacts.AddonPro.Price.usd  ∅ → 5.99`). A deleted fact is not a `changedSince` seed, but every artifact that pinned it is stale in `check`.

## What rewrites the lock

| Command | Effect |
|---|---|
| `starchart lock` | Pin every artifact and every fact to the current graph (`buildLock`). Records `code.maxCodeDepth`. |
| `starchart lock <ids…>` | Pin only these, keeping old fact values that still-stale artifacts need (`relockArtifacts`). |
| `starchart apply` | After successful writes (including codegen), rebuilds the project so edits to bound files are seen, then `relockArtifacts` for the applied artifacts. |
| `starchart ack <ids…>` | `relockArtifacts` for manual/review artifacts you've handled by hand. Errors on non-artifacts (exit 2). |
| `starchart revert <journal>` | Restores the lock saved in the journal ([Apply, Revert and Journals](Apply-Revert-and-Journals)). |

## Commit the lock

Commit `starchart.lock`. It's the record of what the world was last synced to, and:

- `check` in CI needs it;
- `starchart history <fact>` reads fact values from the lock in past commits ([Time Machine](Time-Machine));
- journals and `revert` restore it.

Lock diffs are readable: a price change shows up as new hashes under the artifacts you synced, and, once nothing stale depends on the old price any more, a one-line value change under `facts`. So `history` sees the new value when the last dependent artifact is synced or acked.

## CI usage

`starchart check` is the drift gate:

| Exit code | Meaning |
|---|---|
| `0` | Every artifact is in sync (`✓ every artifact is in sync`). |
| `1` | At least one artifact is stale **or unlocked**. |
| `2` | Error: bad YAML, schema violation, unknown edge type, bad lock version. |

```yaml
- run: npx @spz/starchart check -f markdown >> "$GITHUB_STEP_SUMMARY"
```

`@spz/starchart` isn't published to npm yet. Until it is, build from source in the workflow and call the CLI directly, the way STARCHART's own CI checks the demo:

```yaml
- run: git clone https://github.com/space-pirate-zero/starchart.git /tmp/starchart && cd /tmp/starchart && pnpm install && pnpm build   # needs Node 22 and pnpm set up first
- run: node /tmp/starchart/packages/starchart/dist/cli/bin.js check -f markdown >> "$GITHUB_STEP_SUMMARY"
```

The [GitHub Action](GitHub-Action) runs `impact --diff` for a sticky PR comment and can run `check` with `fail-on-stale: true`; it needs the published package.

## See also

- [Impact Analysis](Impact-Analysis)
- [Apply, Revert and Journals](Apply-Revert-and-Journals)
- [GitHub Action](GitHub-Action)
- [Time Machine](Time-Machine)
- [Rollout Ordering](Rollout-Ordering)
