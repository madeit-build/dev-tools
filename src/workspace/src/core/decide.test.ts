import { describe, expect, it } from "vitest";
import { decide } from "./decide.ts";
import { cases, without } from "./testing/cases.ts";

describe("decide follows the shared cases", () => {
  for (const c of cases) {
    it(c.name, () => {
      const got = without(
        decide({ cwd: c.cwd, session: c.session, org: c.org }),
        "layers",
      );
      expect(got).toEqual({
        schema: "madeit-workspace-project-v1",
        ...without(c.expect, "display"),
      });
    });
  }
});

describe("layers are the evidence", () => {
  it("marks exactly one layer used, and it names the pick", () => {
    for (const c of cases) {
      const got = decide({ cwd: c.cwd, session: c.session, org: c.org });
      const used = got.layers.filter((layer) => layer.outcome === "used");
      expect(used, c.name).toHaveLength(1);
      expect(used[0].value, c.name).toBe(got.project);
    }
  });

  it("records a plain-folder session as available, never used", () => {
    const c = cases.find(
      (each) =>
        each.name === "cwd in a foreign clone, session in a plain folder",
    )!;
    const sessionLayers = decide({
      cwd: c.cwd,
      session: c.session,
      org: c.org,
    }).layers.filter((l) => l.where === "session");
    expect(sessionLayers.map((l) => [l.source, l.outcome, l.value])).toEqual([
      ["origin", "absent", null],
      ["git-common-dir", "absent", null],
      ["folder", "available", "made-it"],
    ]);
  });

  it("carries a directory's failure onto the layer it belongs to", () => {
    const c = cases.find(
      (each) => each.name === "session directory supplied but no longer exists",
    )!;
    const failed = decide({
      cwd: c.cwd,
      session: c.session,
      org: c.org,
    }).layers.filter((l) => l.outcome === "failed");
    expect(failed).toEqual([
      {
        where: "session",
        source: "git-common-dir",
        outcome: "failed",
        value: null,
        detail: "old-worktree does not exist; pass a directory that does",
      },
    ]);
  });

  it("lists the cwd's layers before the session's, each in origin, git-common-dir, folder order", () => {
    const c = cases.find(
      (each) =>
        each.name === "cwd in a foreign clone at a tag, session in our repo",
    )!;
    const order = decide({
      cwd: c.cwd,
      session: c.session,
      org: c.org,
    }).layers.map((l) => `${l.where}:${l.source}`);
    expect(order).toEqual([
      "cwd:origin",
      "cwd:git-common-dir",
      "cwd:folder",
      "session:origin",
      "session:git-common-dir",
      "session:folder",
    ]);
  });
});
