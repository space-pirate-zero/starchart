# Changelog

## 0.1.1 — 2026-09-30

Security release. Upgrading is recommended for anyone who runs `starchart serve` or the MCP server.

- **`serve` no longer exposes the chart to web pages.** CORS is granted only to browser-extension origins (the Reality X-Ray), requests with a non-loopback `Host` header get 403 (DNS rebinding), and a non-loopback `--host` requires the new `--allow-remote` flag.
- **Secret-looking literals are redacted from the code layer.** Values of constants named like secrets, or that look like API keys, tokens, private keys, JWTs or credentialed URLs, are withheld (`meta.redacted: true`) instead of flowing into the viewer, `emit graph`, MCP and `serve`.
- **Git option injection fixed.** `impact --diff <base>` and the MCP `starchart_diff_impact` tool reject revisions that start with `-` and pass `--end-of-options`, so a crafted base can no longer make git write arbitrary files.
- **Writes can't escape the project.** `apply`, `codegen` and `revert` resolve every path inside the project root, following symlinks.
- **Unsafe regexes rejected.** Rule `pattern`s and fs `regex:` selectors with nested quantifiers or more than 500 characters are refused.
- The CLI and MCP server read their version from `package.json`.
- Added `SECURITY.md`.

## 0.1.0 — 2026-09-30

First release.
