export const NODE_TYPES = [
  "fleet", "host", "external", "service", "vhost",
  "datastore", "port", "part", "module", "option", "input",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const EDGE_TYPES = [
  "contains",
  "proxies-to", "listens-on", "reads", "writes", "depends-on",
  "declared-by", "defines", "imports", "provides",
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

// Whether Nix told us this edge exists, or whether we guessed it by reading
// free-form config text. Rendered as solid vs dashed. The diagram must never
// present a guess as a fact.
export type EdgeSource = "declared" | "inferred";

// Where in the source a node came from. Paths are repo-relative, always.
export interface Provenance {
  files: string[];
  option?: string;
}

export interface OrreryNode {
  id: string;
  type: NodeType;
  label: string;
  host: string | null;
  attrs: Record<string, string | number | boolean | null>;
  provenance: Provenance;
}

export interface OrreryEdge {
  id: string;
  from: string;
  to: string;
  type: EdgeType;
  source: EdgeSource;
  // Why we believe this edge exists. For inferred edges this is the matched
  // text, which is what makes a wrong guess debuggable instead of mysterious.
  evidence: string | null;
}

export const DROP_REASONS = [
  "no-exec", "filtered-by-rule", "rule-error", "eval-failed",
] as const;
export type DropReason = (typeof DROP_REASONS)[number];

export interface DropRecord {
  candidate: string;
  host: string | null;
  rule: string;
  reason: DropReason;
  detail: string;
}

export interface Graph {
  version: 1;
  generatedAt: string;
  flakeRef: string;
  nodes: OrreryNode[];
  edges: OrreryEdge[];
  ledger: DropRecord[];
}
