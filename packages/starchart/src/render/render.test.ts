import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Graph } from "../core/graph.js";
import { renderOg, svgWidth } from "./og.js";
import { escapeFor, formatMoney, renderTemplate } from "./template.js";

function graph(): Graph {
  const g = new Graph();
  g.addNode({ id: "addon:pro.name", kind: "fact", value: "Pro <Plus>" });
  g.addNode({ id: "addon:pro.price", kind: "fact", value: { usd: 5.99, eur: 5.49, gbp: 4.99, jpy: 900 } });
  g.addNode({ id: "addon:pro.price.usd", kind: "fact", value: 5.99 });
  g.addNode({ id: "addon:pro.features", kind: "fact", value: ["themes", "sync"] });
  return g;
}

describe("renderTemplate", () => {
  it("resolves facts with and without the fact: prefix", () => {
    expect(renderTemplate("{{ fact:addon:pro.price.usd }} / {{addon:pro.name}}", graph())).toBe("5.99 / Pro <Plus>");
  });

  it("applies filters", () => {
    const g = graph();
    expect(renderTemplate("{{ addon:pro.price.usd | money:USD }}", g)).toBe("$5.99");
    expect(renderTemplate("{{ addon:pro.price | money:EUR }}", g)).toBe("€5.49");
    expect(renderTemplate("{{ addon:pro.price | money:GBP }}", g)).toBe("£4.99");
    expect(renderTemplate("{{ addon:pro.price | money:JPY }}", g)).toBe("¥900");
    expect(renderTemplate("{{ addon:pro.name | upper }}|{{ addon:pro.name | lower }}", g)).toBe("PRO <PLUS>|pro <plus>");
    expect(renderTemplate('{{ addon:pro.features | join:" · " }}', g)).toBe("themes · sync");
    expect(renderTemplate('{{ addon:pro.features | join:", " | upper }}', g)).toBe("THEMES, SYNC");
    expect(renderTemplate('{{ addon:pro.tagline | default:"Go | Pro" }}', g)).toBe("Go | Pro");
    expect(renderTemplate("{{ title }}", g, { title: "Hi" })).toBe("Hi");
  });

  it("escapes for XML when asked", () => {
    expect(renderTemplate("<t>{{ addon:pro.name }}</t>", graph(), {}, { escape: "xml" })).toBe("<t>Pro &lt;Plus&gt;</t>");
    expect(escapeFor("og.svg")).toBe("xml");
    expect(escapeFor("copy.md")).toBe("none");
  });

  it("throws on unknown facts and filters, naming the template", () => {
    expect(() => renderTemplate("{{ addon:nope }}", graph(), {}, { name: "og.svg" })).toThrow('og.svg: unknown fact "addon:nope"');
    expect(() => renderTemplate("{{ addon:pro.name | shout }}", graph())).toThrow(/unknown filter "shout"/);
    expect(() => formatMoney("abc", "USD")).toThrow(/needs a number/);
  });
});

describe("renderOg", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "starchart-og-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100" fill="#030303"/><text x="10" y="50" fill="#ff1493">{{ addon:pro.name }} {{ addon:pro.price.usd | money:USD }}</text></svg>';

  it("writes a valid PNG at the template's width", async () => {
    writeFileSync(join(dir, "og.svg"), svg);
    const out = join(dir, "nested/og.png");
    const { bytes } = await renderOg(join(dir, "og.svg"), graph(), out);
    const buf = readFileSync(out);
    expect(bytes).toBe(buf.length);
    expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const png = PNG.sync.read(buf);
    expect([png.width, png.height]).toEqual([200, 100]);
  });

  it("writes escaped SVG as-is", async () => {
    writeFileSync(join(dir, "og.svg"), svg);
    await renderOg(join(dir, "og.svg"), graph(), join(dir, "og-out.svg"));
    expect(readFileSync(join(dir, "og-out.svg"), "utf8")).toContain("Pro &lt;Plus&gt; $5.99");
  });

  it("reads the intrinsic width", () => {
    expect(svgWidth('<svg width="1200px" height="630">')).toBe(1200);
    expect(svgWidth('<svg viewBox="0 0 800 400">')).toBe(800);
    expect(svgWidth("<svg>")).toBeUndefined();
  });
});
