import { describe, expect, it } from "vitest";
import { ProjectConfig } from "../config/schema.js";
import { Graph } from "../core/graph.js";
import { buildLock } from "../core/lock.js";
import type { Project } from "../project.js";
import { APP_STORE_URL_PATTERN, xrayPayload } from "./xray.js";

function project(): Project {
  const g = new Graph();
  g.addNode({ id: "addon:pro", kind: "entity" });
  g.addNode({ id: "addon:pro.price", kind: "fact", value: { usd: 4.99 } });
  g.addNode({ id: "addon:pro.price.usd", kind: "fact", value: 4.99 });
  g.addNode({ id: "addon:pro.name", kind: "fact", value: "Pro" });
  g.addNode({ id: "addon:pro.features", kind: "fact", value: ["themes", "sync"] });
  g.addEdge({ from: "addon:pro.price.usd", to: "addon:pro.price", type: "partOf" });
  g.addEdge({ from: "addon:pro.price", to: "addon:pro", type: "partOf" });
  g.addEdge({ from: "addon:pro.name", to: "addon:pro", type: "partOf" });
  g.addEdge({ from: "addon:pro.features", to: "addon:pro", type: "partOf" });

  g.addNode({ id: "web:pricing", kind: "artifact", label: "Pricing", binding: { adapter: "url", url: "/pricing" } });
  g.addNode({ id: "appstore:listing", kind: "artifact", binding: { adapter: "appstore", app: "123" } });
  g.addNode({ id: "stripe:price/pro", kind: "artifact", binding: { adapter: "stripe" }, meta: { urls: ["https://buy.stripe.com/*", 7] } });
  g.addNode({ id: "web:blog", kind: "artifact", binding: { adapter: "fs", path: "blog.md" } });
  g.addEdge({ from: "web:pricing", to: "addon:pro.price.usd", type: "embeds" });
  g.addEdge({ from: "appstore:listing", to: "addon:pro.name", type: "embeds" });
  g.addEdge({ from: "stripe:price/pro", to: "addon:pro.price", type: "mirrors" });
  g.addEdge({ from: "web:blog", to: "addon:pro", type: "describes" });

  const lock = buildLock(g);
  // The world was synced at 4.99 / "Pro"; the graph has since moved on.
  g.addNode({ id: "addon:pro.price.usd", kind: "fact", value: 5.99 });
  g.addNode({ id: "addon:pro.price", kind: "fact", value: { usd: 5.99 } });

  return {
    root: "/tmp/x",
    loaded: {
      root: "/tmp/x",
      config: ProjectConfig.parse({ name: "demo", site: "https://example.com" }),
      entities: [],
      artifacts: [],
      edges: [],
      rules: [],
    },
    graph: g,
    lock,
    warnings: [],
  };
}

describe("xrayPayload", () => {
  it("lists leaf facts with display values and stale previous values", () => {
    const payload = xrayPayload(project());
    expect(payload.name).toBe("demo");
    expect(payload.facts.map((f) => f.id)).toEqual(["addon:pro.name", "addon:pro.price.usd"]);
    const price = payload.facts.find((f) => f.id === "addon:pro.price.usd")!;
    expect(price.value).toBe("5.99");
    expect(price.previous).toBe("4.99");
    // embeds the leaf directly, mirrors its parent
    expect(price.artifacts).toEqual(["stripe:price/pro", "web:pricing"]);
    const name = payload.facts.find((f) => f.id === "addon:pro.name")!;
    expect(name.previous).toBeUndefined();
    expect(name.artifacts).toEqual(["appstore:listing"]);
    expect(payload.staleValues).toEqual(["4.99"]);
  });

  it("describes artifacts with URLs, stale flags and edge hints", () => {
    const { artifacts } = xrayPayload(project());
    const byId = Object.fromEntries(artifacts.map((a) => [a.id, a]));
    expect(byId["web:pricing"]).toEqual({
      id: "web:pricing",
      label: "Pricing",
      urls: ["https://example.com/pricing"],
      stale: true,
      adapter: "url",
      edges: ["embeds"],
    });
    expect(byId["appstore:listing"]?.urls).toEqual([APP_STORE_URL_PATTERN]);
    expect(byId["appstore:listing"]?.stale).toBe(false);
    expect(byId["stripe:price/pro"]?.urls).toEqual(["https://buy.stripe.com/*"]);
    expect(byId["stripe:price/pro"]?.stale).toBe(true);
    expect(byId["web:blog"]?.urls).toEqual([]);
    expect(byId["web:blog"]?.edges).toEqual([]);
  });
});
