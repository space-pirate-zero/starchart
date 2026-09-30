/**
 * Screens regexes that come from repo config (rule `value.pattern`, fs `regex:` selectors). JS
 * regexes have no timeout, so a nested quantifier like `(a+)+` or `(.*)*` can hang STARCHART on a
 * crafted input. This rejects the common catastrophic shapes and oversized patterns; it is a
 * heuristic, not a proof of linear time.
 */

const MAX_PATTERN_LENGTH = 500;

/** A group whose body contains a quantifier, itself followed by a quantifier: `(a+)+`, `(\w*b)*`, `(x{2,})+`. */
const NESTED_QUANTIFIER = /\((?:\?:)?(?:[^()\\]|\\.)*(?:[+*]|\{\d+,\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,\d*\})/;

/** Why the pattern is unsafe, or undefined when it passes. */
export function unsafeRegexReason(pattern: string): string | undefined {
  if (pattern.length > MAX_PATTERN_LENGTH) return `pattern is longer than ${MAX_PATTERN_LENGTH} characters`;
  if (NESTED_QUANTIFIER.test(pattern)) return "nested quantifier (e.g. (a+)+) can backtrack catastrophically";
  return undefined;
}
