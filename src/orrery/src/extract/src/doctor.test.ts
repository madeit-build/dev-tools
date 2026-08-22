import { describe, it, expect, vi } from "vitest";
import { runChecks, buildChecks } from "./doctor";

const ok = (name: string) => ({ name, run: async () => ({ ok: true, detail: "fine" }) });
const bad = (name: string) => ({
  name, run: async () => ({ ok: false, detail: "broken", fix: `fix ${name}` }),
});

describe("runChecks", () => {
  it("returns 0 when every check passes", async () => {
    expect(await runChecks([ok("a"), ok("b")])).toBe(0);
  });

  it("returns 1 when any check fails", async () => {
    expect(await runChecks([ok("a"), bad("b")])).toBe(1);
  });

  it("stops at the first failure, since later checks depend on earlier ones", async () => {
    const later = vi.fn(async () => ({ ok: true, detail: "" }));
    await runChecks([bad("first"), { name: "later", run: later }]);
    expect(later).not.toHaveBeenCalled();
  });

  it("treats a thrown check as a failure rather than crashing the command", async () => {
    const thrower = { name: "boom", run: async () => { throw new Error("kaboom"); } };
    expect(await runChecks([thrower])).toBe(1);
  });
});

describe("buildChecks", () => {
  const deps = {
    nixVersion: async () => "nix (Nix) 2.34.8",
    resolveFlake: async () => true,
    discover: async () => [{ name: "box", kind: "nixos" as const }],
    probe: async () => "box",
    lastGraph: async () => null,
  };

  it("orders checks most-likely-wrong first", () => {
    expect(buildChecks(".", deps).map((c) => c.name)).toEqual([
      "nix on PATH",
      "flake resolves",
      "hosts discoverable",
      "probe evaluation",
      "last graph validates",
    ]);
  });

  it("fails the first check with an actionable fix when nix is absent", async () => {
    const checks = buildChecks(".", { ...deps, nixVersion: async () => null });
    const r = await checks[0].run();
    expect(r.ok).toBe(false);
    expect(r.fix).toMatch(/install|PATH/i);
  });

  it("passes the last check when there is no previous graph to validate", async () => {
    const checks = buildChecks(".", deps);
    const r = await checks[4].run();
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/no previous graph/i);
  });

  it("reports the flake ref it could not resolve, with a reproducing command", async () => {
    const checks = buildChecks("/nope", {
      ...deps,
      resolveFlake: async () => { throw new Error("cannot find flake"); },
    });
    const r = await checks[1].run();
    expect(r.ok).toBe(false);
    expect(r.fix).toContain("/nope");
  });

  it("skips the probe when a flake has only darwin hosts", async () => {
    const checks = buildChecks(".", {
      ...deps,
      discover: async () => [{ name: "martinez", kind: "darwin" as const }],
    });
    await checks[2].run();
    const r = await checks[3].run();
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/skipped/);
  });
});
