import { describe, it, expect } from "vitest";
import { launchdAgentsRule, homebrewRule, type RawAgent, type RawHomebrew } from "./darwin";
import agents from "../fixtures/martinez-agents.json";
import homebrew from "../fixtures/martinez-homebrew.json";

const agentsFixture = agents as unknown as Record<string, RawAgent>;
const homebrewFixture = homebrew as unknown as RawHomebrew;

const agent = (over: Partial<RawAgent> = {}): RawAgent => ({
  enable: true, program: "/nix/store/aaa-thing/bin/thing",
  runAtLoad: false, interval: null, watchPaths: 0, keepAlive: null, ...over,
});

describe("launchdAgentsRule", () => {
  it("emits a service node per enabled agent, contained by the host", () => {
    const r = launchdAgentsRule("martinez", { shipper: agent() });
    expect(r.nodes.map((n) => n.id)).toEqual(["service:martinez/shipper"]);
    expect(r.edges).toContainEqual({
      id: "contains:host:martinez->service:martinez/shipper",
      from: "host:martinez", to: "service:martinez/shipper",
      type: "contains", source: "declared", evidence: null,
    });
  });

  it("uses the service type, since a launchd agent is a service by another init", () => {
    const r = launchdAgentsRule("martinez", { shipper: agent() });
    expect(r.nodes[0].type).toBe("service");
  });

  it("marks a keepAlive agent as running", () => {
    const r = launchdAgentsRule("martinez", { colima: agent({ keepAlive: true, runAtLoad: true }) });
    expect(r.nodes[0].attrs.lifecycle).toBe("running");
  });

  // Measured on martinez: colima's keepAlive is an attrset of launchd
  // conditions ({ SuccessfulExit: false, ... }), not a boolean. An attrset
  // present at all means launchd restarts the job, which is running.
  it("treats an attrset keepAlive as running, matching the real colima shape", () => {
    const r = launchdAgentsRule("martinez", {
      colima: agent({ keepAlive: { SuccessfulExit: false }, runAtLoad: true }),
    });
    expect(r.nodes[0].attrs.lifecycle).toBe("running");
  });

  it("marks an interval-triggered agent as oneshot with the cadence visible", () => {
    const r = launchdAgentsRule("martinez", { pub: agent({ interval: 900 }) });
    expect(r.nodes[0].attrs.lifecycle).toBe("oneshot");
    expect(r.nodes[0].attrs.trigger).toBe("every 900s");
  });

  it("marks a watch-path agent as oneshot triggered by file changes", () => {
    const r = launchdAgentsRule("martinez", { ship: agent({ watchPaths: 3 }) });
    expect(r.nodes[0].attrs.lifecycle).toBe("oneshot");
    expect(r.nodes[0].attrs.trigger).toBe("3 watched paths");
  });

  it("drops a disabled agent into the ledger rather than drawing it", () => {
    const r = launchdAgentsRule("martinez", { off: agent({ enable: false }) });
    expect(r.nodes).toHaveLength(0);
    expect(r.ledger[0]).toMatchObject({
      candidate: "off", reason: "filtered-by-rule",
    });
  });

  it("drops an agent with no program, mirroring the no-exec rule", () => {
    const r = launchdAgentsRule("martinez", { ghost: agent({ program: "" }) });
    expect(r.nodes).toHaveLength(0);
    expect(r.ledger[0].reason).toBe("no-exec");
  });

  describe("against the real captured fleet", () => {
    it("finds the laptop half of the memory pipeline", () => {
      const r = launchdAgentsRule("martinez", agentsFixture);
      const ids = r.nodes.map((n) => n.id);
      for (const name of ["hippocampus-ship", "memory-replica", "bus-publish"]) {
        expect(ids, name).toContain(`service:martinez/${name}`);
      }
    });

    it("classifies colima as running and bus-publish as an interval job", () => {
      const r = launchdAgentsRule("martinez", agentsFixture);
      const byId = new Map(r.nodes.map((n) => [n.id, n]));
      expect(byId.get("service:martinez/colima")?.attrs.lifecycle).toBe("running");
      expect(byId.get("service:martinez/bus-publish")?.attrs.lifecycle).toBe("oneshot");
      expect(byId.get("service:martinez/bus-publish")?.attrs.trigger).toBe("every 900s");
    });

    it("accounts for every agent: kept plus dropped equals input", () => {
      const r = launchdAgentsRule("martinez", agentsFixture);
      expect(r.nodes.length + r.ledger.length).toBe(Object.keys(agentsFixture).length);
    });
  });
});

describe("homebrewRule", () => {
  it("emits app nodes for casks and formulas, contained by the host", () => {
    const r = homebrewRule("martinez", { casks: ["ghostty"], brews: ["eza"] });
    expect(r.nodes.map((n) => n.id).sort()).toEqual([
      "app:martinez/eza", "app:martinez/ghostty",
    ]);
    for (const n of r.nodes) expect(n.type).toBe("app");
    expect(r.edges.every((e) => e.type === "contains" && e.from === "host:martinez")).toBe(true);
  });

  it("distinguishes cask from formula in attrs", () => {
    const r = homebrewRule("martinez", { casks: ["ghostty"], brews: ["eza"] });
    const byId = new Map(r.nodes.map((n) => [n.id, n]));
    expect(byId.get("app:martinez/ghostty")?.attrs.kind).toBe("cask");
    expect(byId.get("app:martinez/eza")?.attrs.kind).toBe("formula");
  });

  it("keeps a versioned cask name intact, since @latest is part of its identity", () => {
    const r = homebrewRule("martinez", { casks: ["claude-code@latest"], brews: [] });
    expect(r.nodes[0].id).toBe("app:martinez/claude-code@latest");
  });

  describe("against the real captured fleet", () => {
    it("draws all 32 casks and the lone formula", () => {
      const r = homebrewRule("martinez", homebrewFixture);
      expect(r.nodes.filter((n) => n.attrs.kind === "cask")).toHaveLength(32);
      expect(r.nodes.filter((n) => n.attrs.kind === "formula")).toHaveLength(1);
    });

    it("produces no duplicate ids", () => {
      const ids = homebrewRule("martinez", homebrewFixture).nodes.map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
