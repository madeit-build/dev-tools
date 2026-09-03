import { describe, it, expect } from "vitest";
import { discoverHosts } from "./discover";
import { NixError } from "./nix";

describe("discoverHosts", () => {
  it("returns nixos and darwin hosts, each tagged with its kind", async () => {
    const evaluate = async (_ref: string, attr: string) => {
      if (attr === "nixosConfigurations") return ["box", "cerberus"];
      if (attr === "darwinConfigurations") return ["martinez"];
      return null;
    };
    expect(await discoverHosts(".", evaluate)).toEqual([
      { name: "box", kind: "nixos" },
      { name: "cerberus", kind: "nixos" },
      { name: "martinez", kind: "darwin" },
    ]);
  });

  it("tolerates a flake with no darwinConfigurations at all", async () => {
    const evaluate = async (_ref: string, attr: string) =>
      attr === "nixosConfigurations" ? ["box"] : null;
    expect(await discoverHosts(".", evaluate)).toEqual([{ name: "box", kind: "nixos" }]);
  });

  it("sorts hosts so two runs of the same flake agree", async () => {
    const evaluate = async (_ref: string, attr: string) =>
      attr === "nixosConfigurations" ? ["zulu", "alpha"] : null;
    expect((await discoverHosts(".", evaluate)).map((h) => h.name)).toEqual(["alpha", "zulu"]);
  });

  it("throws when a flake has no host attributes of either kind", async () => {
    const evaluate = async () => null;
    await expect(discoverHosts(".", evaluate)).rejects.toThrow(/no nixosConfigurations or darwinConfigurations/);
  });

  it("propagates a non-missing-attr failure rather than swallowing it", async () => {
    const evaluate = async () => {
      throw new NixError("bad-flake-ref", "nope", "nixosConfigurations", "");
    };
    await expect(discoverHosts(".", evaluate)).rejects.toThrow(NixError);
  });
});
