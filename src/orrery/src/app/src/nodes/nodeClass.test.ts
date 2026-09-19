import { describe, it, expect } from "vitest";
import { nodeClass } from "./nodeClass";
import type { OrreryNode } from "@made-i-t/orrery-model";

const n = (over: Partial<OrreryNode>): OrreryNode => ({
  id: "service:box/x", type: "service", label: "x", host: "box",
  attrs: {}, provenance: { files: [] }, ...over,
});

describe("nodeClass", () => {
  it("always carries the base class", () => {
    expect(nodeClass(n({}), false)).toContain("orrery-node");
  });

  it("carries a modifier for the node type", () => {
    expect(nodeClass(n({ type: "vhost" }), false)).toContain("orrery-node--vhost");
  });

  it("marks a oneshot service as a job rather than as a service", () => {
    const c = nodeClass(n({ attrs: { lifecycle: "oneshot" } }), false);
    expect(c).toContain("orrery-node--job");
  });

  it("does not mark a long-running service as a job", () => {
    expect(nodeClass(n({ attrs: { lifecycle: "running" } }), false)).not.toContain("--job");
  });

  it("adds the selected modifier only when selected", () => {
    expect(nodeClass(n({}), true)).toContain("orrery-node--selected");
    expect(nodeClass(n({}), false)).not.toContain("orrery-node--selected");
  });

  it("marks an annotated node so it is discoverable without clicking", () => {
    expect(nodeClass(n({}), false, true)).toContain("orrery-node--annotated");
    expect(nodeClass(n({}), false, false)).not.toContain("--annotated");
  });

  it("defaults the annotation marker off for existing two-argument callers", () => {
    expect(nodeClass(n({}), false)).not.toContain("--annotated");
  });

  it("never emits a class encoding a color, since the brand is monochrome", () => {
    for (const type of ["host", "service", "vhost", "module", "input"] as const) {
      const c = nodeClass(n({ type }), false);
      expect(c).not.toMatch(/red|green|blue|amber|warn|error|success/i);
    }
  });
});
