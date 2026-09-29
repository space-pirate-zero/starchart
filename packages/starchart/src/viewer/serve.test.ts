import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashValue } from "../core/lock.js";
import { serve, type ServeHandle } from "./serve.js";

let dir: string;
let server: ServeHandle;

function writeProject(root: string) {
  mkdirSync(join(root, ".starchart", "entities"), { recursive: true });
  mkdirSync(join(root, ".starchart", "artifacts"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, ".starchart", "config.yaml"), "name: served-demo\ncode:\n  scopes:\n    app: src\n");
  writeFileSync(
    join(root, ".starchart", "entities", "pro.yaml"),
    "id: addon:pro\nlabel: Pro\nfacts:\n  name: Pro\n  price:\n    usd: 5.99\n",
  );
  writeFileSync(
    join(root, ".starchart", "artifacts", "web.yaml"),
    [
      "artifacts:",
      "  - id: web:pricing",
      "    label: Pricing page",
      "    binding: { adapter: url, url: 'https://example.com/pricing' }",
      "    embeds: [addon:pro.price.usd, addon:pro.name]",
      "  - id: web:landing",
      "    describes: addon:pro",
      "",
    ].join("\n"),
  );
  const lock = {
    version: 1,
    facts: { "addon:pro.price.usd": { hash: hashValue(4.99), value: 4.99 } },
    code: {},
    artifacts: {
      "web:pricing": { deps: { "addon:pro.price.usd": hashValue(4.99), "addon:pro.name": hashValue("Pro") } },
    },
  };
  writeFileSync(join(root, "starchart.lock"), JSON.stringify(lock));
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "starchart-serve-"));
  writeProject(dir);
  server = await serve({ root: dir, port: 0 });
});

afterAll(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function get(path: string) {
  const res = await fetch(server.url + path);
  return { res, body: await res.text() };
}

describe("serve", () => {
  it("binds an ephemeral localhost port and reports it", () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.url).not.toMatch(/:0$/);
  });

  it("GET /health", async () => {
    const { res, body } = await get("/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const json = JSON.parse(body) as { ok: boolean; name: string; nodes: number };
    expect(json).toMatchObject({ ok: true, name: "served-demo" });
    expect(json.nodes).toBeGreaterThanOrEqual(6);
  });

  it("GET / serves the viewer", async () => {
    const { res, body } = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("<title>STARCHART — served-demo</title>");
    expect(body).toContain("web:pricing");
  });

  it("GET /graph.json", async () => {
    const { res, body } = await get("/graph.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const graph = JSON.parse(body) as { nodes: { id: string }[]; edges: unknown[] };
    expect(graph.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(["addon:pro.price.usd", "web:pricing"]));
    expect(graph.edges.length).toBeGreaterThan(0);
  });

  it("GET /impact?id= returns classified items with why paths", async () => {
    const { res, body } = await get(`/impact?id=${encodeURIComponent("addon:pro.price.usd")}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const json = JSON.parse(body) as { seeds: string[]; items: { id: string; class: string; explain: string; confidence: number }[] };
    expect(json.seeds).toEqual(["addon:pro.price.usd"]);
    const pricing = json.items.find((i) => i.id === "web:pricing");
    expect(pricing?.class).toMatch(/auto|manual/);
    expect(pricing?.explain).toBe("addon:pro.price.usd --embeds--> web:pricing");
    expect(json.items.find((i) => i.id === "web:landing")?.class).toBe("review");
  });

  it("GET /impact validates input", async () => {
    expect((await get("/impact")).res.status).toBe(400);
    const missing = await get("/impact?id=nope:nothing");
    expect(missing.res.status).toBe(404);
    expect(JSON.parse(missing.body)).toMatchObject({ ok: false });
  });

  it("GET /xray.json reports stale values and artifact URLs", async () => {
    const { res, body } = await get("/xray.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const payload = JSON.parse(body) as {
      name: string;
      facts: { id: string; value: string; previous?: string }[];
      artifacts: { id: string; urls: string[]; stale: boolean }[];
      staleValues: string[];
    };
    expect(payload.name).toBe("served-demo");
    expect(payload.facts.find((f) => f.id === "addon:pro.price.usd")).toMatchObject({ value: "5.99", previous: "4.99" });
    expect(payload.artifacts.find((a) => a.id === "web:pricing")).toMatchObject({
      urls: ["https://example.com/pricing"],
      stale: true,
    });
    expect(payload.staleValues).toEqual(["4.99"]);
  });

  it("answers CORS preflight and rejects unknown routes and methods", async () => {
    const pre = await fetch(`${server.url}/xray.json`, { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect((await get("/nope")).res.status).toBe(404);
    expect((await fetch(`${server.url}/graph.json`, { method: "POST" })).status).toBe(405);
    expect((await get("/events")).res.status).toBe(404);
  });
});

describe("serve errors", () => {
  it("returns JSON 500 with the message when the project cannot build", async () => {
    const empty = mkdtempSync(join(tmpdir(), "starchart-empty-"));
    mkdirSync(join(empty, ".starchart"));
    writeFileSync(join(empty, ".starchart", "config.yaml"), "name: [broken\n");
    const s = await serve({ root: empty, port: 0 });
    try {
      const res = await fetch(`${s.url}/health`);
      expect(res.status).toBe(500);
      const json = (await res.json()) as { ok: boolean; error: string };
      expect(json.ok).toBe(false);
      expect(json.error.length).toBeGreaterThan(0);
      expect(json.error).not.toMatch(/\n\s+at /);
    } finally {
      await s.close();
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("serves live reload events when watching", async () => {
    const root = mkdtempSync(join(tmpdir(), "starchart-watch-"));
    writeProject(root);
    const s = await serve({ root, port: 0, watch: true });
    try {
      const health = (await (await fetch(`${s.url}/health`)).json()) as { live: boolean };
      expect(health.live).toBe(true);
      const controller = new AbortController();
      const res = await fetch(`${s.url}/events`, { signal: controller.signal });
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = decoder.decode((await reader.read()).value);
      expect(text).toContain(": starchart live");
      writeFileSync(join(root, ".starchart", "entities", "pro.yaml"), "id: addon:pro\nfacts:\n  name: Pro Max\n");
      const deadline = Date.now() + 8000;
      while (!text.includes("event: change") && Date.now() < deadline) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value);
      }
      expect(text).toContain("event: change");
      const graph = (await (await fetch(`${s.url}/graph.json`)).json()) as { nodes: { id: string; value?: unknown }[] };
      expect(graph.nodes.find((n) => n.id === "addon:pro.name")?.value).toBe("Pro Max");
      controller.abort();
    } finally {
      await s.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
