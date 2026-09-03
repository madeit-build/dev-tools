// Regression tests from a security review of the first sanitizer. Each block
// is a leak the original passed straight through.
import { describe, it, expect } from "vitest";
import { scrubText, isSecretName, sanitizeGraph, REDACTED } from "./sanitize";
import type { Graph } from "./types";

describe("scrubText: store paths in values, not just in provenance", () => {
  it("elides the hash from an ExecStart while keeping the derivation name", () => {
    expect(scrubText("/nix/store/g9vyfyqc93dgr0vwz7lmnkyz0ni4yzpg-unit-script-wpa_supplicant-start/bin/x"))
      .toBe("<store>/unit-script-wpa_supplicant-start/bin/x");
  });

  it("leaves no literal /nix/store anywhere, which the artifact invariant requires", () => {
    expect(scrubText("/nix/store/g9vyfyqc93dgr0vwz7lmnkyz0ni4yzpg-caddy-2.10.0/bin/caddy"))
      .not.toContain("/nix/store");
  });

  it("scrubs a store path embedded mid-string, not only one at the start", () => {
    const out = scrubText("sh -c /nix/store/g9vyfyqc93dgr0vwz7lmnkyz0ni4yzpg-thing/bin/go --flag");
    expect(out).not.toContain("/nix/store");
    expect(out).toContain("--flag");
  });

  it("scrubs several store paths in one command line", () => {
    const out = scrubText(
      "/nix/store/g9vyfyqc93dgr0vwz7lmnkyz0ni4yzpg-a/bin/a /nix/store/3n4qphl9s728sz8frmpqqrv9b1m87g68-b/bin/b",
    );
    expect(out.match(/\/nix\/store/g)).toBeNull();
    expect(out).toContain("a/bin/a");
    expect(out).toContain("b/bin/b");
  });
});

describe("scrubText: home paths with no repo-shaped tail", () => {
  // The original only stripped a home path when its tail contained nix/, src/,
  // or docs/. Anything else kept the username.
  it("strips the username from a home path with an unrecognized tail", () => {
    const out = scrubText("/Users/someone/scratch/notes.txt");
    expect(out).not.toContain("someone");
    expect(out).toBe("~/scratch/notes.txt");
  });

  it("strips a Linux home path too", () => {
    expect(scrubText("/home/someone/work/thing")).toBe("~/work/thing");
  });

  it("strips a home path embedded mid-string", () => {
    expect(scrubText("--config /Users/someone/x.toml")).toBe("--config ~/x.toml");
  });

  it("leaves a system path that is not under a home directory alone", () => {
    expect(scrubText("/var/lib/caddy")).toBe("/var/lib/caddy");
  });
});

describe("isSecretName: names the first pass missed", () => {
  it("flags a connection string, which routinely embeds a password", () => {
    for (const n of ["DATABASE_URL", "DB_DSN", "POSTGRES_CONNECTION_STRING"]) {
      expect(isSecretName(n), n).toBe(true);
    }
  });

  it("flags key material and signing names", () => {
    for (const n of ["SSH_KEY", "TLS_CERT", "SERVER_PEM", "SIGNING_KEY", "PASSWORD_SALT"]) {
      expect(isSecretName(n), n).toBe(true);
    }
  });

  it("flags session and bearer names", () => {
    for (const n of ["SESSION_COOKIE", "BEARER", "ADMIN_PW"]) {
      expect(isSecretName(n), n).toBe(true);
    }
  });

  it("still does not flag ordinary configuration names", () => {
    for (const n of ["PATH", "HOME", "OLLAMA_HOST", "OLLAMA_MODELS", "PORT", "TZ", "LANG"]) {
      expect(isSecretName(n), n).toBe(false);
    }
  });
});

describe("secret-file values in any position", () => {
  const withAttr = (v: string): Graph => ({
    version: 1, generatedAt: "", flakeRef: ".",
    nodes: [{
      id: "service:box/x", type: "service", label: "x", host: "box",
      attrs: { EnvironmentFile: v }, provenance: { files: [] },
    }],
    edges: [], ledger: [],
  });

  it("redacts systemd's optional-file form, which carries a leading dash", () => {
    expect(sanitizeGraph(withAttr("-/run/secrets/rendered/x.env")).nodes[0].attrs.EnvironmentFile)
      .toBe(REDACTED);
  });

  it("redacts a secret path that is not at the start of the value", () => {
    expect(sanitizeGraph(withAttr("--env-file /run/secrets/x.env")).nodes[0].attrs.EnvironmentFile)
      .toBe(REDACTED);
  });

  // systemd's own LoadCredential convention, found in the real fleet at
  // /run/credentials/fleet-subscribe.service/nats_fleetsub_password. The
  // filename names the credential even though the value is not the secret.
  it("redacts a systemd LoadCredential path, not only a sops-nix one", () => {
    expect(sanitizeGraph(withAttr("/run/credentials/x.service/db_password")).nodes[0].attrs.EnvironmentFile)
      .toBe(REDACTED);
  });
});

