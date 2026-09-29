import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { check, planFromLock } from "../api.js";
import { buildLock } from "../core/lock.js";
import { buildProject, readLock, writeLock } from "../project.js";
import { ackArtifacts, applyPlan, listJournals, revertJournal, type StepEvent } from "./apply.js";
import { auditProject } from "./audit.js";
import { buildPreview } from "./preview.js";

const API = "https://api.stripe.com/v1";
let root: string;

function write(rel: string, content: string) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

const entity = (usd: number) => `id: addon:pro\nfacts:\n  name: "Pro+"\n  price: { usd: ${usd} }\n`;

const ARTIFACTS = `artifacts:
  - id: stripe:price/pro
    binding: { adapter: stripe, price: price_old }
    mirrors: [addon:pro.price, addon:pro.name]
  - id: web:pricing
    binding: { adapter: fs, path: web/pricing.md }
    embeds: [addon:pro.price.usd, addon:pro.name]
  - id: web:og
    binding: { adapter: fs }
    renders: { template: tpl/og.svg, with: [addon:pro.price.usd], out: public/og.png }
  - id: web:landing
    binding: { adapter: fs, path: web/landing.md }
    describes: [addon:pro]
`;

const PRICING = "# Pricing\n\n<script>alert(1)</script>\nPro+ is $4.99 a month (Team: $14.99).\n";

interface Call {
  method: string;
  url: string;
  body?: string;
}

/** A tiny in-memory Stripe: GET/POST prices and products. */
function fakeStripe() {
  const prices: Record<string, { id: string; active: boolean; currency: string; unit_amount: number; product: string; recurring: null; lookup_key: null; nickname: null }> = {
    price_old: { id: "price_old", active: true, currency: "usd", unit_amount: 499, product: "prod_pro", recurring: null, lookup_key: null, nickname: null },
  };
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ method, url, body });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    const priceMatch = /^https:\/\/api\.stripe\.com\/v1\/prices(?:\/([^?]+))?/.exec(url);
    if (url.startsWith(`${API}/products/prod_pro`)) return json(200, { id: "prod_pro", name: "Pro+", active: true });
    if (priceMatch) {
      const id = priceMatch[1];
      const form = new URLSearchParams(body ?? "");
      if (method === "POST" && !id) {
        const created = { ...prices.price_old!, id: "price_new", active: true, unit_amount: Number(form.get("unit_amount")) };
        prices.price_new = created;
        return json(200, created);
      }
      const price = id ? prices[id] : undefined;
      if (!price) return json(404, { error: { message: "No such price" } });
      if (method === "POST" && form.has("active")) price.active = form.get("active") === "true";
      return json(200, price);
    }
    return json(404, { error: { message: `unexpected ${url}` } });
  }) as typeof fetch;
  return { fetch: f, calls, prices };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "starchart-engine-"));
  write(".starchart/config.yaml", "name: demo\nadapters:\n  stripe: { write: true }\n");
  write(".starchart/entities/pro.yaml", entity(4.99));
  write(".starchart/artifacts/world.yaml", ARTIFACTS);
  write("web/pricing.md", PRICING);
  write("web/landing.md", "The best Pro plan.\n");
  write(
    "tpl/og.svg",
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="#030303"/><text x="10" y="60" fill="#ff1493">{{ addon:pro.price.usd | money:USD }}</text></svg>',
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function lockedProjectWithPriceChange() {
  const initial = await buildProject(root, { skipCode: true });
  writeLock(root, buildLock(initial.graph));
  write(".starchart/entities/pro.yaml", entity(5.99));
  return buildProject(root, { skipCode: true });
}

describe("audit", () => {
  it("reports stale fs content, skips Stripe without credentials, and detects code breaks", async () => {
    const project = await lockedProjectWithPriceChange();
    const noKey = await auditProject(project, { env: {}, fetch: fakeStripe().fetch });
    expect(noKey.diffs).toEqual(
      expect.arrayContaining([expect.objectContaining({ artifact: "web:pricing", kind: "stale", fact: "addon:pro.price.usd", where: "web/pricing.md:4" })]),
    );
    expect(noKey.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ artifact: "stripe:price/pro", reason: expect.stringMatching(/STRIPE_SECRET_KEY/) })]));
    expect(noKey.checked).toContain("web:pricing");
    expect(noKey.errors).toEqual([]);

    // a hardcoded, now-archived price id in code
    project.graph.addNode({ id: "symbol:web/lib/stripe.PRICE_PRO", kind: "symbol", value: "price_dead", location: { file: "web/lib/stripe.ts", line: 12 } });
    project.graph.addNode({ id: "symbol:web/app/checkout.POST", kind: "symbol", location: { file: "web/app/api/checkout/route.ts", line: 31 } });
    project.graph.addEdge({ from: "symbol:web/app/checkout.POST", to: "symbol:web/lib/stripe.PRICE_PRO", type: "references" });
    const stripe = fakeStripe();
    stripe.prices.price_dead = { ...stripe.prices.price_old!, id: "price_dead", active: false };
    const withKey = await auditProject(project, { env: { STRIPE_SECRET_KEY: "sk_test" }, fetch: stripe.fetch, ids: ["symbol:web/lib/stripe.PRICE_PRO"] });
    expect(withKey.diffs).toEqual([
      expect.objectContaining({
        artifact: "symbol:web/lib/stripe.PRICE_PRO",
        kind: "break",
        where: "web/lib/stripe.ts:12",
        message: "Stripe price price_dead is ARCHIVED; referenced by web/app/api/checkout/route.ts:31",
      }),
    ]);
  });
});

