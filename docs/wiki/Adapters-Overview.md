Adapters are how STARCHART touches reality. The graph knows that your pricing page embeds `addon:pro.price.usd`. An adapter knows how to open that file, fetch that URL or call that API, check whether the value is really there, and (when allowed) fix it. This page covers the adapter contract, the capability model, the registry and the `canWrite` rules, adapter settings in `.starchart/config.yaml`, the `AdapterContext` every call receives, the four `Diff` kinds, and the `starchart adapters` command.

## What an adapter does

Every artifact in the world layer can carry a `binding`. The `binding.adapter` field names the adapter. The rest of the binding is adapter-specific:

```yaml
artifacts:
  - id: web:pricing-page
    binding: { adapter: fs, path: apps/web/app/pricing/page.tsx }
    embeds: [addon:pro.price.usd]

  - id: stripe:price/pro-monthly
    binding: { adapter: stripe, price: price_1NebulaPro499 }
    mirrors: [addon:pro.price.usd, addon:pro.name]
```

Three engine commands drive adapters:

| Command | Adapter method | What happens |
|---|---|---|
| `starchart audit` | `audit(node, ctx)` | Compare the artifact's real state with the facts it embeds or mirrors. Returns `Diff[]`. |
| `starchart apply` | `apply(node, ctx)` | Bring the artifact in line with current facts. Returns an `ApplyResult` with an undo record. |
| `starchart revert` | `revert(undo, ctx)` | Undo one `apply` from its journaled undo record. |
| `starchart orphans --external` | `list(ctx)` | Enumerate everything in the external system so unreferenced resources show up as orphans. |

STARCHART ships four adapters:

| Adapter | Talks to | Capabilities | Writes by default? | Page |
|---|---|---|---|---|
| `fs` | Files inside the repo | read, write, dryRun, rollback | yes | [Adapter fs](Adapter-fs) |
| `url` | Live web pages over HTTP | read | never (no `apply`) | [Adapter url](Adapter-url) |
| `stripe` | Stripe prices and products | read, write, dryRun, rollback, list | no, opt in with `write: true` | [Adapter Stripe](Adapter-Stripe) |
| `appstore` | App Store Connect listing text | read, write, dryRun, rollback | no, opt in with `write: true` | [Adapter App Store Connect](Adapter-App-Store-Connect) |

