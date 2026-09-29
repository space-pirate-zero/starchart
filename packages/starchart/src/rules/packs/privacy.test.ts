import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Graph } from "../../core/graph.js";
import { evaluateRules, type Violation } from "../engine.js";
import { parsePlist } from "../plist.js";
import { loadPacks } from "./index.js";
import { normalizeDataType, PRIVACY_CATALOG } from "./privacy-catalog.js";
import { detectCollection, disclosureSources, findPrivacyManifests, packagePlatforms, parsePrivacyManifest } from "./privacy.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../fixtures/privacy-app");
const MANIFEST = "apps/ios/PrivacyInfo.xcprivacy";

const run = (g: Graph, root?: string): Violation[] => evaluateRules(g, loadPacks(["privacy"]).rules, { root });
const lines = (vs: Violation[]) => vs.map((v) => `${v.severity} ${v.rule} ${v.node}: ${v.message}`);

/** An iOS app that links Sentry and RevenueCat; web uses PostHog. */
function app(): Graph {
  const g = new Graph();
  g.addNode({ id: "pkg:swift/sentry-cocoa", kind: "package" });
  g.addNode({ id: "pkg:swift/purchases-ios", kind: "package" });
  g.addNode({ id: "pkg:swift/unused-lib", kind: "package" });
  g.addNode({ id: "file:ios/App.swift", kind: "file", meta: { path: "apps/ios/App.swift" } });
  g.addEdge({ from: "file:ios/App.swift", to: "pkg:swift/sentry-cocoa", type: "dependsOn" });
  g.addEdge({ from: "file:ios/App.swift", to: "pkg:swift/purchases-ios", type: "dependsOn" });
  return g;
}

describe("parsePrivacyManifest", () => {
  it("parses a realistic PrivacyInfo.xcprivacy", () => {
    const m = parsePrivacyManifest(readFileSync(join(ROOT, MANIFEST), "utf8"));
    expect(m.tracking).toBe(false);
    expect(m.trackingDomains).toEqual([]);
    expect(m.collected.map((c) => c.type)).toEqual(["ProductInteraction", "PerformanceData", "OtherDiagnosticData", "PurchaseHistory", "UserID", "DeviceID"]);
    expect(m.collected[3]).toEqual({
      key: "NSPrivacyCollectedDataTypePurchaseHistory",
      type: "PurchaseHistory",
      linked: true,
      tracking: false,
      purposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
    });
    expect(m.accessedApiTypes).toEqual(["NSPrivacyAccessedAPICategoryUserDefaults"]);
  });

  it("leaves tracking undefined when absent and rejects malformed XML", () => {
    expect(parsePrivacyManifest("<plist><dict/></plist>").tracking).toBeUndefined();
    expect(() => parsePrivacyManifest("<plist><dict><key>A</key></dict></plist>")).toThrow();
    expect(() => parsePrivacyManifest("<plist><array/></plist>")).toThrow(/root must be a <dict>/);
  });

  it("parses plist scalars, entities and comments", () => {
    expect(
      parsePlist(`<?xml version="1.0"?><!-- c --><plist version="1.0"><dict>
        <key>s</key><string> a &amp; b </string><key>i</key><integer>-3</integer><key>r</key><real>1.5</real>
        <key>t</key><true/><key>e</key><string/><key>arr</key><array><false/><date>2026-01-01T00:00:00Z</date></array>
      </dict></plist>`),
    ).toEqual({ s: " a & b ", i: -3, r: 1.5, t: true, e: "", arr: [false, "2026-01-01T00:00:00Z"] });
  });
});

