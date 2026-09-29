import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Graph } from "../core/graph.js";
import type { GraphNode } from "../core/model.js";
import { appstoreAdapter, createAscToken } from "./appstore.js";
import { MissingCredentialsError } from "./errors.js";
import type { AdapterContext } from "./types.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const API = "https://api.appstoreconnect.apple.com";

interface Call {
  method: string;
  url: string;
  body?: unknown;
  auth?: string;
}

function fakeFetch(routes: Record<string, unknown>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      auth: new Headers(init?.headers).get("authorization") ?? undefined,
    };
    calls.push(call);
    const key = `${call.method} ${call.url.slice(API.length)}`;
    if (key in routes) return new Response(JSON.stringify(routes[key]), { status: 200 });
    return new Response(JSON.stringify({ errors: [{ detail: `no route ${key}` }] }), { status: 404 });
  }) as typeof fetch;
  return { fetch: f, calls };
}

function setup(field: string, extraBinding: Record<string, unknown> = {}): { graph: Graph; node: GraphNode } {
  const g = new Graph();
  g.addNode({ id: "addon:pro.price.usd", kind: "fact", value: 5.99 });
  g.addNode({ id: "addon:pro.name", kind: "fact", value: "Pro+" });
  const node = g.addNode({ id: `appstore:listing/${field}`, kind: "artifact", binding: { adapter: "appstore", app: "123456", field, ...extraBinding } });
  g.addEdge({ from: node.id, to: "addon:pro.price.usd", type: "embeds" });
  g.addEdge({ from: node.id, to: "addon:pro.name", type: "embeds" });
  return { graph: g, node };
}

function ctx(graph: Graph, f: typeof fetch, extra: Partial<AdapterContext> = {}): AdapterContext {
  return {
    root: "/",
    graph,
    settings: { keyId: "KEY123", issuerId: "issuer-uuid" },
    env: { ASC_PRIVATE_KEY: pem },
    fetch: f,
    previousValues: { "addon:pro.price.usd": 4.99, "addon:pro.name": "Pro+" },
    dryRun: false,
    ...extra,
  };
}

const versions = (state: string) => ({
  data: [
    { id: "v-live", type: "appStoreVersions", attributes: { appStoreVersionState: "READY_FOR_SALE", versionString: "1.0" } },
    ...(state ? [{ id: "v-next", type: "appStoreVersions", attributes: { appStoreVersionState: state, versionString: "1.1" } }] : []),
  ],
});
const localizations = (text: string, field = "description") => ({
  data: [
    { id: "loc-fr", type: "appStoreVersionLocalizations", attributes: { locale: "fr-FR", [field]: "Pro+ à 4,99" } },
    { id: "loc-en", type: "appStoreVersionLocalizations", attributes: { locale: "en-US", [field]: text } },
  ],
});
const VERSIONS_URL = "GET /v1/apps/123456/appStoreVersions?filter[platform]=IOS&limit=5";

describe("App Store Connect JWT", () => {
  it("builds an ES256 token Apple can verify", () => {
    const token = createAscToken({ keyId: "KEY123", issuerId: "issuer-uuid", privateKey: pem }, 1_700_000_000);
    const [h, p, s] = token.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY123", typ: "JWT" });
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toEqual({
      iss: "issuer-uuid",
      iat: 1_700_000_000,
      exp: 1_700_001_200,
      aud: "appstoreconnect-v1",
    });
    const signature = Buffer.from(s!, "base64url");
    expect(signature).toHaveLength(64);
    expect(verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, signature)).toBe(true);
  });

  it("reports missing credentials", async () => {
    const { graph, node } = setup("description");
    const { fetch } = fakeFetch({});
    await expect(appstoreAdapter.audit(node, ctx(graph, fetch, { settings: {}, env: {} }))).rejects.toBeInstanceOf(MissingCredentialsError);
  });
});

