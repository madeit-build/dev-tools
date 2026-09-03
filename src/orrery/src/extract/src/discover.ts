import { nixEvalOptional } from "./nix";

export type HostKind = "nixos" | "darwin";

export interface HostRef {
  name: string;
  kind: HostKind;
}

// Injected so the unit test needs no working nix. The pipeline passes the
// real one.
export type Evaluator = (
  flakeRef: string,
  attrPath: string,
  apply?: string,
) => Promise<string[] | null>;

const defaultEvaluator: Evaluator = (ref, attr, apply) =>
  nixEvalOptional<string[]>(ref, attr, apply);

const ATTRS: ReadonlyArray<[string, HostKind]> = [
  ["nixosConfigurations", "nixos"],
  ["darwinConfigurations", "darwin"],
];

export async function discoverHosts(
  flakeRef: string,
  evaluate: Evaluator = defaultEvaluator,
): Promise<HostRef[]> {
  const hosts: HostRef[] = [];

  for (const [attr, kind] of ATTRS) {
    const names = await evaluate(flakeRef, attr, "builtins.attrNames");
    if (!names) continue;
    // Sorted per attribute, so the fleet renders identically on every run.
    // Determinism is what makes a future generation diff readable.
    for (const name of [...names].sort()) hosts.push({ name, kind });
  }

  if (hosts.length === 0) {
    throw new Error(
      `no nixosConfigurations or darwinConfigurations in ${flakeRef}; `
        + `orrery needs at least one host to draw. Run 'nix flake show ${flakeRef}' to see what it exposes.`,
    );
  }

  return hosts;
}
