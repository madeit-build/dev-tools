import { describe, it, expect } from "vitest";
import {
  buildPortIndex,
  parseEndpoints,
  linksRule,
  capAttr,
  MAX_ATTR_CHARS,
} from "./ports";
import containers from "../fixtures/box-containers.json";
import env from "../fixtures/box-env.json";

const fixtureContainers = containers as unknown as Record<string, string[]>;
const fixtureEnv = env as unknown as Record<string, Record<string, string>>;

describe("parseEndpoints", () => {
  it("reads a bare host:port", () => {
    expect(parseEndpoints("127.0.0.1:11434")).toEqual([11434]);
  });

  it("reads a port out of a URL", () => {
    expect(parseEndpoints("http://127.0.0.1:8188")).toEqual([8188]);
  });

  it("reads a port out of a URL that carries a path and a query", () => {
    expect(parseEndpoints("http://127.0.0.1:31088/search?q=<query>")).toEqual([
      31088,
    ]);
  });

  it("finds nothing in a value with no port", () => {
    expect(parseEndpoints("/var/lib/reverie")).toEqual([]);
  });

  it("ignores a number that is not a port, so a version string is not an endpoint", () => {
    expect(parseEndpoints("qwen_2.5_vl_7b")).toEqual([]);
  });
});

describe("buildPortIndex", () => {
  it("maps a docker published port to its unit and marks it declared", () => {
    const idx = buildPortIndex({ grafana: ["127.0.0.1:3000:3000"] }, {}, {});
    expect(idx.get(3000)).toEqual({
      unit: "docker-grafana",
      source: "declared",
    });
  });

  it("uses the host side of a mapping, not the container side", () => {
    const idx = buildPortIndex({ ntfy: ["127.0.0.1:2586:80"] }, {}, {});
    expect(idx.get(2586)?.unit).toBe("docker-ntfy");
    expect(idx.has(80)).toBe(false);
  });

  it("maps a declared services.<n>.port and marks it declared", () => {
    const idx = buildPortIndex({}, { "open-webui": 31080 }, {});
    expect(idx.get(31080)).toEqual({ unit: "open-webui", source: "declared" });
  });

  it("falls back to an env var and marks that one inferred", () => {
    const idx = buildPortIndex(
      {},
      {},
      { ollama: { OLLAMA_HOST: "127.0.0.1:11434" } },
    );
    expect(idx.get(11434)).toEqual({ unit: "ollama", source: "inferred" });
  });

  // Regression: on the real box both ollama and ollama-model-loader carry
  // OLLAMA_HOST=127.0.0.1:11434. The first is the unit saying where it
  // listens; the second is a client naming its upstream. Without the
  // self-naming check the port went to whichever sorted last.
  it("gives a port to the unit that names itself, not to a client naming it", () => {
    const idx = buildPortIndex(
      {},
      {},
      {
        ollama: { OLLAMA_HOST: "127.0.0.1:11434" },
        "ollama-model-loader": { OLLAMA_HOST: "127.0.0.1:11434" },
      },
    );
    expect(idx.get(11434)?.unit).toBe("ollama");
  });

  it("requires the prefix to equal the unit name, not merely begin it", () => {
    const idx = buildPortIndex(
      {},
      {},
      {
        "ollama-model-loader": { OLLAMA_HOST: "127.0.0.1:11434" },
      },
    );
    expect(idx.has(11434)).toBe(false);
  });

  it("prefers a declared mapping over an inferred one for the same port", () => {
    const idx = buildPortIndex(
      { grafana: ["127.0.0.1:3000:3000"] },
      {},
      { something: { X_HOST: "127.0.0.1:3000" } },
    );
    expect(idx.get(3000)).toEqual({
      unit: "docker-grafana",
      source: "declared",
    });
  });

  describe("against the real captured fleet", () => {
    it("resolves every docker-published upstream the vhosts point at", () => {
      const idx = buildPortIndex(fixtureContainers, {}, {});
      for (const port of [39093, 3000, 2586, 4318, 9090, 31088]) {
        expect(idx.get(port), String(port)).toBeDefined();
        expect(idx.get(port)?.source).toBe("declared");
      }
    });

    it("resolves ollama from its environment, as inferred", () => {
      const idx = buildPortIndex({}, {}, fixtureEnv);
      expect(idx.get(11434)).toEqual({ unit: "ollama", source: "inferred" });
    });
  });
});

