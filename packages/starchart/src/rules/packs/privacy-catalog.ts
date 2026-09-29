/**
 * Community-maintained defaults for what common SDKs collect, expressed in Apple's
 * NSPrivacyCollectedDataType vocabulary with the matching Google Play Data Safety
 * categories. These are starting points, not legal advice: projects override an entry
 * by declaring `meta.privacy` on the package node, or pass their own catalog to
 * `detectCollection`.
 */

export const APPLE_DATA_TYPE_PREFIX = "NSPrivacyCollectedDataType";
export const APPLE_PURPOSE_PREFIX = "NSPrivacyCollectedDataTypePurpose";

/** Apple data type short names (append to {@link APPLE_DATA_TYPE_PREFIX} for the manifest key). */
export const PLAY_CATEGORY = {
  Name: "Personal info: Name",
  EmailAddress: "Personal info: Email address",
  PhoneNumber: "Personal info: Phone number",
  PhysicalAddress: "Personal info: Address",
  UserID: "Personal info: User IDs",
  DeviceID: "Device or other IDs",
  PaymentInfo: "Financial info: User payment info",
  PurchaseHistory: "Financial info: Purchase history",
  PreciseLocation: "Location: Precise location",
  CoarseLocation: "Location: Approximate location",
  Contacts: "Contacts: Contacts",
  PhotosorVideos: "Photos and videos: Photos",
  AudioData: "Audio: Voice or sound recordings",
  SearchHistory: "App activity: In-app search history",
  BrowsingHistory: "Web browsing: Web browsing history",
  OtherUserContent: "App activity: Other user-generated content",
  ProductInteraction: "App activity: App interactions",
  AdvertisingData: "App activity: Other actions",
  OtherUsageData: "App activity: Other actions",
  CrashData: "App info and performance: Crash logs",
  PerformanceData: "App info and performance: Diagnostics",
  OtherDiagnosticData: "App info and performance: Other app performance data",
} as const;

export type AppleDataType = keyof typeof PLAY_CATEGORY;

export const APPLE_DATA_TYPES = Object.keys(PLAY_CATEGORY) as AppleDataType[];

export type ApplePurpose = "AppFunctionality" | "Analytics" | "DeveloperAdvertising" | "ThirdPartyAdvertising" | "ProductPersonalization" | "Other";

export const appleDataTypeKey = (t: AppleDataType): string => `${APPLE_DATA_TYPE_PREFIX}${t}`;

export interface CatalogCollection {
  type: AppleDataType;
  purposes: ApplePurpose[];
  /** Collected only when a feature is used (e.g. `identify()`, session replay); not required to disclose by default. */
  optional?: boolean;
  note?: string;
}

export interface SdkCatalogEntry {
  id: string;
  name: string;
  /** Package id patterns across ecosystems (`*` wildcard, case-insensitive). */
  packages: string[];
  collects: CatalogCollection[];
  /** Tracking in Apple's ATT sense: data linked with third-party data for advertising. */
  tracking: boolean;
  /** Google Play Data Safety categories for everything in `collects`. */
  play: string[];
  source: string;
  note?: string;
}

const SOURCE = "STARCHART community catalog, compiled from vendor privacy documentation (defaults; override per project)";

function sdk(entry: Omit<SdkCatalogEntry, "play" | "source"> & { source?: string }): SdkCatalogEntry {
  return {
    ...entry,
    play: [...new Set(entry.collects.map((c) => PLAY_CATEGORY[c.type]))],
    source: entry.source ?? SOURCE,
  };
}

const c = (type: AppleDataType, purposes: ApplePurpose[], extra: Partial<CatalogCollection> = {}): CatalogCollection => ({ type, purposes, ...extra });

