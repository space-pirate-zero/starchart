import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli/main.js";
import { detectScopes, discoverChart } from "../src/cli/init.js";
import { buildProject } from "../src/project.js";

const EXAMPLE = resolve(import.meta.dirname, "../../../examples/pro-universe");

/** Runs the CLI in-process and captures stdout. */
async function sc(cwd: string, ...args: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const code = await run(["node", "starchart", "-C", cwd, "-q", ...args]);
    return { code, out };
  } finally {
    write.mockRestore();
    err.mockRestore();
  }
}

let dir: string;

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "starchart-e2e-")), "pro-universe");
  cpSync(EXAMPLE, dir, { recursive: true, filter: (src) => !src.includes(`${"/"}.starchart${"/"}journal`) && !src.includes("/public/og/") });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const setPrice = (usd: string) => {
  const file = join(dir, ".starchart/entities/pro.yaml");
  writeFileSync(file, readFileSync(file, "utf8").replace(/usd: [\d.]+/, `usd: ${usd}`));
};

describe("the Pro universe, end to end", () => {
  it("is in sync as committed", async () => {
    const { code, out } = await sc(dir, "check");
    expect(out).toContain("every artifact is in sync");
    expect(code).toBe(0);
  });

  it("plans a price change across code, facts and world", async () => {
    setPrice("5.99");
    const { out } = await sc(dir, "plan", "--format", "json");
    const plan = JSON.parse(out) as { items: { id: string; class: string }[] };
    const cls = Object.fromEntries(plan.items.map((i) => [i.id, i.class]));
    expect(cls["web:pricing-page"]).toBe("auto");
    expect(cls["web:og-pro"]).toBe("auto");
    expect(cls["stripe:price/pro-monthly"]).toBe("manual"); // external writes are opt-in
    expect(cls["appstore:screenshots/6.9/03"]).toBe("manual");
    expect(cls["reel:spring-2026"]).toBe("retire");
    expect(cls["symbol:ios/Pricing.proUSD"]).toBe("code");
    expect(cls["symbol:web/lib/starchart-facts#ADDON_PRO_PRICE_USD"]).toBe("auto");
    expect(cls["test:ios/Tests/PaywallTests.swift"]).toBe("test");
  });

  it("applies auto steps, relocks them, and reverts from the journal", async () => {
    setPrice("5.99");
    const applied = await sc(dir, "apply", "--yes");
    expect(applied.code).toBe(0);
    expect(readFileSync(join(dir, "apps/web/app/pricing/page.tsx"), "utf8")).toContain("$5.99 / month");
    expect(readFileSync(join(dir, "apps/web/messages/en.json"), "utf8")).toContain("$5.99/month");
    expect(readFileSync(join(dir, "apps/web/public/og/pro.png")).subarray(1, 4).toString()).toBe("PNG");

    const { out } = await sc(dir, "check", "--format", "json");
    const stale = (JSON.parse(out) as { id: string }[]).map((s) => s.id);
    expect(stale).not.toContain("web:pricing-page"); // not stale against its own edit
    expect(stale).toContain("appstore:screenshots/6.9/03");

    const journal = readdirSync(join(dir, ".starchart/journal"))[0]!;
    await sc(dir, "revert", `.starchart/journal/${journal}`);
    expect(readFileSync(join(dir, "apps/web/app/pricing/page.tsx"), "utf8")).toContain("$4.99 / month");
    expect(existsSync(join(dir, "apps/web/public/og/pro.png"))).toBe(false);
  });

  it("finds the privacy drift and the hardcoded price", async () => {
    const rules = await sc(dir, "rules", "--format", "json");
    const violations = JSON.parse(rules.out) as { rule: string; message: string }[];
    expect(violations.some((v) => v.rule === "privacy-disclosed" && /sentry-cocoa collects CrashData/.test(v.message))).toBe(true);
    expect(violations.some((v) => v.rule === "promo-not-expired")).toBe(true);
    expect(rules.code).toBe(1);

    const scan = await sc(dir, "scan", "--format", "json");
    const hits = JSON.parse(scan.out) as { file: string; factId: string }[];
    expect(hits).toContainEqual(expect.objectContaining({ file: "apps/web/lib/pricing.ts", factId: "addon:pro.price.eur" }));
  });

  it("explains why a Swift view makes a store screenshot stale", async () => {
    const { out } = await sc(dir, "why", "apps/ios/Sources/Paywall/PaywallView.swift", "appstore:screenshots/6.9/03");
    expect(out).toContain("--captures--> appstore:screenshots/6.9/03");
  });

  it("emits schema.org Offers and a Reality Score", async () => {
    const jsonld = JSON.parse((await sc(dir, "emit", "jsonld", "--entity", "addon:pro")).out) as { priceCurrency: string; price: string }[];
    expect(jsonld).toContainEqual(expect.objectContaining({ priceCurrency: "USD", price: "4.99" }));
    const score = JSON.parse((await sc(dir, "score", "--format", "json")).out) as { score: number; total: number };
    expect(score.total).toBe(12);
    expect(score.score).toBeGreaterThan(0);
  });
});

describe("init", () => {
  it("detects scopes and discovers facts from code alone", async () => {
    rmSync(join(dir, ".starchart"), { recursive: true });
    rmSync(join(dir, "starchart.lock"));
    rmSync(join(dir, "apps/web/lib/starchart-facts.ts"));
    rmSync(join(dir, "apps/ios/Sources/Core/StarchartFacts.swift"));
    expect(detectScopes(dir)).toEqual({ ios: "apps/ios", web: "apps/web" });

    const { out } = await sc(dir, "init", "--discover");
    expect(out).toContain("proposed 2 facts");
    const proposalPath = join(dir, ".starchart/proposals/discovered.yaml");
    const discovered = readFileSync(proposalPath, "utf8");
    expect(discovered).toContain("price_1NebulaPro499");
    expect(discovered).toContain("marketing/emails/onboarding-day-3.md");

    // inert until moved into .starchart/
    expect((await buildProject(dir)).graph.hasNode("offer:main")).toBe(false);
    renameSync(proposalPath, join(dir, ".starchart/discovered.yaml"));
    const project = await buildProject(dir);
    expect(project.graph.node("offer:main.features")?.value).toEqual(["Themes", "iCloud sync"]);
    const proposal = discoverChart(project.graph, "offer:x");
    expect(Object.keys(proposal.facts).sort()).toEqual(["features", "price.usd"]);
  });
});
