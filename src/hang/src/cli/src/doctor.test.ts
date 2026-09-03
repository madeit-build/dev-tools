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
      "useTabs not set",
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
  let scopedPlugin = "";
  let wideProject = "";
  let tabsProject = "";

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "hang-doctor-")));
    brokenPlugin = join(base, "broken-plugin");
    malformedConfig = join(base, "malformed-config");
    scopedPlugin = join(base, "scoped-plugin");
    wideProject = join(base, "wide-project");
    tabsProject = join(base, "tabs-project");
    await mkdir(brokenPlugin);
    await mkdir(malformedConfig);
    await mkdir(scopedPlugin);
    await mkdir(wideProject);
    await mkdir(tabsProject);
    await writeFile(
      join(tabsProject, ".prettierrc.json"),
      JSON.stringify({ useTabs: true }),
    );
    // Regression: hangWidth's fallback used to be computed three different
    // ways (a dead printWidth + 20 in plugin.ts, an independent printWidth +
    // 20 here, and the plugin's real declared default of 100 in explain.ts).
    // At printWidth 120 those two formulas disagree with the real default,
    // so this config used to pass a check that should fail: the plugin
    // actually budgets 100, well under this project's printWidth of 120.
    await writeFile(
      join(wideProject, ".prettierrc.json"),
      JSON.stringify({ printWidth: 120 }),
    );
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
    // An uninstalled scoped package is the shape of this project's own
    // real failure mode (@made-i-t/hang-prettier before Task 9 links it),
    // and the shape that broke the first redaction attempt: the scope
    // separator is a "/" that must NOT be mistaken for a path boundary.
    await writeFile(
      join(scopedPlugin, ".prettierrc.json"),
      JSON.stringify({ plugins: ["@totally-not-installed/whatever"] }),
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

  it("still runs the config-independent checks when the config fails to parse", async () => {
    const checks = await collectChecks(malformedConfig);
    expect(checks.map((c) => c.name)).toEqual([
      "prettier config parses",
      "prettier resolves",
      "operator position supported",
      "typescript scanner available",
    ]);
  });

  it("skips the checks that need a parsed config when it fails to parse, rather than reporting them ok", async () => {
    const checks = await collectChecks(malformedConfig);
    const names = checks.map((c) => c.name);
    expect(names).not.toContain("plugin loaded");
    expect(names).not.toContain("operator position configured");
    expect(names).not.toContain("hangWidth at least printWidth");
    expect(names).not.toContain("useTabs not set");
  });

  it("keeps a scoped package specifier intact instead of mangling it as a path", async () => {
    const checks = await collectChecks(scopedPlugin);
    const pluginLoaded = checks.find((c) => c.name === "plugin loaded");
    expect(pluginLoaded?.ok).toBe(false);
    expect(pluginLoaded?.detail).toContain("@totally-not-installed/whatever");
    expect(pluginLoaded?.detail).not.toContain("<path>");
  });

  it("never leaks an absolute filesystem path for a scoped plugin failure either", async () => {
    const checks = await collectChecks(scopedPlugin);
    assertNoAbsolutePaths(checks, scopedPlugin);
  });

  it("fails hangWidth-at-least-printWidth at printWidth 120 with no hangWidth configured, using the plugin's real default", async () => {
    const checks = await collectChecks(wideProject);
    const hangWidthCheck = checks.find(
      (c) => c.name === "hangWidth at least printWidth",
    );
    expect(hangWidthCheck?.ok).toBe(false);
    expect(hangWidthCheck?.detail).toBe("hangWidth 100, printWidth 120");
  });

  it("fails useTabs-not-set when the project configures useTabs", async () => {
    const checks = await collectChecks(tabsProject);
    const useTabsCheck = checks.find((c) => c.name === "useTabs not set");
    expect(useTabsCheck?.ok).toBe(false);
    expect(useTabsCheck?.detail).toContain("useTabs is true");
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