export const PRIVACY_CATALOG: SdkCatalogEntry[] = [
  sdk({
    id: "sentry",
    name: "Sentry",
    packages: ["pkg:npm/@sentry/*", "pkg:swift/sentry-cocoa", "pkg:cocoapods/Sentry", "pkg:gradle/io.sentry:*"],
    collects: [
      c("CrashData", ["AppFunctionality"]),
      c("PerformanceData", ["AppFunctionality"]),
      c("OtherDiagnosticData", ["AppFunctionality"]),
      c("DeviceID", ["AppFunctionality"], { optional: true, note: "when sendDefaultPii is enabled" }),
    ],
    tracking: false,
  }),
  sdk({
    id: "posthog",
    name: "PostHog",
    packages: ["pkg:npm/posthog-js", "pkg:npm/posthog-node", "pkg:npm/posthog-react-native", "pkg:swift/posthog-ios", "pkg:cocoapods/PostHog", "pkg:gradle/com.posthog:*", "pkg:gradle/com.posthog.android:*"],
    collects: [
      c("ProductInteraction", ["Analytics"]),
      c("DeviceID", ["Analytics"]),
      c("UserID", ["Analytics"], { optional: true, note: "when identify() is called" }),
    ],
    tracking: false,
  }),
  sdk({
    id: "firebase-analytics",
    name: "Firebase Analytics",
    packages: [
      "pkg:npm/firebase",
      "pkg:npm/@firebase/analytics",
      "pkg:npm/@react-native-firebase/analytics",
      "pkg:swift/firebase-ios-sdk",
      "pkg:cocoapods/FirebaseAnalytics",
      "pkg:gradle/com.google.firebase:firebase-analytics*",
    ],
    collects: [c("ProductInteraction", ["Analytics"]), c("DeviceID", ["Analytics"]), c("CoarseLocation", ["Analytics"])],
    tracking: false,
    note: "The umbrella `firebase` / `firebase-ios-sdk` packages are assumed to include Analytics; override if you only use other products",
  }),
  sdk({
    id: "firebase-crashlytics",
    name: "Firebase Crashlytics",
    packages: ["pkg:npm/@react-native-firebase/crashlytics", "pkg:cocoapods/FirebaseCrashlytics", "pkg:gradle/com.google.firebase:firebase-crashlytics*"],
    collects: [c("CrashData", ["AppFunctionality"]), c("DeviceID", ["AppFunctionality"])],
    tracking: false,
  }),
  sdk({
    id: "amplitude",
    name: "Amplitude",
    packages: ["pkg:npm/@amplitude/*", "pkg:npm/amplitude-js", "pkg:swift/amplitude-swift", "pkg:swift/amplitude-ios", "pkg:cocoapods/Amplitude*", "pkg:gradle/com.amplitude:*"],
    collects: [c("ProductInteraction", ["Analytics"]), c("DeviceID", ["Analytics"]), c("UserID", ["Analytics"], { optional: true, note: "when setUserId() is called" })],
    tracking: false,
  }),
  sdk({
    id: "mixpanel",
    name: "Mixpanel",
    packages: ["pkg:npm/mixpanel", "pkg:npm/mixpanel-browser", "pkg:npm/mixpanel-react-native", "pkg:swift/mixpanel-swift", "pkg:swift/mixpanel-iphone", "pkg:cocoapods/Mixpanel*", "pkg:gradle/com.mixpanel.android:*"],
    collects: [c("ProductInteraction", ["Analytics"]), c("DeviceID", ["Analytics"]), c("UserID", ["Analytics"], { optional: true, note: "when identify() is called" })],
    tracking: false,
  }),
  sdk({
    id: "segment",
    name: "Segment",
    packages: [
      "pkg:npm/@segment/analytics-next",
      "pkg:npm/@segment/analytics-node",
      "pkg:npm/@segment/analytics-react-native",
      "pkg:npm/analytics-node",
      "pkg:swift/analytics-swift",
      "pkg:swift/analytics-ios",
      "pkg:gradle/com.segment.analytics.kotlin:*",
      "pkg:gradle/com.segment.analytics.android:*",
    ],
    collects: [c("ProductInteraction", ["Analytics"]), c("DeviceID", ["Analytics"]), c("UserID", ["Analytics"], { optional: true, note: "when identify() is called" })],
    tracking: false,
    note: "Destinations configured in Segment may collect more; declare them as separate packages or override",
  }),
  sdk({
    id: "revenuecat",
    name: "RevenueCat",
    packages: [
      "pkg:swift/purchases-ios",
      "pkg:cocoapods/RevenueCat",
      "pkg:npm/react-native-purchases",
      "pkg:npm/@revenuecat/*",
      "pkg:gradle/com.revenuecat.purchases:*",
    ],
    collects: [c("PurchaseHistory", ["AppFunctionality"]), c("UserID", ["AppFunctionality"]), c("DeviceID", ["AppFunctionality"])],
    tracking: false,
  }),
  sdk({
    id: "facebook",
    name: "Facebook SDK",
    packages: ["pkg:swift/facebook-ios-sdk", "pkg:cocoapods/FBSDK*", "pkg:npm/react-native-fbsdk-next", "pkg:gradle/com.facebook.android:*"],
    collects: [
      c("DeviceID", ["ThirdPartyAdvertising", "Analytics"]),
      c("ProductInteraction", ["ThirdPartyAdvertising", "Analytics"]),
      c("AdvertisingData", ["ThirdPartyAdvertising"]),
    ],
    tracking: true,
  }),
  sdk({
    id: "google-mobile-ads",
    name: "Google Mobile Ads",
    packages: [
      "pkg:swift/google-mobile-ads",
      "pkg:swift/swift-package-manager-google-mobile-ads",
      "pkg:cocoapods/Google-Mobile-Ads-SDK",
      "pkg:npm/react-native-google-mobile-ads",
      "pkg:gradle/com.google.android.gms:play-services-ads*",
    ],
    collects: [
      c("DeviceID", ["ThirdPartyAdvertising"]),
      c("AdvertisingData", ["ThirdPartyAdvertising"]),
      c("CoarseLocation", ["ThirdPartyAdvertising"]),
    ],
    tracking: true,
  }),
  sdk({
    id: "stripe",
    name: "Stripe",
    packages: ["pkg:swift/stripe-ios", "pkg:swift/stripe-ios-spm", "pkg:cocoapods/Stripe*", "pkg:npm/@stripe/stripe-js", "pkg:npm/@stripe/stripe-react-native", "pkg:gradle/com.stripe:*"],
    collects: [
      c("PaymentInfo", ["AppFunctionality"]),
      c("PurchaseHistory", ["AppFunctionality"]),
      c("EmailAddress", ["AppFunctionality"], { optional: true, note: "when collected at checkout" }),
    ],
    tracking: false,
  }),
  sdk({
    id: "datadog",
    name: "Datadog",
    packages: ["pkg:npm/@datadog/browser-rum*", "pkg:npm/@datadog/browser-logs", "pkg:npm/@datadog/mobile-react-native", "pkg:swift/dd-sdk-ios", "pkg:cocoapods/Datadog*", "pkg:gradle/com.datadoghq:*"],
    collects: [
      c("CrashData", ["AppFunctionality"]),
      c("PerformanceData", ["AppFunctionality"]),
      c("OtherDiagnosticData", ["AppFunctionality"]),
      c("ProductInteraction", ["Analytics"], { optional: true, note: "RUM action tracking / session replay" }),
    ],
    tracking: false,
  }),
  sdk({
    id: "bugsnag",
    name: "Bugsnag",
    packages: ["pkg:npm/@bugsnag/*", "pkg:swift/bugsnag-cocoa", "pkg:cocoapods/Bugsnag*", "pkg:gradle/com.bugsnag:*"],
    collects: [c("CrashData", ["AppFunctionality"]), c("OtherDiagnosticData", ["AppFunctionality"]), c("DeviceID", ["AppFunctionality"], { optional: true })],
    tracking: false,
  }),
  sdk({
    id: "logrocket",
    name: "LogRocket",
    packages: ["pkg:npm/logrocket", "pkg:npm/@logrocket/*", "pkg:swift/logrocket-ios", "pkg:cocoapods/LogRocket", "pkg:gradle/com.logrocket:*"],
    collects: [
      c("ProductInteraction", ["Analytics", "AppFunctionality"]),
      c("OtherUsageData", ["Analytics", "AppFunctionality"]),
      c("CrashData", ["AppFunctionality"], { optional: true }),
    ],
    tracking: false,
    note: "Session replay records user interactions",
  }),
];

const APPLE_BY_LOWER = new Map(APPLE_DATA_TYPES.map((t) => [t.toLowerCase(), t]));
const APPLE_BY_PLAY = new Map<string, AppleDataType[]>();
for (const t of APPLE_DATA_TYPES) {
  const full = PLAY_CATEGORY[t].toLowerCase();
  const short = full.split(": ").pop()!;
  for (const key of new Set([full, short])) APPLE_BY_PLAY.set(key, [...(APPLE_BY_PLAY.get(key) ?? []), t]);
}

/**
 * Normalizes a declared data type — `NSPrivacyCollectedDataTypeCrashData`, `CrashData`,
 * or a Play category like `Crash logs` / `App info and performance: Crash logs` — to Apple
 * short names. Unknown strings return [].
 */
export function normalizeDataType(raw: string): AppleDataType[] {
  const trimmed = raw.trim();
  const short = trimmed.startsWith(APPLE_DATA_TYPE_PREFIX) ? trimmed.slice(APPLE_DATA_TYPE_PREFIX.length) : trimmed;
  const apple = APPLE_BY_LOWER.get(short.toLowerCase());
  if (apple) return [apple];
  return APPLE_BY_PLAY.get(trimmed.toLowerCase()) ?? [];
}
