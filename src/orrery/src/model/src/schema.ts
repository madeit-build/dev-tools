import { z } from "zod";
import { NODE_TYPES, EDGE_TYPES, DROP_REASONS, type Graph } from "./types";

const attrValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const nodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(NODE_TYPES),
  label: z.string(),
  host: z.string().nullable(),
  attrs: z.record(z.string(), attrValue),
  provenance: z.object({
    files: z.array(z.string()),
    option: z.string().optional(),
  }),
});

const edgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.enum(EDGE_TYPES),
  source: z.enum(["declared", "inferred"]),
  evidence: z.string().nullable(),
});

const ledgerSchema = z.object({
  candidate: z.string(),
  host: z.string().nullable(),
  rule: z.string(),
  reason: z.enum(DROP_REASONS),
  detail: z.string(),
});

export const graphSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  flakeRef: z.string(),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  ledger: z.array(ledgerSchema),
});

// Structural rules zod cannot express. Each one is a bug that would otherwise
// surface as an unexplained blank area in the UI rather than as an error.
function checkIntegrity(g: Graph): void {
  const seen = new Set<string>();
  for (const n of g.nodes) {
    if (seen.has(n.id)) throw new Error(`duplicate node id: ${n.id}`);
    seen.add(n.id);

    for (const f of n.provenance.files) {
      if (f.startsWith("/")) {
        throw new Error(`absolute path in provenance for ${n.id}: ${f}`);
      }
    }
  }

  for (const e of g.edges) {
    if (!seen.has(e.from))
      throw new Error(`dangling edge ${e.id}: no node ${e.from}`);
    if (!seen.has(e.to))
      throw new Error(`dangling edge ${e.id}: no node ${e.to}`);
  }
}

export function validateGraph(input: unknown): Graph {
  const parsed = graphSchema.parse(input) as Graph;
  checkIntegrity(parsed);
  return parsed;
}