describe("apply → revert", () => {
  it("syncs Stripe and files, rewrites the YAML binding, journals, re-locks, and reverts", async () => {
    const project = await lockedProjectWithPriceChange();
    const plan = planFromLock(project);
    const classes = Object.fromEntries(plan.steps.map((s) => [s.item.id, s.item.class]));
    expect(classes).toEqual({ "stripe:price/pro": "auto", "web:og": "auto", "web:pricing": "auto", "web:landing": "review" });

    const stripe = fakeStripe();
    const env = { STRIPE_SECRET_KEY: "sk_test" };

    const dry = await applyPlan(project, plan, { dryRun: true, fetch: stripe.fetch, env });
    expect(dry.applied).toHaveLength(3);
    expect(stripe.calls.some((c) => c.method === "POST")).toBe(false);
    expect(readFileSync(join(root, "web/pricing.md"), "utf8")).toBe(PRICING);
    expect(existsSync(join(root, ".starchart/journal"))).toBe(false);

    const events: StepEvent[] = [];
    const report = await applyPlan(project, plan, { fetch: stripe.fetch, env, onStep: (e) => events.push(e) });
    expect(report.failed).toBeUndefined();
    expect(report.applied.map((r) => r.artifact)).toEqual(["stripe:price/pro", "web:og", "web:pricing"]);
    expect(report.pending).toEqual([expect.objectContaining({ id: "web:landing", class: "review", why: expect.stringContaining("--describes--> web:landing") })]);
    expect(events.filter((e) => e.type === "done")).toHaveLength(3);

    // world + files
    expect(stripe.prices.price_old!.active).toBe(false);
    expect(stripe.prices.price_new!.unit_amount).toBe(599);
    expect(readFileSync(join(root, "web/pricing.md"), "utf8")).toBe(PRICING.replace("$4.99", "$5.99"));
    expect(readFileSync(join(root, "public/og.png")).subarray(1, 4).toString()).toBe("PNG");
    // YAML binding rewritten to the new immutable price
    expect(report.bindingEdits).toEqual([expect.objectContaining({ artifact: "stripe:price/pro", from: "price_old", to: "price_new", written: true })]);
    expect(readFileSync(join(root, ".starchart/artifacts/world.yaml"), "utf8")).toContain("price: price_new");

    // lock + journal
    expect(report.lockUpdated).toBe(true);
    const lock = readLock(root);
    expect(lock.facts["addon:pro.price.usd"]?.value).toBe(5.99);
    expect(check(project).map((s) => s.id)).toEqual(["web:landing"]);
    expect(report.journal).toMatch(/^\.starchart\/journal\/.+\.json$/);
    const journals = await listJournals(root);
    expect(journals).toHaveLength(1);
    expect(journals[0]!.artifacts.sort()).toEqual(["stripe:price/pro", "web:og", "web:pricing"]);

    // reload from disk: the new binding and lock are in effect
    const reloaded = await buildProject(root, { skipCode: true });
    expect(reloaded.graph.node("stripe:price/pro")?.binding?.price).toBe("price_new");
    expect(planFromLock(reloaded).steps).toEqual([]);

    // revert everything
    const reverted = await revertJournal(reloaded, journals[0]!.id, { fetch: stripe.fetch, env });
    expect(reverted.ok).toBe(true);
    expect(reverted.lockRestored).toBe(true);
    expect(readFileSync(join(root, "web/pricing.md"), "utf8")).toBe(PRICING);
    expect(existsSync(join(root, "public/og.png"))).toBe(false);
    expect(readFileSync(join(root, ".starchart/artifacts/world.yaml"), "utf8")).toContain("price: price_old");
    expect(stripe.prices.price_old!.active).toBe(true);
    expect(stripe.prices.price_new!.active).toBe(false);
    expect(readLock(root).facts["addon:pro.price.usd"]?.value).toBe(4.99);
    expect((await listJournals(root))[0]!.revertedAt).toBeDefined();
    await expect(revertJournal(reloaded, journals[0]!.id, { fetch: stripe.fetch, env })).rejects.toThrow(/already reverted/);
  });

  it("stops at the first failure, reports the rest as not run, and keeps old values for them", async () => {
    const project = await lockedProjectWithPriceChange();
    const plan = planFromLock(project);
    const failing = (async () => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 })) as typeof fetch;
    const report = await applyPlan(project, plan, { fetch: failing, env: { STRIPE_SECRET_KEY: "sk_test" } });
    expect(report.failed).toMatchObject({ artifact: "stripe:price/pro", ok: false, error: expect.stringContaining("boom") });
    expect(report.notRun).toEqual(["web:og", "web:pricing"]);
    expect(report.lockUpdated).toBe(false);
    expect(readFileSync(join(root, "web/pricing.md"), "utf8")).toBe(PRICING);

    // run only the fs page: the pricing page is synced, the still-pending Stripe price keeps its old values
    const only = await applyPlan(project, plan, { only: ["web:pricing"], env: {} });
    expect(only.applied.map((r) => r.artifact)).toEqual(["web:pricing"]);
    expect(readLock(root).facts["addon:pro.price.usd"]?.value).toBe(4.99);
    expect(readLock(root).artifacts["web:pricing"]?.deps["addon:pro.price.usd"]).toBe(project.lock.artifacts["web:pricing"]?.deps["addon:pro.price.usd"]);
  });

  it("acks manual/review items by re-locking them", async () => {
    const project = await lockedProjectWithPriceChange();
    expect(check(project).map((s) => s.id)).toContain("web:landing");
    await ackArtifacts(project, ["web:landing"]);
    expect(check(project).map((s) => s.id)).not.toContain("web:landing");
    expect(readLock(root).artifacts["web:landing"]).toBeDefined();
    await expect(ackArtifacts(project, ["nope"])).rejects.toThrow(/not an artifact/);
  });
});

