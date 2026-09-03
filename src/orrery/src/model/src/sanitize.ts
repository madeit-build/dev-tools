import type { DropRecord, Graph, OrreryEdge, OrreryNode } from "./types";

export const REDACTED = "<redacted>";

// Nix base32 excludes e, o, t, and u. Matching the real alphabet is what keeps
// a path that merely starts with /nix/store from being mangled.
const STORE_HASH = "[0-9a-df-np-sv-z]{32}";

// A store path anchored at the start, used for source-file provenance where
// the useful answer is the path inside the flake.
const STORE_PATH_PREFIX = new RegExp(`^/nix/store/${STORE_HASH}-[^/]+/(.*)$`);

// The same shape found anywhere in a string, used for values like ExecStart.
// The name is kept and the hash dropped: the name says what runs, the hash is
// machine-specific churn and a local filesystem detail.
const STORE_PATH_ANYWHERE = new RegExp(`/nix/store/${STORE_HASH}-([^/\\s]+)`, "g");

// Any absolute path under any user's home, on macOS or Linux. Deliberately not
// requiring a repo-shaped tail: the original version only stripped paths whose
// tail contained nix/, src/, or docs/, which let every other home path through
// with the username attached.
const HOME_PATH_ANYWHERE = /\/(?:Users|home)\/[^/\s]+(?=\/)/g;

// A home path whose tail looks like it sits inside a repo. Used only for
// provenance, where a repo-relative path is both possible and more useful
// than a tilde.
const HOME_REPO_PATH = /^\/(?:Users|home)\/[^/]+\/(?:.*\/)?[^/]+\/((?:nix|src|docs)\/.*)$/;

// For source-file provenance: the path inside the repo, or inside the flake.
export function toRepoPath(p: string): string {
  const store = STORE_PATH_PREFIX.exec(p);
  if (store) return store[1];

  const home = HOME_REPO_PATH.exec(p);
  if (home) return home[1];

  return p;
}

// For any free-form string that may embed paths: attribute values, edge
// evidence, ledger details. Keeps the string readable while removing store
// hashes and usernames, both of which are local filesystem structure.
export function scrubText(s: string): string {
  return s
    .replace(STORE_PATH_ANYWHERE, "<store>/$1")
    .replace(HOME_PATH_ANYWHERE, "~");
}

// Matches on the NAME, never the value. A name is an architectural fact worth
// drawing ("this service reads a secret called X"); the value never is.
//
// url/dsn/connection are here because a connection string routinely embeds a
// password in its userinfo, which no value-shaped check would catch.
const SECRET_NAME =
  /(secret|password|passwd|_pw\b|pw_|token|api[_-]?key|apikey|access[_-]?key|credential|private[_-]?key|ssh[_-]?key|signing|salt|cert|pem|auth|bearer|session|cookie|dsn|connection[_-]?string|database[_-]?url)/i;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

// Anywhere in the value, not anchored: systemd's optional-file syntax puts a
// leading dash before the path, and a value may name a secret file as one
// argument among several.
//
// Two conventions, both present in the real fleet: /run/secrets is sops-nix,
// /run/credentials is systemd's own LoadCredential. Neither holds a secret at
// evaluation time, but a path into either says "a secret lands here", and the
// filename alone often names the credential.
const SECRET_VALUE_PATH = /\/run\/(?:secrets|credentials)\//;

function looksSecret(key: string, value: unknown): boolean {
  if (isSecretName(key)) return true;
  return typeof value === "string" && SECRET_VALUE_PATH.test(value);
}

function sanitizeNode(n: OrreryNode): OrreryNode {
  const attrs: OrreryNode["attrs"] = {};
  for (const [k, v] of Object.entries(n.attrs)) {
    if (looksSecret(k, v)) {
      attrs[k] = REDACTED;
      continue;
    }
    attrs[k] = typeof v === "string" ? scrubText(v) : v;
  }
  return {
    ...n,
    label: scrubText(n.label),
    attrs,
    provenance: { ...n.provenance, files: n.provenance.files.map(toRepoPath) },
  };
}

// Evidence is usually "KEY=value" or a matched config line. When the key half
// is secret-shaped the whole thing goes, because the value half is the secret.
const EVIDENCE_KEY = /^([A-Za-z0-9_.-]+)\s*=/;

function sanitizeEdge(e: OrreryEdge): OrreryEdge {
  if (e.evidence === null) return e;

  const key = EVIDENCE_KEY.exec(e.evidence);
  if ((key && isSecretName(key[1])) || SECRET_VALUE_PATH.test(e.evidence)) {
    return { ...e, evidence: REDACTED };
  }

  return { ...e, evidence: scrubText(e.evidence) };
}

function sanitizeDrop(r: DropRecord): DropRecord {
  return { ...r, candidate: scrubText(r.candidate), detail: scrubText(r.detail) };
}

export function sanitizeGraph(g: Graph): Graph {
  return {
    ...g,
    // The flake ref is whatever the caller typed, so on a real run it is an
    // absolute path into somebody's home. It is the one field that is not
    // derived from Nix output, and so the one a fixture test with a relative
    // ref will never catch.
    flakeRef: scrubText(g.flakeRef),
    nodes: g.nodes.map(sanitizeNode),
    edges: g.edges.map(sanitizeEdge),
    ledger: g.ledger.map(sanitizeDrop),
  };
}
