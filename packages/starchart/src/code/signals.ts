/** Call names recognised as feature-flag reads (PostHog, LaunchDarkly, Statsig, GrowthBook, Unleash). */
export const FLAG_FUNCS: ReadonlySet<string> = new Set([
  "isFeatureEnabled",
  "isFeatureFlagEnabled",
  "useFeatureFlagEnabled",
  "useFeatureFlag",
  "useFeatureFlagPayload",
  "useFeatureFlagVariantKey",
  "getFeatureFlag",
  "getFeatureFlagPayload",
  "variation",
  "boolVariation",
  "stringVariation",
  "intVariation",
  "doubleVariation",
  "numberVariation",
  "jsonVariation",
  "jsonValueVariation",
  "checkGate",
  "useGate",
  "getFeatureValue",
  "useFeatureIsOn",
  "useFeatureValue",
]);

/** Call names recognised as analytics event emission (PostHog, Segment, Amplitude, Mixpanel, Firebase). */
export const EVENT_FUNCS: ReadonlySet<string> = new Set(["track", "capture", "logEvent", "trackEvent"]);

/** Env var names: conventional upper snake case, but anything identifier-like is accepted. */
export function isEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/** Flag keys and event names: printable, no whitespace at the ends, reasonably short. */
export function isSignalKey(name: string): boolean {
  return name.length > 0 && name.length <= 200 && name.trim() === name && !/[\n\r\t]/.test(name);
}
