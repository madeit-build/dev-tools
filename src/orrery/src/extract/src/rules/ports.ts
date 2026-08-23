import {
  serviceId, isSecretName,
  type DropRecord, type EdgeSource, type OrreryEdge,
} from "@made-i-t/orrery-model";
import type { RuleResult } from "./services";

export const CONTAINERS_APPLY = `c: builtins.mapAttrs (n: v: v.ports or []) c`;
export const ENV_APPLY = `s: builtins.mapAttrs (n: v: v.environment or {}) s`;

// Tier 2: services.<name>.port, for the units that have one.
//
// Probes a NAMED list rather than walking config.services, and the naming is
// the entire safety mechanism. config.services carries a lazy entry for every
// service nixpkgs knows about, not only the ones this host runs. Forcing one
// whose port option was renamed to a target that no longer exists calls abort,
// which is not catchable by tryEval, and takes the whole evaluation with it.
// A list built from units that actually exist never names those, and an
// unforced thunk costs nothing.
//
// Measured against box on 2026-08-22, where services.glitchtip is a service
// the fleet does not run:
//
//   s ? glitchtip           -> true    safe
//   s.glitchtip ? port      -> true    safe, a presence check does not force
//   s.glitchtip.enable      -> false   safe
//   s.glitchtip.port        -> ABORT
//   tryEval s.glitchtip.port-> ABORT
//
// So the `? port` check below does NOT defend against this: it reports true
// for a renamed option and the read still aborts. It is here for the ordinary
// case of a named unit with no port option at all, such as caddy.
//
// Gating on `.enable` would also dodge it, since a disabled service's port is
// never read, but that only holds while every poisoned rename sits on a
// service you do not run. Naming is structural; enable-gating is luck.
//
// Unit name and service option name coincide for native NixOS services, which
// is what makes the mapping back to a unit sound.
export function servicePortsApply(units: readonly string[]): string {
  const list = units.map((u) => JSON.stringify(u)).join(" ");
  return `s: builtins.listToAttrs (builtins.filter (x: x.value != null) (map (n:
  { name = n; value = if s ? \${n} && s.\${n} ? port then s.\${n}.port else null; })
  [ ${list} ]))`;
}

// One env var on the real box holds 1.5KB of ComfyUI workflow JSON. Dropped
// into graph.json it bloats the artifact and blows out the attribute panel.
// Oversized values are dropped rather than truncated: half a JSON blob is
// worse than no blob, because it looks like data.
export const MAX_ATTR_CHARS = 200;

export function capAttr(value: string): string | null {
  return value.length > MAX_ATTR_CHARS ? null : value;
}

export interface PortOwner {
  unit: string;
  source: EdgeSource;
}
export type PortIndex = Map<number, PortOwner>;

// A port is 1-65535. Bounding it stops a version string or a model name from
// being read as an endpoint.
const PORT = /(?::)(\d{2,5})(?:\b|\/)/g;

export function parseEndpoints(value: string): number[] {
  const out: number[] = [];
  for (const m of value.matchAll(PORT)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 65535) out.push(n);
  }
  return out;
}

// hostIP:hostPort:containerPort. The host side is what a reverse_proxy can
// reach; the container side is private to the bridge network.
const PUBLISHED = /^(?:[\d.]+:)?(\d+):(\d+)$/;

// OLLAMA_HOST inside the ollama unit is that unit declaring where it listens.
// The identical variable inside ollama-model-loader is that unit pointing at
// somebody else, and treating it as an ownership claim hands the port to the
// wrong service. Measured on the real box, where both units carry it.
//
// The prefix must equal the unit name, not merely start it: "ollama" and
// "ollama-model-loader" both begin with the same six letters.
function namesItself(unit: string, key: string): boolean {
  const prefix = key.slice(0, key.lastIndexOf("_")).toLowerCase().replace(/[_-]/g, "");
  return prefix === unit.toLowerCase().replace(/[_-]/g, "");
}

export function buildPortIndex(
  containers: Record<string, string[]>,
  servicePorts: Record<string, number>,
  env: Record<string, Record<string, string>>,
): PortIndex {
  const index: PortIndex = new Map();

  // Declared tiers first. A later inferred hit must never overwrite one.
  const claim = (port: number, unit: string, source: EdgeSource): void => {
    const held = index.get(port);
    if (held && held.source === "declared") return;
    index.set(port, { unit, source });
  };

  for (const name of Object.keys(containers).sort()) {
    for (const mapping of containers[name]) {
      const m = PUBLISHED.exec(mapping);
      if (!m) continue;
      // NixOS names the unit for an oci-container docker-<name>.
      claim(Number(m[1]), `docker-${name}`, "declared");
    }
  }

  for (const unit of Object.keys(servicePorts).sort()) {
    claim(servicePorts[unit], unit, "declared");
  }

  for (const unit of Object.keys(env).sort()) {
    for (const [key, value] of Object.entries(env[unit])) {
      if (isSecretName(key)) continue;
      if (typeof value !== "string") continue;
      // Only a variable naming this unit's own listen address. A URL pointing
      // at someone else is a link, handled by linksRule, not an ownership
      // claim over that port.
      if (!/_(HOST|PORT|LISTEN|ADDR|BIND)$/i.test(key)) continue;
      if (!namesItself(unit, key)) continue;
      for (const port of parseEndpoints(value)) claim(port, unit, "inferred");
    }
  }

  return index;
}

const RULE = "links";

export function linksRule(
  host: string,
  env: Record<string, Record<string, string>>,
  index: PortIndex,
  serviceUnits: ReadonlySet<string>,
): RuleResult {
  const edges: OrreryEdge[] = [];
  const ledger: DropRecord[] = [];
  const drawn = new Set<string>();

  for (const unit of Object.keys(env).sort()) {
    if (!serviceUnits.has(unit)) continue;

    for (const [key, value] of Object.entries(env[unit])) {
      // Never read an endpoint out of a secret-named variable. The value may
      // be a credential that merely looks like a URL, and reading it at all
      // risks putting it into evidence text.
      if (isSecretName(key)) continue;
      if (typeof value !== "string" || value.length > MAX_ATTR_CHARS) continue;

      for (const port of parseEndpoints(value)) {
        const owner = index.get(port);

        if (!owner || !serviceUnits.has(owner.unit)) {
          ledger.push({
            candidate: `${unit} -> :${port}`,
            host, rule: RULE, reason: "filtered-by-rule",
            detail: `env ${key} names port ${port}, which maps to no service in the graph`,
          });
          continue;
        }

        if (owner.unit === unit) continue;

        const id = `depends-on:${serviceId(host, unit)}->${serviceId(host, owner.unit)}`;
        if (drawn.has(id)) continue;
        drawn.add(id);

        edges.push({
          id,
          from: serviceId(host, unit), to: serviceId(host, owner.unit),
          type: "depends-on",
          // Always inferred, even when the port resolved from a declared
          // mapping. That a URL in an env var means a runtime dependency is
          // a reading of a string, and the weaker claim governs the edge.
          source: "inferred",
          evidence: `${key}=${value}`,
        });
      }
    }
  }

  return { nodes: [], edges, ledger };
}
