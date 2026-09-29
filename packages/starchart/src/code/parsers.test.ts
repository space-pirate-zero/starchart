import { describe, expect, it } from "vitest";
import { annotationTarget, parseAnnotations, scanTextAnnotations } from "./annotations.js";
import { classify, isTestPath } from "./files.js";
import { parseGo } from "./golang.js";
import { jsonKeyLines, parseI18nFile } from "./i18n.js";
import { parseKotlin } from "./kotlin.js";
import { lex } from "./lexer.js";
import { npmPackageName, PackageIndex } from "./packages.js";
import { detectRoute } from "./routes.js";
import { parseSwift } from "./swift.js";
import { loadTsConfig, TsResolver } from "./tsresolve.js";
import type { Diagnostics, SourceFile, SourceLang } from "./types.js";
import { parseTypeScript } from "./typescript.js";

const src = (rel: string, lang: SourceLang, scope = "app", isTest = false): SourceFile => ({ scope, scopeDir: scope, rel, path: `${scope}/${rel}`, abs: `/x/${scope}/${rel}`, lang, isTest });
const diag = (): Diagnostics & { messages: string[] } => {
  const messages: string[] = [];
  return { messages, warn: (m) => messages.push(m) };
};

describe("lexer", () => {
  it("skips nested Swift block comments and keeps brace matching intact", () => {
    const { tokens, comments, match } = lex("/* a /* b */ { */ struct A { let x = \"}\" }", "swift");
    expect(comments).toHaveLength(1);
    expect(tokens.map((t) => t.v)).toEqual(["struct", "A", "{", "let", "x", "=", '"}"', "}"]);
    expect(match[2]).toBe(7);
  });

  it("lexes Swift interpolation, emitting inner tokens", () => {
    const { tokens } = lex('Text("Price: \\(Pricing.proUSD, format: .currency(code: "USD"))!")', "swift");
    const str = tokens.find((t) => t.k === "str" && t.interp);
    expect(str).toBeDefined();
    expect(tokens.filter((t) => t.k === "id").map((t) => t.v)).toEqual(["Text", "Pricing", "proUSD", "format", "currency", "code"]);
    expect(tokens.find((t) => t.k === "str" && !t.interp)?.s).toBe("USD");
  });

  it("decodes Swift multi-line and raw strings", () => {
    const { tokens } = lex('let a = """\n    line 1\n      line 2\n    """\nlet b = #"no \\(interp) "here""#', "swift");
    const strs = tokens.filter((t) => t.k === "str");
    expect(strs[0]!.s).toBe("line 1\n  line 2");
    expect(strs[1]!.s).toBe('no \\(interp) "here"');
    expect(strs[0]!.line).toBe(1);
    expect(strs[0]!.endLine).toBe(4);
  });

  it("handles Kotlin templates and raw strings", () => {
    const { tokens } = lex('val s = "a $name ${user.id} b"\nval r = """x { y"""\nval c = \'}\'', "kotlin");
    expect(tokens.filter((t) => t.k === "id").map((t) => t.v)).toEqual(["val", "s", "name", "user", "id", "val", "r", "val", "c"]);
    expect(tokens.filter((t) => t.k === "str")[1]!.s).toBe("x { y");
    expect(tokens.filter((t) => t.k === "p" && (t.v === "{" || t.v === "}"))).toHaveLength(0);
  });

  it("handles Go raw strings, runes and numbers", () => {
    const { tokens } = lex("const X = `a\n}` + 'x' + 1_000 + 0x1F + 4.99", "go");
    expect(tokens.find((t) => t.k === "str")?.s).toBe("a\n}");
    expect(tokens.filter((t) => t.k === "num").map((t) => t.n)).toEqual([1000, 31, 4.99]);
  });
});

