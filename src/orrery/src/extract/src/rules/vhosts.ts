import {
  hostId, serviceId, vhostId,
  type DropRecord, type OrreryEdge, type OrreryNode,
} from "@made-i-t/orrery-model";
import type { RuleResult } from "./services";

export const VHOSTS_APPLY = `v: builtins.mapAttrs (n: h: { extra = h.extraConfig or ""; }) v`;

export interface RawVHost {
  extra: string;
}

export interface Upstream {
  host: string;
  port: number;
  raw: string;
}

const RULE = "vhosts";

// Caddyfile is not a format with a parser we can import, so this is a text
// match, and everything it produces is marked inferred for exactly that
// reason. A trailing { is allowed because a reverse_proxy may open a block.
const REVERSE_PROXY = /^\s*reverse_proxy\s+([A-Za-z0-9_.-]+):(\d+)\s*\{?\s*$/;

export function parseUpstreams(extraConfig: string): Upstream[] {
  const found: Upstream[] = [];
  for (const line of extraConfig.split("\n")) {
    // A commented reverse_proxy is documentation, not configuration. The real
    // ollama vhost carries exactly this case in its comment block.
    if (line.trimStart().startsWith("#")) continue;
    const m = REVERSE_PROXY.exec(line);
    if (!m) continue;
    found.push({ host: m[1], port: Number(m[2]), raw: line.trim() });
  }
  return found;
}

export function vhostsRule(
  host: string,
  raw: Record<string, RawVHost>,
  serviceUnits: ReadonlySet<string>,
  portToUnit: Record<number, string>,
): RuleResult {
  const nodes: OrreryNode[] = [];
  const edges: OrreryEdge[] = [];
  const ledger: DropRecord[] = [];

  for (const name of Object.keys(raw).sort()) {
    const id = vhostId(host, name);

    nodes.push({
      id, type: "vhost", label: name, host,
      attrs: { config: raw[name].extra.trim() || null },
      provenance: { files: [] },
    });

    edges.push({
      id: `contains:${hostId(host)}->${id}`,
      from: hostId(host), to: id,
      type: "contains", source: "declared", evidence: null,
    });

    for (const up of parseUpstreams(raw[name].extra)) {
      const unit = portToUnit[up.port];

      // Refuse to draw an edge into a node that does not exist. A dangling
      // edge would fail schema validation anyway, and a guessed edge to a
      // guessed node is two guesses stacked.
      if (!unit || !serviceUnits.has(unit)) {
        ledger.push({
          candidate: `${name} -> :${up.port}`,
          host, rule: RULE, reason: "filtered-by-rule",
          detail: `upstream port ${up.port} maps to no service in the graph`,
        });
        continue;
      }

      edges.push({
        id: `proxies-to:${id}->${serviceId(host, unit)}`,
        from: id, to: serviceId(host, unit),
        type: "proxies-to",
        // Always inferred. This came from matching text in a Caddyfile, not
        // from anything NixOS asserted.
        source: "inferred",
        evidence: up.raw,
      });
    }
  }

  return { nodes, edges, ledger };
}