describe("appstore adapter", () => {
  it("audits the editable version's localization", async () => {
    const { graph, node } = setup("description");
    const { fetch, calls } = fakeFetch({
      [VERSIONS_URL]: versions("PREPARE_FOR_SUBMISSION"),
      "GET /v1/appStoreVersions/v-next/appStoreVersionLocalizations?limit=200": localizations("Unlock Pro+ for $4.99 a month."),
    });
    const diffs = await appstoreAdapter.audit(node, ctx(graph, fetch));
    expect(calls[0]!.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(diffs).toEqual([
      expect.objectContaining({ kind: "stale", fact: "addon:pro.price.usd", field: "description", where: "appstore:123456/en-US/description" }),
    ]);
  });

  it("returns nothing for screenshot sets and IAP bindings (manual)", async () => {
    const { graph, node } = setup("description", { set: "6.7", index: 3 });
    const { fetch, calls } = fakeFetch({});
    expect(await appstoreAdapter.audit(node, ctx(graph, fetch))).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("patches an editable version and reverts", async () => {
    const { graph, node } = setup("description");
    const routes = {
      [VERSIONS_URL]: versions("PREPARE_FOR_SUBMISSION"),
      "GET /v1/appStoreVersions/v-next/appStoreVersionLocalizations?limit=200": localizations("Unlock Pro+ for $4.99 a month."),
      "PATCH /v1/appStoreVersionLocalizations/loc-en": { data: {} },
    };
    const { fetch, calls } = fakeFetch(routes);
    const result = await appstoreAdapter.apply!(node, ctx(graph, fetch));
    expect(result.ok).toBe(true);
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({
      data: { type: "appStoreVersionLocalizations", id: "loc-en", attributes: { description: "Unlock Pro+ for $5.99 a month." } },
    });
    expect(result.undo?.data).toEqual({ scope: "version", localizationId: "loc-en", field: "description", previous: "Unlock Pro+ for $4.99 a month." });

    const r = fakeFetch(routes);
    expect((await appstoreAdapter.revert!(result.undo!, ctx(graph, r.fetch))).ok).toBe(true);
    expect(r.calls[0]!.body).toMatchObject({ data: { attributes: { description: "Unlock Pro+ for $4.99 a month." } } });
  });

  it("requires an editable version for description but not for promotionalText", async () => {
    const live = versions("");
    const desc = setup("description");
    const d = fakeFetch({
      [VERSIONS_URL]: live,
      "GET /v1/appStoreVersions/v-live/appStoreVersionLocalizations?limit=200": localizations("Pro+ $4.99"),
    });
    const refused = await appstoreAdapter.apply!(desc.node, ctx(desc.graph, d.fetch));
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/editable version/);
    expect(d.calls.some((c) => c.method === "PATCH")).toBe(false);

    const promo = setup("promotionalText");
    const p = fakeFetch({
      [VERSIONS_URL]: live,
      "GET /v1/appStoreVersions/v-live/appStoreVersionLocalizations?limit=200": localizations("Now $4.99!", "promotionalText"),
      "PATCH /v1/appStoreVersionLocalizations/loc-en": { data: {} },
    });
    const ok = await appstoreAdapter.apply!(promo.node, ctx(promo.graph, p.fetch));
    expect(ok.ok).toBe(true);
    expect(ok.changes[0]).toContain("live version");
    expect(p.calls.find((c) => c.method === "PATCH")!.body).toMatchObject({ data: { attributes: { promotionalText: "Now $5.99!" } } });
  });

  it("reads and writes app info fields (name/subtitle)", async () => {
    const { graph, node } = setup("subtitle");
    const { fetch } = fakeFetch({
      "GET /v1/apps/123456/appInfos": { data: [{ id: "info-1", type: "appInfos", attributes: { appStoreState: "PREPARE_FOR_SUBMISSION" } }] },
      "GET /v1/appInfos/info-1/appInfoLocalizations?limit=200": {
        data: [{ id: "il-en", type: "appInfoLocalizations", attributes: { locale: "en-US", subtitle: "Pro+ from $4.99" } }],
      },
      "PATCH /v1/appInfoLocalizations/il-en": { data: {} },
    });
    const dry = await appstoreAdapter.apply!(node, ctx(graph, fetch, { dryRun: true }));
    expect(dry).toMatchObject({ ok: true, changes: [expect.stringMatching(/^would update subtitle/)] });
    const result = await appstoreAdapter.apply!(node, ctx(graph, fetch));
    expect(result.undo?.data).toMatchObject({ scope: "info", localizationId: "il-en", field: "subtitle" });
  });
});
