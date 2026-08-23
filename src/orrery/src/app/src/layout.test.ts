import { describe, it, expect } from "vitest";
import { layoutGraph } from "./layout";
import type { OrreryEdge, OrreryNode } from "@made-i-t/orrery-model";

const node = (id: string): OrreryNode => ({
  id, type: "service", label: id, host: "box", attrs: {}, provenance: { files: [] },
});
const edge = (from: string, to: string): OrreryEdge => ({
  id: `${from}->${to}`, from, to, type: "depends-on", source: "declared", evidence: null,
});

describe("layoutGraph", () => {
  it("gives every node a position", async () => {
    const out = await layoutGraph([node("a"), node("b")], [edge("a", "b")]);
    expect(out).toHaveLength(2);
    for (const p of out) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it("is deterministic: the same graph lays out identically twice", async () => {
    const nodes = [node("a"), node("b"), node("c")];
    const edges = [edge("a", "b"), edge("b", "c")];
    const first = await layoutGraph(nodes, edges);
    const second = await layoutGraph(nodes, edges);
    expect(first).toEqual(second);
  });

  it("does not depend on input ordering, so a rule reordering does not reshuffle the canvas", async () => {
    const edges = [edge("a", "b")];
    const forward = await layoutGraph([node("a"), node("b")], edges);
    const reversed = await layoutGraph([node("b"), node("a")], edges);
    const pos = (r: typeof forward, id: string) => r.find((p) => p.id === id);
    expect(pos(forward, "a")).toEqual(pos(reversed, "a"));
    expect(pos(forward, "b")).toEqual(pos(reversed, "b"));
  });

  it("separates the two ends of an edge along the flow axis", async () => {
    const out = await layoutGraph([node("a"), node("b")], [edge("a", "b")]);
    const a = out.find((p) => p.id === "a")!;
    const b = out.find((p) => p.id === "b")!;
    expect(a.x).not.toBe(b.x);
  });

  it("handles a node with no edges at all", async () => {
    const out = await layoutGraph([node("lonely")], []);
    expect(out).toHaveLength(1);
  });

  it("handles an empty graph without throwing", async () => {
    expect(await layoutGraph([], [])).toEqual([]);
  });

  it("drops an edge whose endpoint is not in the node set, rather than throwing", async () => {
    const out = await layoutGraph([node("a")], [edge("a", "ghost")]);
    expect(out).toHaveLength(1);
  });
});
