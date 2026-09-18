/** What the cue throttle already keys on, so the two agree on identity. */
export const SESSION_PREFIX_LEN = 12;

// Whole words rather than substrings: `keyboard` is not a key and `token_count`
// is a metric, but `private_key` and `refresh_token` are exactly what must never land.
const CREDENTIAL_WORDS = new Set([
  "token", "secret", "secrets", "password", "passwords", "passwd", "credential",
  "credentials", "authorization", "auth", "bearer", "cookie", "cookies", "apikey",
  "key", "jwt",
]);

// A counted token is a number, not a credential, and this library serves LLM
// tooling where token counts are the most common attribute of all.
const COUNT_WORDS = new Set(["count", "used", "limit", "max", "total", "remaining"]);

const SESSION_WORD = "session";

function wordsOf(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

// Only `token` earns the count exemption: nobody counts passwords, so
// `password_max` is a credential with a suffix, not a metric.
function isCredentialKey(words: readonly string[]): boolean {
  const credentials = words.filter((word) => CREDENTIAL_WORDS.has(word));
  if (credentials.length === 0) return false;
  const onlyTokens = credentials.every((word) => word === "token");
  return !(onlyTokens && words.some((word) => COUNT_WORDS.has(word)));
}

export function redact(attributes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    const words = wordsOf(key);
    if (isCredentialKey(words)) {
      dropped.push(key);
      continue;
    }
    out[key] = words.includes(SESSION_WORD) && typeof value === "string"
      ? value.slice(0, SESSION_PREFIX_LEN)
      : value;
  }
  if (dropped.length > 0) out["madeit.redacted"] = dropped;
  return out;
}
