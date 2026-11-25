const NETWORK_SCHEMES = new Set(["https:", "http:", "ssh:", "git:"]);
// user@host:path, git's scp-like form. A single-letter "host" is a Windows drive, not a remote.
const SCP_LIKE = /^(?:[^@/\s]+@)?([^:/\s]{2,}):(?!\/\/)(.+)$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function remotePath(url: string): string | null {
  const scp = SCP_LIKE.exec(url);
  if (scp) return scp[2];
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (!NETWORK_SCHEMES.has(parsed.protocol)) return null;
  try {
    return decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
}

// Returns owner and name only. Whatever else the URL carried, a credential included, is dropped here.
export function parseOrigin(url: string): { owner: string; name: string } | null {
  const path = remotePath(url.trim());
  if (path === null) return null;
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.length < 2) return null;
  const last = segments[segments.length - 1];
  segments[segments.length - 1] = last.endsWith(".git") ? last.slice(0, -4) : last;
  if (!segments.every((segment) => SEGMENT.test(segment))) return null;
  return { owner: segments.slice(0, -1).join("/"), name: segments[segments.length - 1] };
}
