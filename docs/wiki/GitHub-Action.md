The STARCHART GitHub Action posts the cross-layer blast radius of every pull request as one sticky comment: which screens, facts, App Store screenshots, web pages, Stripe prices and promo reels the diff touches, each classified auto / review / manual / break with a why-path. It can also fail the job when artifacts drift from `starchart.lock`. This page covers the action's inputs and outputs, required permissions, a full workflow, how the sticky comment works, running `check`, `rules` and `score --badge` in CI, and how to replicate the action as plain workflow steps. Source: [`action/action.yml`](https://github.com/space-pirate-zero/starchart/blob/main/action/action.yml).

Add it with `uses: space-pirate-zero/starchart/action@main`. It installs the published npm package on the fly with `npx --yes @space-pirate-zero/starchart@<starchart-version>`, so there's nothing to build and nothing to add to your `package.json`.

> **Status:** GitHub Actions is currently blocked on the space-pirate-zero account by a billing lock, so the action hasn't been exercised in a real Actions run yet. Every command it calls works against the published `@space-pirate-zero/starchart@0.1.0`; if you hit a snag in the composite wiring itself, [open an issue](https://github.com/space-pirate-zero/starchart/issues).

## Inputs

| Input | Default | Description |
|---|---|---|
| `base` | `""` → PR base branch (`github.base_ref`), then `main` | Branch to diff against. A leading `refs/heads/` or `origin/` is stripped, and the name must pass `git check-ref-format --branch`. The diff runs against `origin/<base>`. |
| `working-directory` | `.` | Directory containing `.starchart/`. |
| `comment` | `"true"` | Post or update the sticky PR comment. Only runs on `pull_request` and `pull_request_target` events. |
| `fail-on-stale` | `"false"` | Run `starchart check` and fail the job if any artifact is stale against `starchart.lock`. |
| `node-version` | `"22"` | Node.js version for `actions/setup-node@v4`. |
| `starchart-version` | `"latest"` | Version or dist-tag of `@space-pirate-zero/starchart`. Must match `^[A-Za-z0-9][A-Za-z0-9._+-]*$`. |
| `github-token` | `${{ github.token }}` | Token for reading and writing PR comments. Needs `pull-requests: write`. |

## Outputs

| Output | Description |
|---|---|
| `report` | Path to the markdown blast-radius report (`$RUNNER_TEMP/starchart.md`). |

The report is also appended to the job summary (`$GITHUB_STEP_SUMMARY`), so it's visible even when commenting is off or not allowed.

## What it runs

The action is a composite of four steps:

1. `actions/setup-node@v4` with `node-version`.
2. **Compute blast radius:** validate inputs, `git fetch origin +refs/heads/<base>:refs/remotes/origin/<base>` (if the fetch fails, it logs a warning and uses the local ref), then:
   ```bash
   npx --yes "@space-pirate-zero/starchart@${STARCHART_VERSION}" impact --diff "origin/${base}" --format markdown > "$RUNNER_TEMP/starchart.md"
   ```
3. **Post sticky PR comment** (when `comment == 'true'` on a PR event).
4. **Fail on stale artifacts** (when `fail-on-stale == 'true'`): `npx --yes "@space-pirate-zero/starchart@…" check`, which exits 1 on drift.

`impact --diff` seeds from the files changed versus the base plus any fact changes since the lock. See [Git Diff Impact](Git-Diff-Impact). Code-ingest warnings (unknown `@starchart` verbs, unparsable files) go to stderr as `warn …`, so they show up in the job log without leaking into the redirected markdown report.

Plugins listed under `plugins:` in `.starchart/config.yaml` load in CI like anywhere else. Relative paths resolve from the project root; bare package names resolve from the project's `node_modules`, so install your project's dependencies in the job before running STARCHART if you use packaged plugins. A plugin that fails to load is a config error and fails the step.

## Permissions

```yaml
permissions:
  contents: read        # checkout
  pull-requests: write  # create or update the comment
```

Pull requests from forks get a read-only token. The comment step then logs `::warning::could not post the STARCHART comment (does the token have pull-requests: write?)` instead of failing, and the report still lands in the job summary.

## Full workflow

```yaml
# .github/workflows/starchart.yml
name: STARCHART

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  blast-radius:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # the diff needs the base branch history

      - uses: space-pirate-zero/starchart/action@main
        id: starchart
        with:
          fail-on-stale: true
          # starchart-version: 0.1.0   # pin for reproducible CI (default: latest)
          # working-directory: apps     # if .starchart/ isn't at the repo root
```

Use `fetch-depth: 0` so `git diff origin/<base>` has the merge base. With a shallow clone, the diff can't be computed reliably.

## The sticky comment

The body is the markdown report prefixed with a hidden marker:

```text
<!-- starchart-blast-radius -->
## 🌌 STARCHART blast radius

**3 changes:**

- `file:ios/Sources/Core/Pricing.swift`
- `symbol:ios/Pricing`
- `symbol:ios/Pricing.proUSD`

| | Class | Count |
|---|---|---:|
| ! | Manual | 5 |
| ~ | Auto-fixable | 6 |
| ? | Needs review | 1 |
| ⌘ | Code to update | 1 |
| ✗ | Retire | 1 |
| ✓ | Tests to run | 1 |

<details open><summary><b>! Manual</b> (5)</summary>
…
```

