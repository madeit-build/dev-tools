import { describe, it, expect } from "vitest";
import { collectChecks, renderChecks } from "./doctor.js";

describe("collectChecks", () => {
  it("runs the checks in likely-failure order", async () => {
    const checks = await collectChecks(process.cwd());
    expect(checks.map((c) => c.name)).toEqual([
      "prettier resolves",
      "operator position supported",
      "plugin loaded",
      "typescript scanner available",
      "operator position configured",
      "hangWidth at least printWidth",
    ]);
  });

  it("gives every failing check something to try next", async () => {
    const checks = await collectChecks(process.cwd());
    for (const check of checks) {
      if (!check.ok) expect(check.fix.length).toBeGreaterThan(0);
    }
  });
});

describe("renderChecks", () => {
  it("marks passes and failures distinctly and includes the fix", () => {
    const output = renderChecks([
      { name: "a", ok: true, detail: "found 3.9.6", fix: "" },
      { name: "b", ok: false, detail: "missing", fix: "install it" },
    ]);
    expect(output).toContain("ok    a");
    expect(output).toContain("FAIL  b");
    expect(output).toContain("install it");
    expect(output).toContain("found 3.9.6");
  });
});
