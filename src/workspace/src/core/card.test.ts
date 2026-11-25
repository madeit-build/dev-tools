import fs from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { CARD_LINE_MAX, fromCardLine, toCardLine, type CardProject } from "./card.ts";
import { decide } from "./decide.ts";
import { displayLine } from "./display.ts";
import type { ProjectResolution } from "./facts.ts";
import { cases, without } from "./testing/cases.ts";

const schema = JSON.parse(fs.readFileSync(new URL("../../schema/madeit-workspace-card-v1.json", import.meta.url), "utf8"));
const validate = new Ajv2020({ strict: false }).compile(schema);

const resolutions: ProjectResolution[] = cases.map((c) => {
  const decided = decide({ cwd: c.cwd, session: c.session, org: c.org });
  return { ...decided, display: displayLine(decided) };
});
const compact = (resolution: ProjectResolution): CardProject => without(resolution, "layers", "display");
const PREFIX = "<!-- madeit-workspace-project-v1 ";
const line = (json: string) => `${PREFIX}${json} -->`;
const valid = compact(resolutions[3]);

describe("the card line", () => {
  it("round-trips every case", () => {
    for (const resolution of resolutions) expect(fromCardLine(toCardLine(resolution))).toEqual(compact(resolution));
  });

  it("is one line with a fixed prefix and suffix", () => {
    const written = toCardLine(resolutions[3]);
    expect(written.startsWith(PREFIX)).toBe(true);
    expect(written.endsWith(" -->")).toBe(true);
    expect(written).not.toContain("\n");
  });

  it("is found inside a larger card body", () => {
    const body = `the why\n\nCaptured while working in ${resolutions[3].display}.\n${toCardLine(resolutions[3])}\n`;
    expect(fromCardLine(body)).toEqual(valid);
  });

  it("carries no layers, no display, and no path", () => {
    for (const resolution of resolutions) {
      const written = toCardLine(resolution);
      expect(written).not.toContain("layers");
      expect(written).not.toContain("display");
      expect(written).not.toContain("/work/");
      expect(written).not.toContain("/scratch/");
    }
  });

  it("a ref that tries to close the comment cannot", () => {
    const hostile = { ...resolutions[0], ref: "a-->b<!--c---d" };
    const written = toCardLine(hostile);
    expect(written.indexOf("-->")).toBe(written.length - 3);
    expect(written.slice(PREFIX.length)).not.toContain("<!--");
    expect(fromCardLine(written)?.ref).toBe("a-->b<!--c---d");
  });

  it("takes the first line when a body has two", () => {
    expect(fromCardLine(`${toCardLine(resolutions[0])}\n${toCardLine(resolutions[4])}`)).toEqual(compact(resolutions[0]));
  });

  it("returns null when the comment is too long", () => {
    const long = line(JSON.stringify({ ...valid, project: "p".repeat(CARD_LINE_MAX) }));
    expect(fromCardLine(long)).toBeNull();
  });

  const invalid: [string, string][] = [
    ["an empty body", ""],
    ["a body with no card line", "Captured while working in gufo-v0.35.0 on branch HEAD."],
    ["text that is not JSON", line("{not json}")],
    ["a JSON array", line("[]")],
    ["the wrong schema", line(JSON.stringify({ ...valid, schema: "x" }))],
    ["an extra property", line(JSON.stringify({ ...valid, layers: [] }))],
    ["a missing property", line(JSON.stringify({ ...valid, ours: undefined }))],
    ["an unknown source", line(JSON.stringify({ ...valid, source: "vibes" }))],
    ["an empty project", line(JSON.stringify({ ...valid, project: "" }))],
    ["a project with a newline", line(JSON.stringify({ ...valid, project: "a\nb" }))],
    ["a project over 255 characters", line(JSON.stringify({ ...valid, project: "p".repeat(256) }))],
    ["a numeric ours", line(JSON.stringify({ ...valid, ours: 1 }))],
    ["a session source with no sessionSource", line(JSON.stringify({ ...valid, sessionSource: null }))],
    ["a sessionSource on a pick that is not a session", line(JSON.stringify({ ...compact(resolutions[0]), sessionSource: "origin" }))],
    ["a context with an extra property", line(JSON.stringify({ ...valid, context: { ...valid.context, path: "/x" } }))],
    ["a context that is a string", line(JSON.stringify({ ...valid, context: "gufo" }))],
    ["a context whose source is session", line(JSON.stringify({ ...valid, context: { ...valid.context, source: "session" } }))],
    ["an unknown refKind", line(JSON.stringify({ ...valid, refKind: "mood" }))],
  ];

  it.each(invalid)("returns null for %s", (_label, body) => {
    expect(fromCardLine(body)).toBeNull();
  });

  it("agrees with the schema on every input here", () => {
    const candidates = [...invalid.map(([, body]) => body), ...resolutions.map(toCardLine)];
    for (const body of candidates) {
      const json = body.startsWith(PREFIX) ? body.slice(PREFIX.length, -4) : null;
      let parsed: unknown;
      try {
        parsed = json === null ? undefined : JSON.parse(json);
      } catch {
        parsed = undefined;
      }
      const schemaSays = parsed !== undefined && validate(parsed);
      expect(fromCardLine(body) !== null, body.slice(0, 120)).toBe(schemaSays);
    }
  });
});
