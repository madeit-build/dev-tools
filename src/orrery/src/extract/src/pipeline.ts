import {
  fleetId, hostId, vhostId, sanitizeGraph, validateGraph,
  type DropRecord, type Graph, type OrreryEdge, type OrreryNode,
} from "@made-i-t/orrery-model";
import { nixEvalOptional, flakeMetadata, type FlakeMetadata } from "./nix";
import { discoverHosts, type HostRef } from "./discover";
import { servicesRule, SERVICES_APPLY, type RawService } from "./rules/services";
import { buildPortIndex, linksRule, servicePortsApply, CONTAINERS_APPLY, ENV_APPLY } from "./rules/ports";
import { vhostsRule, VHOSTS_APPLY, type RawVHost } from "./rules/vhosts";
import { provenanceRule, PROVENANCE_APPLY, type RawDefinition } from "./rules/provenance";
import { partsRule, PARTS_APPLY, type RawParts } from "./rules/parts";
import {
  launchdAgentsRule, homebrewRule,
  LAUNCHD_AGENTS_APPLY, HOMEBREW_APPLY,
  type RawAgent, type RawHomebrew,
} from "./rules/darwin";
import { inputsRule } from "./rules/inputs";
import { log } from "./log";

export interface Deps {
  discover: (flakeRef: string) => Promise<HostRef[]>;
  metadata: (flakeRef: string) => Promise<FlakeMetadata>;
  evaluate: (flakeRef: string, attrPath: string, apply?: string) => Promise<unknown>;
}

const realDeps: Deps = {
  discover: (ref) => discoverHosts(ref),
  metadata: (ref) => flakeMetadata(ref),
  evaluate: (ref, attr, apply) => nixEvalOptional<unknown>(ref, attr, apply),
};

// One rule failing must not lose the rest of the graph. A rule that throws
// becomes a ledger row naming itself, which is strictly more useful than a
// stack trace and an empty diagram.
async function guard<T>(
  rule: string, host: string | null, ledger: DropRecord[], run: () => Promise<T>,
): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log("rule.failed", { rule, host, detail });
    ledger.push({ candidate: rule, host, rule, reason: "eval-failed", detail });
    return null;
  }
}

