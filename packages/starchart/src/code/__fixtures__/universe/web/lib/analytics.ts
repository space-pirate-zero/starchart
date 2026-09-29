// @ts-nocheck
import posthog from "posthog-js";

export function track(event: string): void {
  posthog.capture(event);
}