describe("preview", () => {
  it("writes before/after files, a PNG render and an escaped HTML report", async () => {
    const project = await lockedProjectWithPriceChange();
    const plan = planFromLock(project);
    const { indexPath, entries } = await buildPreview(project, plan, ".starchart/preview");
    const byId = Object.fromEntries(entries.map((e) => [e.id, e]));

    expect(byId["web:pricing"]).toMatchObject({ kind: "text", class: "auto" });
    expect(byId["web:pricing"]!.diff).toContain("-Pro+ is $4.99 a month (Team: $14.99).");
    expect(byId["web:pricing"]!.diff).toContain("+Pro+ is $5.99 a month (Team: $14.99).");
    expect(readFileSync(join(dirname(indexPath), byId["web:pricing"]!.after!), "utf8")).toContain("$5.99");
    expect(byId["web:og"]).toMatchObject({ kind: "image" });
    expect(byId["web:og"]!.before).toBeUndefined();
    expect(readFileSync(join(dirname(indexPath), byId["web:og"]!.after!)).subarray(1, 4).toString()).toBe("PNG");
    expect(byId["stripe:price/pro"]).toMatchObject({ kind: "external" });
    expect(byId["web:landing"]).toMatchObject({ kind: "task", class: "review", why: expect.stringContaining("describes") });

    const html = readFileSync(indexPath, "utf8");
    expect(html).toContain("Future Universe");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("data:image/png;base64,");
    expect(html).not.toMatch(/(src|href)="https?:/);
    // the real files were not touched
    expect(readFileSync(join(root, "web/pricing.md"), "utf8")).toBe(PRICING);
  });
});