(Real output for a one-line price change in `Pricing.swift` in a copy of the demo.)

On every run, the action lists the PR's issue comments (`gh api --paginate`) and takes the **first** comment whose body starts with `<!-- starchart-blast-radius -->`. It PATCHes that comment in place, or POSTs a new one if none exists. A PR never collects more than one STARCHART comment, and re-pushes update it.

Bodies longer than 65,000 characters (GitHub's limit is 65,536) are truncated on a character boundary with a note to run `starchart plan` locally. API failures produce a warning, never a failed job.

## fail-on-stale

With `fail-on-stale: true`, the job fails whenever `starchart check` finds a stale or never-locked artifact. On the same one-line change:

```text
  ✗ stale     appstore:iap/pro-monthly
                changed: symbol:ios/Pricing.proUSD
  ✗ stale     appstore:listing/description
                changed: symbol:ios/Pricing.proUSD
…
Check: 11 stale
```

This makes `starchart.lock` part of the PR. Whoever changes a fact or anchored code either ships the downstream updates (`starchart apply`, then `starchart ack` for manual items) or relocks on purpose. See [Lockfile and Drift](Lockfile-and-Drift).

## Other commands in CI

The action only covers impact and `check`. Everything else is one `npx --yes @space-pirate-zero/starchart <command>` call (written `starchart <command>` below). Exit codes:

| Command | Fails the step when |
|---|---|
| `starchart check` | any artifact is stale or never locked (exit 1) |
| `starchart rules` | any `error`-severity violation (exit 1). Invalid rules or unknown packs exit 2. |
| `starchart privacy` | any privacy `error` (exit 1) |
| `starchart scan` | unbound fact literals are found (exit 1) |
| `starchart audit` | any live diff or adapter error (exit 1). A `url` artifact whose request fails (network error, or any HTTP error other than 404/410) counts as an error, so an offline runner fails the step. |
| `starchart score`, `orphans`, `cost` | never. They're metrics. |

Rules as a PR check, with the findings in the job summary:

```yaml
      - name: Business rules
        run: |
          npx --yes @space-pirate-zero/starchart rules -f markdown >> "$GITHUB_STEP_SUMMARY" || true
          npx --yes @space-pirate-zero/starchart rules   # prints text and sets the exit code
```

Reality badge on `main`: see [Reality Score](Reality-Score#publishing-the-badge-from-ci) for a complete workflow that writes `--badge` / `--badge-json` and publishes them to a `badges` branch.

## Without the action

Prefer not to pull a third-party action, or want extra steps in the same job? Replicate it with plain `run:` steps. The marker is the same, so switching between this and the action keeps updating the same comment.

```yaml
# .github/workflows/starchart.yml
name: STARCHART

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  blast-radius:
    runs-on: ubuntu-latest
    env:
      SC: npx --yes @space-pirate-zero/starchart@latest   # pin a version for reproducible CI
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Blast radius
        env:
          BASE: ${{ github.base_ref }}
        run: |
          set -euo pipefail
          git fetch --no-tags --quiet origin "+refs/heads/${BASE}:refs/remotes/origin/${BASE}" || true
          $SC impact --diff "origin/${BASE}" --format markdown > "$RUNNER_TEMP/starchart.md"
          cat "$RUNNER_TEMP/starchart.md" >> "$GITHUB_STEP_SUMMARY"

      - name: Sticky comment
        env:
          GH_TOKEN: ${{ github.token }}
          PR: ${{ github.event.pull_request.number }}
          REPO: ${{ github.repository }}
        run: |
          set -euo pipefail
          body="$RUNNER_TEMP/comment.md"
          { printf '%s\n' '<!-- starchart-blast-radius -->'; cat "$RUNNER_TEMP/starchart.md"; } > "$body"
          id="$(gh api --paginate "repos/$REPO/issues/$PR/comments" \
            --jq '.[] | select(.body | startswith("<!-- starchart-blast-radius -->")) | .id' | awk 'NR == 1')"
          if [[ -n "$id" ]]; then
            gh api --method PATCH "repos/$REPO/issues/comments/$id" -F "body=@$body" > /dev/null || echo "::warning::could not update comment"
          else
            gh api --method POST "repos/$REPO/issues/$PR/comments" -F "body=@$body" > /dev/null || echo "::warning::could not post comment"
          fi

      - name: Drift gate
        run: $SC check

      - name: Business rules
        run: $SC rules
```

This version skips the action's 65,000-character truncation. Add it back if your blast radii get huge.

For monorepos where `.starchart/` isn't at the root, run the `$SC` commands with `-C <dir>`, the equivalent of `working-directory`.

## See also

- [Git Diff Impact](Git-Diff-Impact)
- [Lockfile and Drift](Lockfile-and-Drift)
- [Rules Engine](Rules-Engine)
- [Reality Score](Reality-Score)
- [CLI Reference](CLI-Reference)
