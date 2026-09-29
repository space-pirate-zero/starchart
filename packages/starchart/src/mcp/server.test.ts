import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildLock } from "../core/lock.js";
import { buildProject, writeLock } from "../project.js";
import { createServer, INSTRUCTIONS } from "./server.js";

let root: string;
let client: Client;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "starchart-mcp-"));
  mkdirSync(join(root, ".starchart"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, ".starchart/config.yaml"), "name: mcp-test\ncode:\n  scopes:\n    app: src\n");
  writeFileSync(
    join(root, ".starchart/pro.yaml"),
    `id: addon:pro
type: [schema:Offer]
label: Pro add-on
status: active
facts:
  name: "Pro+"
  price: { usd: 4.99 }
`,
  );
  writeFileSync(
    join(root, ".starchart/artifacts.yaml"),
    `- id: web:pricing
  binding: { adapter: fs, path: site/pricing.html }
  embeds: [addon:pro.price.usd]
- id: web:landing
  describes: addon:pro
- id: stripe:price/pro
  binding: { adapter: stripe, price: price_123 }
  mirrors: [addon:pro.price]
`,
  );
  const project = await buildProject(root, { skipCode: true });
  writeLock(root, buildLock(project.graph));

  const server = createServer({ root });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close();
  rmSync(root, { recursive: true, force: true });
});

const textOf = (result: unknown): string => {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  return content.map((c) => c.text ?? "").join("\n");
};

describe("STARCHART MCP server", () => {
  it("advertises instructions and every tool", async () => {
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "starchart_apply",
        "starchart_audit",
        "starchart_check",
        "starchart_diff_impact",
        "starchart_impact",
        "starchart_node",
        "starchart_orphans",
        "starchart_plan",
        "starchart_query",
        "starchart_rules",
        "starchart_score",
        "starchart_why",
      ].sort(),
    );
    const apply = tools.find((t) => t.name === "starchart_apply");
    expect(apply?.annotations?.destructiveHint).toBe(true);
    expect(apply?.inputSchema.properties).toHaveProperty("confirm");
  });

  it("queries nodes", async () => {
    const result = await client.callTool({ name: "starchart_query", arguments: { kind: "artifact" } });
    const data = JSON.parse(textOf(result)) as { count: number; nodes: { id: string; layer: string }[] };
    expect(data.nodes.map((n) => n.id).sort()).toEqual(["stripe:price/pro", "web:landing", "web:pricing"]);
    expect(data.nodes.every((n) => n.layer === "world")).toBe(true);

    const byText = await client.callTool({ name: "starchart_query", arguments: { text: "4.99", kind: "fact" } });
    const facts = JSON.parse(textOf(byText)) as { nodes: { id: string; value: unknown }[] };
    expect(facts.nodes).toContainEqual({ id: "addon:pro.price.usd", kind: "fact", layer: "fact", value: 4.99 });
  });

  it("returns the impact of a fact as markdown and json", async () => {
    const md = textOf(await client.callTool({ name: "starchart_impact", arguments: { ref: "addon:pro.price.usd" } }));
    expect(md).toContain("STARCHART impact of addon:pro.price.usd");
    expect(md).toContain("`web:pricing`");
    expect(md).toContain("`stripe:price/pro`");
    expect(md).toContain("`web:landing`");

    const raw = textOf(await client.callTool({ name: "starchart_impact", arguments: { ref: "addon:pro.price.usd", format: "json" } }));
    const plan = JSON.parse(raw) as { items: { id: string; class: string; why: string }[] };
    expect(plan.items.find((i) => i.id === "web:landing")).toMatchObject({ class: "review" });
    expect(plan.items.find((i) => i.id === "stripe:price/pro")?.why).toContain("--mirrors--> stripe:price/pro");
  });

  it("reports unknown refs as tool errors", async () => {
    const result = await client.callTool({ name: "starchart_impact", arguments: { ref: "nope:nothing" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("no node matches");
  });

  it("validates inputs", async () => {
    const result = await client.callTool({ name: "starchart_impact", arguments: {} });
    expect(result.isError).toBe(true);
  });

  it("explains why and inspects nodes", async () => {
    const whyText = textOf(await client.callTool({ name: "starchart_why", arguments: { from: "addon:pro.price.usd", to: "web:landing" } }));
    expect(whyText).toContain("addon:pro.price.usd --partOf--> addon:pro.price --partOf--> addon:pro --describes--> web:landing");

    const node = JSON.parse(textOf(await client.callTool({ name: "starchart_node", arguments: { id: "web:pricing" } }))) as {
      node: { id: string };
      outgoing: { to: string; type: string }[];
    };
    expect(node.node.id).toBe("web:pricing");
    expect(node.outgoing).toContainEqual(expect.objectContaining({ to: "addon:pro.price.usd", type: "embeds" }));
  });

  it("plans and checks against the lock", async () => {
    expect(textOf(await client.callTool({ name: "starchart_plan", arguments: {} }))).toContain("No changes detected.");
    expect(textOf(await client.callTool({ name: "starchart_check", arguments: {} }))).toContain("in sync");

    writeFileSync(
      join(root, ".starchart/pro.yaml"),
      `id: addon:pro
type: [schema:Offer]
status: active
facts:
  name: "Pro+"
  price: { usd: 5.99 }
`,
    );
    const plan = textOf(await client.callTool({ name: "starchart_plan", arguments: {} }));
    expect(plan).toContain("`addon:pro.price.usd` `4.99` → `5.99`");
    const stale = textOf(await client.callTool({ name: "starchart_check", arguments: {} }));
    expect(stale).toContain("`web:pricing` | ✗ stale");
  });

  it("keeps apply in dry-run mode unless confirmed", async () => {
    const result = await client.callTool({ name: "starchart_apply", arguments: { dryRun: false } });
    const body = textOf(result);
    expect(result.isError).toBeFalsy();
    expect(body).toContain("Dry run only");
    expect(body).toContain('"dryRun": true');
    expect(body).toContain("stripe:price/pro");
  });

  it("loads the analysis modules on demand", async () => {
    const score = JSON.parse(textOf(await client.callTool({ name: "starchart_score", arguments: {} }))) as { score: number; total: number };
    expect(score.total).toBe(3);
    expect(typeof score.score).toBe("number");
    const orphans = await client.callTool({ name: "starchart_orphans", arguments: {} });
    expect(orphans.isError).toBeFalsy();
    const rules = await client.callTool({ name: "starchart_rules", arguments: {} });
    expect(rules.isError).toBeFalsy();
    expect(JSON.parse(textOf(rules))).toHaveProperty("violations");
    const audit = await client.callTool({ name: "starchart_audit", arguments: { ids: ["web:pricing"] } });
    expect(audit.isError).toBeFalsy();
    expect(textOf(audit)).toContain("STARCHART audit");
  });
});
