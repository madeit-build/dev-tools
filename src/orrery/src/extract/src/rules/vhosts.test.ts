import { describe, it, expect } from "vitest";
import { parseUpstreams, vhostsRule, type RawVHost } from "./vhosts";
import raw from "../fixtures/box-vhosts.json";

const fixture = raw as unknown as Record<string, RawVHost>;

describe("parseUpstreams", () => {
  it("reads a plain reverse_proxy line", () => {
    expect(parseUpstreams("reverse_proxy 127.0.0.1:39093\n")).toEqual([
      { host: "127.0.0.1", port: 39093, raw: "reverse_proxy 127.0.0.1:39093" },
    ]);
  });

  it("reads localhost as well as a dotted address", () => {
    expect(parseUpstreams("reverse_proxy localhost:31080\n")[0]).toMatchObject({
      host: "localhost",
      port: 31080,
    });
  });

  it("reads a reverse_proxy that opens a block", () => {
    const extra = [
      "reverse_proxy localhost:11434 {",
      "  header_up Host {upstream_hostport}",
      "}",
    ].join("\n");
    expect(parseUpstreams(extra)).toEqual([
      {
        host: "localhost",
        port: 11434,
        raw: "reverse_proxy localhost:11434 {",
      },
    ]);
  });

  it("ignores reverse_proxy mentioned inside a comment", () => {
    const extra = [
      "# Ollama checks the Host header, so a plain reverse_proxy 127.0.0.1:9999 fails",
      "reverse_proxy localhost:11434",
    ].join("\n");
    const found = parseUpstreams(extra);
    expect(found).toHaveLength(1);
    expect(found[0].port).toBe(11434);
  });

  it("finds nothing in a respond directive", () => {
    expect(
      parseUpstreams('respond "box: caddy + tailnet + DNS-01 OK" 200\n'),
    ).toEqual([]);
  });

  it("finds nothing in a file_server directive", () => {
    expect(parseUpstreams("root * /var/lib/reverie\nfile_server\n")).toEqual(
      [],
    );
  });
});

describe("vhostsRule", () => {
  const units = new Set(["caddy", "ollama", "open-webui"]);

  it("emits a vhost node and a contains edge from the host", () => {
    const r = vhostsRule(
      "box",
      {
        "ollama.keep.madeit.build": {
          extra: "reverse_proxy localhost:11434\n",
        },
      },
      units,
      { 11434: "ollama" },
    );
    expect(r.nodes.map((n) => n.type)).toContain("vhost");
    expect(
      r.edges.some((e) => e.type === "contains" && e.from === "host:box"),
    ).toBe(true);
  });

  it("marks a proxy edge as inferred and carries the matched text as evidence", () => {
    const r = vhostsRule(
      "box",
      {
        "ollama.keep.madeit.build": {
          extra: "reverse_proxy localhost:11434\n",
        },
      },
      units,
      { 11434: "ollama" },
    );
    const proxy = r.edges.filter((e) => e.type === "proxies-to");
    expect(proxy).toHaveLength(1);
    expect(proxy[0].source).toBe("inferred");
    expect(proxy[0].evidence).toBe("reverse_proxy localhost:11434");
    expect(proxy[0].to).toBe("service:box/ollama");
  });

  it("draws no proxy edge for a vhost that only responds inline", () => {
    const r = vhostsRule(
      "box",
      { "health.keep.madeit.build": { extra: 'respond "ok" 200\n' } },
      units,
      {},
    );
    expect(r.edges.filter((e) => e.type === "proxies-to")).toHaveLength(0);
    expect(r.nodes.filter((n) => n.type === "vhost")).toHaveLength(1);
  });

  it("draws no proxy edge when the port maps to no known service", () => {
    const r = vhostsRule(
      "box",
      { "x.example": { extra: "reverse_proxy 127.0.0.1:65000\n" } },
      units,
      {},
    );
    expect(r.edges.filter((e) => e.type === "proxies-to")).toHaveLength(0);
  });

  it("records an unresolvable upstream in the ledger rather than dropping it silently", () => {
    const r = vhostsRule(
      "box",
      { "x.example": { extra: "reverse_proxy 127.0.0.1:65000\n" } },
      units,
      {},
    );
    expect(r.ledger).toHaveLength(1);
    expect(r.ledger[0].reason).toBe("filtered-by-rule");
    expect(r.ledger[0].detail).toMatch(/65000/);
  });

  describe("against the real captured fleet", () => {
    it("emits a node for every vhost in the fixture", () => {
      const r = vhostsRule("box", fixture, new Set(), {});
      expect(r.nodes.filter((n) => n.type === "vhost")).toHaveLength(
        Object.keys(fixture).length,
      );
    });

    it("finds an upstream for ten of the twelve, and none for health and reverie", () => {
      const withUpstream = Object.entries(fixture)
        .filter(([, v]) => parseUpstreams(v.extra).length > 0)
        .map(([k]) => k);
      const without = Object.keys(fixture).filter(
        (k) => !withUpstream.includes(k),
      );
      expect(without.sort()).toEqual([
        "health.keep.madeit.build",
        "reverie.keep.madeit.build",
      ]);
    });

    it("marks every single proxy edge as inferred, never as declared", () => {
      const r = vhostsRule("box", fixture, new Set(["ollama"]), {
        11434: "ollama",
      });
      for (const e of r.edges.filter((x) => x.type === "proxies-to")) {
        expect(e.source).toBe("inferred");
      }
    });
  });
});
