const NETWORK_SCHEMES = new Set(["https:", "http:", "ssh:", "git:"]);
// user@host:path, git's scp-like form. "word:path" is also how a URI scheme or a Windows drive looks,
// so the form counts only with a user or a dotted host, and never with an absolute path.
const SCP_LIKE = /^(?:([^@/\s:]+)@)?([A-Za-z0-9][A-Za-z0-9.-]*):(?!\/)(.+)$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type Remote = { host: string; path: string };

function scpLike(url: string): Remote | null {
  const match = SCP_LIKE.exec(url);
  if (!match) return null;
  const [, user, host, path] = match;
  return user !== undefined || host.includes(".") ? { host: host.toLowerCase(), path } : null;
}

function networkUrl(url: string): Remote | null {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (!NETWORK_SCHEMES.has(parsed.protocol) || parsed.hostname === "") return null;
  try {
    return { host: parsed.hostname.toLowerCase(), path: decodeURIComponent(parsed.pathname) };
  } catch {
    return null;
  }
}

export type Origin = { host: string; owner: string; name: string };

// Returns host, owner and name only. Whatever else the URL carried, a credential included, is dropped here.
// The host is kept because an owner name means nothing without the forge it is an owner on.
export function parseOrigin(url: string): Origin | null {
  const trimmed = url.trim();
  const remote = scpLike(trimmed) ?? networkUrl(trimmed);
  if (remote === null) return null;
  const segments = remote.path.split("/").filter((segment) => segment !== "");
  if (segments.length < 2) return null;
  const last = segments[segments.length - 1];
  segments[segments.length - 1] = last.endsWith(".git") ? last.slice(0, -4) : last;
  if (!segments.every((segment) => SEGMENT.test(segment))) return null;
  return { host: remote.host, owner: segments.slice(0, -1).join("/"), name: segments[segments.length - 1] };
}