describe("edges and the ledger get sanitized, not only nodes", () => {
  const g: Graph = {
    version: 1, generatedAt: "", flakeRef: ".",
    nodes: [
      { id: "a", type: "service", label: "a", host: "box", attrs: {}, provenance: { files: [] } },
      { id: "b", type: "service", label: "b", host: "box", attrs: {}, provenance: { files: [] } },
    ],
    edges: [{
      id: "e1", from: "a", to: "b", type: "depends-on", source: "inferred",
      evidence: "EXEC=/nix/store/g9vyfyqc93dgr0vwz7lmnkyz0ni4yzpg-thing/bin/x",
    }],
    ledger: [{
      candidate: "x", host: "box", rule: "r", reason: "filtered-by-rule",
      detail: "saw /Users/someone/code/thing and skipped it",
    }],
  };

  it("scrubs a store path out of edge evidence", () => {
    expect(sanitizeGraph(g).edges[0].evidence).not.toContain("/nix/store");
  });

  it("scrubs a home path out of a ledger detail", () => {
    const out = sanitizeGraph(g).ledger[0].detail;
    expect(out).not.toContain("someone");
  });

  it("redacts evidence whose key half is secret-shaped", () => {
    const secretEvidence: Graph = {
      ...g,
      edges: [{ ...g.edges[0], evidence: "DATABASE_URL=postgres://u:hunter2@host/db" }],
    };
    expect(sanitizeGraph(secretEvidence).edges[0].evidence).toBe(REDACTED);
  });

  it("keeps ordinary evidence readable, since evidence is the point of an inferred edge", () => {
    const plain: Graph = { ...g, edges: [{ ...g.edges[0], evidence: "reverse_proxy 127.0.0.1:11434" }] };
    expect(sanitizeGraph(plain).edges[0].evidence).toBe("reverse_proxy 127.0.0.1:11434");
  });

  it("leaves a null evidence null rather than turning it into a string", () => {
    const nullEv: Graph = { ...g, edges: [{ ...g.edges[0], evidence: null }] };
    expect(sanitizeGraph(nullEv).edges[0].evidence).toBe(null);
  });
});

describe("the flake ref, the one field not derived from nix output", () => {
  const withRef = (ref: string): Graph => ({
    version: 1, generatedAt: "", flakeRef: ref, nodes: [], edges: [], ledger: [],
  });

  // Caught by running the real CLI, not by the fixture suite: those tests pass
  // a relative "." and so never exercise an absolute ref.
  it("strips the username from an absolute flake ref", () => {
    const out = sanitizeGraph(withRef("/Users/someone/code/thing/nix"));
    expect(out.flakeRef).toBe("~/code/thing/nix");
  });

  it("leaves a relative ref alone", () => {
    expect(sanitizeGraph(withRef(".")).flakeRef).toBe(".");
  });

  it("leaves a remote flake ref alone", () => {
    const ref = "github:NixOS/nixpkgs/nixos-26.05";
    expect(sanitizeGraph(withRef(ref)).flakeRef).toBe(ref);
  });
});

describe("the whole-artifact invariant", () => {
  it("leaves no store path and no username anywhere in a serialized graph", () => {
    const g: Graph = {
      version: 1, generatedAt: "", flakeRef: ".",
      nodes: [{
        id: "service:box/x", type: "service", label: "x", host: "box",
        attrs: { exec: "/nix/store/g9vyfyqc93dgr0vwz7lmnkyz0ni4yzpg-a/bin/a" },
        provenance: { files: ["/nix/store/g9vyfyqc93dgr0vwz7lmnkyz0ni4yzpg-source/nix/x.nix"] },
      }],
      edges: [],
      ledger: [{
        candidate: "y", host: "box", rule: "r", reason: "rule-error",
        detail: "/Users/someone/x",
      }],
    };
    const json = JSON.stringify(sanitizeGraph(g));
    expect(json).not.toContain("/nix/store");
    expect(json).not.toContain("someone");
  });
});
