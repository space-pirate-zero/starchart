Your truth lives somewhere STARCHART doesn't speak yet: a headless CMS, a feature-flag service, a pricing API, a spreadsheet. An adapter teaches it. This page walks through the `Adapter` interface (real types, pasted from the source), loading it into the CLI with `plugins:`, the text helpers the built-in adapters share, what to return from `audit` / `apply` / `revert` / `list` / `canApply`, testing with an injected `fetch`, a small `jsonfile` plugin that was run through `starchart adapters`, `audit`, `plan`, `apply` and `revert` on a copy of the demo, and a complete `cms` adapter in TypeScript.

The examples write `starchart <cmd>`. `@spz/starchart` isn't on npm yet, so build it from source (`git clone https://github.com/space-pirate-zero/starchart.git && cd starchart && pnpm install && pnpm build`) and alias `starchart` to `node /path/to/starchart/packages/starchart/dist/cli/bin.js`. Once it's published, `npx @spz/starchart <cmd>` does the same.

## Two ways to ship an adapter

| | Plugin (your repo) | In tree (a PR to STARCHART) |
|---|---|---|
| Where | A JavaScript module that exports `adapters` | `packages/starchart/src/adapters/<id>.ts`, added to `builtinAdapters` in `registry.ts` |
| Registration | list it under `plugins:` in `.starchart/config.yaml`, or call `registerAdapter(myAdapter)` from the [Library API](Library-API) | automatic on import |
| Works with the `starchart` CLI | yes, and with the [MCP Server](MCP-Server), `serve` and the [Claude Code Hook](Claude-Code-Hook): plugins load inside `buildProject` | yes |
| Text helpers (`leafFacts`, `auditText`, `findValue`, `planReplacements`, `applyReplacements`) | import from `@spz/starchart` | import from `./text.js` |
| `MissingCredentialsError` (skip, don't fail) | import from `@spz/starchart` | import from `./errors.js` |

If your system is common enough (Play Store, RevenueCat, PostHog, YouTube and Figma are all on the [Roadmap](Roadmap)), an in-tree PR helps everyone. See [Contributing](Contributing).

## Plugins

A plugin is an ES module listed under `plugins:` in `.starchart/config.yaml` (source: [`plugins.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/plugins.ts)):

```yaml
# .starchart/config.yaml
plugins: [./plugins/example.mjs, starchart-plugin-cms]
```

- A path starting with `.` (or an absolute path) resolves from the project root. A bare name resolves from the project's `node_modules`, as `require.resolve` would from `<root>/package.json`.
- The module exports `adapters` (an `Adapter[]`) and/or `packs` (a `RulePack[]`), as named exports or on the default export. The default export is only read when there is neither a named `adapters` nor `packs`.
- The loader uses plain `import()`, so ship JavaScript. Compile TypeScript first.
- Each module is loaded once per process. Its adapters go through `registerAdapter` (a plugin adapter **can** replace a built-in id) and its packs through `registerPack` (a built-in pack id **can't** be replaced).
- Plugin packs only run when their id is also listed in `packs:`. See [Rule Packs](Rule-Packs#writing-a-pack).

Every loading problem stops the command with exit code 2:

| Problem | Message |
|---|---|
| bare name not installed | `plugin "starchart-plugin-cms" not found from /path/to/project; install it or use a relative path` |
| module throws or doesn't parse | `plugin "./plugins/x.mjs" failed to load: <error>` |
| no `adapters` and no `packs` | `plugin "./plugins/empty.mjs" exports neither "adapters" nor "packs"` |
| `adapters` or `packs` isn't an array | `plugin "…": "adapters" must be an array` |
| an adapter without `id` or `audit()` | `plugin "…": every adapter needs an id and an audit() function` |
| a pack without `id` or a `rules` array | `plugin "…": every pack needs an id and a rules array` |
| a pack reusing `core`, `appstore`, `privacy` or `seo` | `rule pack "core" is built in and cannot be replaced` |

The not-found, neither-export and built-in-pack messages came from real runs (project path trimmed). The others are quoted from `plugins.ts`.

## The interface

From [`adapters/types.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/adapters/types.ts), exported from `@spz/starchart`:

```ts
export interface AdapterCapabilities {
  read: boolean;
  write?: boolean;
  dryRun?: boolean;
  rollback?: boolean;
  watch?: boolean;
  /** Can enumerate everything in the external system (for orphan detection). */
  list?: boolean;
}

export interface AdapterContext {
  root: string;
  graph: Graph;
  /** Adapter settings from `.starchart/config.yaml` → adapters.<id>. */
  settings: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  /** Previous fact values from the lock, keyed by fact id (needed to find-and-replace). */
  previousValues: Record<string, unknown>;
  dryRun: boolean;
}

/** One observed mismatch between the graph and the real world. */
export interface Diff {
  artifact: string;
  fact?: string;
  field?: string;
  expected?: unknown;
  actual?: unknown;
  /** "stale": an old value is still present; "missing": the expected value is absent; "break": world state is incompatible. */
  kind: "stale" | "missing" | "mismatch" | "break";
  message: string;
  /** Location detail (file:line, URL, API path). */
  where?: string;
}

export interface ApplyResult {
  artifact: string;
  ok: boolean;
  changes: string[];
  /** Serializable undo record for `starchart revert`. */
  undo?: UndoRecord;
  error?: string;
  /**
   * Binding fields that changed in the external system (e.g. Stripe issued a new immutable price
   * id). The engine rewrites them in the artifact's YAML source.
   */
  bindingUpdate?: Record<string, unknown>;
}

export interface UndoRecord {
  adapter: string;
  artifact: string;
  data: Record<string, unknown>;
}

export interface ListedResource {
  /** Stable external id, e.g. a Stripe price id. */
  externalId: string;
  label: string;
  /** Binding that would refer to this resource. */
  binding: Binding;
  active: boolean;
}

export interface Adapter {
  id: string;
  capabilities: AdapterCapabilities;
  /** Compares the artifact's real-world state with the facts it embeds/mirrors. */
  audit(node: GraphNode, ctx: AdapterContext): Promise<Diff[]>;
  /** Brings the artifact in line with current facts. Required when capabilities.write. */
  apply?(node: GraphNode, ctx: AdapterContext): Promise<ApplyResult>;
  revert?(undo: UndoRecord, ctx: AdapterContext): Promise<ApplyResult>;
  /**
   * Whether `apply` supports this particular artifact. Adapters that write some bindings but not
   * others (App Store text fields vs. screenshots) return false so the plan marks them manual.
   */
  canApply?(node: GraphNode): boolean;
  list?(ctx: AdapterContext): Promise<ListedResource[]>;
}
```

`GraphNode`, `Graph` and `Binding` are exported too. A binding is `{ adapter: string; [key: string]: unknown }`: every other field is yours to define.

## The contract, method by method

### audit(node, ctx) → Diff[]

- Find the facts the artifact carries by walking its outgoing edges: `ctx.graph.outgoing(node.id, "mirrors")`, `"embeds"`, `"renders"`. Container facts have children pointing at them with `partOf` edges. The built-ins expand containers to leaves.
- Compare with reality. Return `[]` when in sync.
- Use `ctx.previousValues[factId]` (the lock's value) to tell `stale` (the old value is still there) from `mismatch` / `missing` (something else is there, or nothing).
- Return `break` when the world is incompatible (the resource is gone, archived, or answering errors).
- **Throw** for misconfiguration and unexpected API failures. The engine catches it and lists it under `errors`. Throw `MissingCredentialsError` (`new MissingCredentialsError("cms", "set CMS_TOKEN")`) for a missing key and audit *skips* the artifact instead, like the built-ins do. The engine checks it with `instanceof`, so import it from the same `@spz/starchart` copy the CLI runs from.
- Never write in `audit`. It runs in CI, in the [MCP Server](MCP-Server), in [Reality Score](Reality-Score) with `--audit`.

Audit runs 4 artifacts at a time, so audits must be safe to run concurrently.

### apply(node, ctx) → ApplyResult

- Recompute what needs to change. Don't trust anything cached from audit.
- Nothing to do: `{ ok: true, changes: [] }`.
- `ctx.dryRun`: make read calls if you need them, describe the plan as `would …` changes, write nothing, return no `undo`.
- On success: `ok: true`, human-readable `changes`, and an `undo` record with **everything `revert` needs**. It's serialized to JSON in the journal, so plain data only.
- If the external system hands back a new identifier (Stripe's immutable prices), return `bindingUpdate: { field: newValue }`. The engine replaces the old string value with the new one, as a whole identifier token, in the artifact's YAML file, and journals the edit.
- On failure: `ok: false` with `error`. If you already changed something before failing, still return `undo` (and `bindingUpdate`) for the part that happened. The engine journals it so the user can revert.
- A thrown error is converted to `{ ok: false, error }` by the engine, but you lose the partial undo. Prefer returning.
- `apply` stops at the first failed step, so be precise about `ok`.

### revert(undo, ctx) → ApplyResult

- Validate `undo.data` (it came from a JSON file) and fail cleanly on garbage.
- Honor `ctx.dryRun`.
- Returning `bindingUpdate` is allowed but unused: the engine restores YAML bindings from the journal's `bindingEdits`.

### list(ctx) → ListedResource[]

Set `capabilities.list: true` and implement `list` to take part in `starchart orphans --external`. Return every **active** resource with a `binding` shaped the way an artifact would bind it. A resource counts as referenced if some artifact with the same adapter has a binding value equal to `externalId`, or has all of the listed binding's non-`adapter` fields, or if a code constant's value equals `externalId`. Everything else is reported as `external-unreferenced`. See [Orphans](Orphans).

### canApply(node) → boolean

Optional. Return `false` for artifacts your `apply` can't handle, and they plan as `manual` instead of `auto`, so `apply` never calls you for them. The App Store adapter uses it: only bindings with a `field` (and no `set` or `product`) are writable, so screenshots and in-app purchases stay manual even with `write: true`. Leave it out and every artifact bound to your adapter counts as writable.

### Capabilities and canWrite

Set `write: true` only if you implement `apply`. `canWrite(id, settings, node?)` requires both, then asks `canApply(node)` when a node is given. Every adapter except `fs` is treated as external, so users must opt in with `adapters.<id>.write: true`. Until they do, your artifacts plan as `manual` and `apply` never calls you. That's the point. Impact classification gets the same answer through `ImpactOptions.canWrite(adapter, node?)`.

Rollout order uses `ADAPTER_PRIORITY` in [`core/order.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/core/order.ts): `stripe` 10, `revenuecat` 20, `appstore`/`playstore` 30, code 40, `fs` 50, `url`/`cms` 60, `email` 70, `youtube`/`tiktok` 80. Unknown adapter ids get 55. Pick an id from that table if it fits. See [Rollout Ordering](Rollout-Ordering).

## Text helpers

Adapters that hold free text (web pages, store listings, CMS rich text) should use the helpers in [`adapters/text.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/adapters/text.ts) so matching behaves exactly like fs, url and appstore. Five of them are exported from `@spz/starchart`:

| Helper | Does |
|---|---|
| `leafFacts(graph, artifactId, edgeTypes = ["embeds"]): LeafFact[]` | Leaf facts (`{ id, value }`) reached through those edges, containers expanded |
| `auditText({ artifact, text, facts, previous, regions?, where, whereMissing?, field? }): Diff[]` | The standard stale/missing check |
| `findValue(text, value, regions?)` | First whole-token match of any text form of `value` (`{ start, end, text }`), or `undefined` |
| `planReplacements(facts, previous): ReplacementPlan` | Old → new substitutions, plus `ambiguous` and `unplaced` lists you must refuse on |
| `applyReplacements(text, replacements, regions?)` | Single-pass replacement preserving two-decimal style → `{ text, count, byFact }` |

`findToken`, `tokenPattern`, `textForms` and `lineOf` exist too, but only in-tree: they aren't exported from the package root.

```js
import { auditText, leafFacts } from "@spz/starchart";

// inside your adapter object
async audit(node, ctx) {
  const text = await fetchPageText(node, ctx);   // your code
  return auditText({
    artifact: node.id,
    text,
    facts: leafFacts(ctx.graph, node.id, ["embeds", "mirrors"]),
    previous: ctx.previousValues,
    where: () => node.binding.url,
  });
}
```

The App Store adapter is the best template for a text adapter: about 40 lines between `audit` and `apply`. Rules are on [Adapter fs](Adapter-fs#text-matching-rules).

## A tested plugin: `jsonfile`

This plugin mirrors a fact into a key of a JSON file in the repo, and ships a one-rule pack alongside. It has no imports from `@spz/starchart`, so it runs from a bare copy of the demo. Everything below was run on a temp copy of `examples/pro-universe`.

```js
// plugins/example.mjs: a `jsonfile` adapter and a `house` rule pack.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// binding: { adapter: jsonfile, path: data/pricing.json, key: pro.usd }
const get = (obj, key) => key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
const set = (obj, key, value) => {
  const parts = key.split(".");
  const last = parts.pop();
  let o = obj;
  for (const k of parts) o = o[k] ??= {};
  o[last] = value;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function target(node, ctx) {
  const { path, key } = node.binding ?? {};
  if (typeof path !== "string") throw new Error(`${node.id}: jsonfile binding needs "path"`);
  const edge = ctx.graph.outgoing(node.id, "mirrors")[0];
  const fact = edge ? ctx.graph.node(edge.to) : undefined;
  return { file: join(ctx.root, path), path, key, fact };
}

const jsonfile = {
  id: "jsonfile",
  capabilities: { read: true, write: true, dryRun: true, rollback: true },

  async audit(node, ctx) {
    const { file, path, key, fact } = target(node, ctx);
    if (!fact || typeof key !== "string") return [];
    const actual = get(JSON.parse(await readFile(file, "utf8")), key);
    if (same(actual, fact.value)) return [];
    const stale = fact.id in ctx.previousValues && same(actual, ctx.previousValues[fact.id]);
    return [{
      artifact: node.id, fact: fact.id, field: key, expected: fact.value, actual,
      kind: stale ? "stale" : "mismatch",
      message: `${key} is ${JSON.stringify(actual)}, fact says ${JSON.stringify(fact.value)}`,
      where: `${path}#${key}`,
    }];
  },

  // Only bindings that name a key can be written; the rest plan as manual.
  canApply: (node) => typeof node.binding?.key === "string",

  async apply(node, ctx) {
    const { file, path, key, fact } = target(node, ctx);
    const doc = JSON.parse(await readFile(file, "utf8"));
    const before = get(doc, key);
    if (!fact || same(before, fact.value)) return { artifact: node.id, ok: true, changes: [] };
    const change = `${path}#${key}: ${JSON.stringify(before)} → ${JSON.stringify(fact.value)}`;
    if (ctx.dryRun) return { artifact: node.id, ok: true, changes: [`would set ${change}`] };
    set(doc, key, fact.value);
    await writeFile(file, JSON.stringify(doc, null, 2) + "\n");
    return { artifact: node.id, ok: true, changes: [`set ${change}`], undo: { adapter: "jsonfile", artifact: node.id, data: { path, key, before } } };
  },

  async revert(undo, ctx) {
    const { path, key, before } = undo.data;
    if (typeof path !== "string" || typeof key !== "string") return { artifact: undo.artifact, ok: false, changes: [], error: "malformed jsonfile undo record" };
    if (ctx.dryRun) return { artifact: undo.artifact, ok: true, changes: [`would restore ${path}#${key}`] };
    const file = join(ctx.root, path);
    const doc = JSON.parse(await readFile(file, "utf8"));
    set(doc, key, before);
    await writeFile(file, JSON.stringify(doc, null, 2) + "\n");
    return { artifact: undo.artifact, ok: true, changes: [`restored ${path}#${key}`] };
  },
};

const house = {
  id: "house",
  description: "House conventions",
  rules: [
    {
      id: "house-json-owned",
      pack: "house",
      severity: "warn",
      check(graph) {
        return graph
          .nodes({ kind: "artifact" })
          .filter((n) => n.binding?.adapter === "jsonfile" && !n.owners?.length)
          .map((n) => ({ node: n.id, message: `${n.id} has no owners` }));
      },
    },
  ],
};

export const adapters = [jsonfile];
export const packs = [house];
```

Wire it up. `data/pricing.json` holds `{ "pro": { "usd": 4.99 } }`:

```yaml
# .starchart/config.yaml (additions to the demo's config)
adapters:
  jsonfile:
    write: true            # not fs, so it's external: opt in or it plans as manual
packs: [core, appstore, privacy, seo, house]
plugins: [./plugins/example.mjs]
```

```yaml
# .starchart/artifacts/json.yaml
artifacts:
  - id: json:pricing-pro
    label: Pricing feed for partners
    binding: { adapter: jsonfile, path: data/pricing.json, key: pro.usd }
    mirrors: [addon:pro.price.usd]
```

The CLI now knows the adapter and the pack:

```text
$ starchart adapters
fs         writes  read, write, dryRun, rollback
url        read-only  read
stripe     read-only  read, write, dryRun, rollback, list
appstore   read-only  read, write, dryRun, rollback
jsonfile   writes  read, write, dryRun, rollback

$ starchart rules
…
warn  artifact-bound  privacy:appstore-label has no binding  (.starchart/artifacts/marketing.yaml)
warn  house-json-owned  json:pricing-pro has no owners  (.starchart/artifacts/json.yaml)
…
info  owners  json:pricing-pro has no owners  (.starchart/artifacts/json.yaml)
9 error · 3 warn · 5 info
```

After `starchart lock`, bump `addon:pro.price.usd` from 4.99 to 5.99 and drive the change:

```text
$ starchart audit --ids json:pricing-pro
! stale  json:pricing-pro data/pricing.json#pro.usd  pro.usd is 4.99, fact says 5.99
1 checked · 1 diff(s) · 0 error(s) · 0 skipped

$ starchart plan
…
  ~ auto    json:pricing-pro                                    mirrors    sync via jsonfile
…

$ starchart apply --dry-run --only json:pricing-pro
✓ json:pricing-pro [jsonfile] would set data/pricing.json#pro.usd: 4.99 → 5.99

$ starchart apply --yes --only json:pricing-pro
✓ json:pricing-pro [jsonfile] set data/pricing.json#pro.usd: 4.99 → 5.99
journal: .starchart/journal/2026-09-29T23-20-47-859Z-2b6e9b.json (undo with: starchart revert .starchart/journal/2026-09-29T23-20-47-859Z-2b6e9b.json)

$ starchart audit --ids json:pricing-pro
1 checked · 0 diff(s) · 0 error(s) · 0 skipped
```

`starchart revert <journal>` finds the plugin adapter too, and restored the file to 4.99 (`"changes": ["restored data/pricing.json#pro.usd"]`, `"lockRestored": true`).

`canApply` in action: a second artifact bound without a `key` plans as manual even though `jsonfile` has `write: true`, and the reason says the adapter can't update that binding:

```yaml
  - id: json:pricing-snapshot
    label: Whole-file pricing snapshot (no key)
    binding: { adapter: jsonfile, path: data/pricing.json }
    mirrors: [addon:pro.price.usd]
```

```text
$ starchart plan | grep json
  ! manual  json:pricing-snapshot                               mirrors    jsonfile cannot update this binding; update it by hand
  ~ auto    json:pricing-pro                                    mirrors    sync via jsonfile
```

## A complete example: `cms`

A bigger example, in TypeScript. A headless CMS stores one JSON field per entry. The adapter mirrors a single fact into that field. It audits, applies with a dry run, reverts, and lists entries for orphan detection. It compiles with `strict` and `noUncheckedIndexedAccess` against `@spz/starchart` 0.1.0.

```ts
import type { Adapter, AdapterContext, ApplyResult, Diff, GraphNode, ListedResource, UndoRecord } from "@spz/starchart";

/**
 * cms: a headless CMS that stores one JSON field per entry.
 *
 * binding: { adapter: cms, entry: "pricing-pro", field: "price" }
 * settings (adapters.cms): { baseUrl: "https://cms.example.com/api", tokenEnv?: "CMS_TOKEN", write?: true }
 */

interface Entry {
  id: string;
  title: string;
  fields: Record<string, unknown>;
}

function config(ctx: AdapterContext): { baseUrl: string; token: string } {
  const baseUrl = typeof ctx.settings.baseUrl === "string" ? ctx.settings.baseUrl.replace(/\/+$/, "") : "";
  if (!baseUrl) throw new Error('cms adapter needs "baseUrl" in adapters.cms');
  const tokenEnv = typeof ctx.settings.tokenEnv === "string" ? ctx.settings.tokenEnv : "CMS_TOKEN";
  const token = ctx.env[tokenEnv];
  if (!token) throw new Error(`cms token not found: set ${tokenEnv}`);
  return { baseUrl, token };
}

function bindingOf(node: GraphNode): { entry: string; field: string } {
  const entry = node.binding?.entry;
  const field = node.binding?.field;
  if (typeof entry !== "string" || typeof field !== "string") throw new Error(`${node.id}: cms binding needs "entry" and "field"`);
  return { entry, field };
}

/** The single fact this artifact mirrors. */
function mirroredFact(node: GraphNode, ctx: AdapterContext): { id: string; value: unknown } | undefined {
  const edge = ctx.graph.outgoing(node.id, "mirrors")[0];
  const fact = edge ? ctx.graph.node(edge.to) : undefined;
  return fact && fact.kind === "fact" ? { id: fact.id, value: fact.value } : undefined;
}

async function call<T>(ctx: AdapterContext, method: "GET" | "PATCH", path: string, body?: unknown): Promise<T> {
  const { baseUrl, token } = config(ctx);
  const res = await ctx.fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`cms ${method} ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const cmsAdapter: Adapter = {
  id: "cms",
  capabilities: { read: true, write: true, dryRun: true, rollback: true, list: true },

  async audit(node, ctx): Promise<Diff[]> {
    const { entry, field } = bindingOf(node);
    const fact = mirroredFact(node, ctx);
    if (!fact) return [];
    config(ctx); // misconfiguration throws: reported under "errors", not as a diff
    const where = `cms:${entry}/${field}`;
    let doc: Entry;
    try {
      doc = await call<Entry>(ctx, "GET", `/entries/${encodeURIComponent(entry)}`);
    } catch (e) {
      return [{ artifact: node.id, kind: "break", message: (e as Error).message, where }];
    }
    const actual = doc.fields[field];
    if (same(actual, fact.value)) return [];
    const previous = ctx.previousValues[fact.id];
    return [
      {
        artifact: node.id,
        fact: fact.id,
        field,
        expected: fact.value,
        actual,
        kind: previous !== undefined && same(actual, previous) ? "stale" : "mismatch",
        message: `CMS has ${JSON.stringify(actual)}, fact says ${JSON.stringify(fact.value)}`,
        where,
      },
    ];
  },

  async apply(node, ctx): Promise<ApplyResult> {
    const { entry, field } = bindingOf(node);
    const fact = mirroredFact(node, ctx);
    if (!fact) return { artifact: node.id, ok: true, changes: [] };
    const doc = await call<Entry>(ctx, "GET", `/entries/${encodeURIComponent(entry)}`);
    const before = doc.fields[field];
    if (same(before, fact.value)) return { artifact: node.id, ok: true, changes: [] };
    const change = `${entry}.${field}: ${JSON.stringify(before)} → ${JSON.stringify(fact.value)}`;
    if (ctx.dryRun) return { artifact: node.id, ok: true, changes: [`would set ${change}`] };
    await call(ctx, "PATCH", `/entries/${encodeURIComponent(entry)}`, { fields: { [field]: fact.value } });
    const undo: UndoRecord = { adapter: "cms", artifact: node.id, data: { entry, field, before } };
    return { artifact: node.id, ok: true, changes: [`set ${change}`], undo };
  },

  async revert(undo, ctx): Promise<ApplyResult> {
    const { entry, field, before } = undo.data;
    if (typeof entry !== "string" || typeof field !== "string") {
      return { artifact: undo.artifact, ok: false, changes: [], error: "malformed cms undo record" };
    }
    if (ctx.dryRun) return { artifact: undo.artifact, ok: true, changes: [`would restore ${entry}.${field}`] };
    await call(ctx, "PATCH", `/entries/${encodeURIComponent(entry)}`, { fields: { [field]: before } });
    return { artifact: undo.artifact, ok: true, changes: [`restored ${entry}.${field}`] };
  },

  async list(ctx): Promise<ListedResource[]> {
    const entries = await call<Entry[]>(ctx, "GET", "/entries");
    return entries.flatMap((e) =>
      Object.keys(e.fields).map((field) => ({
        externalId: `${e.id}/${field}`,
        label: `${e.title} · ${field}`,
        binding: { adapter: "cms", entry: e.id, field },
        active: true,
      })),
    );
  },
};
```

### Bind an artifact to it

```yaml
# .starchart/artifacts/cms.yaml
artifacts:
  - id: cms:pricing-pro
    label: CMS pricing entry for Pro
    binding: { adapter: cms, entry: pricing-pro, field: price }
    mirrors: [addon:pro.price.usd]
```

```yaml
# .starchart/config.yaml
adapters:
  cms:
    baseUrl: https://cms.example.com/api
    write: true        # external adapter: opt in, or it plans as manual
```

### Load it from the CLI

Compile `cms-adapter.ts` to JavaScript, then export it from a plugin module:

```js
// plugins/cms.mjs
import { cmsAdapter } from "../dist/cms-adapter.js";
export const adapters = [cmsAdapter];
```

```yaml
# .starchart/config.yaml
plugins: [./plugins/cms.mjs]
```

`starchart audit`, `plan`, `apply` and `revert` then treat `cms` like a built-in, exactly as the `jsonfile` run above shows. Set `CMS_TOKEN` in the environment. Without it `config()` throws and the artifact lands under audit `errors`. Swap that `throw new Error` for `throw new MissingCredentialsError("cms", …)` if you'd rather have it skipped.

### Or drive it from the library

Scripts and tests can skip the config and register the adapter directly:

```ts
import { applyPlan, auditProject, buildProject, planFromLock, registerAdapter } from "@spz/starchart";
import { cmsAdapter } from "./cms-adapter.js";

registerAdapter(cmsAdapter);

const project = await buildProject(process.cwd());
const report = await auditProject(project, { ids: ["cms:pricing-pro"] });
console.log(report.diffs);

const result = await applyPlan(project, planFromLock(project), { only: ["cms:pricing-pro"] });
console.log(result.applied, result.journal);
```

Against a copy of the demo with `usd` bumped to 5.99 and the CMS simulated by an injected `fetch` (next section), that prints:

```text
[
  {
    artifact: 'cms:pricing-pro',
    fact: 'addon:pro.price.usd',
    field: 'price',
    expected: 5.99,
    actual: 4.99,
    kind: 'stale',
    message: 'CMS has 4.99, fact says 5.99',
    where: 'cms:pricing-pro/price'
  }
]
[
  {
    artifact: 'cms:pricing-pro',
    ok: true,
    changes: [ 'set pricing-pro.price: 4.99 → 5.99' ],
    undo: { adapter: 'cms', artifact: 'cms:pricing-pro', data: [Object] }
  }
] .starchart/journal/2026-09-29T22-58-17-987Z-fa17a7.json
```

That journal names adapter `cms`, so whatever reverts it needs `cms` registered: the plain CLI with the plugin configured, or `revertJournal(project, journalId)` after `registerAdapter`. Without either, revert reports `adapter "cms" cannot revert`.

## Testing with an injected fetch

Every HTTP call goes through `ctx.fetch`, and `auditProject` / `applyPlan` / `revertJournal` accept `{ fetch, env }`. No network, no real keys. This is how the Stripe and App Store suites work (see [`stripe.test.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/adapters/stripe.test.ts)).

Unit-test the adapter with a hand-built graph:

```ts
import { Graph, canWrite, registerAdapter, type AdapterContext } from "@spz/starchart";
import { cmsAdapter } from "./cms-adapter.js";

registerAdapter(cmsAdapter);

const graph = new Graph();
graph.addNode({ id: "addon:pro.price.usd", kind: "fact", value: 5.99 });
graph.addNode({ id: "cms:pricing-pro", kind: "artifact", binding: { adapter: "cms", entry: "pricing-pro", field: "price" } });
graph.addEdge({ from: "cms:pricing-pro", to: "addon:pro.price.usd", type: "mirrors" });

let stored: Record<string, unknown> = { price: 4.99 };
const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
  if (init?.method === "PATCH") stored = { ...stored, ...(JSON.parse(String(init.body)) as { fields: Record<string, unknown> }).fields };
  return new Response(JSON.stringify({ id: "pricing-pro", title: "Pro pricing", fields: stored }), { status: 200 });
}) as typeof fetch;

const ctx = (dryRun = false): AdapterContext => ({
  root: process.cwd(),
  graph,
  settings: { baseUrl: "https://cms.example.com/api", write: true },
  env: { CMS_TOKEN: "test-token" },
  fetch: fakeFetch,
  previousValues: { "addon:pro.price.usd": 4.99 },
  dryRun,
});

const node = graph.node("cms:pricing-pro")!;
console.log(canWrite("cms", { cms: { write: true } }), canWrite("cms", {}));   // true false
console.log(await cmsAdapter.audit(node, ctx()));                               // [{ kind: "stale", … }]
console.log(await cmsAdapter.apply!(node, ctx(true)));                          // would set …, nothing written
const applied = await cmsAdapter.apply!(node, ctx());                           // stored.price → 5.99
console.log(await cmsAdapter.audit(node, ctx()));                               // []
await cmsAdapter.revert!(applied.undo!, ctx());                                 // stored.price → 4.99
```

Real output (the snippet compiles under `tsc --strict` and runs with `tsx`):

```text
true false
[
  {
    artifact: 'cms:pricing-pro',
    fact: 'addon:pro.price.usd',
    field: 'price',
    expected: 5.99,
    actual: 4.99,
    kind: 'stale',
    message: 'CMS has 4.99, fact says 5.99',
    where: 'cms:pricing-pro/price'
  }
]
{
  artifact: 'cms:pricing-pro',
  ok: true,
  changes: [ 'would set pricing-pro.price: 4.99 → 5.99' ]
}
[]
```

Things worth a test in any adapter:

- in sync → `[]`
- old value present → `stale`; something else → `mismatch`; resource gone → `break`
- missing config → throws
- `dryRun` makes no write calls (assert on the recorded requests)
- apply → audit is clean → revert restores the original
- partial failure returns `ok: false` **with** `undo`
- `list` pagination, if your API pages

## Checklist

- [ ] `id` is short, lowercase and unique. Reusing a built-in adapter id replaces the built-in (packs can't do that).
- [ ] Artifacts `apply` can't handle return `false` from `canApply`.
- [ ] Shipped as JavaScript if it's loaded through `plugins:`.
- [ ] `audit` never writes and is safe to run 4-wide.
- [ ] `apply` is idempotent: a second run reports no changes.
- [ ] `dryRun` is honored in `apply` and `revert`.
- [ ] `undo.data` is plain JSON and sufficient on its own.
- [ ] Secrets come from `ctx.env`, never from the journal or `changes`.
- [ ] All HTTP goes through `ctx.fetch`.
- [ ] `write: true` in capabilities only if `apply` exists.

## See also

- [Adapters Overview](Adapters-Overview)
- [Library API](Library-API)
- [Apply, Revert and Journals](Apply-Revert-and-Journals)
- [Orphans](Orphans)
- [Contributing](Contributing)
