/** What the cue throttle already keys on, so the two agree on identity. */
export const SESSION_PREFIX_LEN = 12;

// Substring match rather than an exact list: the key that leaks is always the
// one nobody thought to enumerate, and a false positive costs one dropped
// attribute while a false negative costs a credential.
const CREDENTIAL = /(token|secret|password|credential|api[_.-]?key|^key$|authorization|cookie)/i;

const SESSION_KEYS = new Set(["madeit.session_id", "session_id"]);

export function redact(attributes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    const leaf = key.split(".").at(-1) ?? key;
    if (CREDENTIAL.test(key) || CREDENTIAL.test(leaf)) {
      dropped.push(key);
      continue;
    }
    out[key] = SESSION_KEYS.has(key) && typeof value === "string"
      ? value.slice(0, SESSION_PREFIX_LEN)
      : value;
  }
  if (dropped.length > 0) out["madeit.redacted"] = dropped;
  return out;
}
