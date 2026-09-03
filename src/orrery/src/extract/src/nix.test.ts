import { describe, it, expect } from "vitest";
import { classifyNixError, buildEvalArgs } from "./nix";

describe("buildEvalArgs", () => {
  it("always passes the two read-only flags", () => {
    const args = buildEvalArgs(".", "nixosConfigurations", undefined);
    expect(args).toContain("--read-only");
    expect(args).toContain("--no-write-lock-file");
    expect(args).toContain("--json");
  });

  it("joins the flake ref and attribute path with a hash", () => {
    expect(buildEvalArgs(".", "nixosConfigurations", undefined)).toContain(".#nixosConfigurations");
  });

  it("appends --apply only when an apply expression is given", () => {
    expect(buildEvalArgs(".", "x", undefined)).not.toContain("--apply");
    const withApply = buildEvalArgs(".", "x", "builtins.attrNames");
    expect(withApply).toContain("--apply");
    expect(withApply).toContain("builtins.attrNames");
  });
});

describe("classifyNixError", () => {
  // The real string nix emits, captured from a live run on 2026-08-21. It is
  // not "attribute 'x' missing", and getting this wrong makes every
  // Linux-only flake fail host discovery.
  it("recognizes an absent flake output from the real nix wording", () => {
    const real =
      "error: flake 'git+file:///x?dir=nix' does not provide attribute " +
      "'packages.aarch64-darwin.darwinConfigurations', " +
      "'legacyPackages.aarch64-darwin.darwinConfigurations' or 'darwinConfigurations'";
    expect(classifyNixError(real)).toBe("missing-attr");
  });

  it("still recognizes the attrset-level wording", () => {
    expect(classifyNixError("error: attribute 'foo' missing")).toBe("missing-attr");
  });

  it("does not confuse an absent attribute with a bad flake ref", () => {
    expect(classifyNixError("error: flake 'x' does not provide attribute 'y'")).not.toBe("bad-flake-ref");
  });

  it("recognizes the coercion failure a full config dump produces", () => {
    expect(classifyNixError("error: cannot coerce a list to a string")).toBe("not-serializable");
  });

  it("recognizes an unresolvable flake reference", () => {
    expect(classifyNixError("error: cannot find flake 'flake:nope' in the flake registries")).toBe("bad-flake-ref");
  });

  it("recognizes infinite recursion", () => {
    expect(classifyNixError("error: infinite recursion encountered")).toBe("eval-error");
  });

  it("falls back to eval-error for anything unrecognized", () => {
    expect(classifyNixError("error: something nobody has seen before")).toBe("eval-error");
  });
});
