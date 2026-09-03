import {
  moduleId, optionId, toRepoPath,
  type DropRecord, type OrreryEdge, type OrreryNode,
} from "@made-i-t/orrery-model";
import type { RuleResult } from "./services";

// definitionsWithLocations, not options.<path>.files. The former says which
// file contributed which keys; the latter says only that eight files touched
// the option, which would link every module to every vhost.
export const PROVENANCE_APPLY =
  `o: builtins.map (d: { file = d.file; names = builtins.attrNames d.value; }) o.definitionsWithLocations`;

// Option paths worth attributing. Each is an attrset-of-submodules whose keys
// are already nodes in the graph, which is what makes per-key attribution
// meaningful rather than decorative.
export const TRACKED_OPTIONS = [
  "services.caddy.virtualHosts",
  "systemd.services",
  "virtualisation.oci-containers.containers",
] as const;

export interface RawDefinition {
  file: string;
  names: string[];
}

// Maps one key of the tracked option to the id of the node representing it.
// Supplied by the pipeline, which knows what actually survived the filters.
export type ResolveNodeId = (host: string, name: string) => string | null;

const RULE = "provenance";

export function provenanceRule(
  host: string,
  option: string,
  defs: RawDefinition[],
  resolveNodeId: ResolveNodeId,
): RuleResult {
  const nodes: OrreryNode[] = [];
  const edges: OrreryEdge[] = [];
  const ledger: DropRecord[] = [];

  const optId = optionId(host, option);
  nodes.push({
    id: optId, type: "option", label: option, host,
    attrs: { definitions: defs.length },
    provenance: { files: defs.map((d) => toRepoPath(d.file)), option },
  });

  const seenModules = new Set<string>();

  for (const def of defs) {
    const repoPath = toRepoPath(def.file);
    const modId = moduleId(repoPath);

    if (!seenModules.has(modId)) {
      seenModules.add(modId);
      nodes.push({
        id: modId, type: "module", label: repoPath, host: null,
        attrs: {}, provenance: { files: [repoPath] },
      });
      edges.push({
        id: `defines:${modId}->${optId}`,
        from: modId, to: optId,
        type: "defines", source: "declared", evidence: null,
      });
    }

    for (const name of [...def.names].sort()) {
      const target = resolveNodeId(host, name);

      // The key survived the option but not the graph, e.g. a systemd unit
      // that was filtered out. An edge into nothing would fail validation.
      if (!target) {
        ledger.push({
          candidate: `${option}.${name}`,
          host, rule: RULE, reason: "filtered-by-rule",
          detail: `defined in ${repoPath} but has no node in the graph`,
        });
        continue;
      }

      edges.push({
        id: `declared-by:${target}->${modId}`,
        from: target, to: modId,
        // Nix told us which file this definition came from. Nothing here is
        // a reading of free text, so this is as declared as an edge gets.
        type: "declared-by", source: "declared",
        evidence: `${option}.${name}`,
      });
    }
  }

  return { nodes, edges, ledger };
}