export async function buildGraph(flakeRef: string, deps: Deps = realDeps): Promise<Graph> {
  const nodes: OrreryNode[] = [];
  const edges: OrreryEdge[] = [];
  const ledger: DropRecord[] = [];

  nodes.push({
    id: fleetId(), type: "fleet", label: "fleet", host: null,
    attrs: {}, provenance: { files: [] },
  });

  const meta = await guard("inputs", null, ledger, () => deps.metadata(flakeRef));
  if (meta) {
    const r = inputsRule(meta);
    nodes.push(...r.nodes);
    edges.push(...r.edges);
    log("rule.done", { rule: "inputs", host: null, nodes: r.nodes.length, edges: r.edges.length });
  }

  const hosts = await deps.discover(flakeRef);
  log("hosts.discovered", { count: hosts.length });

  for (const host of hosts) {
    const base = host.kind === "nixos" ? "nixosConfigurations" : "darwinConfigurations";
    const cfg = `${base}.${host.name}.config`;
    const opts = `${base}.${host.name}.options`;

    nodes.push({
      id: hostId(host.name), type: "host", label: host.name, host: host.name,
      attrs: { kind: host.kind }, provenance: { files: [] },
    });
    edges.push({
      id: `contains:${fleetId()}->${hostId(host.name)}`,
      from: fleetId(), to: hostId(host.name),
      type: "contains", source: "declared", evidence: null,
    });

    if (host.kind === "darwin") {
      // A Mac's declared surface is home-manager launchd agents and homebrew
      // applications; the NixOS rules below would all be missing-attrs. The
      // user enumeration is real, not assumed: a multi-user Mac gets every
      // user's agents, disambiguated by name only if they ever collide.
      const users = (await guard("darwin-users", host.name, ledger, () =>
        deps.evaluate(flakeRef, `${cfg}.home-manager.users`, "builtins.attrNames") as Promise<string[] | null>)) ?? [];

      for (const user of [...users].sort()) {
        const rawAgents = await guard("launchd-agents", host.name, ledger, () =>
          deps.evaluate(flakeRef, `${cfg}.home-manager.users.${user}.launchd.agents`,
                        LAUNCHD_AGENTS_APPLY) as Promise<Record<string, RawAgent> | null>);
        if (rawAgents) {
          const r = launchdAgentsRule(host.name, rawAgents);
          nodes.push(...r.nodes); edges.push(...r.edges); ledger.push(...r.ledger);
          log("rule.done", { rule: "launchd-agents", host: host.name, user, nodes: r.nodes.length });
        }
      }

      const rawBrew = await guard("homebrew", host.name, ledger, () =>
        deps.evaluate(flakeRef, `${cfg}.homebrew`, HOMEBREW_APPLY) as Promise<RawHomebrew | null>);
      if (rawBrew) {
        const r = homebrewRule(host.name, rawBrew);
        nodes.push(...r.nodes); edges.push(...r.edges); ledger.push(...r.ledger);
        log("rule.done", { rule: "homebrew", host: host.name, nodes: r.nodes.length });
      }
      continue;
    }

    // Services first: everything downstream needs to know which units exist.
    const rawServices = await guard("services", host.name, ledger, () =>
      deps.evaluate(flakeRef, `${cfg}.systemd.services`, SERVICES_APPLY) as Promise<Record<string, RawService> | null>);

    let units = new Set<string>();
    if (rawServices) {
      const r = servicesRule(host.name, rawServices);
      nodes.push(...r.nodes); edges.push(...r.edges); ledger.push(...r.ledger);
      units = new Set(r.nodes.map((n) => n.label));
      log("rule.done", { rule: "services", host: host.name, nodes: r.nodes.length, dropped: r.ledger.length });
    }

    const rawContainers = (await guard("containers", host.name, ledger, () =>
      deps.evaluate(flakeRef, `${cfg}.virtualisation.oci-containers.containers`, CONTAINERS_APPLY) as Promise<Record<string, string[]> | null>)) ?? {};

    const rawEnv = (await guard("env", host.name, ledger, () =>
      deps.evaluate(flakeRef, `${cfg}.systemd.services`, ENV_APPLY) as Promise<Record<string, Record<string, string>> | null>)) ?? {};

    // Probed only for units that survived the services filter: naming the list
    // is what keeps an unrelated renamed nixpkgs service from aborting the
    // evaluation. Skipped entirely when no unit survived.
    const rawServicePorts = units.size === 0 ? {} : (await guard("service-ports", host.name, ledger, () =>
      deps.evaluate(flakeRef, `${cfg}.services`, servicePortsApply([...units].sort())) as Promise<Record<string, number> | null>)) ?? {};

    const portIndex = buildPortIndex(rawContainers ?? {}, rawServicePorts ?? {}, rawEnv ?? {});
    log("ports.indexed", { host: host.name, count: portIndex.size });

    const links = linksRule(host.name, rawEnv ?? {}, portIndex, units);
    edges.push(...links.edges); ledger.push(...links.ledger);

    // The fourth zoom level. Without it, drilling past a service lands on an
    // empty canvas.
    const rawParts = await guard("parts", host.name, ledger, () =>
      deps.evaluate(flakeRef, `${cfg}.systemd.services`, PARTS_APPLY) as Promise<Record<string, RawParts> | null>);

    if (rawParts) {
      const r = partsRule(host.name, rawParts, units, portIndex);
      nodes.push(...r.nodes); edges.push(...r.edges); ledger.push(...r.ledger);
      log("rule.done", { rule: "parts", host: host.name, nodes: r.nodes.length });
    }

    const rawVHosts = await guard("vhosts", host.name, ledger, () =>
      deps.evaluate(flakeRef, `${cfg}.services.caddy.virtualHosts`, VHOSTS_APPLY) as Promise<Record<string, RawVHost> | null>);

    const vhostNames = new Set<string>();
    if (rawVHosts) {
      const portToUnit: Record<number, string> = {};
      for (const [port, owner] of portIndex) portToUnit[port] = owner.unit;
      const r = vhostsRule(host.name, rawVHosts, units, portToUnit);
      nodes.push(...r.nodes); edges.push(...r.edges); ledger.push(...r.ledger);
      for (const n of r.nodes) vhostNames.add(n.label);
      log("rule.done", { rule: "vhosts", host: host.name, nodes: r.nodes.length });
    }

    const rawProv = await guard("provenance", host.name, ledger, () =>
      deps.evaluate(flakeRef, `${opts}.services.caddy.virtualHosts`, PROVENANCE_APPLY) as Promise<RawDefinition[] | null>);

    if (rawProv) {
      const r = provenanceRule(host.name, "services.caddy.virtualHosts", rawProv,
        (h, name) => (vhostNames.has(name) ? vhostId(h, name) : null));
      nodes.push(...r.nodes); edges.push(...r.edges); ledger.push(...r.ledger);
      log("rule.done", { rule: "provenance", host: host.name, nodes: r.nodes.length, edges: r.edges.length });
    }
  }

  // Rules run per host and a module can be shared, so the same module node can
  // be pushed more than once. Deduplicate before validating, since duplicate
  // ids are a validation failure by design.
  const byId = new Map<string, OrreryNode>();
  for (const n of nodes) if (!byId.has(n.id)) byId.set(n.id, n);

  const edgeById = new Map<string, OrreryEdge>();
  for (const e of edges) if (!edgeById.has(e.id)) edgeById.set(e.id, e);

  const graph: Graph = {
    version: 1,
    generatedAt: new Date().toISOString(),
    flakeRef,
    nodes: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edgeById.values()].sort((a, b) => a.id.localeCompare(b.id)),
    ledger,
  };

  const clean = sanitizeGraph(graph);
  log("sanitize.done", { nodes: clean.nodes.length, edges: clean.edges.length, dropped: clean.ledger.length });

  return validateGraph(clean);
}