describe("parseSwift", () => {
  it("parses nested types, attributes, overloads and protocol requirements", () => {
    const text = [
      "@MainActor",
      "final class Store: ObservableObject {",
      "    @Published private(set) var items: [String] = []",
      "    enum Kind: String { case a, b }",
      "    func load() {}",
      "    func load(id: Int) {",
      "        items = []",
      "    }",
      "}",
      "protocol Loader {",
      "    func load()",
      "    var name: String { get }",
      "}",
    ].join("\n");
    const p = parseSwift(src("Store.swift", "swift"), text, false);
    const byId = new Map(p.symbols.map((s) => [s.id, s]));
    expect([...byId.keys()].sort()).toEqual([
      "symbol:app/Loader",
      "symbol:app/Loader.load",
      "symbol:app/Loader.name",
      "symbol:app/Store",
      "symbol:app/Store.Kind",
      "symbol:app/Store.Kind.a",
      "symbol:app/Store.Kind.b",
      "symbol:app/Store.items",
      "symbol:app/Store.load",
    ]);
    expect(byId.get("symbol:app/Store")).toMatchObject({ line: 1, endLine: 9, kind: "class" });
    expect(byId.get("symbol:app/Store.items")).toMatchObject({ line: 3, endLine: 3 });
    expect(byId.get("symbol:app/Store.load")?.ranges).toEqual([
      [5, 5],
      [6, 8],
    ]);
    expect(byId.get("symbol:app/Loader.load")).toMatchObject({ line: 11, endLine: 11 });
    expect(byId.get("symbol:app/Store.Kind.a")?.value).toBe("a");
  });

  it("keeps multi-line initializers and member chains in one declaration", () => {
    const text = ["enum Copy {", "    static let features = [", '        "themes",', '        "sync",', "    ]", "    static let upper = features", "        .map { $0.uppercased() }", "}"].join("\n");
    const p = parseSwift(src("Copy.swift", "swift"), text, false);
    const features = p.symbols.find((s) => s.name === "features")!;
    expect(features).toMatchObject({ line: 2, endLine: 5, value: ["themes", "sync"] });
    expect(p.symbols.find((s) => s.name === "upper")).toMatchObject({ line: 6, endLine: 7 });
  });
});

describe("parseKotlin", () => {
  it("flattens companion objects into their class and reads const vals", () => {
    const text = ["class Config {", "    companion object {", '        const val API = "https://api"', "        val RETRIES = 3", "    }", "    fun String.slug() = lowercase()", "}", "fun Int.cents(): Int = this * 100"].join("\n");
    const p = parseKotlin(src("Config.kt", "kotlin"), text, false);
    const ids = p.symbols.map((s) => s.id).sort();
    expect(ids).toEqual(["symbol:app/Config", "symbol:app/Config.API", "symbol:app/Config.RETRIES", "symbol:app/Config.slug", "symbol:app/Int.cents"]);
    expect(p.symbols.find((s) => s.name === "API")?.value).toBe("https://api");
    expect(p.symbols.find((s) => s.name === "RETRIES")?.value).toBe(3);
  });

  it("parses mapOf/listOf literals", () => {
    const p = parseKotlin(src("P.kt", "kotlin"), 'val PRICES = mapOf("usd" to 4.99, "eur" to 5.49)\nval TAGS = listOf<String>("a", "b")', false);
    expect(p.symbols.find((s) => s.name === "PRICES")?.value).toEqual({ usd: 4.99, eur: 5.49 });
    expect(p.symbols.find((s) => s.name === "TAGS")?.value).toEqual(["a", "b"]);
  });
});

describe("parseGo", () => {
  it("parses grouped declarations, multi-name specs and methods", () => {
    const text = [
      "package billing",
      "",
      'import str "strings"',
      "",
      "const (",
      '\tA, B = "a", "b"',
      "\tC    = iota",
      ")",
      "",
      "type (",
      "\tID string",
      "\tPlan struct{ Name string }",
      ")",
      "",
      "func (p Plan) Label() string { return str.ToUpper(p.Name) }",
    ].join("\n");
    const p = parseGo(src("billing/billing.go", "go", "api"), text, false);
    const byId = new Map(p.symbols.map((s) => [s.id, s]));
    expect(byId.get("symbol:api/billing.A")?.value).toBe("a");
    expect(byId.get("symbol:api/billing.B")?.value).toBe("b");
    expect(byId.get("symbol:api/billing.C")?.value).toBeUndefined();
    expect(byId.has("symbol:api/billing.ID")).toBe(true);
    expect(byId.get("symbol:api/billing.Plan.Label")).toMatchObject({ parent: "symbol:api/billing.Plan", line: 15 });
    expect(p.go?.aliases).toEqual({ str: "strings" });
  });

  it("uses the package name as namespace at the scope root", () => {
    const p = parseGo(src("main.go", "go", "api"), "package main\n\nfunc main() {}\n", false);
    expect(p.symbols.map((s) => s.id)).toEqual(["symbol:api/main.main"]);
  });
});

