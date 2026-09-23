import { describe, it, expect } from "vitest";
import { MissingJson, readJson } from "./readJson";

const json = (body: string) =>
  new Response(body, { headers: { "content-type": "application/json" } });

describe("readJson", () => {
  it("parses a JSON response", async () => {
    await expect(readJson(json('{"nodes":[]}'), "/graph.json")).resolves.toEqual({
      nodes: [],
    });
  });

  it("calls a missing file missing when the dev server answers with the app's page", async () => {
    const page = new Response("<!doctype html><html></html>", {
      headers: { "content-type": "text/html" },
    });
    await expect(readJson(page, "/graph.json")).rejects.toBeInstanceOf(MissingJson);
  });

  it("calls a 404 missing", async () => {
    const gone = new Response("", { status: 404 });
    await expect(readJson(gone, "/graph.json")).rejects.toBeInstanceOf(MissingJson);
  });

  it("reports any other failed status with its code", async () => {
    const broken = new Response("", { status: 500 });
    await expect(readJson(broken, "/graph.json")).rejects.toThrow(
      "500 fetching /graph.json",
    );
  });

  it("still reports malformed JSON as a parse error, not as missing", async () => {
    const bad = json("{not json");
    const failure = readJson(bad, "/graph.json");
    await expect(failure).rejects.toThrow(SyntaxError);
  });
});
