import { describe, it, expect, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { buildGraph } from "./pipeline";
import { validateGraph, type Graph } from "@made-i-t/orrery-model";

const run = promisify(execFile);
const FLAKE = resolve(__dirname, "../../../fixtures/flake");

// The one test that needs a working nix. Skipped rather than failed when nix
// is absent, so the tier-1 suite stays runnable anywhere.
//
// The fixture flake must be tracked by git: a flake inside a repository is
// invisible to Nix until it is, and the failure message says so plainly.
const hasNix = async (): Promise<boolean> => {
  try { await run("nix", ["--version"]); return true; } catch { return false; }
};

// Resolved at module scope, NOT in beforeAll. `it.runIf` reads its condition
// when the test is defined, which happens before any hook runs, so deciding
// this in beforeAll skips the entire suite and reports green. A suite that
// silently skips everything is worse than one that fails.
const available = await hasNix();

describe("integration against the fixture flake", () => {
  let graph: Graph;

  beforeAll(async () => {
    if (available) graph = await buildGraph(FLAKE);
  }, 600_000);

  it("knows whether nix is available, and says so rather than skipping silently", () => {
    expect(typeof available).toBe("boolean");
    if (!available) {
      console.warn("[orrery] nix not on PATH: the tier-2 integration suite did not run");
    }
  });

  it.runIf(available)("produces a graph that passes its own schema", () => {
    expect(() => validateGraph(graph)).not.toThrow();
  });

  it.runIf(available)("finds the host", () => {
    expect(graph.nodes.map((n) => n.id)).toContain("host:testbox");
  });

  it.runIf(available)("finds both long-running services", () => {
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toContain("service:testbox/alpha-app");
    expect(ids).toContain("service:testbox/beta-app");
  });

  it.runIf(available)("classifies the oneshot as a job, not a running service", () => {
    const seed = graph.nodes.find((n) => n.id === "service:testbox/alpha-seed");
    expect(seed?.attrs.lifecycle).toBe("oneshot");
  });

  it.runIf(available)("turns after= into a declared depends-on edge", () => {
    const e = graph.edges.find(
      (x) => x.type === "depends-on" &&
        x.from === "service:testbox/beta-app" && x.to === "service:testbox/alpha-app",
    );
    expect(e?.source).toBe("declared");
  });

  // The headline assertion. Two modules define one option, and each vhost must
  // attribute to the file that actually declared it. No recorded fixture can
  // stand in for this: the merge happens inside the module system.
  it.runIf(available)("attributes each vhost to the module that declared it", () => {
    const declaredBy = (vhost: string) =>
      graph.edges.find((e) => e.type === "declared-by" && e.from === `vhost:testbox/${vhost}`)?.to;

    // Matched by suffix, not equality. The id is repo-relative and this flake
    // lives inside the dev-tools repo, so it carries the fixture's directory
    // prefix. Where the fixture sits is not what this test is about.
    expect(declaredBy("alpha.test")).toMatch(/\/alpha\.nix$/);
    expect(declaredBy("beta.test")).toMatch(/\/beta\.nix$/);
    expect(declaredBy("static.test")).toMatch(/\/beta\.nix$/);
  });

  it.runIf(available)("does not attribute a vhost to a module that did not declare it", () => {
    const declaredBy = (vhost: string) =>
      graph.edges.find((e) => e.type === "declared-by" && e.from === `vhost:testbox/${vhost}`)?.to;

    // The property that matters: two modules defining one option produce two
    // distinct attributions, not a fan-out where every module claims every key.
    expect(declaredBy("alpha.test")).not.toBe(declaredBy("beta.test"));
    expect(declaredBy("beta.test")).toBe(declaredBy("static.test"));

    const alphaEdges = graph.edges.filter(
      (e) => e.type === "declared-by" && e.from === "vhost:testbox/alpha.test",
    );
    expect(alphaEdges).toHaveLength(1);
  });

  it.runIf(available)("carries no absolute path in a module id", () => {
    for (const n of graph.nodes.filter((x) => x.type === "module")) {
      expect(n.label.startsWith("/"), n.label).toBe(false);
    }
  });

  it.runIf(available)("draws no proxy edge from the vhost that only serves files", () => {
    const out = graph.edges.filter((e) => e.type === "proxies-to" && e.from === "vhost:testbox/static.test");
    expect(out).toHaveLength(0);
  });

  it.runIf(available)("marks every proxy edge inferred", () => {
    for (const e of graph.edges.filter((x) => x.type === "proxies-to")) {
      expect(e.source).toBe("inferred");
    }
  });

  // Against a live evaluation rather than a recorded string: systemd's
  // space-separated form has to survive the whole pipeline.
  it.runIf(available)("splits a space-separated StateDirectory into two datastores", () => {
    const dirs = graph.nodes
      .filter((n) => n.type === "datastore" && n.id.startsWith("datastore:testbox/beta-app/"))
      .map((n) => n.label)
      .sort();
    expect(dirs).toEqual(["beta", "beta/inner"]);
  });

  it.runIf(available)("hangs the fourth level off its service", () => {
    const e = graph.edges.find(
      (x) => x.type === "contains" && x.to === "datastore:testbox/alpha-app/alpha",
    );
    expect(e?.from).toBe("service:testbox/alpha-app");
  });

  it.runIf(available)("leaks no store path into the artifact", () => {
    expect(JSON.stringify(graph)).not.toContain("/nix/store");
  });

  it.runIf(available)("accounts for every candidate in the ledger or the graph", () => {
    for (const row of graph.ledger) {
      expect(["no-exec", "filtered-by-rule", "rule-error", "eval-failed"]).toContain(row.reason);
    }
    // A rule erroring here means the pipeline is broken against a config that
    // is known good, not that the config is unusual.
    expect(graph.ledger.filter((r) => r.reason === "eval-failed")).toHaveLength(0);
  });

  it.runIf(available)("is deterministic across two full evaluations", async () => {
    const again = await buildGraph(FLAKE);
    expect(JSON.stringify({ ...again, generatedAt: "" })).toBe(JSON.stringify({ ...graph, generatedAt: "" }));
  }, 600_000);
});
