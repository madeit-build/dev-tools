const NETWORK_SCHEMES = new Set(["https:", "http:", "ssh:", "git:"]);
// user@host:path, git's scp-like form. "word:path" is also how a URI scheme or a Windows drive looks,
// so the form counts only with a user or a dotted host, and never with an absolute path.
const SCP_LIKE = /^(?:([^@/\s:]+)@)?([A-Za-z0-9][A-Za-z0-9.-]*):(?!\/)(.+)$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const DOT_SEGMENTS = new Set([".", ".."]);

type Remote = { host: string; path: string };

// A bare word before the colon is a host only when the caller names it: an ssh alias they configured.
function scpLike(url: string, knownHosts: readonly string[]): Remote | null {
  const match = SCP_LIKE.exec(url);
  if (!match) return null;
  const [, user, rawHost, path] = match;
  const host = rawHost.toLowerCase();
  const isHost = user !== undefined
                 || host.includes(".")
                 || knownHosts.some((known) => known.toLowerCase() === host);
  return isHost ? { host, path } : null;
}

// URL parsing resolves "..", encoded or not, before we see the path. What a server does with the
// raw form is its own business, so a remote that needs resolving is not one we name.
const RAW_DOT_SEGMENT = /\/(?:\.|%2e){1,2}(?:\/|$)/i;

function networkUrl(url: string): Remote | null {
  if (RAW_DOT_SEGMENT.test(url) || !URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (!NETWORK_SCHEMES.has(parsed.protocol) || parsed.hostname === "")
    return null;
  try {
    return {
      host: parsed.hostname.toLowerCase(),
      path: decodeURIComponent(parsed.pathname),
    };
  } catch {
    return null;
  }
}

export type Origin = { host: string; owner: string; name: string };

// Returns host, owner and name only. Whatever else the URL carried, a credential included, is dropped here.
// The host is kept because an owner name means nothing without the forge it is an owner on.
export function parseOrigin(
  url: string,
  knownHosts: readonly string[] = [],
): Origin | null {
  const trimmed = url.trim();
  const remote = scpLike(trimmed, knownHosts) ?? networkUrl(trimmed);
  if (remote === null) return null;
  const segments = remote.path.split("/").filter((segment) => segment !== "");
  if (segments.length < 2) return null;
  const last = segments[segments.length - 1];
  segments[segments.length - 1] = last.endsWith(".git")
    ? last.slice(0, -4)
    : last;
  const isRepoSegment = (segment: string) =>
    SEGMENT.test(segment) && !DOT_SEGMENTS.has(segment);
  if (!segments.every(isRepoSegment)) return null;
  return {
    host: remote.host,
    owner: segments.slice(0, -1).join("/"),
    name: segments[segments.length - 1],
  };
}
