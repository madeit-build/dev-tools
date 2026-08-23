import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { validateGraph } from "@made-i-t/orrery-model";
import { nixEval, flakeMetadata } from "./nix";
import { discoverHosts, type HostRef } from "./discover";

const run = promisify(execFile);

export interface CheckResult {
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface Check {
  name: string;
  run: () => Promise<CheckResult>;
}

export interface DoctorDeps {
  nixVersion: () => Promise<string | null>;
  resolveFlake: (ref: string) => Promise<boolean>;
  discover: (ref: string) => Promise<HostRef[]>;
  probe: (ref: string, host: string) => Promise<string>;
  lastGraph: (out: string) => Promise<unknown | null>;
}

const realDeps: DoctorDeps = {
  nixVersion: async () => {
    try {
      const { stdout } = await run("nix", ["--version"]);
      return stdout.trim();
    } catch {
      return null;
    }
  },
  resolveFlake: async (ref) => { await flakeMetadata(ref); return true; },
  discover: (ref) => discoverHosts(ref),
  probe: (ref, host) =>
    nixEval<string>(ref, `nixosConfigurations.${host}.config.networking.hostName`),
  lastGraph: async (out) => {
    try {
      return JSON.parse(await readFile(resolve(out, "graph.json"), "utf8"));
    } catch {
      return null;
    }
  },
};

// Ordered by what is most likely to be wrong. Each check assumes the ones
// above it passed, which is why runChecks stops at the first failure.
export function buildChecks(flakeRef: string, deps: DoctorDeps = realDeps, out = "out"): Check[] {
  let hosts: HostRef[] = [];

  return [
    {
      name: "nix on PATH",
      run: async () => {
        const v = await deps.nixVersion();
        return v
          ? { ok: true, detail: v }
          : {
              ok: false,
              detail: "nix not found",
              fix: "Install Nix, or add it to PATH. On macOS the daemon installer puts it in /nix/var/nix/profiles/default/bin.",
            };
      },
    },
    {
      name: "flake resolves",
      run: async () => {
        try {
          await deps.resolveFlake(flakeRef);
          return { ok: true, detail: flakeRef };
        } catch (err) {
          return {
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
            fix: `Check the path. Run 'nix flake metadata ${flakeRef}' to see the same error with full context.`,
          };
        }
      },
    },
    {
      name: "hosts discoverable",
      run: async () => {
        try {
          hosts = await deps.discover(flakeRef);
          return { ok: true, detail: hosts.map((h) => `${h.name} (${h.kind})`).join(", ") };
        } catch (err) {
          return {
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
            fix: `Run 'nix flake show ${flakeRef}' to see which outputs the flake actually exposes.`,
          };
        }
      },
    },
    {
      name: "probe evaluation",
      run: async () => {
        const first = hosts.find((h) => h.kind === "nixos");
        if (!first) return { ok: true, detail: "no nixos host to probe, skipped" };
        try {
          const name = await deps.probe(flakeRef, first.name);
          return { ok: true, detail: `${first.name} evaluates, hostName=${name}` };
        } catch (err) {
          return {
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
            fix: "Evaluation reached the flake but failed inside it. The error above is from nix, not from orrery, and reproduces with a plain 'nix eval'.",
          };
        }
      },
    },
    {
      name: "last graph validates",
      run: async () => {
        const g = await deps.lastGraph(out);
        if (!g) return { ok: true, detail: "no previous graph to check" };
        try {
          validateGraph(g);
          return { ok: true, detail: "previous graph.json is valid" };
        } catch (err) {
          return {
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
            fix: `Delete ${out}/graph.json and re-run orrery. If it fails the same way again, the bug is in a rule, not in the artifact.`,
          };
        }
      },
    },
  ];
}

export async function runChecks(checks: Check[]): Promise<number> {
  for (const check of checks) {
    let result: CheckResult;
    try {
      result = await check.run();
    } catch (err) {
      result = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }

    process.stdout.write(`${result.ok ? "ok  " : "FAIL"}  ${check.name}: ${result.detail}\n`);

    // Stop at the first failure. Every later check assumes this one passed,
    // so running them would produce cascading noise around one real cause.
    if (!result.ok) {
      if (result.fix) process.stdout.write(`\n      ${result.fix}\n`);
      return 1;
    }
  }
  return 0;
}

export async function runDoctor(flakeRef: string): Promise<number> {
  return runChecks(buildChecks(flakeRef));
}
