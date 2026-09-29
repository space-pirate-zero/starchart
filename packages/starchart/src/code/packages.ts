import { builtinModules } from "node:module";
import type { Diagnostics } from "./types.js";
import { dirnamePosix } from "./util.js";

export type Ecosystem = "npm" | "swift" | "gradle" | "go";

export interface PackageInfo {
  id: string;
  ecosystem: Ecosystem;
  name: string;
  version?: string;
  /** Declared directly in a manifest. */
  direct: boolean;
  /** Pulled in only transitively (go.mod `// indirect`, Package.resolved pins not declared by the project). */
  transitive?: boolean;
  dev?: boolean;
  url?: string;
  /** Gradle group, for matching Kotlin imports. */
  group?: string;
  /** Root-relative manifest paths declaring the package. */
  files: string[];
  scope: string;
}

export interface GoModule {
  path: string;
  /** Root-relative directory holding go.mod. */
  dir: string;
}

/** Everything learned from manifests across all scopes. */
export class PackageIndex {
  readonly packages = new Map<string, PackageInfo>();
  /** Normalized Swift product/module name -> package identity (from Package.swift / project.pbxproj). */
  readonly swiftProducts = new Map<string, string>();
  /** Swift identities declared by the project itself (Package.swift / project.pbxproj), per scope. */
  readonly swiftDeclared = new Map<string, Set<string>>();
  readonly goModules: GoModule[] = [];

  add(info: Omit<PackageInfo, "files"> & { file: string }): void {
    const { file, ...rest } = info;
    const existing = this.packages.get(info.id);
    if (!existing) {
      this.packages.set(info.id, { ...rest, files: [file] });
      return;
    }
    if (!existing.files.includes(file)) existing.files.push(file);
    existing.version ??= info.version;
    existing.url ??= info.url;
    existing.group ??= info.group;
    if (info.direct) {
      existing.direct = true;
      delete existing.transitive;
    }
    if (existing.dev && !info.dev) delete existing.dev;
  }

  private declareSwift(scope: string, identity: string): void {
    let set = this.swiftDeclared.get(scope);
    if (!set) {
      set = new Set();
      this.swiftDeclared.set(scope, set);
    }
    set.add(identity);
  }

  /** Parses one manifest file. */
  parse(base: string, path: string, scope: string, text: string, diag: Diagnostics): void {
    try {
      switch (base) {
        case "package.json":
          return this.parsePackageJson(path, scope, text);
        case "Package.resolved":
          return this.parsePackageResolved(path, scope, text);
        case "Package.swift":
          return this.parsePackageSwift(path, scope, text);
        case "project.pbxproj":
          return this.parsePbxproj(path, scope, text);
        case "build.gradle":
        case "build.gradle.kts":
          return this.parseGradle(path, scope, text);
        case "libs.versions.toml":
          return this.parseVersionCatalog(path, scope, text);
        case "go.mod":
          return this.parseGoMod(path, scope, text);
      }
    } catch (err) {
      diag.warn(`${path}: could not parse manifest (${(err as Error).message})`);
    }
  }

  private parsePackageJson(path: string, scope: string, text: string): void {
    const json = JSON.parse(text) as Record<string, unknown>;
    const sections: [string, boolean][] = [
      ["dependencies", false],
      ["devDependencies", true],
      ["peerDependencies", false],
      ["optionalDependencies", false],
    ];
    for (const [key, dev] of sections) {
      const deps = json[key];
      if (!deps || typeof deps !== "object") continue;
      for (const [name, version] of Object.entries(deps as Record<string, unknown>)) {
        this.add({ id: `pkg:npm/${name}`, ecosystem: "npm", name, version: typeof version === "string" ? version : undefined, direct: true, dev: dev || undefined, file: path, scope });
      }
    }
  }

