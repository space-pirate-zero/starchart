# @space-pirate-zero/starchart

```text
  ·      ✦          ·        ★            ·          ✦         ·       ·
███████╗████████╗ █████╗ ██████╗  ██████╗██╗  ██╗ █████╗ ██████╗ ████████╗
██╔════╝╚══██╔══╝██╔══██╗██╔══██╗██╔════╝██║  ██║██╔══██╗██╔══██╗╚══██╔══╝
███████╗   ██║   ███████║██████╔╝██║     ███████║███████║██████╔╝   ██║
╚════██║   ██║   ██╔══██║██╔══██╗██║     ██╔══██║██╔══██║██╔══██╗   ██║
███████║   ██║   ██║  ██║██║  ██║╚██████╗██║  ██║██║  ██║██║  ██║   ██║
╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝
☠ EVERY DEPENDENCY. CODE TO COSMOS. ────────── A SPACE PIRATE ZERO JOINT ☠
     ·         ·         ✦           ·          ★          ·         ·
```

**Every dependency. Code to cosmos.** STARCHART charts three layers: your **code** (files, symbols, routes, screens, packages, flags, events, i18n, tests), your canonical **facts** (prices, names, product ids, feature lists) and the **world** that depends on them (website copy, OG images, App Store listing and screenshots, Stripe prices, promo reels, emails). Change anything on any layer and it tells you what else is now wrong, explains why, fixes what it can, and turns the rest into a checklist.

```text
$ npx @space-pirate-zero/starchart plan

Change: addon:pro.price.usd  4.99 → 5.99

  ! manual  appstore:screenshots/6.9/03                         embeds     value is burned into media
  ! manual  stripe:price/pro-monthly                            mirrors    update in stripe (adapter is read-only)
  ~ auto    web:og-pro                                          renders    regenerate from template
  ~ auto    web:pricing-page                                    embeds     replace embedded value
  ⌘ code    symbol:ios/Pricing.proUSD                           anchors    hardcoded value anchors this fact; update or switch to codegen
  ✗ retire  reel:spring-2026                                    embeds     expired 2026-06-30
  ✓ tests   test:ios/Tests/PaywallTests.swift                   tests      run these tests
  …
```

## Install

```bash
npm i -D @space-pirate-zero/starchart
```

Node 20 or newer. Binaries: `starchart` (alias `sc`) and `starchart-mcp`. Use the scoped name with npx (`npx @space-pirate-zero/starchart …`); the unscoped `starchart` package on npm is unrelated.

## Quick start

```bash
npx @space-pirate-zero/starchart init --discover
```

```bash
npx @space-pirate-zero/starchart lock
```

```bash
npx @space-pirate-zero/starchart plan
```

```bash
npx @space-pirate-zero/starchart apply --dry-run
```

`init --discover` detects your code scopes and proposes facts and bridges in `.starchart/proposals/discovered.yaml`. Review it, move it into `.starchart/`, then `lock` pins every artifact to today's facts and code.

## What's inside

- **Cross-layer impact** with a "why" path for every item: `impact`, `impact --diff <base>`, `plan`, `why`
- **Drift as a build failure**: `starchart.lock` + `check`
- **Plan / apply / revert** through adapters (fs, url, Stripe, App Store Connect; external writes are opt-in), with journals
- **Rules**: invariants in YAML plus packs for core, App Store, SEO and **privacy drift** (SDKs in code vs. `PrivacyInfo.xcprivacy` and privacy labels)
- **Facts as code**: TS / Swift / Kotlin codegen; schema.org **JSON-LD** for SEO
- **Orphans, Reality Score badge, change-cost advisor, time machine**
- **Star chart viewer** (`graph`, `serve`) and the Reality X-Ray browser extension
- **Agent-native**: MCP server (`starchart mcp`) and a Claude Code PostToolUse hook (`starchart hook claude`)
- **Plugins**: your own adapters and rule packs via `plugins:` in config

## Library

```ts
import { buildProject, planFromLock, formatPlanText } from "@space-pirate-zero/starchart";

const project = await buildProject(process.cwd());
console.log(formatPlanText(planFromLock(project)));
```

## Docs

📖 Full documentation: **[the STARCHART wiki](https://github.com/space-pirate-zero/starchart/wiki)** · [Getting started](https://github.com/space-pirate-zero/starchart/wiki/Getting-Started) · [Tutorial](https://github.com/space-pirate-zero/starchart/wiki/Tutorial-Pro-Universe) · [CLI reference](https://github.com/space-pirate-zero/starchart/wiki/CLI-Reference)

Source and issues: [github.com/space-pirate-zero/starchart](https://github.com/space-pirate-zero/starchart). Apache-2.0. A Space Pirate Zero joint.
