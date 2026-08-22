import {
  hostId, serviceId,
  type DropRecord, type OrreryEdge, type OrreryNode,
} from "@made-i-t/orrery-model";

// The projection. Kept as an exported constant so the fixture-capture command
// and the live pipeline cannot drift apart.
export const SERVICES_APPLY = `s: builtins.mapAttrs (n: v: {
  inherit (v) description wantedBy after;
  exec = v.serviceConfig.ExecStart or null;
  user = v.serviceConfig.User or null;
  type = v.serviceConfig.Type or null;
}) s`;

export interface RawService {
  description: string;
  wantedBy: string[];
  after: string[];
  exec: string | null;
  user: string | null;
  type: string | null;
}

export interface RuleResult {
  nodes: OrreryNode[];
  edges: OrreryEdge[];
  ledger: DropRecord[];
}

const RULE = "services";

// A unit ending in @ is a systemd template: a pattern instances are made from,
// not something that runs. Drawing it would put a box on the diagram that
// corresponds to no process.
const isTemplate = (unit: string): boolean => unit.endsWith("@");

// Measured on the real box 2026-08-21: of 76 units with an ExecStart, 45 are
// Type=oneshot and 31 are long-running. A oneshot is a job that ran at boot
// (claude-mem-db-password, box-vulnix-scan); postgresql is running right now.
// Drawing them as peers makes a 76-node hairball out of a 31-node system, so
// they are classified rather than dropped: nothing vanishes, and the Runtime
// lens hides jobs behind a toggle.
export type Lifecycle = "running" | "oneshot";

const lifecycleOf = (type: string | null): Lifecycle =>
  type === "oneshot" ? "oneshot" : "running";

export function servicesRule(host: string, raw: Record<string, RawService>): RuleResult {
  const nodes: OrreryNode[] = [];
  const edges: OrreryEdge[] = [];
  const ledger: DropRecord[] = [];

  // Sorted, so the same input always produces the same output ordering.
  for (const unit of Object.keys(raw).sort()) {
    const svc = raw[unit];

    if (isTemplate(unit)) {
      ledger.push({ candidate: unit, host, rule: RULE, reason: "filtered-by-rule", detail: "systemd template unit" });
      continue;
    }

    if (!svc.exec) {
      ledger.push({ candidate: unit, host, rule: RULE, reason: "no-exec", detail: "no ExecStart" });
      continue;
    }

    const id = serviceId(host, unit);
    nodes.push({
      id,
      type: "service",
      label: unit,
      host,
      attrs: {
        description: svc.description || null,
        exec: svc.exec,
        user: svc.user,
        lifecycle: lifecycleOf(svc.type),
        wantedBy: svc.wantedBy.join(", ") || null,
      },
      provenance: { files: [] },
    });

    edges.push({
      id: `contains:${hostId(host)}->${id}`,
      from: hostId(host), to: id,
      type: "contains", source: "declared", evidence: null,
    });
  }

  // Ordering dependencies, but only between units that both survived the
  // filter. A .target is an ordering milestone, not a process, so it never
  // becomes a node and never becomes an edge.
  const kept = new Set(nodes.map((n) => n.label));
  for (const unit of Object.keys(raw).sort()) {
    if (!kept.has(unit)) continue;
    for (const dep of raw[unit].after) {
      if (!dep.endsWith(".service")) continue;
      const depUnit = dep.slice(0, -".service".length);
      if (!kept.has(depUnit)) continue;
      edges.push({
        id: `depends-on:${serviceId(host, unit)}->${serviceId(host, depUnit)}`,
        from: serviceId(host, unit), to: serviceId(host, depUnit),
        type: "depends-on", source: "declared", evidence: `after=${dep}`,
      });
    }
  }

  return { nodes, edges, ledger };
}
