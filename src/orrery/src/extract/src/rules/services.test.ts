import { describe, it, expect } from "vitest";
import { servicesRule, type RawService } from "./services";
import raw from "../fixtures/box-services.json";

const fixture = raw as unknown as Record<string, RawService>;

const only = (unit: string, over: Partial<RawService> = {}): Record<string, RawService> => ({
  [unit]: {
    description: "d", wantedBy: [], after: [], exec: "/nix/store/aaa/bin/x",
    user: null, type: "simple", ...over,
  },
});

describe("servicesRule", () => {
  it("emits a service node for a unit that has an ExecStart", () => {
    const r = servicesRule("box", only("caddy"));
    expect(r.nodes.map((n) => n.id)).toContain("service:box/caddy");
    expect(r.ledger).toHaveLength(0);
  });

  it("drops a unit with no ExecStart and says so in the ledger", () => {
    const r = servicesRule("box", only("dbus", { exec: null }));
    expect(r.nodes).toHaveLength(0);
    expect(r.ledger).toEqual([
      { candidate: "dbus", host: "box", rule: "services", reason: "no-exec", detail: "no ExecStart" },
    ]);
  });

  it("drops a systemd template unit, which is a pattern and not a running thing", () => {
    const r = servicesRule("box", only("user@"));
    expect(r.nodes).toHaveLength(0);
    expect(r.ledger[0].reason).toBe("filtered-by-rule");
    expect(r.ledger[0].detail).toMatch(/template/);
  });

  it("emits a contains edge from the host to each service", () => {
    const r = servicesRule("box", only("caddy"));
    expect(r.edges).toContainEqual({
      id: "contains:host:box->service:box/caddy",
      from: "host:box", to: "service:box/caddy",
      type: "contains", source: "declared", evidence: null,
    });
  });

  it("turns an after= entry into a declared depends-on edge", () => {
    // Both units must be present: the rule refuses to draw an edge to a unit
    // that did not survive the filter, so a one-unit fixture proves nothing.
    const r = servicesRule("box", {
      ...only("grafana", { after: ["postgresql.service", "network.target"] }),
      ...only("postgresql"),
    });
    const dep = r.edges.filter((e) => e.type === "depends-on");
    expect(dep).toHaveLength(1);
    expect(dep[0]).toMatchObject({
      from: "service:box/grafana", to: "service:box/postgresql", source: "declared",
    });
  });

  it("draws no depends-on edge to a unit that did not survive the filter", () => {
    const r = servicesRule("box", only("grafana", { after: ["postgresql.service"] }));
    expect(r.edges.filter((e) => e.type === "depends-on")).toHaveLength(0);
  });

  it("ignores a .target in after=, since a target is not a service node", () => {
    const r = servicesRule("box", only("grafana", { after: ["network.target"] }));
    expect(r.edges.filter((e) => e.type === "depends-on")).toHaveLength(0);
  });

  it("marks a Type=oneshot unit as a job rather than a running service", () => {
    const r = servicesRule("box", only("claude-mem-db-password", { type: "oneshot" }));
    expect(r.nodes[0].attrs.lifecycle).toBe("oneshot");
  });

  it("treats a unit with no explicit Type as running, matching systemd's default", () => {
    const r = servicesRule("box", only("caddy", { type: null }));
    expect(r.nodes[0].attrs.lifecycle).toBe("running");
  });

  it("keeps the user as an attribute rather than inventing a node for it", () => {
    const r = servicesRule("box", only("caddy", { user: "caddy" }));
    expect(r.nodes[0].attrs.user).toBe("caddy");
  });

  it("records the exec path so the sanitizer can rewrite it later", () => {
    const r = servicesRule("box", only("caddy"));
    expect(r.nodes[0].attrs.exec).toBe("/nix/store/aaa/bin/x");
  });

  describe("against the real captured fleet", () => {
    it("accounts for every single candidate: kept plus dropped equals input", () => {
      const r = servicesRule("box", fixture);
      expect(r.nodes.length + r.ledger.length).toBe(Object.keys(fixture).length);
    });

    // Measured against box on 2026-08-21: 121 units in, 16 templates and 29
    // with no ExecStart dropped, 76 kept. Ranges rather than exact equality,
    // because the fleet is live and the fixture will be recaptured.
    it("keeps the measured share of the fleet", () => {
      const r = servicesRule("box", fixture);
      expect(r.nodes.length).toBeGreaterThan(60);
      expect(r.nodes.length).toBeLessThan(90);
    });

    it("classifies the kept units by lifecycle, roughly 31 running to 45 jobs", () => {
      const r = servicesRule("box", fixture);
      const running = r.nodes.filter((n) => n.attrs.lifecycle === "running");
      const oneshot = r.nodes.filter((n) => n.attrs.lifecycle === "oneshot");
      expect(running.length).toBeGreaterThan(20);
      expect(running.length).toBeLessThan(45);
      expect(oneshot.length).toBeGreaterThan(30);
    });

    it("classifies the long-running services as running, not as jobs", () => {
      const r = servicesRule("box", fixture);
      const byId = new Map(r.nodes.map((n) => [n.id, n]));
      for (const unit of ["caddy", "ollama", "postgresql", "nats"]) {
        expect(byId.get(`service:box/${unit}`)?.attrs.lifecycle, unit).toBe("running");
      }
    });

    it("keeps the services the fleet is actually built around", () => {
      const ids = new Set(servicesRule("box", fixture).nodes.map((n) => n.id));
      for (const unit of ["caddy", "ollama", "postgresql"]) {
        expect(ids.has(`service:box/${unit}`), unit).toBe(true);
      }
    });

    it("produces no duplicate node ids", () => {
      const ids = servicesRule("box", fixture).nodes.map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("gives every ledger row a reason from the known set", () => {
      const r = servicesRule("box", fixture);
      for (const row of r.ledger) {
        expect(["no-exec", "filtered-by-rule", "rule-error", "eval-failed"]).toContain(row.reason);
      }
    });
  });
});