describe("catalog", () => {
  it("normalizes Apple keys, short names and Play categories", () => {
    expect(normalizeDataType("NSPrivacyCollectedDataTypeCrashData")).toEqual(["CrashData"]);
    expect(normalizeDataType("deviceid")).toEqual(["DeviceID"]);
    expect(normalizeDataType("Crash logs")).toEqual(["CrashData"]);
    expect(normalizeDataType("App activity: App interactions")).toEqual(["ProductInteraction"]);
    expect(normalizeDataType("Other actions")).toEqual(["AdvertisingData", "OtherUsageData"]);
    expect(normalizeDataType("Telepathy")).toEqual([]);
  });

  it("gives every entry a source and Play categories", () => {
    for (const e of PRIVACY_CATALOG) {
      expect(e.source).toMatch(/community/);
      expect(e.play.length).toBeGreaterThan(0);
      expect(e.packages.every((p) => p.startsWith("pkg:"))).toBe(true);
    }
  });

  it("maps packages to platforms", () => {
    expect(packagePlatforms("pkg:swift/sentry-cocoa")).toEqual(["ios"]);
    expect(packagePlatforms("pkg:gradle/io.sentry:sentry-android")).toEqual(["android"]);
    expect(packagePlatforms("pkg:npm/@sentry/react-native")).toEqual(["ios", "android"]);
    expect(packagePlatforms("pkg:npm/posthog-node")).toEqual(["server"]);
    expect(packagePlatforms("pkg:npm/posthog-js")).toEqual(["web"]);
  });
});

describe("detectCollection", () => {
  it("detects used or declared SDK packages and skips unknown ones", () => {
    const g = app();
    g.addNode({ id: "pkg:npm/posthog-js", kind: "package", meta: { declared: true } });
    g.addNode({ id: "pkg:gradle/com.google.android.gms:play-services-ads-lite", kind: "package", meta: { transitive: true } });
    expect(detectCollection(g).map((d) => ({ sdk: d.sdk, package: d.package, dataTypes: d.dataTypes, tracking: d.tracking }))).toEqual([
      { sdk: "posthog", package: "pkg:npm/posthog-js", dataTypes: ["DeviceID", "ProductInteraction"], tracking: false },
      { sdk: "revenuecat", package: "pkg:swift/purchases-ios", dataTypes: ["DeviceID", "PurchaseHistory", "UserID"], tracking: false },
      { sdk: "sentry", package: "pkg:swift/sentry-cocoa", dataTypes: ["CrashData", "OtherDiagnosticData", "PerformanceData"], tracking: false },
    ]);
    expect(detectCollection(g)[2]!.optionalDataTypes).toEqual(["DeviceID"]);
  });

  it("honours meta.privacy overrides and first-party events", () => {
    const g = new Graph();
    g.addNode({ id: "pkg:swift/sentry-cocoa", kind: "package", meta: { declared: true, privacy: { collects: ["CrashData"] } } });
    g.addNode({ id: "event:paywall_viewed", kind: "event" });
    g.addNode({ id: "symbol:ios/Paywall.track", kind: "symbol", location: { file: "apps/ios/Paywall.swift" } });
    g.addEdge({ from: "symbol:ios/Paywall.track", to: "event:paywall_viewed", type: "emits" });
    const d = detectCollection(g);
    expect(d[0]).toMatchObject({ sdk: "sentry", dataTypes: ["CrashData"], source: "pkg:swift/sentry-cocoa meta.privacy" });
    expect(d[1]).toMatchObject({ sdk: "app-events", package: "event:*", dataTypes: ["ProductInteraction"], platforms: ["ios"] });
  });
});

