import { describe, it, expect } from "vitest";
import { validateGraph } from "./schema";
import type { Graph } from "./types";

const valid: Graph = {
  version: 1,
  generatedAt: "2026-08-21T00:00:00.000Z",
  flakeRef: ".",
  nodes: [
    {
      id: "host:box",
      type: "host",
      label: "box",
      host: "box",
      attrs: {},
      provenance: { files: [] },
    },
    {
      id: "service:box/caddy",
      type: "service",
      label: "caddy",
      host: "box",
      attrs: {},
      provenance: { files: [] },
    },
  ],
  edges: [
    {
      id: "e1",
      from: "host:box",
      to: "service:box/caddy",
      type: "contains",
      source: "declared",
      evidence: null,
    },
  ],
  ledger: [
    {
      candidate: "dbus",
      host: "box",
      rule: "services",
      reason: "no-exec",
      detail: "no ExecStart",
    },
  ],
};

describe("validateGraph", () => {
  it("accepts a well-formed graph and returns it typed", () => {
    expect(validateGraph(valid).nodes).toHaveLength(2);
  });

  it("rejects an unknown node type", () => {
    const bad = { ...valid, nodes: [{ ...valid.nodes[0], type: "banana" }] };
    expect(() => validateGraph(bad)).toThrow();
  });

  it("rejects an unknown drop reason, so the ledger cannot drift", () => {
    const bad = {
      ...valid,
      ledger: [{ ...valid.ledger[0], reason: "because" }],
    };
    expect(() => validateGraph(bad)).toThrow();
  });

  it("rejects an edge pointing at a node that does not exist", () => {
    const bad = {
      ...valid,
      edges: [{ ...valid.edges[0], to: "service:box/ghost" }],
    };
    expect(() => validateGraph(bad)).toThrow(/dangling edge/);
  });

  it("rejects two nodes sharing an id, since identity is the whole contract", () => {
    const bad = { ...valid, nodes: [valid.nodes[0], valid.nodes[0]] };
    expect(() => validateGraph(bad)).toThrow(/duplicate node id/);
  });

  it("rejects a node whose provenance carries an absolute path", () => {
    const bad = {
      ...valid,
      nodes: [
        {
          ...valid.nodes[0],
          provenance: { files: ["/nix/store/aaa-source/nix/x.nix"] },
        },
      ],
    };
    expect(() => validateGraph(bad)).toThrow(/absolute path/);
  });
});
