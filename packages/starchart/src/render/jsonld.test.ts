import { describe, expect, it } from "vitest";
import { compileProject } from "../compiler/compile.js";
import { ArtifactDoc, EntityDoc, ProjectConfig } from "../config/schema.js";
import { jsonLdScriptTag, schemaOrgFor, toJsonLd } from "./jsonld.js";

function graph() {
  const file = ".starchart/x.yaml";
  const entity = (doc: unknown) => ({ ...EntityDoc.parse(doc), file });
  const artifact = (doc: unknown) => ({ ...ArtifactDoc.parse(doc), file });
  const { graph } = compileProject({
    root: "/tmp",
    config: ProjectConfig.parse({}),
    entities: [
      entity({
        id: "app:main",
        type: ["schema:SoftwareApplication"],
        facts: { name: "Starchart", applicationCategory: "DeveloperApplication", operatingSystem: ["iOS", "macOS"], rating: 4.8, ratingCount: 1200 },
      }),
      entity({
        id: "addon:pro",
        type: ["schema:Offer", "sc:AddOn"],
        of: "app:main",
        status: "active",
        validThrough: "2027-01-01",
        facts: { name: "Pro+", price: { usd: 5.99, eur: 5.49 }, url: "https://example.com/pro" },
      }),
      entity({ id: "addon:lite", type: "schema:Offer", facts: { name: "Lite", price: 2, currency: "gbp" } }),
      entity({
        id: "faq:pricing",
        type: "schema:FAQPage",
        facts: { questions: [{ q: "Is there a trial?", a: "Yes, 7 days." }, { question: "Refunds?", answer: "Within 14 days." }] },
      }),
      entity({ id: "thing:mug", facts: { name: "Mug </script>", brand: "SPZ", sku: "MUG-1", price: 12 } }),
    ],
    artifacts: [artifact({ id: "web:pricing", binding: { adapter: "fs", path: "pricing.html" }, embeds: ["addon:pro.price.usd"], describes: "addon:pro" })],
    edges: [],
    rules: [],
  });
  return graph;
}

describe("toJsonLd", () => {
  it("exports nodes and typed edges with a context", () => {
    const doc = toJsonLd(graph()) as { "@context": Record<string, unknown>; "@graph": Record<string, unknown>[] };
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
    expect(doc["@context"]["@vocab"]).toBe("https://schema.org/");
    expect(doc["@context"].sc).toBe("https://starchart.spacepiratezero.com/vocab#");
    expect(doc["@context"]["sc:embeds"]).toEqual({ "@id": "sc:embeds", "@type": "@id" });
    const byId = new Map(doc["@graph"].map((n) => [n["@id"], n]));
    expect(byId.get("addon:pro")?.["@type"]).toEqual(["schema:Offer", "sc:AddOn"]);
    expect(byId.get("addon:pro.price.usd")).toMatchObject({ "@type": "sc:Fact", "sc:value": 5.99, "sc:partOf": "addon:pro.price" });
    expect(byId.get("addon:pro.price")?.["sc:value"]).toEqual({ "@type": "@json", "@value": { eur: 5.49, usd: 5.99 } });
    expect(byId.get("web:pricing")).toMatchObject({ "sc:embeds": "addon:pro.price.usd", "sc:describes": "addon:pro", "@type": "sc:Artifact" });
  });

  it("restricts to ids", () => {
    const doc = toJsonLd(graph(), { ids: ["web:pricing"] }) as { "@graph": unknown[] };
    expect(doc["@graph"]).toHaveLength(1);
  });
});

describe("schemaOrgFor", () => {
  it("emits one Offer per currency", () => {
    const offers = schemaOrgFor(graph(), "addon:pro") as Record<string, unknown>[];
    expect(Array.isArray(offers)).toBe(true);
    expect(offers).toHaveLength(2);
    expect(offers[0]).toMatchObject({
      "@context": "https://schema.org",
      "@type": "Offer",
      name: "Pro+",
      price: "5.49",
      priceCurrency: "EUR",
      url: "https://example.com/pro",
      availability: "https://schema.org/InStock",
      validThrough: "2027-01-01",
    });
    expect(offers[1]).toMatchObject({ price: "5.99", priceCurrency: "USD" });
  });

  it("emits a single Offer with an explicit currency", () => {
    expect(schemaOrgFor(graph(), "addon:lite")).toMatchObject({ "@type": "Offer", price: "2.00", priceCurrency: "GBP" });
  });

  it("emits a SoftwareApplication with offers of its add-ons and rating", () => {
    const app = schemaOrgFor(graph(), "app:main") as Record<string, unknown>;
    expect(app).toMatchObject({
      "@type": "SoftwareApplication",
      name: "Starchart",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "iOS, macOS",
      aggregateRating: { "@type": "AggregateRating", ratingValue: "4.8", ratingCount: "1200" },
    });
    const offers = app.offers as Record<string, unknown>[];
    expect(offers.map((o) => o.priceCurrency)).toEqual(["EUR", "USD"]);
    expect(offers[0]).not.toHaveProperty("@context");
  });

  it("emits an FAQPage", () => {
    const faq = schemaOrgFor(graph(), "faq:pricing") as { mainEntity: unknown[] };
    expect(faq.mainEntity).toEqual([
      { "@type": "Question", name: "Is there a trial?", acceptedAnswer: { "@type": "Answer", text: "Yes, 7 days." } },
      { "@type": "Question", name: "Refunds?", acceptedAnswer: { "@type": "Answer", text: "Within 14 days." } },
    ]);
  });

  it("falls back to a Product", () => {
    expect(schemaOrgFor(graph(), "thing:mug")).toMatchObject({
      "@type": "Product",
      sku: "MUG-1",
      brand: { "@type": "Brand", name: "SPZ" },
      offers: { "@type": "Offer", price: "12.00", priceCurrency: "USD" },
    });
  });

  it("throws for unknown entities", () => {
    expect(() => schemaOrgFor(graph(), "nope")).toThrow(/unknown node/);
  });
});

describe("jsonLdScriptTag", () => {
  it("escapes < so the block cannot close the script early", () => {
    const tag = jsonLdScriptTag(schemaOrgFor(graph(), "thing:mug"));
    expect(tag.startsWith('<script type="application/ld+json">')).toBe(true);
    expect(tag.endsWith("</script>")).toBe(true);
    expect(tag.slice(0, -"</script>".length)).not.toContain("</script");
    expect(tag).toContain("Mug \\u003c/script\\u003e");
    const json = tag.slice('<script type="application/ld+json">'.length, -"</script>".length);
    expect((JSON.parse(json) as { name: string }).name).toBe("Mug </script>");
  });
});
