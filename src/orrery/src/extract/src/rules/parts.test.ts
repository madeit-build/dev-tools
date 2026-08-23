import { describe, it, expect } from "vitest";
import { toList, partsRule, type RawParts } from "./parts";
import raw from "../fixtures/box-parts.json";

const fixture = raw as unknown as Record<string, RawParts>;

describe("toList", () => {
  it("wraps a plain string", () => {
    expect(toList("nats")).toEqual(["nats"]);
  });

  it("splits a space-separated string, which is systemd's own convention", () => {
    expect(toList("postgresql postgresql/17")).toEqual(["postgresql", "postgresql/17"]);
  });

  it("passes a list through", () => {
    expect(toList(["caddy"])).toEqual(["caddy"]);
  });

  it("returns nothing for an empty list", () => {
    expect(toList([])).toEqual([]);
  });

  it("returns nothing for null", () => {
    expect(toList(null)).toEqual([]);
  });

  it("returns nothing for an empty string rather than one empty entry", () => {
    expect(toList("")).toEqual([]);
  });

  it("collapses repeated whitespace instead of emitting blank entries", () => {
    expect(toList("a  b")).toEqual(["a", "b"]);
  });
});

describe("partsRule", () => {
  const units = new Set(["caddy", "postgresql"]);
  const index = new Map([[2019, { unit: "caddy", source: "declared" as const }]]);

  it("emits a datastore node for each state directory", () => {
    const r = partsRule("box", { postgresql: { state: "postgresql postgresql/17", workdir: null, envFile: null } }, units, new Map());
    expect(r.nodes.filter((n) => n.type === "datastore")).toHaveLength(2);
  });

  it("contains each datastore under its service, so the zoom chain reaches it", () => {
    const r = partsRule("box", { caddy: { state: ["caddy"], workdir: null, envFile: null } }, units, new Map());
    const e = r.edges.find((x) => x.type === "contains");
    expect(e?.from).toBe("service:box/caddy");
  });

  it("draws a writes edge from the service to its state directory", () => {
    const r = partsRule("box", { caddy: { state: ["caddy"], workdir: null, envFile: null } }, units, new Map());
    const w = r.edges.filter((x) => x.type === "writes");
    expect(w).toHaveLength(1);
    expect(w[0].source).toBe("declared");
  });

  it("draws a reads edge for an environment file", () => {
    const r = partsRule("box", { reverie: { state: null, workdir: null, envFile: "/run/secrets/rendered/reverie.env" } }, new Set(["reverie"]), new Map());
    expect(r.edges.filter((x) => x.type === "reads")).toHaveLength(1);
  });

  it("keeps the secret file as a node so the fact is drawn, and lets the sanitizer redact the value", () => {
    const r = partsRule("box", { reverie: { state: null, workdir: null, envFile: "/run/secrets/rendered/reverie.env" } }, new Set(["reverie"]), new Map());
    const ds = r.nodes.find((n) => n.type === "datastore");
    expect(ds).toBeDefined();
    // The label says a secret is read. The path lands in attrs, where the
    // sanitizer replaces it. Both halves matter.
    expect(ds!.label).toMatch(/secret/i);
  });

  it("labels an ordinary env file plainly, not as a secret", () => {
    const r = partsRule("box", { caddy: { state: null, workdir: null, envFile: "/etc/caddy/env" } }, units, new Map());
    expect(r.nodes.find((n) => n.type === "datastore")?.label).toBe("env file");
  });

  it("emits a port node for a port the index attributes to this service", () => {
    const r = partsRule("box", { caddy: { state: null, workdir: null, envFile: null } }, units, index);
    const port = r.nodes.find((n) => n.type === "port");
    expect(port?.label).toBe(":2019");
  });

  it("draws listens-on from the service to its port", () => {
    const r = partsRule("box", { caddy: { state: null, workdir: null, envFile: null } }, units, index);
    const l = r.edges.filter((x) => x.type === "listens-on");
    expect(l).toHaveLength(1);
    expect(l[0].from).toBe("service:box/caddy");
  });

  it("carries the port's own confidence, so a guessed port says so", () => {
    const guessed = new Map([[9999, { unit: "caddy", source: "inferred" as const }]]);
    const r = partsRule("box", { caddy: { state: null, workdir: null, envFile: null } }, units, guessed);
    expect(r.nodes.find((n) => n.type === "port")?.attrs.confidence).toBe("inferred");
  });

  it("skips a unit that did not survive the services filter", () => {
    const r = partsRule("box", { ghost: { state: "ghost", workdir: null, envFile: null } }, units, new Map());
    expect(r.nodes).toHaveLength(0);
  });

  it("gives a service with nothing to show no nodes at all", () => {
    const r = partsRule("box", { caddy: { state: null, workdir: null, envFile: null } }, units, new Map());
    expect(r.nodes).toHaveLength(0);
  });

  describe("against the real captured fleet", () => {
    const allUnits = new Set(Object.keys(fixture));

    it("handles every shape StateDirectory takes without throwing", () => {
      expect(() => partsRule("box", fixture, allUnits, new Map())).not.toThrow();
    });

    it("finds both of postgres's state directories, not just the first", () => {
      const r = partsRule("box", fixture, allUnits, new Map());
      const pg = r.nodes.filter((n) => n.id.startsWith("datastore:box/postgresql/"));
      expect(pg.length).toBeGreaterThanOrEqual(2);
    });

    it("finds caddy's state directory, which arrives as a list", () => {
      const r = partsRule("box", fixture, allUnits, new Map());
      expect(r.nodes.some((n) => n.id === "datastore:box/caddy/caddy")).toBe(true);
    });

    it("marks the services that read a secret, of which the fleet has several", () => {
      const r = partsRule("box", fixture, allUnits, new Map());
      const secrets = r.nodes.filter((n) => n.attrs.kind === "secret");
      expect(secrets.length).toBeGreaterThanOrEqual(2);
    });

    it("produces no duplicate node ids across the whole fleet", () => {
      const ids = partsRule("box", fixture, allUnits, new Map()).nodes.map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("gives every node it emits a containing edge, so none is orphaned", () => {
      const r = partsRule("box", fixture, allUnits, new Map());
      for (const n of r.nodes) {
        expect(r.edges.some((e) => e.type === "contains" && e.to === n.id), n.id).toBe(true);
      }
    });
  });
});
