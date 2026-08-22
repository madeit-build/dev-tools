import { describe, it, expect } from "vitest";
import { buildGraph } from "./pipeline";
import { validateGraph } from "@made-i-t/orrery-model";
import services from "./fixtures/box-services.json";
import vhosts from "./fixtures/box-vhosts.json";
import containers from "./fixtures/box-containers.json";
import env from "./fixtures/box-env.json";
import provenance from "./fixtures/box-provenance.json";
import servicePorts from "./fixtures/box-service-ports.json";

// A fake evaluator that answers from the committed fixtures. The whole
// assembly is therefore testable with no nix on the machine.
const deps = {
  discover: async () => [{ name: "box", kind: "nixos" as const }],
  metadata: async () => ({ locks: { nodes: { root: { inputs: { nixpkgs: "nixpkgs" } } } } }),
  evaluate: async (_ref: string, attr: string, apply?: string) => {
    if (attr.includes("options.services.caddy.virtualHosts")) return provenance;
    if (attr.endsWith("config.services.caddy.virtualHosts")) return vhosts;
    if (attr.endsWith("config.services")) return servicePorts;
    if (attr.endsWith("config.virtualisation.oci-containers.containers")) return containers;
    if (attr.endsWith("config.systemd.services")) {
      if (apply?.includes("environment")) return env;
      return services;
    }
    return null;
  },
};

describe("buildGraph", () => {
  it("produces a graph that passes its own schema", async () => {
    const g = await buildGraph(".", deps);
    expect(() => validateGraph(g)).not.toThrow();
  });

  it("includes the fleet node and the host node", async () => {
    const g = await buildGraph(".", deps);
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(ids.has("fleet:fleet")).toBe(true);
    expect(ids.has("host:box")).toBe(true);
  });

  it("contains the whole zoom chain from fleet down to a service", async () => {
    const g = await buildGraph(".", deps);
    const contains = g.edges.filter((e) => e.type === "contains");
    expect(contains.some((e) => e.from === "fleet:fleet" && e.to === "host:box")).toBe(true);
    expect(contains.some((e) => e.from === "host:box" && e.to === "service:box/caddy")).toBe(true);
  });

  it("carries both declared and inferred edges, so the distinction is exercised", async () => {
    const g = await buildGraph(".", deps);
    expect(g.edges.some((e) => e.source === "declared")).toBe(true);
    expect(g.edges.some((e) => e.source === "inferred")).toBe(true);
  });

  it("emits a non-empty ledger, since the real fleet has units that get dropped", async () => {
    const g = await buildGraph(".", deps);
    expect(g.ledger.length).toBeGreaterThan(30);
  });

  it("leaks no store path anywhere in the artifact", async () => {
    const g = await buildGraph(".", deps);
    expect(JSON.stringify(g)).not.toContain("/nix/store");
  });

  it("leaks no absolute home path anywhere in the artifact", async () => {
    const g = await buildGraph(".", deps);
    expect(JSON.stringify(g)).not.toMatch(/"\/(?:Users|home)\//);
  });

  it("leaks no secret file path anywhere in the artifact", async () => {
    const g = await buildGraph(".", deps);
    expect(JSON.stringify(g)).not.toContain("/run/secrets");
    expect(JSON.stringify(g)).not.toContain("/run/credentials");
  });

  it("is deterministic: two runs of the same input produce identical bytes", async () => {
    const a = await buildGraph(".", deps);
    const b = await buildGraph(".", deps);
    expect(JSON.stringify({ ...a, generatedAt: "" })).toBe(JSON.stringify({ ...b, generatedAt: "" }));
  });

  // The drop ledger surfaced this against the real fleet: tier 2 of the port
  // index was built but never wired, so every vhost fronting a native service
  // (chat -> open-webui:31080) resolved to nothing and drew no edge.
  it("resolves a vhost upstream that only services.<n>.port can explain", async () => {
    const g = await buildGraph(".", deps);
    const edge = g.edges.find(
      (e) => e.type === "proxies-to" && e.from === "vhost:box/chat.keep.madeit.build",
    );
    expect(edge?.to).toBe("service:box/open-webui");
    expect(edge?.source).toBe("inferred");
  });

  it("attributes a vhost to the module that declared it, end to end", async () => {
    const g = await buildGraph(".", deps);
    const edge = g.edges.find(
      (e) => e.type === "declared-by" && e.from === "vhost:box/chat.keep.madeit.build",
    );
    expect(edge?.to).toBe("module:nix/nixos/chat.nix");
  });

  it("records a rule failure in the ledger rather than aborting the whole run", async () => {
    const broken = {
      ...deps,
      evaluate: async (ref: string, attr: string, apply?: string) => {
        if (attr.endsWith("config.services.caddy.virtualHosts")) throw new Error("boom");
        return deps.evaluate(ref, attr, apply);
      },
    };
    const g = await buildGraph(".", broken);
    expect(g.nodes.some((n) => n.type === "service")).toBe(true);
    expect(g.ledger.some((r) => r.reason === "eval-failed" && r.rule === "vhosts")).toBe(true);
  });
});
