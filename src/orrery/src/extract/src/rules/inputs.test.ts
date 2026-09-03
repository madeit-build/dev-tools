import { describe, it, expect } from "vitest";
import { inputsRule } from "./inputs";

const meta = {
  locks: {
    nodes: {
      root: { inputs: { nixpkgs: "nixpkgs", disko: "disko", "nixpkgs-box": "nixpkgs-box" } },
    },
  },
};

describe("inputsRule", () => {
  it("emits one input node per flake input, sorted", () => {
    const r = inputsRule(meta);
    expect(r.nodes.map((n) => n.label)).toEqual(["disko", "nixpkgs", "nixpkgs-box"]);
  });

  it("types every input node as an input", () => {
    expect(inputsRule(meta).nodes.every((n) => n.type === "input")).toBe(true);
  });

  it("draws a provides edge from the fleet to each input", () => {
    const r = inputsRule(meta);
    expect(r.edges).toHaveLength(3);
    expect(r.edges[0]).toMatchObject({ from: "fleet:fleet", type: "provides", source: "declared" });
  });

  it("handles a flake with no inputs at all without throwing", () => {
    expect(inputsRule({ locks: { nodes: { root: {} } } })).toEqual({ nodes: [], edges: [], ledger: [] });
  });

  it("handles a follows entry, whose value is an array rather than a string", () => {
    const withFollows = { locks: { nodes: { root: { inputs: { x: ["nixpkgs", "y"] } } } } };
    expect(inputsRule(withFollows).nodes.map((n) => n.label)).toEqual(["x"]);
  });
});