  private parsePackageResolved(path: string, scope: string, text: string): void {
    const json = JSON.parse(text) as { pins?: unknown[]; object?: { pins?: unknown[] } };
    const pins = json.pins ?? json.object?.pins ?? [];
    for (const raw of pins) {
      const pin = raw as { identity?: string; package?: string; location?: string; repositoryURL?: string; state?: { version?: string; revision?: string; branch?: string } };
      const url = pin.location ?? pin.repositoryURL;
      const identity = (pin.identity ?? (url ? identityFromUrl(url) : pin.package))?.toLowerCase();
      if (!identity) continue;
      this.add({
        id: `pkg:swift/${identity}`,
        ecosystem: "swift",
        name: identity,
        version: pin.state?.version ?? pin.state?.branch ?? pin.state?.revision,
        direct: true,
        url,
        file: path,
        scope,
      });
    }
  }

  private parsePackageSwift(path: string, scope: string, text: string): void {
    const clean = stripSlashComments(text);
    for (const m of clean.matchAll(/\.package\s*\(([^)]*)\)/g)) {
      const args = m[1]!;
      const url = /url\s*:\s*"([^"]+)"/.exec(args)?.[1];
      if (!url) continue;
      const identity = identityFromUrl(url);
      const version = /(?:from|exact|branch|revision)\s*:\s*"([^"]+)"/.exec(args)?.[1] ?? /"([0-9][^"]*)"\s*\.\.[.<]/.exec(args)?.[1];
      this.add({ id: `pkg:swift/${identity}`, ecosystem: "swift", name: identity, version, direct: true, url, file: path, scope });
      this.declareSwift(scope, identity);
      const name = /name\s*:\s*"([^"]+)"/.exec(args)?.[1];
      if (name) this.swiftProducts.set(normName(name), identity);
    }
    for (const m of clean.matchAll(/\.product\s*\(\s*name\s*:\s*"([^"]+)"\s*,\s*package\s*:\s*"([^"]+)"/g)) {
      this.swiftProducts.set(normName(m[1]!), m[2]!.toLowerCase());
    }
  }

  private parsePbxproj(path: string, scope: string, text: string): void {
    const refs = new Map<string, string>();
    for (const m of text.matchAll(/(\w+)\s*(?:\/\*[^*]*\*\/\s*)?=\s*\{\s*isa\s*=\s*XCRemoteSwiftPackageReference;([\s\S]*?)\n\s*\};/g)) {
      const url = /repositoryURL\s*=\s*"?([^";]+)"?;/.exec(m[2]!)?.[1];
      if (!url) continue;
      const identity = identityFromUrl(url);
      refs.set(m[1]!, identity);
      const version = /(?:minimumVersion|version)\s*=\s*"?([^";]+)"?;/.exec(m[2]!)?.[1];
      this.add({ id: `pkg:swift/${identity}`, ecosystem: "swift", name: identity, version, direct: true, url, file: path, scope });
      this.declareSwift(scope, identity);
    }
    for (const m of text.matchAll(/isa\s*=\s*XCSwiftPackageProductDependency;([\s\S]*?)\n\s*\};/g)) {
      const body = m[1]!;
      const pkgRef = /package\s*=\s*(\w+)/.exec(body)?.[1];
      const product = /productName\s*=\s*"?([^";]+)"?;/.exec(body)?.[1];
      const identity = pkgRef ? refs.get(pkgRef) : undefined;
      if (product && identity) this.swiftProducts.set(normName(product), identity);
    }
  }

  private parseGradle(path: string, scope: string, text: string): void {
    const clean = stripSlashComments(text);
    const configs =
      "implementation|api|compileOnly|runtimeOnly|testImplementation|androidTestImplementation|debugImplementation|releaseImplementation|kapt|ksp|annotationProcessor|testRuntimeOnly|coreLibraryDesugaring|compile|testCompile|classpath";
    const re = new RegExp(`\\b(${configs})\\s*\\(?\\s*(?:(?:platform|enforcedPlatform)\\s*\\(\\s*)?["']([^"':\\s$]+):([^"':\\s$]+)(?::([^"'\\s]+))?["']`, "g");
    for (const m of clean.matchAll(re)) {
      const group = m[2]!;
      const artifact = m[3]!;
      const dev = /^(?:test|androidTest|debug)/.test(m[1]!) || undefined;
      this.add({ id: `pkg:gradle/${group}:${artifact}`, ecosystem: "gradle", name: `${group}:${artifact}`, version: m[4], direct: true, dev, group, file: path, scope });
    }
  }

  private parseVersionCatalog(path: string, scope: string, text: string): void {
    const toml = parseSimpleToml(text);
    const versions = toml.get("versions") ?? new Map<string, TomlValue>();
    const libraries = toml.get("libraries") ?? new Map<string, TomlValue>();
    for (const value of libraries.values()) {
      let group: string | undefined;
      let artifact: string | undefined;
      let version: string | undefined;
      if (typeof value === "string") {
        [group, artifact, version] = value.split(":");
      } else {
        const module = value.get("module");
        if (typeof module === "string") [group, artifact] = module.split(":");
        const g = value.get("group");
        const n = value.get("name");
        if (typeof g === "string") group = g;
        if (typeof n === "string") artifact = n;
        const v = value.get("version");
        const ref = value.get("version.ref");
        if (typeof v === "string") version = v;
        else if (typeof ref === "string") {
          const resolved = versions.get(ref);
          if (typeof resolved === "string") version = resolved;
        }
      }
      if (!group || !artifact) continue;
      this.add({ id: `pkg:gradle/${group}:${artifact}`, ecosystem: "gradle", name: `${group}:${artifact}`, version, direct: true, group, file: path, scope });
    }
  }

  private parseGoMod(path: string, scope: string, text: string): void {
    const lines = text.split("\n");
    let inRequire = false;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      const mod = /^module\s+(\S+)/.exec(line);
      if (mod) {
        this.goModules.push({ path: mod[1]!.replace(/^"|"$/g, ""), dir: dirnamePosix(path) });
        continue;
      }
      if (/^require\s*\($/.test(line)) {
        inRequire = true;
        continue;
      }
      if (inRequire && line === ")") {
        inRequire = false;
        continue;
      }
      const req = inRequire ? /^(\S+)\s+(\S+)(.*)$/.exec(line) : /^require\s+(\S+)\s+(\S+)(.*)$/.exec(line);
      if (!req || req[1]!.startsWith("//")) continue;
      const indirect = /\/\/\s*indirect/.test(req[3] ?? "");
      this.add({
        id: `pkg:go/${req[1]!}`,
        ecosystem: "go",
        name: req[1]!,
        version: req[2],
        direct: !indirect,
        transitive: indirect || undefined,
        file: path,
        scope,
      });
    }
  }

  /** Marks Package.resolved pins that the project never declares as transitive. */
  finalize(): void {
    for (const pkg of this.packages.values()) {
      if (pkg.ecosystem !== "swift") continue;
      const declared = this.swiftDeclared.get(pkg.scope);
      const onlyResolved = pkg.files.every((f) => f.endsWith("Package.resolved"));
      if (declared && declared.size > 0 && onlyResolved && !declared.has(pkg.name)) {
        pkg.direct = false;
        pkg.transitive = true;
      }
    }
  }

  /** Swift module name -> package ids. */
  matchSwiftModule(module: string, scope: string): string[] {
    if (APPLE_FRAMEWORKS.has(module)) return [];
    const swift = [...this.packages.values()].filter((p) => p.ecosystem === "swift");
    if (swift.length === 0) return [];
    const byIdentity = new Map(swift.map((p) => [p.name, p]));
    const prefer = (ids: PackageInfo[]) => {
      const inScope = ids.filter((p) => p.scope === scope);
      return (inScope.length ? inScope : ids).map((p) => p.id);
    };

    const explicit = this.swiftProducts.get(normName(module));
    if (explicit && byIdentity.has(explicit)) return [byIdentity.get(explicit)!.id];

    for (const [pattern, identities] of SWIFT_MODULE_ALIASES) {
      if (!pattern.test(module)) continue;
      const hits = identities.map((i) => byIdentity.get(i)).filter((p): p is PackageInfo => p !== undefined);
      if (hits.length) return prefer(hits);
    }

    const variants = moduleVariants(module);
    const exact = swift.filter((p) => {
      const names = packageNames(p);
      return variants.some((v) => names.core.includes(v) || names.owner === v);
    });
    if (exact.length) return prefer(exact);

    const fuzzy = swift.filter((p) => {
      const names = packageNames(p);
      return variants.some((v) => v.length >= 4 && names.full.some((n) => n.includes(v)));
    });
    return prefer(fuzzy);
  }

  /** Kotlin import path -> gradle package ids sharing the longest matching group prefix. */
  matchKotlinImport(path: string): string[] {
    if (/^(?:kotlin|kotlinx\.coroutines\.internal|java|javax|android)\./.test(path)) return [];
    let best = 0;
    let hits: string[] = [];
    for (const p of this.packages.values()) {
      if (p.ecosystem !== "gradle" || !p.group) continue;
      if (!(path === p.group || path.startsWith(`${p.group}.`))) continue;
      if (p.group.length > best) {
        best = p.group.length;
        hits = [p.id];
      } else if (p.group.length === best) hits.push(p.id);
    }
    return hits;
  }

  /** Go import path -> go package id (longest module prefix), or undefined for stdlib and own modules. */
  matchGoImport(path: string): string | undefined {
    if (this.goModules.some((m) => path === m.path || path.startsWith(`${m.path}/`))) return undefined;
    let best: PackageInfo | undefined;
    for (const p of this.packages.values()) {
      if (p.ecosystem !== "go") continue;
      if ((path === p.name || path.startsWith(`${p.name}/`)) && (!best || p.name.length > best.name.length)) best = p;
    }
    return best?.id;
  }

  /** The own Go module and in-module directory for an import path, if it is internal. */
  goInternalDir(path: string): string | undefined {
    for (const m of this.goModules) {
      if (path === m.path) return m.dir;
      if (path.startsWith(`${m.path}/`)) return [m.dir, path.slice(m.path.length + 1)].filter(Boolean).join("/");
    }
    return undefined;
  }
}

