STARCHART runs on your machine, reads your repo and can write to your files, Stripe and App Store Connect. This page lays out what it trusts and what it doesn't, how to report a vulnerability privately, and what the 0.1.1 security release hardened, with a link to the page that covers each protection in detail. The canonical copy of the policy is [SECURITY.md](https://github.com/space-pirate-zero/starchart/blob/main/SECURITY.md) in the repo.

## Trust model

STARCHART is a local developer tool, not a sandbox. Your config is code. Everything else is data, and data gets checked at the door.

| Input | Trust level | What that means |
|---|---|---|
| Your `.starchart/` config | **Trusted, like code** | Modules under `plugins:` are imported and run as JavaScript, exactly like an eslint or vite config. Don't run `starchart` on a repo you don't trust. |
| Repo files the code layer reads | Content only | Parsed, never executed. Secret-looking literal values are redacted before they reach the graph. |
| File writes (`apply`, `codegen`, `revert`) | Confined | Every write path must resolve inside the project root, symlinks followed. |
| Git revisions (`impact --diff`, MCP `starchart_diff_impact`) | Validated | Revisions shaped like options are rejected, and git gets `--end-of-options`. |
| Regexes from config (rule `pattern`s, fs `regex:` selectors) | Screened | Nested quantifiers and patterns over 500 characters are refused. |
| `starchart serve` clients | Loopback and extension only | Binds loopback by default, rejects non-loopback `Host` headers, grants CORS only to browser-extension origins. `--allow-remote` exposes it **without authentication**. |
| MCP clients (agents) | Inputs validated | `starchart_apply` is a dry run unless called with `dryRun: false` **and** `confirm: true`. |
| External systems (Stripe, App Store Connect) | Opt-in writes | Adapters are read-only until `adapters.<id>.write: true`. Credentials come from the environment and never appear in output or journals. |

### CI

Run STARCHART on trusted code. A pull request can add a module to `plugins:`, and that module runs with the job's permissions. Never combine `pull_request_target` with a checkout of the PR's own branch. See [GitHub Action](GitHub-Action).

## Reporting a vulnerability

Report privately through GitHub: **[Report a vulnerability](https://github.com/space-pirate-zero/starchart/security/advisories/new)**. Private vulnerability reporting is enabled on the repo. Don't open a public issue for anything exploitable.

Include:

- the version (`starchart --version`)
- what an attacker controls (a repo file, a config value, a web page, an MCP tool argument, …)
- a reproduction, if you have one

Fixes ship as patch releases of [`@space-pirate-zero/starchart`](https://www.npmjs.com/package/@space-pirate-zero/starchart) and are listed in the [CHANGELOG](https://github.com/space-pirate-zero/starchart/blob/main/CHANGELOG.md).

## Hardening in 0.1.1

0.1.1 (2026-09-30) is a security release. Upgrade if you run `starchart serve` or the MCP server:

```bash
npm i -D @space-pirate-zero/starchart@0.1.1
```

```text
$ npx --yes @space-pirate-zero/starchart@0.1.1 --version
0.1.1
```

| Protection | What changed | Details |
|---|---|---|
| **`serve` stays private** | CORS only for browser-extension origins (the X-Ray), `403 forbidden host` on a non-loopback `Host` header (DNS rebinding), and a non-loopback `--host` needs `--allow-remote`. | [Viewer and Serve](Viewer-and-Serve#cors-and-headers) |
| **Secrets stay out of the graph** | Constants named like secrets, or whose value looks like an API key, token, private key, JWT or credentialed URL, are stored without a value and with `meta.redacted: true`. Nothing leaks into the viewer, `emit graph`, MCP or `serve`. | [Code Ingestion](Code-Ingestion#secret-redaction) |
| **Git revisions can't become flags** | A base starting with `-` (or holding a NUL or line break) fails with `invalid git revision: "<rev>"` (exit 2), and git gets `--end-of-options`. A crafted base can no longer make git write files. | [Git Diff Impact](Git-Diff-Impact#revision-validation) · [MCP Server](MCP-Server) |
| **Writes can't escape the project** | Every path `apply`, `codegen` and `revert` write must resolve inside the project root, symlinks followed: `path "<p>" is outside the project root` or `… resolves outside the project root (symlink)`. | [Adapter fs](Adapter-fs#path-containment) · [Apply, Revert and Journals](Apply-Revert-and-Journals#writes-stay-inside-the-project) · [Codegen](Codegen#output-stays-in-the-project) |
| **Config regexes can't hang the process** | Rule `value.pattern`s and fs `regex:` selectors with nested quantifiers (`(a+)+`) or over 500 characters are refused. A heuristic, not a proof of linear time. | [Rules Engine](Rules-Engine#regex-screening) · [Adapter fs](Adapter-fs#regex-screening) |
| **One version, everywhere** | The CLI (`--version`, `about`) and the MCP server read the version from `package.json`, so they can't drift from the published package. | [Architecture](Architecture) |

The repo also gained [SECURITY.md](https://github.com/space-pirate-zero/starchart/blob/main/SECURITY.md) and a `.gitignore` that covers secret-bearing files (`*.p8`, `*.pem`, `credentials*.json`, …). Every fix above is pinned by a regression test in [`packages/starchart/test/security.test.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/test/security.test.ts).

## What it doesn't protect against

Straight talk about the edges:

- **Plugins are code.** A malicious `plugins:` entry can do anything your user can. The trust model starts at "you trust this repo's config".
- **`--allow-remote` has no auth.** Anyone who can reach the port reads the whole chart. Use it only on a network you control.
- **Redaction is pattern-based.** A credential with an unremarkable name and an unrecognized format still gets through. Keep secrets in the environment, not in constants.
- **Regex screening is a heuristic.** It catches the common catastrophic shapes. A pattern that passes can still be slow on a hostile input.

## See also

- [Viewer and Serve](Viewer-and-Serve)
- [Code Ingestion](Code-Ingestion)
- [Apply, Revert and Journals](Apply-Revert-and-Journals)
- [MCP Server](MCP-Server)
- [Contributing](Contributing)
