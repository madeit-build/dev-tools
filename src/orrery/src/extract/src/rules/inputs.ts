import {
  fleetId,
  inputId,
  type OrreryEdge,
  type OrreryNode,
} from "@made-i-t/orrery-model";
import type { FlakeMetadata } from "../nix";
import type { RuleResult } from "./services";

export function inputsRule(meta: FlakeMetadata): RuleResult {
  const nodes: OrreryNode[] = [];
  const edges: OrreryEdge[] = [];

  const inputs = meta.locks?.nodes?.root?.inputs ?? {};

  for (const name of Object.keys(inputs).sort()) {
    const id = inputId(name);
    nodes.push({
      id,
      type: "input",
      label: name,
      host: null,
      attrs: {},
      provenance: { files: [] },
    });
    edges.push({
      id: `provides:${fleetId()}->${id}`,
      from: fleetId(),
      to: id,
      type: "provides",
      source: "declared",
      evidence: null,
    });
  }

  return { nodes, edges, ledger: [] };
}