/** npm package name of a bare module specifier, or undefined for relative paths, builtins and aliases. */
export function npmPackageName(spec: string): string | undefined {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:") || spec.startsWith("#")) return undefined;
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/.test(name)) return undefined;
  if (BUILTINS.has(name)) return undefined;
  return name;
}

const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, "").split("/")[0]!));

export function identityFromUrl(url: string): string {
  const last = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? url;
  return last.replace(/\.git$/, "").toLowerCase();
}

function normName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const IDENTITY_AFFIXES = /^(?:swift-?)|(?:-?(?:ios-sdk|ios|swift|cocoa|spm|sdk|xcframework|apple|package))+$/g;

function packageNames(p: PackageInfo): { core: string[]; owner?: string; full: string[] } {
  const identity = p.name;
  const repo = p.url ? identityFromUrl(p.url) : identity;
  const ownerMatch = p.url ? /[/:]([^/:]+)\/[^/]+?(?:\.git)?\/?$/.exec(p.url) : null;
  const owner = ownerMatch ? normName(ownerMatch[1]!) : undefined;
  const core = [...new Set([identity, repo].flatMap((n) => [normName(n), normName(n.replace(IDENTITY_AFFIXES, ""))]))].filter(Boolean);
  return { core, owner, full: [...new Set([normName(identity), normName(repo)])] };
}

