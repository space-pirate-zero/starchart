# STARCHART GitHub Action

```text
███████╗████████╗ █████╗ ██████╗  ██████╗██╗  ██╗ █████╗ ██████╗ ████████╗
██╔════╝╚══██╔══╝██╔══██╗██╔══██╗██╔════╝██║  ██║██╔══██╗██╔══██╗╚══██╔══╝
███████╗   ██║   ███████║██████╔╝██║     ███████║███████║██████╔╝   ██║
╚════██║   ██║   ██╔══██║██╔══██╗██║     ██╔══██║██╔══██║██╔══██╗   ██║
███████║   ██║   ██║  ██║██║  ██║╚██████╗██║  ██║██║  ██║██║  ██║   ██║
╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝
☠ GITHUB ACTION ── A SPACE PIRATE ZERO JOINT ☠
```

Posts the cross-layer blast radius of every pull request as a single sticky comment: which
screens, facts, App Store screenshots, web pages, Stripe prices and promo reels the diff touches,
classified as auto / review / manual / break, with a why-path for each.

## Usage

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
        with:
          fail-on-stale: true
```

The comment is identified by a hidden `<!-- starchart-blast-radius -->` marker and updated in
place on every push, so a PR never collects more than one STARCHART comment. The report is also
written to the job summary.

## Inputs

| Input | Default | Description |
|---|---|---|
| `base` | PR base branch, then `main` | Branch to diff against (`origin/<base>`). |
| `working-directory` | `.` | Directory containing `.starchart/`. |
| `comment` | `true` | Post or update the sticky PR comment. |
| `fail-on-stale` | `false` | Run `starchart check` and fail when artifacts drift from `starchart.lock`. |
| `node-version` | `22` | Node.js version. |
| `starchart-version` | `latest` | `@spz/starchart` version or dist-tag. |
| `github-token` | `${{ github.token }}` | Token for reading and writing PR comments. |

## Outputs

| Output | Description |
|---|---|
| `report` | Path to the markdown report (`$RUNNER_TEMP/starchart.md`). |

## Notes

- Pull requests from forks get a read-only token, so the comment step logs a warning instead of
  failing; the report still lands in the job summary.
- Pin `starchart-version` to an exact version for reproducible CI.