describe("parseTypeScript", () => {
  it("records classes, enums, re-exports and default exports", () => {
    const text = [
      "export enum Tier { Free, Pro = 5, Team }",
      "export class Store {",
      '  static readonly KEY = "store";',
      "  load() { return Tier.Pro; }",
      "}",
      "const hidden = 1;",
      "export default hidden;",
      'export * from "./other";',
      'export { a as b } from "./third";',
    ].join("\n");
    const p = parseTypeScript(src("store.ts", "ts"), text, false);
    const byId = new Map(p.symbols.map((s) => [s.id, s]));
    expect(byId.get("symbol:app/store#Tier.Free")?.value).toBe(0);
    expect(byId.get("symbol:app/store#Tier.Pro")?.value).toBe(5);
    expect(byId.get("symbol:app/store#Tier.Team")?.value).toBe(6);
    expect(byId.get("symbol:app/store#Store.KEY")?.value).toBe("store");
    expect(p.exports.get("default")).toEqual({ local: "hidden" });
    expect(p.exports.get("b")).toEqual({ from: "./third", imported: "a" });
    expect(p.starExports).toEqual(["./other"]);
    expect(p.localRefs).toContainEqual({ from: "symbol:app/store#Store.load", name: "Tier", member: "Pro" });
  });

  it("finds env reads through destructuring and import.meta.env", () => {
    const text = "const { API_URL, TOKEN: tok } = process.env;\nexport const x = import.meta.env.VITE_KEY;";
    const p = parseTypeScript(src("env.ts", "ts"), text, false);
    expect(p.signals.map((s) => s.name).sort()).toEqual(["API_URL", "TOKEN", "VITE_KEY"]);
  });
});

describe("annotations", () => {
  it("parses several directives and stops at prose", () => {
    const entries = parseAnnotations({ text: "/* @starchart anchors addon:pro.price, addon:pro.price.usd (price)\n * @starchart screen Paywall */", line: 10, endLine: 11, trailing: false });
    expect(entries).toEqual([
      { verb: "anchors", targets: ["addon:pro.price", "addon:pro.price.usd"], line: 10 },
      { verb: "screen", targets: ["Paywall"], line: 11 },
    ]);
  });

  it("finds directives in markdown, yaml and html comments", () => {
    const found = scanTextAnnotations("# title\n<!-- @starchart describes addon:pro -->\nkey: 1 # @starchart embeds addon:pro.name\nplain @starchart mention");
    expect(found.map((c) => c.line)).toEqual([2, 3]);
  });

  it("attaches to the next declaration only across blank or comment lines", () => {
    const symbols = [
      { id: "a", name: "a", qname: "a", kind: "let", line: 3, endLine: 3, depth: 0, hash: "" },
      { id: "b", name: "b", qname: "b", kind: "func", line: 6, endLine: 9, depth: 0, hash: "" },
    ];
    const code = new Set([1, 3, 5, 6, 7, 8, 9]);
    expect(annotationTarget({ text: "", line: 2, endLine: 2, trailing: false }, symbols, code, "file")).toBe("a");
    expect(annotationTarget({ text: "", line: 4, endLine: 4, trailing: false }, symbols, code, "file")).toBe("file");
    expect(annotationTarget({ text: "", line: 7, endLine: 7, trailing: true }, symbols, code, "file")).toBe("b");
    expect(annotationTarget({ text: "", line: 6, endLine: 6, trailing: true }, symbols, code, "file")).toBe("b");
  });
});

describe("routes", () => {
  it("maps the pages router, skipping _app and private folders", () => {
    const route = (rel: string) => detectRoute(src(rel, "ts", "web"), [""]);
    expect(route("pages/index.tsx")?.id).toBe("route:web/");
    expect(route("pages/blog/[slug].tsx")?.id).toBe("route:web/blog/[slug]");
    expect(route("src/pages/docs/index.mdx")?.id).toBe("route:web/docs");
    expect(route("pages/api/hello.ts")).toMatchObject({ id: "route:web/api/hello", api: true });
    expect(route("pages/_app.tsx")).toBeUndefined();
    expect(route("app/_components/page.tsx")).toBeUndefined();
    expect(route("app/(shop)/@modal/cart/page.tsx")?.id).toBe("route:web/cart");
    expect(route("app/components/Button.tsx")).toBeUndefined();
  });
});

