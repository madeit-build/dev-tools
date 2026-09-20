import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Tour } from "@made-i-t/hdtw-protocol";
import { slugify, writeTourToCatalog } from "./tourStorage.js";

describe("slugify", () => {
  test("lowercases and dashes non-alphanumerics, trims dashes", () => {
    expect(slugify("How Does Drift Work?!")).toBe("how-does-drift-work");
    expect(slugify("***")).toBe("tour");
  });
});

function tour(title: string): Tour {
  return {
    schemaVersion: 1,
    id: "provisional",
    title,
    summary: "",
    steps: [
      {
        title: "s",
        narration: "n",
        anchor: {
          file: "README.md",
          startLine: 1,
          endLine: 1,
          snippetHash: "sha256:aa",
        },
      },
    ],
  };
}

describe("writeTourToCatalog", () => {
  let workspaceRoot: string;
  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), "hdtw-store-"));
  });
  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("writes the tour with a slugified id and matching filename", async () => {
    const result = await writeTourToCatalog(workspaceRoot, tour("My Tour"));
    expect(result.savedPath).toBe(".hdtw/tours/my-tour.tour.json");
    expect(result.tour.id).toBe("my-tour");
    const onDisk = JSON.parse(
      await readFile(path.join(workspaceRoot, result.savedPath), "utf8"),
    );
    expect(onDisk.id).toBe("my-tour");
  });

  test("a colliding title gets a -2 suffix", async () => {
    await mkdir(path.join(workspaceRoot, ".hdtw", "tours"), {
      recursive: true,
    });
    await writeFile(
      path.join(workspaceRoot, ".hdtw/tours/my-tour.tour.json"),
      "{}",
    );
    const result = await writeTourToCatalog(workspaceRoot, tour("My Tour"));
    expect(result.savedPath).toBe(".hdtw/tours/my-tour-2.tour.json");
    expect(result.tour.id).toBe("my-tour-2");
  });
});
