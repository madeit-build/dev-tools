import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectChecks, renderChecks } from "./doctor.js";

function assertNoAbsolutePaths(
  checks: readonly { detail: string; fix: string }[],
  root: string,
) {
  for (const check of checks) {
    expect(check.detail).not.toContain(root);
    expect(check.fix).not.toContain(root);
  }
}

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

describe("collectChecks against a broken environment", () => {
  let base = "";
  let brokenPlugin = "";
  let malformedConfig = "";

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "hang-doctor-")));
    brokenPlugin = join(base, "broken-plugin");
    malformedConfig = join(base, "malformed-config");
    await mkdir(brokenPlugin);
    await mkdir(malformedConfig);
    // A relative plugin specifier is an ordinary prettier config pattern.
    // Node's resolution failure for it embeds an absolute path twice (the
    // resolved plugin path and the resolver's own location) - the scrub
    // must survive that, not just a bare package-name lookup failure.
    await writeFile(
      join(brokenPlugin, ".prettierrc.json"),
      JSON.stringify({ plugins: ["./nonexistent-plugin.js"] }),
    );
    await writeFile(
      join(malformedConfig, ".prettierrc.json"),
      "{ invalid json",
    );
  });

  afterAll(async () => {
    if (base) await rm(base, { recursive: true, force: true });
  });

  it("keeps operator-position-supported passing when only the plugin fails to resolve", async () => {
    const checks = await collectChecks(brokenPlugin);
    const operatorPosition = checks.find(
      (c) => c.name === "operator position supported",
    );
    expect(operatorPosition?.ok).toBe(true);
  });

  it("fails plugin loaded when the configured plugin can't be resolved", async () => {
    const checks = await collectChecks(brokenPlugin);
    const pluginLoaded = checks.find((c) => c.name === "plugin loaded");
    expect(pluginLoaded?.ok).toBe(false);
  });

  it("names the resolution failure without pointing the user back at adding the plugin", async () => {
    const checks = await collectChecks(brokenPlugin);
    const pluginLoaded = checks.find((c) => c.name === "plugin loaded");
    expect(pluginLoaded?.fix).not.toContain('add "@made-i-t/hang-prettier"');
  });

  it("never leaks an absolute filesystem path when a plugin fails to resolve", async () => {
    const checks = await collectChecks(brokenPlugin);
    assertNoAbsolutePaths(checks, brokenPlugin);
  });

  it("reports an unparseable config as a failing check instead of throwing", async () => {
    const checks = await collectChecks(malformedConfig);
    const configParses = checks.find(
      (c) => c.name === "prettier config parses",
    );
    expect(configParses?.ok).toBe(false);
    expect(configParses?.fix.length).toBeGreaterThan(0);
  });

  it("never leaks a path or the config's own source text for a malformed config", async () => {
    const checks = await collectChecks(malformedConfig);
    assertNoAbsolutePaths(checks, malformedConfig);
    for (const check of checks) {
      expect(check.detail).not.toContain("invalid json");
      expect(check.fix).not.toContain("invalid json");
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
