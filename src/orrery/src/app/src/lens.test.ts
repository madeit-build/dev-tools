import { describe, it, expect } from "vitest";
import { visibleFor } from "./lens";
import type { Graph } from "@made-i-t/orrery-model";

const g: Graph = {
  version: 1,
  generatedAt: "",
  flakeRef: ".",
  nodes: [
    {
      id: "fleet:fleet",
      type: "fleet",
      label: "fleet",
      host: null,
      attrs: {},
      provenance: { files: [] },
    },
    {
      id: "host:box",
      type: "host",
      label: "box",
      host: "box",
      attrs: {},
      provenance: { files: [] },
    },
    {
      id: "host:cerberus",
      type: "host",
      label: "cerberus",
      host: "cerberus",
      attrs: {},
      provenance: { files: [] },
    },
    {
      id: "service:box/caddy",
      type: "service",
      label: "caddy",
      host: "box",
      attrs: { lifecycle: "running" },
      provenance: { files: [] },
    },
    {
      id: "service:box/seed",
      type: "service",
      label: "seed",
      host: "box",
      attrs: { lifecycle: "oneshot" },
      provenance: { files: [] },
    },
    {
      id: "vhost:box/chat.example",
      type: "vhost",
      label: "chat.example",
      host: "box",
      attrs: {},
      provenance: { files: [] },
    },
    {
      id: "module:nix/nixos/chat.nix",
      type: "module",
      label: "nix/nixos/chat.nix",
      host: null,
      attrs: {},
      provenance: { files: [] },
    },
  ],
  edges: [
    {
      id: "c1",
      from: "fleet:fleet",
      to: "host:box",
      type: "contains",
      source: "declared",
      evidence: null,
    },
    {
      id: "c2",
      from: "fleet:fleet",
      to: "host:cerberus",
      type: "contains",
      source: "declared",
      evidence: null,
    },
    {
      id: "c3",
      from: "host:box",
      to: "service:box/caddy",
      type: "contains",
      source: "declared",
      evidence: null,
    },
    {
      id: "c4",
      from: "host:box",
      to: "service:box/seed",
      type: "contains",
      source: "declared",
      evidence: null,
    },
    {
      id: "c5",
      from: "host:box",
      to: "vhost:box/chat.example",
      type: "contains",
      source: "declared",
      evidence: null,
    },
    {
      id: "p1",
      from: "vhost:box/chat.example",
      to: "service:box/caddy",
      type: "proxies-to",
      source: "inferred",
      evidence: "x",
    },
    {
      id: "d1",
      from: "vhost:box/chat.example",
      to: "module:nix/nixos/chat.nix",
      type: "declared-by",
      source: "declared",
      evidence: null,
    },
  ],
  ledger: [],
};

const runtime = { lens: "runtime" as const, selected: null };
const decl = { lens: "declaration" as const, selected: null };

describe("visibleFor, runtime lens", () => {
  it("shows the hosts at the fleet level, and not their contents", () => {
    const v = visibleFor(g, { ...runtime, path: [] });
    expect(v.nodes.map((n) => n.id).sort()).toEqual([
      "host:box",
      "host:cerberus",
    ]);
  });

  it("shows one host's children when drilled into it", () => {
    const v = visibleFor(g, { ...runtime, path: ["box"] });
    const ids = v.nodes.map((n) => n.id);
    expect(ids).toContain("service:box/caddy");
    expect(ids).toContain("vhost:box/chat.example");
    expect(ids).not.toContain("host:cerberus");
  });

  it("hides oneshot jobs by default, since they are bootstrap tasks not services", () => {
    const v = visibleFor(g, { ...runtime, path: ["box"] });
    expect(v.nodes.map((n) => n.id)).not.toContain("service:box/seed");
  });

  it("shows oneshot jobs when asked", () => {
    const v = visibleFor(g, { ...runtime, path: ["box"] }, { showJobs: true });
    expect(v.nodes.map((n) => n.id)).toContain("service:box/seed");
  });

  it("hides module nodes, which belong to the other lens", () => {
    const v = visibleFor(g, { ...runtime, path: ["box"] });
    expect(v.nodes.map((n) => n.id)).not.toContain("module:nix/nixos/chat.nix");
  });

  it("keeps a runtime edge between two visible nodes", () => {
    const v = visibleFor(g, { ...runtime, path: ["box"] });
    expect(v.edges.map((e) => e.id)).toContain("p1");
  });

  it("drops any edge whose other end is not visible", () => {
    const v = visibleFor(g, { ...runtime, path: ["box"] });
    const ids = new Set(v.nodes.map((n) => n.id));
    for (const e of v.edges) {
      expect(ids.has(e.from) && ids.has(e.to), e.id).toBe(true);
    }
  });
});

describe("visibleFor, declaration lens", () => {
  it("shows the modules that declared what is in view", () => {
    const v = visibleFor(g, { ...decl, path: ["box"] });
    expect(v.nodes.map((n) => n.id)).toContain("module:nix/nixos/chat.nix");
  });

  it("keeps the declared-by edges", () => {
    const v = visibleFor(g, { ...decl, path: ["box"] });
    expect(v.edges.map((e) => e.id)).toContain("d1");
  });

  it("drops the runtime-only edges", () => {
    const v = visibleFor(g, { ...decl, path: ["box"] });
    expect(v.edges.map((e) => e.id)).not.toContain("p1");
  });

  it("keeps a node visible across a lens flip, which is what makes the flip usable", () => {
    const runtimeView = visibleFor(g, { ...runtime, path: ["box"] });
    const declView = visibleFor(g, { ...decl, path: ["box"] });
    const inBoth = "vhost:box/chat.example";
    expect(runtimeView.nodes.map((n) => n.id)).toContain(inBoth);
    expect(declView.nodes.map((n) => n.id)).toContain(inBoth);
  });

  // Caught in the browser against the real fleet: the jobs filter only ran in
  // the runtime branch, so flipping the lens added 45 boot-time jobs back.
  it("honours the jobs toggle here too, not only in the runtime lens", () => {
    const v = visibleFor(g, { ...decl, path: ["box"] });
    expect(v.nodes.map((n) => n.id)).not.toContain("service:box/seed");
  });

  it("still shows jobs in this lens when the toggle is on", () => {
    const v = visibleFor(g, { ...decl, path: ["box"] }, { showJobs: true });
    expect(v.nodes.map((n) => n.id)).toContain("service:box/seed");
  });

  it("shows the same runtime nodes in both lenses, so the flip does not relocate you", () => {
    const ids = (lens: "runtime" | "declaration") =>
      visibleFor(g, { path: ["box"], lens, selected: null })
        .nodes.filter(
          (n) =>
            n.type !== "module" && n.type !== "option" && n.type !== "input",
        )
        .map((n) => n.id)
        .sort();
    expect(ids("declaration")).toEqual(ids("runtime"));
  });

  it("keeps a selected node visible after the flip, which is the whole promise", () => {
    const selected = "vhost:box/chat.example";
    const before = visibleFor(g, { path: ["box"], lens: "runtime", selected });
    const after = visibleFor(g, {
      path: ["box"],
      lens: "declaration",
      selected,
    });
    expect(before.nodes.some((n) => n.id === selected)).toBe(true);
    expect(after.nodes.some((n) => n.id === selected)).toBe(true);
  });
});
