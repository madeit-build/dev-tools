import { describe, it, expect } from "vitest";
import { provenanceRule, type RawDefinition } from "./provenance";
import raw from "../fixtures/box-provenance.json";
import { vhostId } from "@made-i-t/orrery-model";

const fixture = raw as unknown as RawDefinition[];
const resolve = (host: string, name: string) => vhostId(host, name);

const STORE = "/nix/store/7ja3qcq17d764r430vn10x6nwlg6ihvb-source/nix/nixos";

describe("provenanceRule", () => {
  it("emits one module node per contributing file", () => {
    const defs: RawDefinition[] = [
      { file: `${STORE}/chat.nix`, names: ["chat.example"] },
    ];
    const r = provenanceRule(
      "box",
      "services.caddy.virtualHosts",
      defs,
      resolve,
    );
    expect(r.nodes.filter((n) => n.type === "module")).toHaveLength(1);
    expect(r.nodes.some((n) => n.id === "module:nix/nixos/chat.nix")).toBe(
      true,
    );
  });

  it("labels a module node with its repo-relative path, never a store path", () => {
    const defs: RawDefinition[] = [
      { file: `${STORE}/chat.nix`, names: ["chat.example"] },
    ];
    const r = provenanceRule(
      "box",
      "services.caddy.virtualHosts",
      defs,
      resolve,
    );
    const mod = r.nodes.find((n) => n.type === "module");
    expect(mod?.label).toBe("nix/nixos/chat.nix");
    expect(JSON.stringify(r.nodes)).not.toContain("/nix/store");
  });

  it("draws declared-by from the defined thing to the file that defined it", () => {
    const defs: RawDefinition[] = [
      { file: `${STORE}/chat.nix`, names: ["chat.example"] },
    ];
    const r = provenanceRule(
      "box",
      "services.caddy.virtualHosts",
      defs,
      resolve,
    );
    const declared = r.edges.filter((e) => e.type === "declared-by");
    expect(declared).toHaveLength(1);
    expect(declared[0]).toMatchObject({
      from: "vhost:box/chat.example",
      to: "module:nix/nixos/chat.nix",
      source: "declared",
    });
  });

  it("attributes each name to its own file rather than to all of them", () => {
    const defs: RawDefinition[] = [
      { file: `${STORE}/a.nix`, names: ["one.example"] },
      { file: `${STORE}/b.nix`, names: ["two.example"] },
    ];
    const r = provenanceRule(
      "box",
      "services.caddy.virtualHosts",
      defs,
      resolve,
    );
    const byFrom = new Map(
      r.edges
        .filter((e) => e.type === "declared-by")
        .map((e) => [e.from, e.to]),
    );
    expect(byFrom.get("vhost:box/one.example")).toBe("module:nix/nixos/a.nix");
    expect(byFrom.get("vhost:box/two.example")).toBe("module:nix/nixos/b.nix");
    // The whole point: two files, two edges, not four.
    expect(r.edges.filter((e) => e.type === "declared-by")).toHaveLength(2);
  });

  it("gives one file that defines several names one edge per name", () => {
    const defs: RawDefinition[] = [
      {
        file: `${STORE}/observability.nix`,
        names: ["a.example", "b.example", "c.example"],
      },
    ];
    const r = provenanceRule(
      "box",
      "services.caddy.virtualHosts",
      defs,
      resolve,
    );
    expect(r.edges.filter((e) => e.type === "declared-by")).toHaveLength(3);
    expect(r.nodes.filter((n) => n.type === "module")).toHaveLength(1);
  });

  it("emits an option node and a defines edge from each module to it", () => {
    const defs: RawDefinition[] = [
      { file: `${STORE}/a.nix`, names: ["one.example"] },
      { file: `${STORE}/b.nix`, names: ["two.example"] },
    ];
    const r = provenanceRule(
      "box",
      "services.caddy.virtualHosts",
      defs,
      resolve,
    );
    const opt = r.nodes.find((n) => n.type === "option");
    expect(opt?.id).toBe("option:box/services.caddy.virtualHosts");
    expect(
      r.edges.filter((e) => e.type === "defines" && e.to === opt!.id),
    ).toHaveLength(2);
  });

  it("emits one module node even when a file appears in several definitions", () => {
    const f = `${STORE}/a.nix`;
    const r = provenanceRule(
      "box",
      "services.caddy.virtualHosts",
      [
        { file: f, names: ["one.example"] },
        { file: f, names: ["two.example"] },
      ],
      resolve,
    );
    expect(r.nodes.filter((n) => n.type === "module")).toHaveLength(1);
  });

  it("records a name with no node in the ledger rather than dangling an edge", () => {
    const defs: RawDefinition[] = [
      { file: `${STORE}/a.nix`, names: ["ghost.example"] },
    ];
    const r = provenanceRule(
      "box",
      "services.caddy.virtualHosts",
      defs,
      () => null,
    );
    expect(r.edges.filter((e) => e.type === "declared-by")).toHaveLength(0);
    expect(r.ledger[0].detail).toMatch(/no node in the graph/);
  });

  describe("against the real captured fleet", () => {
    it("finds the eight modules that merge into one option", () => {
      const r = provenanceRule(
        "box",
        "services.caddy.virtualHosts",
        fixture,
        resolve,
      );
      expect(r.nodes.filter((n) => n.type === "module")).toHaveLength(8);
    });

    it("attributes the five observability vhosts to observability.nix alone", () => {
      const r = provenanceRule(
        "box",
        "services.caddy.virtualHosts",
        fixture,
        resolve,
      );
      const fromObs = r.edges
        .filter(
          (e) =>
            e.type === "declared-by"
            && e.to === "module:nix/nixos/observability.nix",
        )
        .map((e) => e.from)
        .sort();
      expect(fromObs).toEqual(
        [
          vhostId("box", "alerts.keep.madeit.build"),
          vhostId("box", "grafana.keep.madeit.build"),
          vhostId("box", "ntfy.keep.madeit.build"),
          vhostId("box", "otlp.keep.madeit.build"),
          vhostId("box", "prometheus.keep.madeit.build"),
        ].sort(),
      );
    });

    it("attributes the health responder to services.nix", () => {
      const r = provenanceRule(
        "box",
        "services.caddy.virtualHosts",
        fixture,
        resolve,
      );
      const edge = r.edges.find(
        (e) => e.from === vhostId("box", "health.keep.madeit.build"),
      );
      expect(edge?.to).toBe("module:nix/nixos/services.nix");
    });

    it("attributes chat to chat.nix, the single-vhost case", () => {
      const r = provenanceRule(
        "box",
        "services.caddy.virtualHosts",
        fixture,
        resolve,
      );
      const edge = r.edges.find(
        (e) => e.from === vhostId("box", "chat.keep.madeit.build"),
      );
      expect(edge?.to).toBe("module:nix/nixos/chat.nix");
    });

    it("leaks no store path into any node or edge", () => {
      const r = provenanceRule(
        "box",
        "services.caddy.virtualHosts",
        fixture,
        resolve,
      );
      expect(JSON.stringify(r)).not.toContain("/nix/store");
    });
  });
});
