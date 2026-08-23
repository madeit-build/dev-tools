import {
  datastoreId, portId, serviceId,
  type EdgeType, type OrreryEdge, type OrreryNode,
} from "@made-i-t/orrery-model";
import type { RuleResult } from "./services";
import type { PortIndex } from "./ports";

export const PARTS_APPLY = `s: builtins.mapAttrs (n: v: {
  state = v.serviceConfig.StateDirectory or null;
  workdir = v.serviceConfig.WorkingDirectory or null;
  envFile = v.serviceConfig.EnvironmentFile or null;
}) s`;

export interface RawParts {
  state: unknown;
  workdir: string | null;
  envFile: unknown;
}

// systemd accepts a space-separated string here and NixOS passes it through
// untyped, so one fleet yields "nats", ["caddy"], and "postgresql
// postgresql/17" from the same option. Splitting on whitespace is what keeps
// postgres's second directory from silently disappearing.
export function toList(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap((v) => toList(v));
  if (typeof value !== "string") return [];
  return value.split(/\s+/).filter(Boolean);
}

// Two conventions, both present in the real fleet: sops-nix renders into
// /run/secrets, systemd's LoadCredential into /run/credentials.
const SECRET_PATH = /\/run\/(?:secrets|credentials)\//;

export function partsRule(
  host: string,
  raw: Record<string, RawParts>,
  serviceUnits: ReadonlySet<string>,
  index: PortIndex,
): RuleResult {
  const nodes: OrreryNode[] = [];
  const edges: OrreryEdge[] = [];
  const seen = new Set<string>();

  const add = (node: OrreryNode, from: string, type: EdgeType): void => {
    if (!seen.has(node.id)) {
      seen.add(node.id);
      nodes.push(node);
      edges.push({
        id: `contains:${from}->${node.id}`,
        from, to: node.id, type: "contains", source: "declared", evidence: null,
      });
    }
    edges.push({
      id: `${type}:${from}->${node.id}`,
      from, to: node.id, type, source: "declared", evidence: null,
    });
  };

  for (const unit of Object.keys(raw).sort()) {
    if (!serviceUnits.has(unit)) continue;
    const svc = serviceId(host, unit);
    const p = raw[unit];

    for (const dir of toList(p.state)) {
      add({
        id: datastoreId(host, `${unit}/${dir}`), type: "datastore", label: dir, host,
        attrs: { path: `/var/lib/${dir}`, kind: "state" }, provenance: { files: [] },
      }, svc, "writes");
    }

    for (const file of toList(p.envFile)) {
      const secret = SECRET_PATH.test(file);
      add({
        id: datastoreId(host, `${unit}/env`), type: "datastore",
        // The label carries the fact. The path goes in attrs, where the
        // sanitizer redacts it. Drawing "reads a secret" is the point;
        // drawing which secret is not.
        label: secret ? "secret env" : "env file", host,
        attrs: { path: file, kind: secret ? "secret" : "env" }, provenance: { files: [] },
      }, svc, "reads");
    }

    for (const [port, owner] of [...index].sort((a, b) => a[0] - b[0])) {
      if (owner.unit !== unit) continue;
      add({
        id: portId(host, port), type: "port", label: `:${port}`, host,
        // The port's own confidence travels with it: a port read out of an
        // env var should not look as solid as a published docker mapping.
        attrs: { port, confidence: owner.source }, provenance: { files: [] },
      }, svc, "listens-on");
    }
  }

  return { nodes, edges, ledger: [] };
}
