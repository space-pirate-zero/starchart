import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CodeConfig } from "../config/schema.js";
import type { Graph } from "../core/graph.js";
import type { EdgeType } from "../core/model.js";
import { ingestCode, lastIngestWarnings } from "./index.js";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/universe", import.meta.url));
const CONFIG: CodeConfig = { scopes: { web: "web", ios: "ios", android: "android", api: "api" }, exclude: [] };

let graph: Graph;

const edge = (from: string, type: EdgeType, to: string) => graph.outgoing(from, type).find((e) => e.to === to);
const hasEdge = (from: string, type: EdgeType, to: string) => edge(from, type, to) !== undefined;

beforeAll(async () => {
  graph = await ingestCode(FIXTURE, CONFIG);
});

describe("ingestCode: files and tests", () => {
  it("creates file nodes with root-relative locations and content hashes", () => {
    const f = graph.node("file:ios/Sources/Paywall/PaywallView.swift")!;
    expect(f.kind).toBe("file");
    expect(f.location).toEqual({ file: "ios/Sources/Paywall/PaywallView.swift", line: 1 });
    expect(f.meta?.path).toBe("ios/Sources/Paywall/PaywallView.swift");
    expect(f.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(graph.hasNode("file:web/app/(marketing)/about/page.tsx")).toBe(true);
  });

  it("turns test files into test nodes (and no file node)", () => {
    for (const id of [
      "test:web/lib/pricing.test.tsx",
      "test:ios/Tests/PaywallTests.swift",
      "test:android/app/src/test/java/com/nebula/PricingTest.kt",
      "test:api/internal/pricing/pricing_test.go",
    ]) {
      expect(graph.node(id)?.kind, id).toBe("test");
      expect(graph.hasNode(id.replace(/^test:/, "file:")), id).toBe(false);
    }
  });

  it("links tests to the symbols and screens they exercise", () => {
    expect(hasEdge("test:web/lib/pricing.test.tsx", "tests", "symbol:web/lib/pricing#formatPrice")).toBe(true);
    expect(hasEdge("test:web/lib/pricing.test.tsx", "tests", "symbol:web/lib/pricing#PRO_PRICE_USD")).toBe(true);
    expect(hasEdge("test:ios/Tests/PaywallTests.swift", "tests", "symbol:ios/PaywallView")).toBe(true);
    expect(hasEdge("test:ios/Tests/PaywallTests.swift", "tests", "screen:ios/Paywall")).toBe(true);
    expect(hasEdge("test:ios/Tests/PaywallTests.swift", "tests", "symbol:ios/Pricing.proUSD")).toBe(true);
    expect(hasEdge("test:android/app/src/test/java/com/nebula/PricingTest.kt", "tests", "symbol:android/Pricing.PRO_USD")).toBe(true);
    expect(hasEdge("test:android/app/src/test/java/com/nebula/PricingTest.kt", "tests", "symbol:android/Tier.PRO")).toBe(true);
    expect(hasEdge("test:api/internal/pricing/pricing_test.go", "tests", "symbol:api/internal/pricing.ProUSD")).toBe(true);
    expect(hasEdge("test:api/internal/pricing/pricing_test.go", "tests", "symbol:api/internal/pricing.Plan")).toBe(true);
  });
});

describe("ingestCode: TypeScript", () => {
  it("extracts top-level symbols with literal values and ranges", () => {
    const price = graph.node("symbol:web/lib/pricing#PRO_PRICE_USD")!;
    expect(price.value).toBe(4.99);
    expect(price.label).toBe("PRO_PRICE_USD");
    expect(price.location).toEqual({ file: "web/lib/pricing.ts", line: 5, endLine: 5 });
    expect(graph.node("symbol:web/lib/pricing#PRO_FEATURES")?.value).toEqual(["themes", "sync"]);
    expect(graph.node("symbol:web/lib/pricing#PLANS")?.value).toEqual({ pro: { usd: 4.99, name: "Nebula Pro" }, free: { usd: 0 } });
    expect(graph.node("symbol:web/lib/pricing#PLANS.pro")?.value).toEqual({ usd: 4.99, name: "Nebula Pro" });
    expect(graph.node("symbol:web/lib/pricing#formatPrice")?.value).toBeUndefined();
    expect(graph.node("symbol:web/lib/pricing#DISPLAY_PRICE")?.value).toBeUndefined();
    expect(hasEdge("file:web/lib/pricing.ts", "contains", "symbol:web/lib/pricing#PRO_PRICE_USD")).toBe(true);
  });

  it("resolves tsconfig path aliases, barrels and re-exports", () => {
    expect(hasEdge("file:web/app/pricing/page.tsx", "imports", "file:web/lib/pricing.ts")).toBe(true);
    expect(hasEdge("file:web/app/pricing/page.tsx", "imports", "file:web/lib/index.ts")).toBe(true);
    expect(hasEdge("file:web/app/api/checkout/route.ts", "imports", "file:web/lib/analytics.ts")).toBe(true);
    const page = "symbol:web/app/pricing/page#PricingPage";
    expect(hasEdge(page, "references", "symbol:web/lib/pricing#PRO_PRICE_USD")).toBe(true);
    expect(hasEdge(page, "references", "symbol:web/lib/pricing#PRO_FEATURES")).toBe(true);
    // `fmt` is `export { formatPrice as fmt } from "./pricing"` in the barrel
    expect(hasEdge(page, "references", "symbol:web/lib/pricing#formatPrice")).toBe(true);
    // PLANS.pro.usd resolves to the member symbol
    expect(hasEdge(page, "references", "symbol:web/lib/pricing#PLANS.pro")).toBe(true);
    expect(hasEdge("symbol:web/lib/pricing#DISPLAY_PRICE", "references", "symbol:web/lib/pricing#formatPrice")).toBe(true);
    expect(hasEdge("symbol:web/lib/pricing#PLANS", "references", "symbol:web/lib/pricing#PLANS.pro")).toBe(true);
  });

  it("links bare imports to npm packages from package.json", () => {
    const pkg = graph.node("pkg:npm/posthog-js")!;
    expect(pkg.kind).toBe("package");
    expect(pkg.meta).toMatchObject({ ecosystem: "npm", version: "^1.200.0", direct: true });
    expect(graph.node("pkg:npm/vitest")?.meta?.dev).toBe(true);
    expect(hasEdge("file:web/app/pricing/page.tsx", "dependsOn", "pkg:npm/posthog-js")).toBe(true);
    expect(hasEdge("file:web/app/pricing/page.tsx", "dependsOn", "pkg:npm/next-intl")).toBe(true);
    expect(hasEdge("file:web/app/api/checkout/route.ts", "dependsOn", "pkg:npm/stripe")).toBe(true);
  });

  it("detects Next.js app router routes", () => {
    expect(graph.node("route:web/")?.label).toBe("/");
    expect(graph.hasNode("route:web/about")).toBe(true);
    expect(graph.hasNode("route:web/blog/[slug]")).toBe(true);
    const pricing = graph.node("route:web/pricing")!;
    expect(pricing.location?.file).toBe("web/app/pricing/page.tsx");
    expect(hasEdge("route:web/pricing", "serves", "symbol:web/app/pricing/page#PricingPage")).toBe(true);
    expect(hasEdge("route:web/", "serves", "symbol:web/app/page#Home")).toBe(true);
    const api = graph.node("route:web/api/checkout")!;
    expect(api.meta?.api).toBe(true);
    expect(hasEdge("route:web/api/checkout", "serves", "symbol:web/app/api/checkout/route#POST")).toBe(true);
  });

  it("extracts env vars, flags, events and translation keys", () => {
    expect(hasEdge("symbol:web/app/api/checkout/route#stripe", "readsEnv", "env:STRIPE_SECRET_KEY")).toBe(true);
    expect(hasEdge("symbol:web/app/api/checkout/route#POST", "readsEnv", "env:STRIPE_WEBHOOK_SECRET")).toBe(true);
    expect(hasEdge("symbol:web/app/api/checkout/route#POST", "emits", "event:checkout_started")).toBe(true);
    expect(hasEdge("symbol:web/app/pricing/page#PricingPage", "emits", "event:pricing_viewed")).toBe(true);
    expect(hasEdge("symbol:web/app/pricing/page#PricingPage", "readsFlag", "flag:new-paywall")).toBe(true);
    expect(graph.node("env:STRIPE_SECRET_KEY")?.kind).toBe("env");
    // useTranslations("pricing") + t("title") -> pricing.title
    expect(hasEdge("symbol:web/app/pricing/page#PricingPage", "references", "i18n:web/pricing.title")).toBe(true);
  });

  it("reads JSON message catalogs as i18n nodes", () => {
    const title = graph.node("i18n:web/pricing.title")!;
    expect(title.value).toEqual({ de: "Mehr mit Nebula Pro", en: "Go further with Nebula Pro" });
    expect(title.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(title.meta?.locations).toEqual([
      { file: "web/messages/de.json", line: 3, locale: "de" },
      { file: "web/messages/en.json", line: 3, locale: "en" },
    ]);
  });

  it("marks codegen output as generated", () => {
    expect(graph.node("symbol:web/lib/generated-facts#PRO")?.meta?.generated).toBe(true);
    expect(graph.node("file:web/lib/generated-facts.ts")?.meta?.generated).toBe(true);
    expect(graph.node("symbol:web/lib/pricing#PRO_PRICE_USD")?.meta?.generated).toBeUndefined();
  });
});

describe("ingestCode: Swift", () => {
  it("extracts types and members, including extension members", () => {
    expect(graph.node("symbol:ios/Pricing")?.meta?.kind).toBe("enum");
    expect(graph.node("symbol:ios/Pricing.proUSD")?.value).toBe(4.99);
    expect(graph.node("symbol:ios/Pricing.proEUR")?.value).toBe(5.49);
    expect(graph.node("symbol:ios/Pricing.proEUR")?.location?.file).toBe("ios/Sources/Core/Pricing+EUR.swift");
    expect(graph.node("symbol:ios/Pricing.tiers")?.value).toEqual({ pro: 4.99, team: 9.99 });
    expect(graph.node("symbol:ios/ProductID.proMonthly")?.value).toBe("pro_monthly");
    expect(graph.node("symbol:ios/Entitlements.proFeatures")?.value).toEqual(["themes", "sync"]);
    const loc = graph.node("symbol:ios/Pricing.proUSD")!.location!;
    expect(loc).toEqual({ file: "ios/Sources/Core/Pricing.swift", line: 4, endLine: 4 });
  });

  it("handles String-backed enum cases and raw values", () => {
    expect(graph.node("symbol:ios/Plan.monthly")?.value).toBe("monthly");
    expect(graph.node("symbol:ios/Plan.yearly")?.value).toBe("annual");
    expect(graph.node("symbol:ios/Plan.lifetime")?.value).toBe("lifetime");
  });

  it("skips comments and string contents (multi-line, raw, interpolated)", () => {
    expect(graph.node("symbol:ios/Entitlements.legalCopy")?.value).toBe("Pro renews monthly. } struct Fake {\nCancel anytime.");
    expect(graph.node("symbol:ios/Entitlements.raw")?.value).toBe('a "quoted" \\(value)');
    expect(graph.hasNode("symbol:ios/Fake")).toBe(false);
    expect(graph.hasNode("symbol:ios/Decoy")).toBe(false);
    // the method after the tricky strings is still found with the right range
    expect(graph.node("symbol:ios/Entitlements.isPro")?.location).toMatchObject({ line: 14, endLine: 16 });
    expect(hasEdge("symbol:ios/Entitlements.isPro", "references", "symbol:ios/Entitlements.proFeatures")).toBe(true);
  });

  it("creates SwiftUI screens and resolves references, including inside interpolation", () => {
    const screen = graph.node("screen:ios/Paywall")!;
    expect(screen.kind).toBe("screen");
    expect(screen.hash).toBe(graph.node("symbol:ios/PaywallView")!.hash);
    expect(hasEdge("screen:ios/Paywall", "references", "symbol:ios/PaywallView")).toBe(true);
    const ref = edge("symbol:ios/PaywallView.body", "references", "symbol:ios/Pricing.proUSD")!;
    expect(ref).toMatchObject({ confidence: 0.8, origin: "extracted" });
    expect(hasEdge("symbol:ios/PaywallView.body", "references", "symbol:ios/ProductID.proMonthly")).toBe(true);
    expect(hasEdge("symbol:ios/PaywallView.body", "references", "symbol:ios/PaywallView.purchase")).toBe(true);
    expect(hasEdge("symbol:ios/PaywallView", "references", "symbol:ios/PaywallView.body")).toBe(true);
  });

  it("maps Swift imports to SwiftPM packages", () => {
    expect(graph.node("pkg:swift/purchases-ios")?.meta).toMatchObject({ version: "5.14.0", direct: true, url: "https://github.com/RevenueCat/purchases-ios.git" });
    expect(hasEdge("file:ios/Sources/Paywall/PaywallView.swift", "dependsOn", "pkg:swift/purchases-ios")).toBe(true);
    expect(hasEdge("file:ios/Sources/App/Telemetry.swift", "dependsOn", "pkg:swift/sentry-cocoa")).toBe(true);
    expect(graph.outgoing("file:ios/Sources/Core/Pricing.swift", "dependsOn")).toEqual([]);
  });

  it("extracts env, flags, events and localization keys", () => {
    expect(hasEdge("symbol:ios/Telemetry.start", "readsEnv", "env:SENTRY_DSN")).toBe(true);
    expect(hasEdge("symbol:ios/Telemetry.start", "emits", "event:app_opened")).toBe(true);
    expect(hasEdge("symbol:ios/PaywallView.body", "readsFlag", "flag:new-paywall")).toBe(true);
    expect(hasEdge("symbol:ios/PaywallView.body", "references", "i18n:ios/paywall.title")).toBe(true);
    expect(hasEdge("symbol:ios/PaywallView.body", "references", "i18n:ios/Subscribe")).toBe(true);
    expect(graph.node("i18n:ios/paywall.title")?.value).toEqual({ de: "Nebula Pro freischalten", en: "Unlock Nebula Pro" });
    expect(graph.node("i18n:ios/Subscribe")?.value).toEqual({ en: "Subscribe" });
    expect(graph.node("i18n:ios/NSCameraUsageDescription")?.value).toEqual({ de: "Pro-Karte scannen", en: 'Scan your "Pro" card' });
    expect(graph.hasNode("i18n:ios/not a key")).toBe(false);
  });
});

describe("ingestCode: Kotlin and Go", () => {
  it("extracts Kotlin objects, enums and Compose screens", () => {
    expect(graph.node("symbol:android/Pricing.PRO_USD")?.value).toBe(4.99);
    expect(graph.node("symbol:android/Pricing.FEATURES")?.value).toEqual(["themes", "sync"]);
    expect(graph.node("symbol:android/Pricing.LABEL")?.value).toBeUndefined();
    expect(graph.node("symbol:android/Tier.PRO")?.value).toBe("pro_monthly");
    expect(graph.hasNode("symbol:android/Tier.isPaid")).toBe(true);
    expect(hasEdge("screen:android/Paywall", "references", "symbol:android/PaywallScreen")).toBe(true);
    expect(hasEdge("symbol:android/PaywallScreen", "references", "symbol:android/Pricing.PRO_USD")).toBe(true);
    expect(hasEdge("symbol:android/PaywallScreen", "readsEnv", "env:API_URL")).toBe(true);
    expect(hasEdge("symbol:android/PaywallScreen", "readsFlag", "flag:new-paywall")).toBe(true);
    expect(hasEdge("symbol:android/PaywallScreen", "emits", "event:paywall_shown")).toBe(true);
    expect(hasEdge("symbol:android/PaywallScreen", "references", "i18n:android/paywall_title")).toBe(true);
    expect(graph.node("i18n:android/paywall_title")?.value).toEqual({ de: "Nebula Pro freischalten", default: "Unlock Nebula Pro & more" });
  });

  it("reads Gradle dependencies and version catalogs, matching Kotlin imports by group", () => {
    expect(graph.node("pkg:gradle/androidx.compose.ui:ui")?.meta?.version).toBe("1.7.5");
    expect(graph.node("pkg:gradle/com.revenuecat.purchases:purchases")?.meta?.version).toBe("8.10.0");
    const file = "file:android/app/src/main/java/com/nebula/PaywallScreen.kt";
    expect(hasEdge(file, "dependsOn", "pkg:gradle/com.revenuecat.purchases:purchases")).toBe(true);
    expect(hasEdge(file, "dependsOn", "pkg:gradle/com.posthog:posthog-android")).toBe(true);
    expect(hasEdge(file, "dependsOn", "pkg:gradle/junit:junit")).toBe(false);
  });

  it("extracts Go declarations with package-directory namespaces", () => {
    expect(graph.node("symbol:api/internal/pricing.ProMonthly")?.value).toBe("pro_monthly");
    expect(graph.node("symbol:api/internal/pricing.ProUSD")?.value).toBe(4.99);
    expect(graph.node("symbol:api/internal/pricing.Features")?.value).toEqual(["themes", "sync"]);
    expect(graph.hasNode("symbol:api/internal/pricing.Plan.Total")).toBe(true);
    expect(hasEdge("symbol:api/internal/pricing.Plan.Total", "references", "symbol:api/internal/pricing.ProUSD")).toBe(true);
    expect(hasEdge("symbol:api/main.main", "references", "symbol:api/internal/pricing.ProUSD")).toBe(true);
    expect(hasEdge("symbol:api/main.main", "readsEnv", "env:STRIPE_KEY")).toBe(true);
  });

  it("reads go.mod requirements, flagging indirect ones as transitive", () => {
    expect(graph.node("pkg:go/github.com/stripe/stripe-go/v76")?.meta).toMatchObject({ version: "v76.25.0", direct: true });
    expect(graph.node("pkg:go/golang.org/x/text")?.meta).toMatchObject({ transitive: true });
    expect(graph.node("pkg:go/golang.org/x/text")?.meta?.direct).toBeUndefined();
    expect(hasEdge("file:api/main.go", "dependsOn", "pkg:go/github.com/stripe/stripe-go/v76")).toBe(true);
  });
});

describe("ingestCode: annotations", () => {
  it("attaches a preceding annotation to the next declaration", () => {
    expect(edge("symbol:ios/ProductID.proMonthly", "anchors", "addon:pro.productId")).toMatchObject({ origin: "annotation", confidence: 1 });
    expect(edge("symbol:web/lib/pricing#PRO_PRICE_USD", "anchors", "addon:pro.price.usd")).toMatchObject({ origin: "annotation" });
  });

  it("attaches trailing and in-body annotations to the enclosing declaration", () => {
    expect(hasEdge("symbol:web/app/pricing/page#PricingPage", "publishes", "web:pricing-page")).toBe(true);
    expect(hasEdge("symbol:web/app/pricing/page#PricingPage", "displays", "addon:pro.price")).toBe(true);
  });

  it("annotates non-code files through their file node", () => {
    expect(graph.node("file:web/README.md")?.kind).toBe("file");
    expect(hasEdge("file:web/README.md", "describes", "addon:pro")).toBe(true);
  });

  it("reports unknown edge types as warnings", () => {
    expect(lastIngestWarnings()).toEqual(['web/lib/pricing.ts:16: unknown @starchart edge type "frobnicates"']);
  });
});

describe("ingestCode: stability", () => {
  let tmp: string;
  afterAll(() => tmp && rmSync(tmp, { recursive: true, force: true }));

  it("produces identical hashes across runs and ignores line shifts and reformatting", async () => {
    const again = await ingestCode(FIXTURE, CONFIG);
    expect(again.toJSON()).toEqual(graph.toJSON());

    tmp = mkdtempSync(join(tmpdir(), "starchart-stable-"));
    cpSync(FIXTURE, tmp, { recursive: true });
    const swift = join(tmp, "ios/Sources/Core/Pricing.swift");
    writeFileSync(swift, `\n\n// moved down\n${readFileSync(swift, "utf8").replace("static let proUSD = 4.99", "static  let   proUSD =\n        4.99")}`);
    const shifted = await ingestCode(tmp, CONFIG);
    const before = graph.node("symbol:ios/Pricing.proUSD")!;
    const after = shifted.node("symbol:ios/Pricing.proUSD")!;
    expect(after.location?.line).toBe(before.location!.line! + 3);
    expect(after.hash).toBe(before.hash);
    expect(after.value).toBe(4.99);
    expect(shifted.node("file:ios/Sources/Core/Pricing.swift")!.hash).not.toBe(graph.node("file:ios/Sources/Core/Pricing.swift")!.hash);

    writeFileSync(swift, readFileSync(swift, "utf8").replace("4.99", "5.99"));
    const changed = await ingestCode(tmp, CONFIG);
    expect(changed.node("symbol:ios/Pricing.proUSD")!.hash).not.toBe(before.hash);
    expect(changed.node("symbol:ios/Pricing.proUSD")!.value).toBe(5.99);
  });
});

describe("ingestCode: example project and scale", () => {
  const example = fileURLToPath(new URL("../../../../examples/pro-universe", import.meta.url));

  it.skipIf(!existsSync(example))("maps Swift module imports to SwiftPM identities in the pro-universe example", async () => {
    const g = await ingestCode(example, { scopes: { web: "apps/web", ios: "apps/ios" }, exclude: [] });
    expect(g.outgoing("file:ios/Sources/Core/Telemetry.swift", "dependsOn").map((e) => e.to)).toEqual(["pkg:swift/sentry-cocoa"]);
    expect(g.outgoing("file:ios/Sources/Paywall/PaywallView.swift", "dependsOn").map((e) => e.to)).toEqual(["pkg:swift/purchases-ios"]);
    expect(g.node("pkg:swift/sentry-cocoa")?.meta?.direct).toBe(true);
    expect(g.node("symbol:ios/Entitlements.proFeatures")?.value).toEqual(["Themes", "iCloud sync"]);
  });

  it("ingests a couple of thousand files quickly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "starchart-scale-"));
    try {
      for (let i = 0; i < 1200; i++) {
        const sub = join(dir, "web", `mod${i % 40}`);
        mkdirSync(sub, { recursive: true });
        const next = (i + 1) % 1200;
        writeFileSync(
          join(sub, `file${i}.ts`),
          `import { helper${next} } from "../mod${next % 40}/file${next}";\nexport const NAME_${i} = "value-${i}";\nexport function helper${i}(x: number): number {\n  if (process.env.FLAG_${i % 10}) track("event_${i % 7}");\n  return helper${next}(x) + ${i};\n}\n`,
        );
      }
      for (let i = 0; i < 800; i++) {
        const sub = join(dir, "ios", `Mod${i % 20}`);
        mkdirSync(sub, { recursive: true });
        writeFileSync(join(sub, `Type${i}.swift`), `import SwiftUI\n\nstruct Type${i}View: View {\n    static let id = "type-${i}"\n    var body: some View { Text("\\(Type${(i + 1) % 800}View.id)") }\n}\n`);
      }
      const started = performance.now();
      const g = await ingestCode(dir, { scopes: { web: "web", ios: "ios" }, exclude: [] });
      const elapsed = performance.now() - started;
      expect(g.nodes({ kind: "file" })).toHaveLength(2000);
      expect(g.nodes({ kind: "screen" })).toHaveLength(800);
      expect(g.outgoing("symbol:web/mod0/file0#helper0", "references").map((e) => e.to)).toEqual(["symbol:web/mod1/file1#helper1"]);
      expect(elapsed).toBeLessThan(8000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