describe("files", () => {
  it("classifies files and test paths", () => {
    expect(classify("src/a.ts")?.role).toBe("code");
    expect(classify("src/a.d.ts")).toBeUndefined();
    expect(classify("Resources/en.lproj/Localizable.strings")?.role).toBe("i18n");
    expect(classify("app/src/main/res/values-fr/strings.xml")?.role).toBe("i18n");
    expect(classify("locales/en/common.json")?.role).toBe("i18n");
    expect(classify("config/settings.json")).toBeUndefined();
    expect(classify("App.xcodeproj/project.pbxproj")?.role).toBe("manifest");
    expect(isTestPath("src/__tests__/x.ts", "ts")).toBe(true);
    expect(isTestPath("src/x.spec.tsx", "ts")).toBe(true);
    expect(isTestPath("AppTests/LoginTests.swift", "swift")).toBe(true);
    expect(isTestPath("app/src/test/java/A.kt", "kotlin")).toBe(true);
    expect(isTestPath("x_test.go", "go")).toBe(true);
    expect(isTestPath("src/testing.ts", "ts")).toBe(false);
  });
});

describe("i18n", () => {
  it("records JSON key lines for nested paths", () => {
    const lines = jsonKeyLines('{\n  "a": {\n    "b": "x",\n    "c": ["y", {"d": 1}]\n  }\n}');
    expect(lines.get("a")).toBe(2);
    expect(lines.get("a\u0000b")).toBe(3);
    expect(lines.get("a\u0000c\u00001\u0000d")).toBe(4);
  });

  it("reads xcstrings plural variations and locale-folder JSON", () => {
    const xc = JSON.stringify({
      sourceLanguage: "en",
      strings: { items: { localizations: { en: { variations: { plural: { one: { stringUnit: { value: "1 item" } }, other: { stringUnit: { value: "%d items" } } } } } } } },
    });
    expect(parseI18nFile("L.xcstrings", xc, diag(), "L.xcstrings")).toEqual([{ key: "items", locale: "en", value: "%d items", line: 1 }]);
    const json = parseI18nFile("locales/pt-BR/common.json", '{"nav": {"home": "Início"}}', diag(), "x");
    expect(json).toEqual([{ key: "nav.home", locale: "pt-BR", value: "Início", line: 1 }]);
  });

  it("warns on unparsable catalogs", () => {
    const d = diag();
    expect(parseI18nFile("messages/en.json", "{ nope", d, "web/messages/en.json")).toEqual([]);
    expect(d.messages[0]).toMatch(/web\/messages\/en.json: could not parse localization file/);
  });
});