function moduleVariants(module: string): string[] {
  const out = new Set<string>([normName(module)]);
  const stripped = module.replace(/(?:SwiftUI|UI|Core|Kit|Swift|SDK)$/, "");
  if (stripped.length >= 3 && stripped !== module) out.add(normName(stripped));
  return [...out];
}

/** Well-known module -> package identity mappings where the names differ. */
const SWIFT_MODULE_ALIASES: [RegExp, string[]][] = [
  [/^Sentry/, ["sentry-cocoa"]],
  [/^RevenueCat/, ["purchases-ios", "purchases-ios-spm"]],
  [/^Firebase/, ["firebase-ios-sdk"]],
  [/^PostHog/, ["posthog-ios"]],
  [/^Amplitude/, ["amplitude-swift", "amplitude-ios", "amplitude-ios-core"]],
  [/^Mixpanel/, ["mixpanel-swift", "mixpanel-iphone"]],
  [/^(?:FBSDK|Facebook)/, ["facebook-ios-sdk"]],
  [/^GoogleMobileAds$/, ["swift-package-manager-google-mobile-ads"]],
  [/^GoogleSignIn/, ["googlesignin-ios"]],
  [/^Stripe/, ["stripe-ios", "stripe-ios-spm"]],
  [/^Datadog/, ["dd-sdk-ios"]],
  [/^Bugsnag/, ["bugsnag-cocoa"]],
  [/^OneSignal/, ["onesignal-xcframework", "onesignal-ios-sdk"]],
  [/^Segment$/, ["analytics-swift"]],
  [/^BranchSDK$|^Branch$/, ["ios-branch-sdk-spm", "ios-branch-deep-linking-attribution"]],
  [/^Lottie$/, ["lottie-spm", "lottie-ios"]],
  [/^AppsFlyerLib/, ["appsflyerframework", "appsflyerframework-static"]],
  [/^Adjust/, ["ios_sdk"]],
  [/^LaunchDarkly/, ["ios-client-sdk"]],
  [/^Statsig/, ["statsig-kit"]],
  [/^Intercom/, ["intercom-ios-sp"]],
  [/^SDWebImage/, ["sdwebimage", "sdwebimageswiftui"]],
];

