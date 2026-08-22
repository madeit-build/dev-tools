import type { Graph, OrreryNode } from "./types";

export const REDACTED = "<redacted>";

// A nix store path looks like /nix/store/<32 base32 chars>-<name>/<rest>.
// The rest is the path inside the flake source, which is what a reader wants.
const STORE_PATH = /^\/nix\/store\/[0-9a-df-np-sv-z]{32}-[^/]+\/(.*)$/;

// Any absolute path under a user's home. Two shapes cover macOS and Linux.
// We keep only the tail from the last recognizable repo boundary, because a
// committed artifact must never reveal local filesystem structure.
const HOME_PATH = /^\/(?:Users|home)\/[^/]+\/(?:.*\/)?([^/]+\/(?:nix|src|docs)\/.*)$/;

export function toRepoPath(p: string): string {
  const store = STORE_PATH.exec(p);
  if (store) return store[1];

  const home = HOME_PATH.exec(p);
  if (home) {
    const tail = home[1];
    const slash = tail.indexOf("/");
    return slash < 0 ? tail : tail.slice(slash + 1);
  }

  return p;
}

// Matches on the NAME, never the value. A name is an architectural fact worth
// drawing ("this service reads a secret called X"); the value never is.
const SECRET_NAME = /(secret|password|passwd|token|api[_-]?key|apikey|credential|private[_-]?key|auth)/i;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

const SECRET_VALUE_PATH = /^\/run\/secrets\//;

function sanitizeNode(n: OrreryNode): OrreryNode {
  const attrs: OrreryNode["attrs"] = {};
  for (const [k, v] of Object.entries(n.attrs)) {
    const leaks = isSecretName(k) || (typeof v === "string" && SECRET_VALUE_PATH.test(v));
    attrs[k] = leaks ? REDACTED : v;
  }
  return {
    ...n,
    attrs,
    provenance: { ...n.provenance, files: n.provenance.files.map(toRepoPath) },
  };
}

export function sanitizeGraph(g: Graph): Graph {
  return { ...g, nodes: g.nodes.map(sanitizeNode) };
}
