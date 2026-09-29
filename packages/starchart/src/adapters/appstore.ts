import { createPrivateKey, sign as cryptoSign, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { GraphNode } from "../core/model.js";
import { MissingCredentialsError } from "./errors.js";
import { applyReplacements, auditText, leafFacts, planReplacements } from "./text.js";
import type { Adapter, AdapterContext, ApplyResult, Diff, UndoRecord } from "./types.js";

/**
 * App Store Connect listing metadata.
 *
 * binding: { adapter: appstore, app: "1234567890", field?: description | promotionalText | keywords
 *            | whatsNew | name | subtitle, locale?: "en-US", platform?: "IOS" }
 * settings (adapters.appstore): { keyId, issuerId, keyPath } or env ASC_KEY_ID, ASC_ISSUER_ID,
 *            ASC_PRIVATE_KEY_PATH / ASC_PRIVATE_KEY.
 *
 * Only text fields are audited and written. Screenshot sets (bindings with `set`) and in-app
 * purchase prices (bindings with `iap`) are deliberately out of scope: screenshots must be
 * re-captured and uploaded, and IAP price changes go through Apple's price schedule. They are
 * tracked by the graph (classified manual by the planner) and this adapter reports nothing for them.
 *
 * Only promotionalText may be edited on a live (READY_FOR_SALE) version; every other field needs a
 * version in an editable state.
 */

const API = "https://api.appstoreconnect.apple.com";

const VERSION_FIELDS = new Set(["description", "promotionalText", "keywords", "whatsNew"]);
const INFO_FIELDS = new Set(["name", "subtitle"]);
const LIMITS: Record<string, number> = { description: 4000, promotionalText: 170, keywords: 100, whatsNew: 4000, name: 30, subtitle: 30 };

/** Version states whose metadata can be edited, in order of preference. */
const EDITABLE_STATES = [
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
];
const LIVE_STATES = new Set(["READY_FOR_SALE", "READY_FOR_DISTRIBUTION"]);

export interface AscCredentials {
  keyId: string;
  issuerId: string;
  privateKey: KeyObject | string;
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

/** ES256 JWT for the App Store Connect API (20-minute lifetime). */
export function createAscToken(creds: AscCredentials, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = { alg: "ES256", kid: creds.keyId, typ: "JWT" };
  const payload = { iss: creds.issuerId, iat: nowSeconds, exp: nowSeconds + 1200, aud: "appstoreconnect-v1" };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = typeof creds.privateKey === "string" ? createPrivateKey(creds.privateKey) : creds.privateKey;
  const signature = cryptoSign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${b64url(signature)}`;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

export async function ascCredentials(ctx: AdapterContext): Promise<AscCredentials> {
  const keyId = str(ctx.settings.keyId) ?? str(ctx.env.ASC_KEY_ID);
  const issuerId = str(ctx.settings.issuerId) ?? str(ctx.env.ASC_ISSUER_ID);
  const keyPath = str(ctx.settings.keyPath) ?? str(ctx.env.ASC_PRIVATE_KEY_PATH);
  let pem = str(ctx.env.ASC_PRIVATE_KEY)?.replace(/\\n/g, "\n");
  if (keyPath) {
    try {
      pem = await readFile(resolve(ctx.root, keyPath), "utf8");
    } catch {
      throw new MissingCredentialsError("appstore", `App Store Connect private key not readable at ${keyPath}`);
    }
  }
  const missing = [!keyId && "ASC_KEY_ID", !issuerId && "ASC_ISSUER_ID", !pem && "ASC_PRIVATE_KEY_PATH or ASC_PRIVATE_KEY"].filter(Boolean);
  if (missing.length > 0 || !keyId || !issuerId || !pem) {
    throw new MissingCredentialsError("appstore", `App Store Connect credentials missing: ${missing.join(", ")}`);
  }
  return { keyId, issuerId, privateKey: pem };
}

interface JsonApiResource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
}

class AscClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async request<T>(method: "GET" | "PATCH", path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    if (!res.ok) {
      const err = (json as { errors?: { title?: string; detail?: string }[] }).errors?.[0];
      throw new Error(`App Store Connect ${method} ${path}: HTTP ${res.status}${err ? ` ${err.detail ?? err.title ?? ""}` : ""}`.trim());
    }
    return json as T;
  }

  async list(path: string): Promise<JsonApiResource[]> {
    return (await this.request<{ data: JsonApiResource[] }>("GET", path)).data ?? [];
  }
}

interface Target {
  field: string;
  locale: string;
  scope: "version" | "info";
  /** Localization resource to read/patch. */
  localization: JsonApiResource;
  /** Whether the parent version / app info is in an editable state. */
  editable: boolean;
  live: boolean;
  parentState: string;
}

const stateOf = (r: JsonApiResource): string =>
  String(r.attributes?.appVersionState ?? r.attributes?.appStoreVersionState ?? r.attributes?.appStoreState ?? r.attributes?.state ?? "");

function pickParent(resources: JsonApiResource[]): { resource: JsonApiResource; editable: boolean; live: boolean } | undefined {
  for (const state of EDITABLE_STATES) {
    const hit = resources.find((r) => stateOf(r) === state);
    if (hit) return { resource: hit, editable: true, live: false };
  }
  const live = resources.find((r) => LIVE_STATES.has(stateOf(r)));
  if (live) return { resource: live, editable: false, live: true };
  const first = resources[0];
  return first ? { resource: first, editable: false, live: false } : undefined;
}

/** Live version for promotionalText, which is editable without a new submission. */
function pickLive(resources: JsonApiResource[]): JsonApiResource | undefined {
  return resources.find((r) => LIVE_STATES.has(stateOf(r)));
}

function bindingOf(node: GraphNode): { app: string; field?: string; locale: string; platform: string } | undefined {
  const b = node.binding ?? { adapter: "appstore" };
  if (b.set !== undefined || b.iap !== undefined) return undefined; // screenshots / IAP prices: manual
  const field = str(b.field);
  if (!field) return undefined;
  if (!VERSION_FIELDS.has(field) && !INFO_FIELDS.has(field)) throw new Error(`${node.id}: unsupported appstore field "${field}"`);
  const app = b.app === undefined ? undefined : String(b.app);
  if (!app || !/^\d+$/.test(app)) throw new Error(`${node.id}: appstore binding needs "app" (numeric App Store Connect app id)`);
  return { app, field, locale: str(b.locale) ?? "en-US", platform: str(b.platform) ?? "IOS" };
}

async function resolveTarget(
  client: AscClient,
  b: { app: string; field?: string; locale: string; platform: string },
  forWrite: boolean,
): Promise<Target> {
  const field = b.field!;
  if (VERSION_FIELDS.has(field)) {
    const versions = await client.list(`/v1/apps/${b.app}/appStoreVersions?filter[platform]=${encodeURIComponent(b.platform)}&limit=5`);
    let parent = pickParent(versions);
    if (forWrite && field === "promotionalText" && parent && !parent.editable) {
      const live = pickLive(versions);
      if (live) parent = { resource: live, editable: true, live: true };
    }
    if (!parent) throw new Error(`app ${b.app} has no ${b.platform} App Store versions`);
    const locs = await client.list(`/v1/appStoreVersions/${parent.resource.id}/appStoreVersionLocalizations?limit=200`);
    const localization = locs.find((l) => l.attributes?.locale === b.locale);
    if (!localization) throw new Error(`version ${parent.resource.id} has no ${b.locale} localization`);
    return { field, locale: b.locale, scope: "version", localization, editable: parent.editable, live: parent.live, parentState: stateOf(parent.resource) };
  }
  const infos = await client.list(`/v1/apps/${b.app}/appInfos`);
  const parent = pickParent(infos);
  if (!parent) throw new Error(`app ${b.app} has no app infos`);
  const locs = await client.list(`/v1/appInfos/${parent.resource.id}/appInfoLocalizations?limit=200`);
  const localization = locs.find((l) => l.attributes?.locale === b.locale);
  if (!localization) throw new Error(`app info ${parent.resource.id} has no ${b.locale} localization`);
  return { field, locale: b.locale, scope: "info", localization, editable: parent.editable, live: parent.live, parentState: stateOf(parent.resource) };
}

const resourceType = (scope: Target["scope"]) => (scope === "version" ? "appStoreVersionLocalizations" : "appInfoLocalizations");

async function patchField(client: AscClient, scope: Target["scope"], id: string, field: string, value: string): Promise<void> {
  const type = resourceType(scope);
  await client.request("PATCH", `/v1/${type}/${id}`, { data: { type, id, attributes: { [field]: value } } });
}

async function clientFor(ctx: AdapterContext): Promise<AscClient> {
  return new AscClient(createAscToken(await ascCredentials(ctx)), ctx.fetch);
}

async function audit(node: GraphNode, ctx: AdapterContext): Promise<Diff[]> {
  const b = bindingOf(node);
  if (!b) return [];
  const facts = leafFacts(ctx.graph, node.id, ["embeds", "mirrors", "renders"]);
  if (facts.length === 0) return [];
  const client = await clientFor(ctx);
  const target = await resolveTarget(client, b, false);
  const text = String(target.localization.attributes?.[target.field] ?? "");
  const where = `appstore:${b.app}/${target.locale}/${target.field}`;
  return auditText({ artifact: node.id, text, facts, previous: ctx.previousValues, field: target.field, where: () => where });
}

async function apply(node: GraphNode, ctx: AdapterContext): Promise<ApplyResult> {
  const fail = (error: string, changes: string[] = []): ApplyResult => ({ artifact: node.id, ok: false, changes, error });
  if (ctx.settings.write === false) return fail("writes to App Store Connect are disabled (adapters.appstore.write: false)");
  let b: ReturnType<typeof bindingOf>;
  try {
    b = bindingOf(node);
  } catch (e) {
    return fail((e as Error).message);
  }
  if (!b) return fail(`${node.id}: screenshots and in-app purchase prices are updated manually`);

  const facts = leafFacts(ctx.graph, node.id, ["embeds", "mirrors", "renders"]);
  const plan = planReplacements(facts, ctx.previousValues);
  if (plan.ambiguous.length > 0) {
    const a = plan.ambiguous[0]!;
    return fail(`ambiguous: old value ${JSON.stringify(a.value)} of ${a.fact} is also the current value of ${a.conflictsWith}`);
  }
  if (plan.unplaced.length > 0) {
    return fail(`cannot place new item(s) ${plan.unplaced.map((u) => JSON.stringify(u.value)).join(", ")} in ${b.field}; edit it in App Store Connect`);
  }
  if (plan.replacements.length === 0) return { artifact: node.id, ok: true, changes: [] };

  const client = await clientFor(ctx);
  const target = await resolveTarget(client, b, true);
  if (!target.editable) {
    return fail(
      `${target.field} can only be changed on an editable version (current: ${target.parentState || "unknown"}); create a new version in App Store Connect first`,
    );
  }
  const previous = String(target.localization.attributes?.[target.field] ?? "");
  const { text: next, count } = applyReplacements(previous, plan.replacements);
  if (count === 0) {
    const r = plan.replacements[0]!;
    return fail(`could not find old value ${JSON.stringify(r.from)} of ${r.fact} in ${target.field} (${target.locale})`);
  }
  const limit = LIMITS[target.field];
  if (limit !== undefined && [...next].length > limit) {
    return fail(`${target.field} would be ${[...next].length} characters; App Store Connect allows ${limit}`);
  }
  const summary = plan.replacements.map((r) => `${JSON.stringify(r.from)} → ${JSON.stringify(r.to)}`).join(", ");
  const label = `${target.field} (${target.locale}${target.live ? ", live version" : ""})`;
  if (ctx.dryRun) return { artifact: node.id, ok: true, changes: [`would update ${label}: ${summary}`] };

  await patchField(client, target.scope, target.localization.id, target.field, next);
  const undo: UndoRecord = {
    adapter: "appstore",
    artifact: node.id,
    data: { scope: target.scope, localizationId: target.localization.id, field: target.field, previous },
  };
  return { artifact: node.id, ok: true, changes: [`updated ${label}: ${summary}`], undo };
}

async function revert(undo: UndoRecord, ctx: AdapterContext): Promise<ApplyResult> {
  const { scope, localizationId, field, previous } = undo.data;
  if ((scope !== "version" && scope !== "info") || typeof localizationId !== "string" || typeof field !== "string" || typeof previous !== "string") {
    return { artifact: undo.artifact, ok: false, changes: [], error: "malformed appstore undo record" };
  }
  if (ctx.dryRun) return { artifact: undo.artifact, ok: true, changes: [`would restore ${field}`] };
  const client = await clientFor(ctx);
  await patchField(client, scope, localizationId, field, previous);
  return { artifact: undo.artifact, ok: true, changes: [`restored ${field}`] };
}

export const appstoreAdapter: Adapter = {
  id: "appstore",
  capabilities: { read: true, write: true, dryRun: true, rollback: true },
  canApply(node) {
    try {
      return bindingOf(node) !== undefined;
    } catch {
      return false;
    }
  },
  audit,
  apply,
  revert,
};
