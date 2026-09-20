import {
  hostId, serviceId,
  type DropRecord, type OrreryEdge, type OrreryNode,
} from "@made-i-t/orrery-model";
import type { RuleResult } from "./services";

// The darwin rules. A Mac in this fleet is a workstation: its interesting
// declared surface is home-manager launchd agents (the laptop half of the
// memory pipeline lives there) and homebrew applications, not systemd units.
// Measured on martinez 2026-08-23: launchd.daemons holds only nix plumbing,
// while home-manager.users.matt.launchd.agents carries bus-publish, colima,
// hippocampus-ship, memory-replica, and sops-nix.

// Every launchd option EXISTS with value null when unset (the module system
// declares them all), so the projection guards with explicit null checks:
// `or` only fires on missing attrs, and ProgramArguments arrived null, not
// absent, which silently emptied the first fixture capture.
export const LAUNCHD_AGENTS_APPLY = `a: builtins.mapAttrs (n: v:
  let c = v.config or {}; nn = x: d: if x == null then d else x; in {
    enable = nn (v.enable or true) true;
    program = builtins.concatStringsSep " " (nn (c.ProgramArguments or null) []);
    runAtLoad = nn (c.RunAtLoad or null) false;
    interval = c.StartInterval or null;
    watchPaths = builtins.length (nn (c.WatchPaths or null) []);
    keepAlive = c.KeepAlive or null;
  }) a`;

export const HOMEBREW_APPLY =
  `h: { casks = map (c: c.name or c) h.casks; brews = map (b: b.name or b) h.brews; }`;

export interface RawAgent {
  enable: boolean;
  program: string;
  runAtLoad: boolean;
  interval: number | null;
  watchPaths: number;
  // bool, null, or launchd's condition attrset ({ SuccessfulExit: false, ... },
  // the real shape colima carries). Any attrset means launchd restarts the job.
  keepAlive: boolean | Record<string, unknown> | null;
}

export interface RawHomebrew {
  casks: string[];
  brews: string[];
}

const AGENTS_RULE = "launchd-agents";

const keptAlive = (k: RawAgent["keepAlive"]): boolean =>
  k === true || (typeof k === "object" && k !== null);

// launchd has no oneshot/simple split, so lifecycle is derived from the
// restart-and-trigger shape: a kept-alive agent is a running service, and
// everything else fires on a trigger and exits, which is what the canvas's
// jobs toggle already means by oneshot.
function classify(agent: RawAgent): { lifecycle: string; trigger: string | null } {
  if (keptAlive(agent.keepAlive)) return { lifecycle: "running", trigger: null };
  if (agent.interval) return { lifecycle: "oneshot", trigger: `every ${agent.interval}s` };
  if (agent.watchPaths > 0) {
    return { lifecycle: "oneshot", trigger: `${agent.watchPaths} watched paths` };
  }
  if (agent.runAtLoad) return { lifecycle: "oneshot", trigger: "at login" };
  return { lifecycle: "oneshot", trigger: "on demand" };
}

export function launchdAgentsRule(
  host: string,
  raw: Record<string, RawAgent>,
): RuleResult {
  const nodes: OrreryNode[] = [];
  const edges: OrreryEdge[] = [];
  const ledger: DropRecord[] = [];

  for (const name of Object.keys(raw).sort()) {
    const agent = raw[name];

    if (!agent.enable) {
      ledger.push({ candidate: name, host, rule: AGENTS_RULE,
                    reason: "filtered-by-rule", detail: "agent disabled" });
      continue;
    }
    if (!agent.program.trim()) {
      ledger.push({ candidate: name, host, rule: AGENTS_RULE,
                    reason: "no-exec", detail: "no ProgramArguments" });
      continue;
    }

    const { lifecycle, trigger } = classify(agent);
    const id = serviceId(host, name);
    nodes.push({
      id, type: "service", label: name, host,
      attrs: { exec: agent.program, lifecycle, trigger, init: "launchd" },
      provenance: { files: [] },
    });
    edges.push({
      id: `contains:${hostId(host)}->${id}`,
      from: hostId(host), to: id,
      type: "contains", source: "declared", evidence: null,
    });
  }

  return { nodes, edges, ledger };
}

export function homebrewRule(host: string, raw: RawHomebrew): RuleResult {
  const nodes: OrreryNode[] = [];
  const edges: OrreryEdge[] = [];

  const add = (name: string, kind: "cask" | "formula"): void => {
    const id = `app:${host}/${name}`;
    nodes.push({
      id, type: "app", label: name, host,
      attrs: { kind }, provenance: { files: [] },
    });
    edges.push({
      id: `contains:${hostId(host)}->${id}`,
      from: hostId(host), to: id,
      type: "contains", source: "declared", evidence: null,
    });
  };

  for (const name of [...raw.casks].sort()) add(name, "cask");
  for (const name of [...raw.brews].sort()) add(name, "formula");

  return { nodes, edges, ledger: [] };
}