describe("capAttr", () => {
  it("passes a short value through unchanged", () => {
    expect(capAttr("127.0.0.1:11434")).toBe("127.0.0.1:11434");
  });

  it("drops an oversized value entirely rather than truncating it", () => {
    const blob = "x".repeat(MAX_ATTR_CHARS + 1);
    expect(capAttr(blob)).toBe(null);
  });

  it("drops the real COMFYUI_WORKFLOW blob, which is over a kilobyte of JSON", () => {
    const blob = fixtureEnv["open-webui"]?.COMFYUI_WORKFLOW;
    expect(blob, "fixture should contain the workflow blob").toBeDefined();
    expect(capAttr(blob)).toBe(null);
  });
});

describe("linksRule", () => {
  const units = new Set(["open-webui", "ollama"]);
  const idx = new Map([
    [11434, { unit: "ollama", source: "declared" as const }],
  ]);

  it("draws a depends-on edge from a service to the service its env names", () => {
    const r = linksRule(
      "box",
      { "open-webui": { OLLAMA_BASE_URL: "http://127.0.0.1:11434" } },
      idx,
      units,
    );
    const dep = r.edges.filter((e) => e.type === "depends-on");
    expect(dep).toHaveLength(1);
    expect(dep[0]).toMatchObject({
      from: "service:box/open-webui",
      to: "service:box/ollama",
      source: "inferred",
    });
    expect(dep[0].evidence).toBe("OLLAMA_BASE_URL=http://127.0.0.1:11434");
  });

  it("marks the link inferred even when the port itself resolved as declared", () => {
    const r = linksRule(
      "box",
      { "open-webui": { OLLAMA_BASE_URL: "http://127.0.0.1:11434" } },
      idx,
      units,
    );
    // The port mapping is a declared fact; that this env var means a runtime
    // dependency is still a reading of a string. The weaker claim wins.
    expect(r.edges[0].source).toBe("inferred");
  });

  it("never draws a service depending on itself", () => {
    const selfIdx = new Map([
      [11434, { unit: "ollama", source: "declared" as const }],
    ]);
    const r = linksRule(
      "box",
      { ollama: { OLLAMA_HOST: "127.0.0.1:11434" } },
      selfIdx,
      units,
    );
    expect(r.edges).toHaveLength(0);
  });

  it("records an unresolvable endpoint in the ledger", () => {
    const r = linksRule(
      "box",
      { "open-webui": { X_URL: "http://127.0.0.1:65000" } },
      idx,
      units,
    );
    expect(r.ledger[0].detail).toMatch(/65000/);
  });

  it("does not read an endpoint out of a secret-named variable", () => {
    const r = linksRule(
      "box",
      { "open-webui": { API_KEY: "http://127.0.0.1:11434" } },
      idx,
      units,
    );
    expect(r.edges).toHaveLength(0);
  });

  describe("against the real captured fleet", () => {
    it("finds the service-to-service graph nothing else in the config states", () => {
      const realUnits = new Set(Object.keys(fixtureEnv));
      const index = buildPortIndex(fixtureContainers, {}, fixtureEnv);
      const r = linksRule("box", fixtureEnv, index, realUnits);
      const from = (unit: string) =>
        r.edges.filter((e) => e.from === `service:box/${unit}`)
               .map((e) => e.to);
      // open-webui names ollama and searxng by URL in its environment.
      expect(from("open-webui")).toContain("service:box/ollama");
      expect(from("open-webui")).toContain("service:box/docker-searxng");
    });

    it("marks every link inferred, since all of them come from reading a string", () => {
      const realUnits = new Set(Object.keys(fixtureEnv));
      const index = buildPortIndex(fixtureContainers, {}, fixtureEnv);
      const r = linksRule("box", fixtureEnv, index, realUnits);
      expect(r.edges.length).toBeGreaterThan(0);
      for (const e of r.edges) expect(e.source).toBe("inferred");
    });
  });
});
