import { describe, it, expect } from "vitest";
import { toRepoPath, isSecretName, sanitizeGraph, REDACTED } from "./sanitize";
import type { Graph } from "./types";

describe("toRepoPath", () => {
  it("strips a nix store prefix down to the repo-relative path", () => {
    expect(
      toRepoPath(
        "/nix/store/7ja3qcq17d764r430vn10x6nwlg6ihvb-source/nix/nixos/chat.nix",
      ),
    ).toBe("nix/nixos/chat.nix");
  });

  it("handles a store path whose name is not 'source'", () => {
    expect(
      toRepoPath(
        "/nix/store/3n4qphl9s728sz8frmpqqrv9b1m87g68-my-flake/nix/flake.nix",
      ),
    ).toBe("nix/flake.nix");
  });

  // Nix base32 excludes e, o, t, and u. A path that merely starts with
  // /nix/store is not a store path, and mangling it would invent a fact.
  it("leaves a /nix/store lookalike with no valid hash untouched", () => {
    const fake = "/nix/store/not-a-hash/nix/flake.nix";
    expect(toRepoPath(fake)).toBe(fake);
  });

  it("leaves an already-relative path alone", () => {
    expect(toRepoPath("nix/nixos/chat.nix")).toBe("nix/nixos/chat.nix");
  });

  it("keeps a runtime path that is not a store path, since it is a real fact", () => {
    expect(toRepoPath("/run/secrets/rendered/reverie.env")).toBe(
      "/run/secrets/rendered/reverie.env",
    );
  });

  it("strips a home directory prefix so no local structure survives", () => {
    expect(
      toRepoPath("/Users/someone/code/made-it/box.provisioning/nix/flake.nix"),
    ).toBe("nix/flake.nix");
  });
});

describe("isSecretName", () => {
  it("flags the usual secret-shaped env var names", () => {
    for (const n of [
      "ANTHROPIC_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "DB_PASSWORD",
      "GITHUB_TOKEN",
      "SESSION_SECRET",
      "private_key",
      "AUTH_CREDENTIAL",
    ]) {
      expect(isSecretName(n), n).toBe(true);
    }
  });

  it("does not flag ordinary configuration names", () => {
    for (const n of [
      "PATH",
      "HOME",
      "OLLAMA_HOST",
      "OLLAMA_MODELS",
      "PORT",
      "TZ",
    ]) {
      expect(isSecretName(n), n).toBe(false);
    }
  });
});

const graphWith = (attrs: Record<string, string>): Graph => ({
  version: 1,
  generatedAt: "2026-08-21T00:00:00.000Z",
  flakeRef: ".",
  nodes: [
    {
      id: "service:box/reverie",
      type: "service",
      label: "reverie",
      host: "box",
      attrs,
      provenance: {
        files: [
          "/nix/store/7ja3qcq17d764r430vn10x6nwlg6ihvb-source/nix/nixos/reverie.nix",
        ],
      },
    },
  ],
  edges: [],
  ledger: [],
});

describe("sanitizeGraph", () => {
  it("redacts the value of a secret-named attribute but keeps its key", () => {
    const out = sanitizeGraph(
      graphWith({ ANTHROPIC_API_KEY: "sk-ant-real-value-here" }),
    );
    expect(out.nodes[0].attrs.ANTHROPIC_API_KEY).toBe(REDACTED);
    expect(Object.keys(out.nodes[0].attrs)).toContain("ANTHROPIC_API_KEY");
  });

  it("redacts any value that looks like it came out of /run/secrets", () => {
    const out = sanitizeGraph(
      graphWith({ EnvironmentFile: "/run/secrets/rendered/reverie.env" }),
    );
    expect(out.nodes[0].attrs.EnvironmentFile).toBe(REDACTED);
  });

  it("leaves ordinary attributes untouched", () => {
    const out = sanitizeGraph(graphWith({ OLLAMA_HOST: "127.0.0.1:11434" }));
    expect(out.nodes[0].attrs.OLLAMA_HOST).toBe("127.0.0.1:11434");
  });

  it("rewrites provenance store paths to repo-relative", () => {
    const out = sanitizeGraph(graphWith({}));
    expect(out.nodes[0].provenance.files).toEqual(["nix/nixos/reverie.nix"]);
  });

  it("does not mutate its input", () => {
    const input = graphWith({ GITHUB_TOKEN: "ghp_secret" });
    sanitizeGraph(input);
    expect(input.nodes[0].attrs.GITHUB_TOKEN).toBe("ghp_secret");
  });
});