describe("packages", () => {
  it("parses Package.resolved v1, Package.swift products and pbxproj references", () => {
    const idx = new PackageIndex();
    const d = diag();
    idx.parse(
      "Package.resolved",
      "ios/Package.resolved",
      "ios",
      JSON.stringify({ object: { pins: [{ package: "Firebase", repositoryURL: "https://github.com/firebase/firebase-ios-sdk.git", state: { version: "11.0.0" } }, { package: "Nuke", repositoryURL: "https://github.com/kean/Nuke", state: { version: "12.0.0" } }] }, version: 1 }),
      d,
    );
    idx.parse(
      "project.pbxproj",
      "ios/App.xcodeproj/project.pbxproj",
      "ios",
      [
        "\t\tAAA /* XCRemoteSwiftPackageReference \"firebase-ios-sdk\" */ = {",
        "\t\t\tisa = XCRemoteSwiftPackageReference;",
        '\t\t\trepositoryURL = "https://github.com/firebase/firebase-ios-sdk.git";',
        "\t\t};",
        "\t\tBBB /* FirebaseAnalytics */ = {",
        "\t\t\tisa = XCSwiftPackageProductDependency;",
        '\t\t\tpackage = AAA /* XCRemoteSwiftPackageReference "firebase-ios-sdk" */;',
        "\t\t\tproductName = FirebaseAnalytics;",
        "\t\t};",
      ].join("\n"),
      d,
    );
    idx.parse("Package.swift", "pkg/Package.swift", "pkg", '.package(url: "https://github.com/pointfreeco/swift-composable-architecture", from: "1.10.0"),\n.product(name: "ComposableArchitecture", package: "swift-composable-architecture")', d);
    idx.finalize();
    expect(d.messages).toEqual([]);
    expect(idx.packages.get("pkg:swift/firebase-ios-sdk")).toMatchObject({ version: "11.0.0", direct: true });
    // Nuke is only pinned, never declared by the Xcode project: transitive
    expect(idx.packages.get("pkg:swift/nuke")).toMatchObject({ direct: false, transitive: true });
    expect(idx.matchSwiftModule("FirebaseAnalytics", "ios")).toEqual(["pkg:swift/firebase-ios-sdk"]);
    expect(idx.matchSwiftModule("Nuke", "ios")).toEqual(["pkg:swift/nuke"]);
    expect(idx.matchSwiftModule("ComposableArchitecture", "pkg")).toEqual(["pkg:swift/swift-composable-architecture"]);
    expect(idx.matchSwiftModule("SwiftUI", "ios")).toEqual([]);
    expect(idx.matchSwiftModule("Nebula", "ios")).toEqual([]);
  });

  it("matches well-known SDK module names to their package identities", () => {
    const idx = new PackageIndex();
    const pins = ["getsentry/sentry-cocoa", "RevenueCat/purchases-ios", "PostHog/posthog-ios", "stripe/stripe-ios", "DataDog/dd-sdk-ios", "mixpanel/mixpanel-swift"].map((r) => ({
      identity: r.split("/")[1]!.toLowerCase(),
      location: `https://github.com/${r}.git`,
      state: { version: "1.0.0" },
    }));
    idx.parse("Package.resolved", "ios/Package.resolved", "ios", JSON.stringify({ pins, version: 3 }), diag());
    expect(idx.matchSwiftModule("Sentry", "ios")).toEqual(["pkg:swift/sentry-cocoa"]);
    expect(idx.matchSwiftModule("RevenueCatUI", "ios")).toEqual(["pkg:swift/purchases-ios"]);
    expect(idx.matchSwiftModule("PostHog", "ios")).toEqual(["pkg:swift/posthog-ios"]);
    expect(idx.matchSwiftModule("StripePaymentSheet", "ios")).toEqual(["pkg:swift/stripe-ios"]);
    expect(idx.matchSwiftModule("DatadogRUM", "ios")).toEqual(["pkg:swift/dd-sdk-ios"]);
    expect(idx.matchSwiftModule("Mixpanel", "ios")).toEqual(["pkg:swift/mixpanel-swift"]);
  });

  it("extracts npm package names from bare specifiers", () => {
    expect(npmPackageName("@sentry/nextjs/client")).toBe("@sentry/nextjs");
    expect(npmPackageName("lodash/get")).toBe("lodash");
    expect(npmPackageName("node:fs")).toBeUndefined();
    expect(npmPackageName("fs/promises")).toBeUndefined();
    expect(npmPackageName("@/lib/x")).toBeUndefined();
    expect(npmPackageName("./x")).toBeUndefined();
  });
});

describe("tsconfig resolution", () => {
  it("follows extends and resolves baseUrl, paths, index files and .js -> .ts", () => {
    const files: Record<string, string> = {
      "web/tsconfig.base.json": '{ "compilerOptions": { "baseUrl": "src", "paths": { "~/*": ["*"] } } }',
      "web/tsconfig.json": '{ "extends": "./tsconfig.base", /* comment */ "compilerOptions": {} }',
    };
    const cfg = loadTsConfig("web/tsconfig.json", (p) => files[p])!;
    expect(cfg).toEqual({ dir: "web", baseUrl: "web/src", paths: [["~/*", ["web/src/*"]]] });
    const resolver = new TsResolver(new Set(["web/src/lib/a.ts", "web/src/ui/index.tsx", "web/src/b.ts"]), [cfg]);
    expect(resolver.resolve("web/src/b.ts", "~/lib/a")).toBe("web/src/lib/a.ts");
    expect(resolver.resolve("web/src/b.ts", "ui")).toBe("web/src/ui/index.tsx");
    expect(resolver.resolve("web/src/lib/a.ts", "../b.js")).toBe("web/src/b.ts");
    expect(resolver.resolve("web/src/b.ts", "react")).toBeUndefined();
  });
});
