The Reality Score is one number for how much of your public world matches your chart: the share of live world artifacts that are bound, in sync with `starchart.lock`, not expired and, optionally, passing a live audit. Put it in your README as a badge and watch it drop the moment someone changes a price without shipping the screenshots. This page covers the exact formula, what counts as in sync, the `--audit` mode, the SVG badge and shields.io endpoint, the color thresholds, and how to publish the badge from CI. Source: [`analysis/score.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/analysis/score.ts).

## Formula

```text
artifacts = every node with kind "artifact" and status != "retired"
bad       = unbound ∪ stale ∪ expired ∪ failingAudit      (a set; each artifact counts once)
inSync    = |artifacts| − |bad|
score     = round(100 × inSync / |artifacts|)             (100 when there are no artifacts)
```

An artifact is **in sync** when all four hold:

| Condition | Breakdown key | Fails when |
|---|---|---|
| Bound | `unbound` | It has no `binding`. |
| Not stale | `stale` | Any dependency pinned in `starchart.lock` (fact value or code hash) changed, a new dependency appeared, or the artifact was **never locked**. See [Lockfile and Drift](Lockfile-and-Drift). |
| Not expired | `expired` | Its `validThrough` has passed. A bare date lasts through the end of that day (UTC). |
| Passing audit | `failingAudit` | Only with `--audit`: the live audit reported any diff for it. |

**Retired artifacts are excluded** from both the numerator and the denominator. Retiring an expired promo is how you get its points back, not by deleting it.

An artifact that fails several conditions (unbound **and** expired, say) still costs one point. The breakdown lists it under every key it fails.

## Usage

```bash
starchart score                               # text (-f accepts text or json only)
starchart score -f json                       # ScoreReport
starchart score --audit                       # also run the live audit (slower, needs credentials)
starchart score --badge badge.svg             # write a README badge
starchart score --badge-json reality.json     # write a shields.io endpoint JSON
```

`starchart` here is shorthand for `npx @space-pirate-zero/starchart`. The package isn't on npm yet, so for now build from source and alias `starchart` to `node /path/to/starchart/packages/starchart/dist/cli/bin.js` (see [Getting Started](Getting-Started)).

`--badge` and `--badge-json` paths resolve against the current directory (or `-C`), and parent directories are created. The command always exits 0. The score is a metric. Use `starchart check` as the gate (see [GitHub Action](GitHub-Action)).

### Real output

Demo (`examples/pro-universe`), freshly locked:

```text
$ starchart score
reality 83%  10/12 artifacts in sync
  unbound      privacy:appstore-label
  expired      reel:spring-2026
```

```json
{
  "score": 83,
  "total": 12,
  "inSync": 10,
  "breakdown": {
    "unbound": ["privacy:appstore-label"],
    "stale": [],
    "expired": ["reel:spring-2026"],
    "failingAudit": []
  }
}
```

With `--audit` and no Stripe or App Store credentials, artifacts the audit can't check are **skipped, not failed**. Only real diffs count:

```text
$ starchart score --audit
reality 75%  9/12 artifacts in sync
  unbound      privacy:appstore-label
  expired      reel:spring-2026
  failingAudit web:og-pro
```

Here `web:og-pro`'s rendered PNG hasn't been generated, which is a real diff. `web:live-pricing` couldn't be fetched (the demo site doesn't exist), but a network failure is an audit **error**, not a diff, so it doesn't cost a point. Only a 404/410 from the `url` adapter counts as a diff. Run `starchart audit` to see errors. See [Audit and Break Detection](Audit-and-Break-Detection).

### Staleness is strict

The score is harsh on purpose. After a one-line change to `apps/ios/Sources/Core/Pricing.swift` (a hardcoded price) in a copy of the demo, every artifact that depends on it, transitively through the fact it anchors, went stale:

```text
$ starchart score
reality 0%  0/12 artifacts in sync
  unbound      privacy:appstore-label
  stale        appstore:iap/pro-monthly, appstore:listing/description, appstore:screenshots/6.9/03, email:onboarding-day-3, reel:spring-2026, stripe:price/pro-monthly, web:landing-hero, web:live-pricing, web:messages-en, web:og-pro, web:pricing-page
  expired      reel:spring-2026
```

It recovers as you ship: `starchart apply` relocks the artifacts it updates, and `starchart ack <id…>` relocks the ones you updated by hand. Relocking only pins those ids. Artifacts you haven't shipped yet keep the old values of their dependencies, so they stay stale (and keep costing points) until you ack or fix them. See [Apply, Revert and Journals](Apply-Revert-and-Journals).

## Colors

| Score | Color | Badge text |
|---|---|---|
| ≥ 95 | `#00ff41` (green) | dark |
| 80–94 | `#ffd000` (yellow) | dark |
| < 80 | `#ff1493` (pink) | white |

The CLI tints the text output the same way when color is on.

## Badges

### SVG

`--badge <file>` writes a standalone, shields-style flat SVG that reads `reality | 83%`. The score is clamped to 0–100 and rounded. The demo's badge starts:

```text
<svg xmlns="http://www.w3.org/2000/svg" width="81" height="20" role="img" aria-label="reality: 83%"><title>reality: 83%</title>…
```

### shields.io endpoint JSON

`--badge-json <file>` writes a [shields.io endpoint](https://shields.io/badges/endpoint-badge) document:

```json
{"schemaVersion":1,"label":"reality","message":"83%","color":"#ffd000"}
```

Host it at any public URL and reference it with `https://img.shields.io/endpoint?url=<url-encoded URL>`. Shields handles styling and caching.

Both are also in the library: `badgeSvg(score)`, `badgeJson(score)`, `realityScore(graph, lock, { now, auditDiffs })`.

## Publishing the badge from CI

The simplest setup commits the badge to a dedicated `badges` branch on every push to `main`, and the README points at the raw file. The action installs `@space-pirate-zero/starchart` from npm, which isn't published yet, so this workflow builds STARCHART from source. See [GitHub Action](GitHub-Action#until-the-npm-package-is-published).

```yaml
# .github/workflows/reality-badge.yml
name: Reality badge

on:
  push:
    branches: [main]
  schedule:
    - cron: "0 6 * * *" # expiry dates pass even when nobody pushes

permissions:
  contents: write

jobs:
  badge:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/checkout@v4
        with:
          repository: space-pirate-zero/starchart
          path: .starchart-src
      - uses: pnpm/action-setup@v4
        with:
          package_json_file: .starchart-src/package.json
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Build STARCHART
        working-directory: .starchart-src
        run: pnpm install --frozen-lockfile && pnpm build

      - name: Score
        run: |
          node .starchart-src/packages/starchart/dist/cli/bin.js score \
            --badge "$RUNNER_TEMP/badges/reality.svg" \
            --badge-json "$RUNNER_TEMP/badges/reality.json"

      - name: Publish to the badges branch
        run: |
          cd "$RUNNER_TEMP/badges"
          git init -q -b badges
          git add reality.svg reality.json
          git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
            commit -qm "reality badge ${GITHUB_SHA::7}"
          git push -f "https://x-access-token:${{ secrets.GITHUB_TOKEN }}@github.com/${GITHUB_REPOSITORY}.git" badges
```

Then pick one of these for the README:

```markdown
<!-- the SVG STARCHART rendered -->
![Reality Score](https://raw.githubusercontent.com/<owner>/<repo>/badges/reality.svg)

<!-- or shields.io styling from the endpoint JSON -->
![Reality Score](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2F<owner>%2F<repo>%2Fbadges%2Freality.json)
```

Once `@space-pirate-zero/starchart` is on npm, the build steps collapse to `npx --yes @space-pirate-zero/starchart score --badge … --badge-json …`.

For a live-audit score, add `--audit` and pass the adapter credentials as secrets: `STRIPE_SECRET_KEY` (or the variable named by `adapters.stripe.secretEnv`), and `ASC_KEY_ID`, `ASC_ISSUER_ID` plus `ASC_PRIVATE_KEY` or `ASC_PRIVATE_KEY_PATH` for App Store Connect. Config values aren't env-interpolated, so don't put `${VAR}` in config.yaml. Without credentials, those artifacts are skipped, not failed.

## Also available to agents

The `starchart_score` [MCP tool](MCP-Server) returns the same JSON (without `--audit`).

## See also

- [Lockfile and Drift](Lockfile-and-Drift)
- [Audit and Break Detection](Audit-and-Break-Detection)
- [Orphans](Orphans)
- [GitHub Action](GitHub-Action)