A binding that names an adapter nobody registered (the demo's `youtube` reel, for example) is skipped by `audit` with the reason `no adapter "youtube" is registered`. The planner classifies it as manual because nothing can write it.

## The Adapter interface

From [`adapters/types.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/adapters/types.ts):

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

### Capabilities

| Capability | Meaning | Who reads it |
|---|---|---|
| `read` | The adapter can `audit`. Every adapter sets this. | informational |
| `write` | The adapter implements `apply`. Required for `canWrite` to ever return true. | `canWrite`, planner |
| `dryRun` | `apply`/`revert` honor `ctx.dryRun` and report `would …` changes without touching anything. | informational (all shipped writers honor it) |
| `rollback` | `apply` returns an `UndoRecord` and `revert` can replay it. | informational |
| `watch` | Reserved. No shipped adapter sets it and nothing reads it yet. | nobody |
| `list` | `list()` enumerates the external system. `orphans --external` only calls adapters with both `capabilities.list` and a `list` function. | `orphans` |

`canApply(node)` is not a capability flag. It is an optional per-artifact check for adapters that can write some bindings but not others. The App Store adapter uses it: bindings with a `field` are writable, screenshot sets and in-app purchases are not. Leave it out and every binding of a writing adapter counts as writable.

## Registry

[`adapters/registry.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/adapters/registry.ts) keeps a module-level map of adapters by id. The four built-ins are registered on import.

```ts
export const builtinAdapters: readonly Adapter[] = [fsAdapter, urlAdapter, stripeAdapter, appstoreAdapter];

export function registerAdapter(adapter: Adapter): void;   // registers or replaces by id
export function getAdapter(id: string): Adapter | undefined;
export function listAdapters(): Adapter[];
```

`registerAdapter`, `getAdapter`, `listAdapters`, `builtinAdapters` and `canWrite` are all exported from `@space-pirate-zero/starchart`.

Custom adapters reach the CLI through `plugins` in `.starchart/config.yaml`:

```yaml
plugins:
  - ./starchart/youtube-adapter.mjs   # relative paths resolve from the project root
  - my-starchart-plugin               # bare names resolve from the project's node_modules
```

Each module exports `adapters` (an `Adapter[]`) and/or `packs`, named or on the default export. Every adapter needs an `id` and an `audit()` function. Plugins load once per process when the project is built, so `audit`, `apply`, `mcp`, `serve` and the hook all see them. A plugin adapter with the same id as a built-in replaces it. Load failures are config errors (`plugin "X" failed to load: …`, `plugin "X" not found from <root>; install it or use a relative path`, `plugin "X" exports neither "adapters" nor "packs"`). Through the [Library API](Library-API) you can also call `registerAdapter` directly. See [Writing an Adapter](Writing-an-Adapter).

## canWrite: who may touch reality

This is the safety switch. Here is the whole function:

```ts
/** Adapters that write only inside the repo; everything else touches external systems. */
const LOCAL_ADAPTERS = new Set(["fs"]);

/**
 * Whether the adapter can write. Local adapters write unless `adapters.<id>.write: false`;
 * adapters that touch external systems (Stripe, App Store, …) are opt-in via `write: true`.
 */
export function canWrite(id: string, settings?: Record<string, Record<string, unknown>>, node?: GraphNode): boolean {
  const adapter = adapters.get(id);
  if (adapter?.capabilities.write !== true || typeof adapter.apply !== "function") return false;
  if (node && adapter.canApply && !adapter.canApply(node)) return false;
  const setting = settings?.[id]?.write;
  return LOCAL_ADAPTERS.has(id) ? setting !== false : setting === true;
}
```

In plain terms:

- **`fs` writes by default.** It edits files in your repo, which git already protects. Set `adapters.fs.write: false` to make it read-only.
- **Every other adapter is read-only until you say otherwise.** Stripe, App Store Connect and any custom adapter need `adapters.<id>.write: true`. Only exactly `true` counts. `"yes"`, `1` and a missing key all mean no.
- **No `apply`, no writes.** `url` has no `apply`, so no setting can make it write.
- **Per-artifact veto.** When a node is passed and the adapter has `canApply`, a `false` answer wins over any setting. App Store screenshots and IAPs stay manual even with `write: true`.

`canWrite` feeds impact classification (see [Impact Analysis](Impact-Analysis)) through `ImpactOptions.canWrite(adapter, node?)`, so the check runs per artifact. An `embeds` or `mirrors` edge into a writable artifact is classified `auto`. The same edge into a read-only artifact is `manual`, with a reason like `update in stripe (adapter is read-only)`, or, when the adapter writes but `canApply` refuses this binding, `appstore cannot update this binding; update it by hand`. `apply` only runs `auto` steps, so a read-only adapter is never called to write.

The Stripe and App Store adapters also refuse inside `apply` when `write: false` is set explicitly. That is a second lock behind `canWrite`.

## Adapter settings in config

Everything under `adapters.<id>` in `.starchart/config.yaml` is passed to that adapter as `ctx.settings`. The project's `site` is merged in for every adapter, so the url adapter can resolve relative URLs.

```yaml
# .starchart/config.yaml
site: https://nebula.example.com
adapters:
  fs: {}                          # writes by default; add write: false to stop that
  stripe:
    secretEnv: STRIPE_SECRET_KEY  # env var holding the key (this is the default)
    write: true                   # opt in to live Stripe writes
  appstore:
    keyId: ABC123DEFG
    issuerId: 00000000-0000-0000-0000-000000000000
    keyPath: secrets/AuthKey_ABC123DEFG.p8
```

The schema is `record<string, record<string, unknown>>`: STARCHART does not validate adapter settings. Each adapter reads the keys it knows and ignores the rest.

> **Heads-up: no `${ENV}` interpolation.** The config loader does not expand environment variables. `keyId: ${ASC_KEY_ID}` passes the literal string `${ASC_KEY_ID}` to the adapter, and because settings win over env vars, the real `ASC_KEY_ID` is ignored. Leave the key out of config and let the adapter read the environment instead.

| Setting | Adapter | Meaning |
|---|---|---|
| `write` | all | `false` disables fs writes; `true` enables external writes |
| `site` (top-level config) | url, merged into every adapter's settings | Base URL for relative `url` bindings |
| `secretEnv` | stripe | Env var name for the secret key (default `STRIPE_SECRET_KEY`) |
| `keyId`, `issuerId`, `keyPath` | appstore | App Store Connect API key (env fallbacks `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY_PATH`) |

## AdapterContext

Every adapter call receives a fresh context built by `adapterContext()` in [`engine/context.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/engine/context.ts):

```ts
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
```

| Field | Source | Why it matters |
|---|---|---|
| `root` | project root (the directory holding `.starchart/`) | fs resolves paths here and refuses anything outside it |
| `graph` | the built project graph | adapters walk `embeds` / `mirrors` / `renders` edges to find the facts an artifact carries |
| `settings` | `{ site, ...adapters[id] }` | per-adapter config |
| `env` | `process.env` (injectable) | credentials |
| `fetch` | `globalThis.fetch` (injectable) | every HTTP call goes through here, which is how tests mock Stripe and Apple |
| `previousValues` | `starchart.lock` → `facts[id].value` | **what the world should currently show**. Text adapters need the old value to find and replace it, and audit uses it to tell "stale" from "missing" |
| `dryRun` | `--dry-run` | writers must describe, not do |

`previousValues` is why the lock matters so much. After you change `usd: 4.99` to `5.99`, the lock still says `4.99`. That old value is what fs searches for in your files. See [Lockfile and Drift](Lockfile-and-Drift).

## Diff kinds

`audit` returns zero or more `Diff` objects:

```ts
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
```

| Kind | Meaning | Typical sources |
|---|---|---|
| `stale` | An old value from the lock is still present. The artifact was never updated. | fs, url, appstore text: `still shows old value 4.99; expected 5.99` |
| `missing` | The current value is absent, or the thing itself is gone. | text doesn't contain the value; file not found; rendered output not found; JSON path not found |
| `mismatch` | A structured value differs from the fact, or a render is out of date. | Stripe `unit_amount`, currency or product name; fs template output differs from a fresh render |
| `break` | The world is incompatible with the chart. Something will fail for users. | archived or deleted Stripe price/product; a url artifact answering 404 or 410; a template that fails to render; code pointing at a dead price id |

The CLI prints `✗ break`, `! stale`, and `? missing` / `? mismatch`. An adapter that throws (network down, HTTP 500, bad binding) is not a diff: the artifact lands under **errors**. Any diff or error makes `audit` exit 1. See [Audit and Break Detection](Audit-and-Break-Detection).

## ApplyResult, UndoRecord, ListedResource

```ts
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
```

The engine journals every `undo` it gets (see [Apply, Revert and Journals](Apply-Revert-and-Journals)) and rewrites YAML for every `bindingUpdate`.

## Missing credentials skip, they don't fail

External adapters throw `MissingCredentialsError` when a key isn't configured. `audit` catches it and lists the artifact under **skipped**, not **errors**, so a laptop without a Stripe key still gets a useful audit. `MissingCredentialsError` (from `adapters/errors.ts`) is exported from `@space-pirate-zero/starchart`, so custom adapters can throw it too: `new MissingCredentialsError("myadapter", "MY_API_KEY is not set")`. Anything else they throw lands under errors.

## `starchart adapters`

Lists every registered adapter, whether it may write under the current config, and its capabilities. From the demo (`examples/pro-universe`, whose config has `fs: {}` and a `stripe` block without `write`):

```text
fs         writes  read, write, dryRun, rollback
url        read-only  read
stripe     read-only  read, write, dryRun, rollback, list
appstore   read-only  read, write, dryRun, rollback
```

`stripe` and `appstore` are *capable* of writing (`write` is in their capabilities) but are `read-only` because the config does not opt them in. Add `write: true` under `adapters.stripe` and the line flips to `writes`.

## See also

- [Adapter fs](Adapter-fs)
- [Writing an Adapter](Writing-an-Adapter)
- [Audit and Break Detection](Audit-and-Break-Detection)
- [Apply, Revert and Journals](Apply-Revert-and-Journals)
- [Configuration](Configuration)
