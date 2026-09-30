STARCHART ships an MCP server so AI agents get the same map you do. Before an agent edits a price, it can ask what the price touches. After it edits, it can ask what it just broke, and it can apply the safe parts with your sign-off. This page covers setup (Claude Code, the `starchart-mcp` binary, `STARCHART_ROOT`), the instructions the server hands the agent, every tool with its input schema and output, the safety model for `starchart_apply`, example agent sessions, and how to test the server with an in-memory client. Source: [`mcp/server.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/mcp/server.ts).

## Setup

The server speaks MCP over stdio. There are two ways to start it:

| Command | Project root |
|---|---|
| `starchart mcp` | `-C <dir>` if given, then `$STARCHART_ROOT`, then the current directory. |
| `starchart-mcp` (separate bin in the same package) | `$STARCHART_ROOT`, then the current directory. |

Either way, the root can be any directory inside the project. STARCHART walks up to the nearest `.starchart/`. Plugins listed under `plugins:` in `.starchart/config.yaml` load here too, so custom adapters and rule packs show up in `starchart_audit`, `starchart_rules` and `starchart_apply` exactly as they do on the CLI (see [Writing an Adapter](Writing-an-Adapter)).

### Claude Code

Once `@space-pirate-zero/starchart` is published:

```bash
claude mcp add starchart -- npx @space-pirate-zero/starchart mcp
```

Always use the scoped name. The unscoped npm package `starchart` belongs to someone else, so bare `npx starchart` runs the wrong thing.

> **Heads-up:** `@space-pirate-zero/starchart` is not on npm yet. Until it is, point Claude Code at a source build:

```bash
git clone https://github.com/space-pirate-zero/starchart.git && cd starchart
pnpm install && pnpm build

# from your project directory:
claude mcp add starchart -- node /abs/path/to/starchart/packages/starchart/dist/cli/bin.js -C /abs/path/to/your-project mcp

# or let STARCHART_ROOT pick the project (works with either bin):
claude mcp add starchart -e STARCHART_ROOT=/abs/path/to/your-project -- node /abs/path/to/starchart/packages/starchart/dist/cli/bin.js mcp
claude mcp add starchart -e STARCHART_ROOT=/abs/path/to/your-project -- node /abs/path/to/starchart/packages/starchart/dist/mcp/bin.js
```

To share the setup with your team, check in a project-scoped `.mcp.json`:

```json
{
  "mcpServers": {
    "starchart": {
      "command": "node",
      "args": ["/abs/path/to/starchart/packages/starchart/dist/mcp/bin.js"],
      "env": { "STARCHART_ROOT": "." }
    }
  }
}
```

Any other MCP client works the same way: run the command over stdio.

**Every tool call rebuilds the project from disk**: YAML, code ingestion, lock. Answers always reflect the working tree, including edits the agent made a second ago. The cost is a full build per call, so big repos will feel it (see [Architecture](Architecture)).

## Instructions sent to the agent

The server advertises this `instructions` string on connect. Clients like Claude Code put it in the agent's context:

```text
STARCHART charts how code, canonical facts (prices, names, product ids, feature lists) and real-world artifacts (website pages, App Store listings, Stripe prices, screenshots, reels) depend on each other.

How to use it:
- Before editing a fact in .starchart/ or a file that anchors a fact, call starchart_impact with the node id or file path to see the cross-layer blast radius, and tell the user what it touches.
- After making changes, call starchart_plan (changes since starchart.lock) or starchart_diff_impact (changes versus a git base) and fix the "code" and "auto" items in the same session; report "manual", "review" and "break" items to the user.
- Use starchart_why to explain a dependency, starchart_query / starchart_node to explore the graph, starchart_check for drift against the lock, and starchart_audit to compare the graph with live systems.
- starchart_apply writes to external systems and files. It defaults to a dry run. Only call it with dryRun: false and confirm: true after the user has explicitly approved the dry-run output.
```

Server name `starchart`, version `0.1.0`.

## Tools

Every tool returns text content. Failures come back as tool errors (`isError: true`) and never crash the server. STARCHART's own failures (unknown or ambiguous refs, config and build errors) start with `Error: `. Schema violations are reported by the MCP SDK, for example `MCP error -32602: Input validation error: Invalid arguments for tool starchart_impact: Invalid input: expected string, received undefined at ref`. Where a tool takes `format`, it's `"markdown"` (default) or `"json"`.

| Tool | Input | Output | Annotations |
|---|---|---|---|
| `starchart_impact` | `ref`: string (required), `format?` | Plan: markdown, or JSON as in `starchart impact -f json` | read-only |
| `starchart_plan` | `format?` | Plan of changes since `starchart.lock` | read-only |
| `starchart_diff_impact` | `base?`: string (default `"origin/main"`), `format?` | Plan for the working tree versus a git base | read-only |
| `starchart_check` | `format?` | Stale artifacts: markdown table, or `StaleArtifact[]` JSON | read-only |
| `starchart_why` | `from`: string, `to`: string (both required) | Text explanation plus the typed edge path | read-only |
| `starchart_query` | `kind?`, `layer?` (`code`\|`fact`\|`world`), `prefix?`, `text?`, `edge?`, `to?`, `limit?` (int 1–1000, default 100) | JSON `{ count, nodes: [{ id, kind, layer, label?, value? }] }` | read-only |
| `starchart_node` | `id`: string (required) | JSON `{ node, outgoing, incoming }` | read-only |
| `starchart_audit` | `ids?`: string[] | Markdown summary plus the full audit report as a JSON block | read-only, **open world** (calls external APIs) |
| `starchart_rules` | none | JSON `{ violations, errors, unknownPacks, rules }` | read-only |
| `starchart_orphans` | none | JSON `{ count, orphans }` | read-only |
| `starchart_score` | none | JSON `ScoreReport` | read-only |
| `starchart_apply` | `dryRun?`: boolean (default true), `confirm?`: boolean, `only?`: string[] | A status note plus the apply report as a JSON block | **destructive**, not idempotent, open world |

"read-only" means `readOnlyHint: true, openWorldHint: false`, except `starchart_audit`, which sets `openWorldHint: true`.

### starchart_impact

`ref` can be a node id (`addon:pro.price.usd`), a file path (absolute or relative to the project root, expanding to the file node and every symbol it contains), or a unique id suffix. A non-file ref that matches several nodes is an error that lists up to 15 candidates. An unknown ref returns:

```text
Error: no node matches "nope". Try starchart_query with text: "nope".
```

Markdown output (from the demo, `ref: "addon:pro.price.eur"`, trimmed):

```text
## 🌌 STARCHART impact of addon:pro.price.eur

**1 change:**

- `addon:pro.price.eur`

| | Class | Count |
|---|---|---:|
| ! | Manual | 1 |
| ~ | Auto-fixable | 2 |
| ? | Needs review | 2 |
| ✗ | Retire | 1 |

<details open><summary><b>! Manual</b> (1)</summary>

| Artifact | Via | Reason | Why |
|---|---|---|---|
| `appstore:iap/pro-monthly` | mirrors | update in appstore (adapter is read-only) | <code>addon:pro.price.eur --partOf--&gt; addon:pro.price --mirrors--&gt; appstore:iap/pro-monthly</code> |
…
```

### starchart_plan and starchart_diff_impact

`starchart_plan` seeds from every fact value and code hash that changed since `starchart.lock`. With no changes, the markdown says `No changes detected.` `starchart_diff_impact` seeds from `git diff <base>`, plus fact changes since the lock, exactly like the PR comment from the [GitHub Action](GitHub-Action). A `base` starting with `-` is rejected. After editing `addon:pro.price.usd` from 4.99 to 5.99:

```text
## 🌌 STARCHART plan

**2 changes:**

- `addon:pro.price` `{"usd":4.99,"eur":4.99}` → `{"usd":5.99,"eur":4.99}`
- `addon:pro.price.usd` `4.99` → `5.99`

| | Class | Count |
|---|---|---:|
| ! | Manual | 5 |
| ~ | Auto-fixable | 6 |
| ? | Needs review | 1 |
| ⌘ | Code to update | 2 |
| ✗ | Retire | 1 |
| ✓ | Tests to run | 1 |
…
```

### starchart_check

```text
## 🌌 STARCHART drift check

| Artifact | Status | Changed dependencies |
|---|---|---|
| `appstore:iap/pro-monthly` | ✗ stale | `addon:pro.price`<br>`addon:pro.price.usd` |
| `appstore:listing/description` | ✗ stale | `addon:pro.price.usd` |
…
```

When everything is in sync: `✅ All artifacts are in sync with \`starchart.lock\`.`

### starchart_why

`from` can be a node id, a unique suffix, or a file path. A file path resolves to the file node and every symbol in it; the server tries each one and explains the shortest path. `to` must resolve to **exactly one** node (an ambiguous `to` is an error listing up to 15 candidates). Both `from: "apps/ios/Sources/Core/Pricing.swift"` and `from: "symbol:ios/Pricing.proUSD"` give the same answer on the demo:

```text
stripe:price/pro-monthly is impacted by symbol:ios/Pricing.proUSD (manual: update in stripe (adapter is read-only); confidence 1).

symbol:ios/Pricing.proUSD --anchors--> addon:pro.price.usd --mirrors--> stripe:price/pro-monthly
```

With no path: `<to> does not depend on <from>: no impact path within the traversal limits.`

### starchart_query

The same filters as `starchart query`. `edge` matches nodes with an **outgoing** edge of that type, and `to` narrows it to a target id or prefix.

```json
{
  "count": 2,
  "nodes": [
    { "id": "stripe:price/pro-monthly", "kind": "artifact", "layer": "world", "label": "Stripe price — Pro monthly (USD)" },
    { "id": "appstore:iap/pro-monthly", "kind": "artifact", "layer": "world", "label": "App Store subscription — Pro monthly" }
  ]
}
```

(`kind: "artifact", edge: "mirrors"`)

### starchart_node

Returns the full node and its edges, sorted by type, then from, then to. Each edge includes `confidence` and `origin` when present.

```json
{
  "node": {
    "id": "web:og-pro",
    "kind": "artifact",
    "label": "OG image for Pro",
    "types": ["schema:ImageObject"],
    "binding": { "adapter": "fs", "path": "apps/web/public/og/pro.png" },
    "owners": ["@zero"],
    "tags": ["og"],
    "meta": { "width": 1200, "height": 630, "file": ".starchart/artifacts/web.yaml", "template": "apps/web/og/pro.svg" },
    "layer": "world"
  },
  "outgoing": [
    { "from": "web:og-pro", "to": "addon:pro.name", "type": "renders", "origin": "declared" },
    { "from": "web:og-pro", "to": "addon:pro.price.usd", "type": "renders", "origin": "declared" }
  ],
  "incoming": []
}
```

### starchart_audit

Runs the adapters' live comparison (see [Audit and Break Detection](Audit-and-Break-Detection)). The output starts with `## 🌌 STARCHART audit`, a count line (`Checked N, skipped N, N diff(s), N error(s).`) and one bullet per diff or error, followed by the full report JSON. It needs the same credentials as the CLI. Artifacts without credentials are skipped, not failed.

### starchart_rules, starchart_orphans, starchart_score

`starchart_rules` evaluates the configured packs plus your YAML rules. Unlike the CLI, it doesn't fail on invalid rules or unknown packs. It reports them:

```json
{
  "violations": [
    {
      "rule": "privacy-disclosed",
      "severity": "error",
      "node": "pkg:swift/purchases-ios",
      "message": "pkg:swift/purchases-ios collects DeviceID but PrivacyInfo.xcprivacy (apps/ios/Resources/PrivacyInfo.xcprivacy) does not declare NSPrivacyCollectedDataTypeDeviceID",
      "pack": "privacy",
      "file": "apps/ios/Resources/PrivacyInfo.xcprivacy"
    }
  ],
  "errors": [],
  "unknownPacks": [],
  "rules": 20
}
```

`rules` is the number of rules evaluated. `starchart_orphans` returns `{ "count": 7, "orphans": [ … ] }` without external listing (see [Orphans](Orphans)). `starchart_score` returns the [Reality Score](Reality-Score) report without `--audit`:

```json
{ "score": 83, "total": 12, "inSync": 10, "breakdown": { "unbound": ["privacy:appstore-label"], "stale": [], "expired": ["reel:spring-2026"], "failingAudit": [] } }
```

## Safety model: starchart_apply

`starchart_apply` is the only tool that writes. It runs the plan since the lock: `auto` steps go through adapters in rollout order, and everything else comes back as pending tasks. Two independent locks guard it.

**1. The tool itself.** Writes happen only when `dryRun === false` **and** `confirm === true`. Every other combination is a dry run:

| Arguments | Result |
|---|---|
| `{}` | Dry run. Note: `Dry run: nothing was written. Show this to the user; re-run with dryRun: false and confirm: true only after they approve.` |
| `{ dryRun: false }` | Still a dry run. Note: `Dry run only: writes require confirm: true in addition to dryRun: false, after explicit user approval.` |
| `{ confirm: true }` | Dry run (`dryRun` defaults to true). |
| `{ dryRun: false, confirm: true }` | Writes. Note: `Applied (writes executed).` |

The tool description and the server instructions both tell the agent to pass `confirm: true` only after the user has approved the dry-run output. The tool is annotated `destructiveHint: true`, so clients that ask before destructive calls will prompt.

**2. Adapter write permissions.** Even a confirmed apply only writes where the config allows it. `fs` writes by default. External adapters (`stripe`, `appstore`) are read-only unless `adapters.<id>.write: true`. Their items stay in `pending` as manual tasks. See [Adapters Overview](Adapters-Overview).

`only: [ids…]` limits the run to those artifacts. Generated constants (`// @starchart generated` symbols, class `auto`) are handled by regenerating your codegen targets once per apply; if the plan has generated constants but no codegen targets are configured, apply fails with `generated constants found but no codegen targets are configured`. Every adapter write is journaled and can be undone with `starchart revert <journal>`. Codegen output is **not** journaled, so revert leaves it alone; use git for that (see [Apply, Revert and Journals](Apply-Revert-and-Journals) and [Codegen](Codegen)).

A real dry run after changing the demo's USD price (trimmed):

````text
Dry run: nothing was written. Show this to the user; re-run with dryRun: false and confirm: true only after they approve.

```json
{
  "dryRun": true,
  "applied": [
    { "artifact": "symbol:ios/StarchartFacts.AddonPro.Price.usd", "ok": true, "changes": ["would regenerate apps/web/lib/starchart-facts.ts, apps/ios/Sources/Core/StarchartFacts.swift"] },
    { "artifact": "symbol:web/lib/starchart-facts#ADDON_PRO_PRICE_USD", "ok": true, "changes": ["would regenerate apps/web/lib/starchart-facts.ts, apps/ios/Sources/Core/StarchartFacts.swift"] },
    { "artifact": "email:onboarding-day-3", "ok": true, "changes": ["would addon:pro.price.usd: 4.99 → 5.99"] },
    { "artifact": "web:messages-en", "ok": true, "changes": ["would addon:pro.price.usd: 4.99 → 5.99"] },
    { "artifact": "web:og-pro", "ok": true, "changes": ["would render apps/web/og/pro.svg → apps/web/public/og/pro.png"] },
    { "artifact": "web:pricing-page", "ok": true, "changes": ["would addon:pro.price.usd: 4.99 → 5.99"] }
  ],
  "notRun": [],
  "pending": [
    { "id": "stripe:price/pro-monthly", "class": "manual", "reason": "update in stripe (adapter is read-only)", "why": "addon:pro.price.usd --mirrors--> stripe:price/pro-monthly" },
    { "id": "appstore:screenshots/6.9/03", "class": "manual", "reason": "value is burned into media", "why": "addon:pro.price.usd --embeds--> appstore:screenshots/6.9/03" },
    { "id": "symbol:web/lib/stripe#PRICE_PRO_MONTHLY", "class": "code", "reason": "holds this artifact's external id; update it if the id changes", "why": "addon:pro.price.usd --mirrors--> stripe:price/pro-monthly --anchors--> symbol:web/lib/stripe#PRICE_PRO_MONTHLY" },
    …
  ],
  "bindingEdits": [],
  "lockUpdated": false
}
```
````

## Example agent sessions

These sessions are illustrative. The tool results quoted are real outputs from the demo.

**Before an edit.**

> **You:** Bump Nebula Pro to $5.99.
>
> **Agent:** *(calls `starchart_impact` with `ref: "addon:pro.price.usd"`)* Changing `addon:pro.price.usd` touches 21 items. I can update the pricing page, web copy, onboarding email and OG image automatically, and regenerate the fact constants. You'll need to update the Stripe price and the App Store subscription by hand, since both adapters are read-only, and re-shoot App Store screenshot 6.9/03, which has the price burned in. `Pricing.proUSD` in the iOS app hardcodes 4.99, so I'll switch it to the generated constant. Shall I go ahead?

**After an edit.**

> **Agent:** *(edits `.starchart/entities/pro.yaml`, calls `starchart_plan`, then `starchart_apply` with no arguments)* Here's the dry run: 4 files would be updated and the generated fact constants regenerated. 5 manual tasks remain: the Stripe price, App Store IAP, App Store description, screenshot 6.9/03 and the live pricing page. Want me to apply the file updates?
>
> **You:** Yes.
>
> **Agent:** *(calls `starchart_apply` with `dryRun: false, confirm: true`)* Applied. The file writes are journaled (undo with `starchart revert <journal>`); the regenerated constants are plain git changes. `starchart_plan` keeps listing the 5 manual items, plus the review, code and retire items, until you mark them done with `starchart ack <id…>` or fix them.

**Exploring.**

> **You:** Why does the Stripe price care about `Pricing.swift`?
>
> **Agent:** *(calls `starchart_why` with `from: "apps/ios/Sources/Core/Pricing.swift", to: "stripe:price/pro-monthly"`)* `symbol:ios/Pricing.proUSD --anchors--> addon:pro.price.usd --mirrors--> stripe:price/pro-monthly`. The Swift constant hardcodes the same value the Stripe price mirrors.

Pair the server with the [Claude Code Hook](Claude-Code-Hook) so the agent sees the blast radius after every edit without having to ask.

## Testing with the in-memory client

The package exports the server factory as `createMcpServer` (it's `createServer` inside [`mcp/server.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/mcp/server.ts)). It returns an unconnected `McpServer`, so you can drive it in-process with the SDK's linked in-memory transports. This is how [`mcp/server.test.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/mcp/server.test.ts) works:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "@space-pirate-zero/starchart";

const server = createMcpServer({ root: "/path/to/project" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "test", version: "1.0.0" });
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

client.getInstructions();                                  // the instructions string above
const { tools } = await client.listTools();                // the 12 starchart_* tools
const result = await client.callTool({ name: "starchart_score", arguments: {} });
const report = JSON.parse(result.content[0].text);         // { score, total, inSync, breakdown }

const bad = await client.callTool({ name: "starchart_impact", arguments: {} });
bad.isError;                                               // true: `ref` is required

await client.close();
```

The repo's own test builds a throwaway project in a temp dir, writes a lock with `buildLock`, and asserts on tool names, markdown fragments and dry-run behavior. `INSTRUCTIONS` is only exported from `mcp/server.ts`, not the package root.

To poke the real stdio server by hand, use `StdioClientTransport` with `command: "node", args: [".../dist/mcp/bin.js"]` (or `[".../dist/cli/bin.js", "mcp"]`) and `env: { STARCHART_ROOT }`. The outputs on this page were produced that way.

## See also

- [Claude Code Hook](Claude-Code-Hook)
- [Impact Analysis](Impact-Analysis)
- [Apply, Revert and Journals](Apply-Revert-and-Journals)
- [CLI Reference](CLI-Reference)
- [Library API](Library-API)