describe("privacy rules", () => {
  it("finds first-party manifests only (Pods are excluded)", () => {
    expect(findPrivacyManifests(ROOT).map((m) => m.path)).toEqual([MANIFEST]);
  });

  it("flags Sentry's CrashData missing from PrivacyInfo.xcprivacy", () => {
    expect(lines(run(app(), ROOT))).toEqual([
      `error privacy-disclosed pkg:swift/sentry-cocoa: pkg:swift/sentry-cocoa collects CrashData but PrivacyInfo.xcprivacy (${MANIFEST}) does not declare NSPrivacyCollectedDataTypeCrashData`,
    ]);
    expect(run(app(), ROOT)[0]!.file).toBe(MANIFEST);
  });

  it("checks store labels in their own vocabulary and scopes them by platform", () => {
    const g = app();
    g.addNode({ id: "pkg:gradle/io.sentry:sentry-android", kind: "package", meta: { declared: true } });
    g.addNode({ id: "appstore:privacy", kind: "artifact", types: ["sc:PrivacyLabel"], binding: { adapter: "appstore" }, meta: { declares: ["CrashData", "PerformanceData", "OtherDiagnosticData", "PurchaseHistory", "UserID"] } });
    g.addNode({ id: "playstore:data-safety", kind: "artifact", types: ["sc:PrivacyLabel"], binding: { adapter: "playstore" }, meta: { declares: ["Crash logs", "Diagnostics"] } });
    expect(lines(run(g))).toEqual([
      "error privacy-disclosed pkg:gradle/io.sentry:sentry-android: pkg:gradle/io.sentry:sentry-android collects OtherDiagnosticData but Play Data Safety label playstore:data-safety does not declare \"App info and performance: Other app performance data\"",
      "error privacy-disclosed pkg:swift/purchases-ios: pkg:swift/purchases-ios collects DeviceID but privacy label appstore:privacy does not declare DeviceID",
    ]);
  });

  it("requires NSPrivacyTracking for tracking SDKs", () => {
    const g = app();
    g.addNode({ id: "pkg:swift/facebook-ios-sdk", kind: "package", meta: { direct: true } });
    const got = lines(run(g, ROOT));
    expect(got).toContain(`error privacy-tracking pkg:swift/facebook-ios-sdk: pkg:swift/facebook-ios-sdk tracks users but PrivacyInfo.xcprivacy (${MANIFEST}) sets NSPrivacyTracking to false`);
    expect(got).toContain(
      `error privacy-disclosed pkg:swift/facebook-ios-sdk: pkg:swift/facebook-ios-sdk collects AdvertisingData but PrivacyInfo.xcprivacy (${MANIFEST}) does not declare NSPrivacyCollectedDataTypeAdvertisingData`,
    );
  });

  it("warns when data is collected but nothing discloses it", () => {
    const g = app();
    g.addNode({ id: "pkg:npm/posthog-js", kind: "package", meta: { declared: true } });
    g.addNode({ id: "web:privacy", kind: "artifact", types: ["sc:PrivacyPolicy"], meta: { platform: "web", declares: ["ProductInteraction", "DeviceID"] } });
    expect(lines(run(g))).toEqual([
      "warn privacy-disclosure-exists pkg:swift/purchases-ios: pkg:swift/purchases-ios, pkg:swift/sentry-cocoa collect CrashData, DeviceID, OtherDiagnosticData, PerformanceData, PurchaseHistory, UserID on ios but no disclosure exists; add a PrivacyInfo.xcprivacy or an App Store privacy label (sc:PrivacyLabel)",
    ]);
  });

  it("reports unparseable manifests", () => {
    const root = mkdtempSync(join(tmpdir(), "starchart-privacy-"));
    try {
      mkdirSync(join(root, "ios"));
      writeFileSync(join(root, "ios/PrivacyInfo.xcprivacy"), "<plist><dict><key>NSPrivacyTracking</key></dict></plist>");
      const vs = run(app(), root);
      expect(vs).toHaveLength(1);
      expect(vs[0]).toMatchObject({ rule: "privacy-disclosed", node: "ios/PrivacyInfo.xcprivacy", file: "ios/PrivacyInfo.xcprivacy" });
      expect(vs[0]!.message).toMatch(/^cannot parse PrivacyInfo\.xcprivacy \(ios\/PrivacyInfo\.xcprivacy\): /);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("memoizes disclosure sources per evaluation", () => {
    const cache = new Map<string, unknown>();
    const first = disclosureSources(new Graph(), { root: ROOT, cache });
    expect(disclosureSources(new Graph(), { root: ROOT, cache })).toBe(first);
    expect(first.map((s) => [s.kind, s.id, s.tracking])).toEqual([["manifest", MANIFEST, false]]);
  });
});
