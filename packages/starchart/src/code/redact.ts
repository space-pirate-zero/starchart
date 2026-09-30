/**
 * Keeps credentials out of the graph. Literal values of code constants are useful (prices, product
 * ids, feature lists), but a hardcoded API key or connection string would otherwise flow into the
 * viewer HTML, `emit graph`, the MCP server and `serve`. A value is withheld when its symbol name
 * says "secret" or when any string inside it looks like a credential.
 */

const SECRET_NAME =
  /(secret|passw(or)?d|pwd|passphrase|token|api[_-]?key|apikey|private[_-]?key|credential|auth[_-]?key|access[_-]?key|signing[_-]?key|client[_-]?secret|webhook[_-]?secret|\bdsn\b|_dsn$|^dsn)/i;

const SECRET_VALUE: RegExp[] = [
  /^(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/, // Stripe secret / restricted keys
  /^whsec_[A-Za-z0-9]{8,}/, // Stripe webhook secrets
  /^gh[pousr]_[A-Za-z0-9]{20,}/, // GitHub tokens
  /^github_pat_[A-Za-z0-9_]{20,}/,
  /^(?:AKIA|ASIA)[0-9A-Z]{16}$/, // AWS access key ids
  /^AIza[0-9A-Za-z_-]{30,}/, // Google API keys
  /^xox[abprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /^sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/, // Anthropic / OpenAI keys
  /^npm_[A-Za-z0-9]{30,}/, // npm tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private keys
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/, // JWTs
  /^[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i, // URLs with embedded credentials
];

/** Whether a single string looks like a credential. */
export function looksLikeSecret(value: string): boolean {
  return SECRET_VALUE.some((re) => re.test(value.trim()));
}

function containsSecret(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (typeof value === "string") return looksLikeSecret(value);
  if (Array.isArray(value)) return value.some((v) => containsSecret(v, depth + 1));
  if (value && typeof value === "object") return Object.values(value).some((v) => containsSecret(v, depth + 1));
  return false;
}

/**
 * The value to store for a code symbol: the literal itself, or `undefined` (and `redacted: true`)
 * when the name or the content looks secret. Non-string literals under a secret-looking name
 * (e.g. a numeric PIN) are withheld too.
 */
export function redactLiteral(name: string, value: unknown): { value: unknown; redacted: boolean } {
  if (value === undefined) return { value, redacted: false };
  if (SECRET_NAME.test(name) || containsSecret(value)) return { value: undefined, redacted: true };
  return { value, redacted: false };
}
