# Security

## Reporting a vulnerability

Please report security issues privately through GitHub: **[Report a vulnerability](https://github.com/space-pirate-zero/starchart/security/advisories/new)** on this repository. Don't open a public issue for anything exploitable. Include the version (`starchart --version`), what an attacker controls, and a reproduction if you have one.

Fixes ship as patch releases of [`@space-pirate-zero/starchart`](https://www.npmjs.com/package/@space-pirate-zero/starchart); see [CHANGELOG.md](CHANGELOG.md).

## Trust model

STARCHART is a local developer tool. What it trusts, and what it doesn't:

| Input | Trusted? | Notes |
|---|---|---|
| Your `.starchart/` config | **Yes, like code.** | `plugins:` entries are imported and run as JavaScript, the same way eslint or vite configs are. Don't run `starchart` on a repo you don't trust. |
| Repo files read by the code layer | Content only | Parsed, never executed. Secret-looking literal values are redacted from the graph. |
| File writes (`apply`, `codegen`, `revert`) | Confined | Every write path must resolve inside the project root, symlinks included. |
| Git revisions (`--diff`, MCP `starchart_diff_impact`) | Validated | Option-shaped revisions are rejected; git gets `--end-of-options`. |
| Regexes from config (rule patterns, `regex:` selectors) | Screened | Nested quantifiers and oversized patterns are rejected. |
| `starchart serve` clients | Loopback + extension only | Binds loopback by default, rejects non-loopback `Host` headers, and grants CORS only to browser-extension origins. `--allow-remote` exposes it without authentication. |
| MCP clients (agents) | Tool inputs validated | `starchart_apply` is a dry run unless called with `dryRun: false` and `confirm: true`. |
| External systems (Stripe, App Store Connect) | Opt-in writes | Adapters are read-only until `adapters.<id>.write: true`. Credentials come from the environment and never appear in output or journals. |

In CI, run STARCHART on trusted code. Don't combine `pull_request_target` with a checkout of the PR's own branch, because a PR could add a plugin.