export const APPLE_FRAMEWORKS: ReadonlySet<string> = new Set([
  "Swift", "SwiftUI", "SwiftUICore", "Foundation", "UIKit", "AppKit", "Combine", "CoreData", "CoreGraphics", "CoreImage", "CoreLocation",
  "MapKit", "AVFoundation", "AVKit", "StoreKit", "XCTest", "Testing", "os", "OSLog", "WidgetKit", "ActivityKit", "SwiftData",
  "Observation", "CloudKit", "AuthenticationServices", "UserNotifications", "Photos", "PhotosUI", "Security", "CryptoKit", "Network",
  "WebKit", "SafariServices", "MessageUI", "QuartzCore", "Metal", "MetalKit", "SceneKit", "SpriteKit", "ARKit", "RealityKit",
  "HealthKit", "EventKit", "Contacts", "ContactsUI", "GameKit", "Charts", "TipKit", "AppIntents", "Intents", "IntentsUI",
  "LocalAuthentication", "CoreML", "Vision", "NaturalLanguage", "Speech", "CoreMotion", "CoreBluetooth", "CoreHaptics", "CoreText",
  "ImageIO", "UniformTypeIdentifiers", "LinkPresentation", "BackgroundTasks", "Darwin", "Dispatch", "ObjectiveC", "CoreTransferable",
  "Accelerate", "CoreFoundation", "SystemConfiguration", "AdSupport", "AppTrackingTransparency", "CallKit", "PassKit", "QuickLook",
  "VisionKit", "RegexBuilder", "_Concurrency", "Synchronization", "CoreServices", "MediaPlayer", "CarPlay", "WatchKit", "ClockKit",
  "DeviceActivity", "FamilyControls", "ManagedSettings", "MusicKit", "ShazamKit", "SensitiveContentAnalysis", "Translation",
]);

function stripSlashComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"])\/\/[^\n]*/g, "$1");
}

type TomlValue = string | Map<string, string>;

/** Parses the subset of TOML used by Gradle version catalogs: sections, strings and inline tables. */
function parseSimpleToml(text: string): Map<string, Map<string, TomlValue>> {
  const out = new Map<string, Map<string, TomlValue>>();
  let section = new Map<string, TomlValue>();
  out.set("", section);
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) {
      section = new Map();
      out.set(sec[1]!.trim(), section);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^"|"$/g, "");
    const value = line.slice(eq + 1).trim();
    if (value.startsWith("{")) section.set(key, parseInlineTable(value));
    else {
      const s = /^"([^"]*)"|^'([^']*)'/.exec(value);
      if (s) section.set(key, s[1] ?? s[2] ?? "");
    }
  }
  return out;
}

function parseInlineTable(value: string): Map<string, string> {
  const out = new Map<string, string>();
  const body = value.replace(/^\{|\}$/g, "");
  for (const m of body.matchAll(/([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g)) {
    if (m[4] !== undefined) {
      const inner = /(?:strictly|require|prefer)\s*=\s*"([^"]*)"/.exec(m[4]);
      if (inner) out.set(m[1]!, inner[1]!);
      continue;
    }
    out.set(m[1]!, m[2] ?? m[3] ?? "");
  }
  return out;
}
