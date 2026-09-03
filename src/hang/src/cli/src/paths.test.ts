import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insideRoot, expand } from "./paths.js";

let root = "";
let outside = "";

beforeAll(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hang-paths-")));
  root = join(base, "project");
  outside = join(base, "elsewhere");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(root, "inside.ts"), "const a = 1;\n");
  await writeFile(join(outside, "secret.ts"), "const b = 2;\n");
  await symlink(join(outside, "secret.ts"), join(root, "escape.ts"));
  // Sibling directory that shares root's name as a strict string prefix
  // (e.g. "project-other" next to "project"). It must actually exist so
  // insideRoot resolves it via realpath instead of failing for the
  // unrelated reason that the path doesn't exist at all - only then does
  // the test exercise the prefix-boundary check it is named for.
  await mkdir(`${root}-other`);
});

afterAll(async () => {
  if (root) await rm(join(root, ".."), { recursive: true, force: true });
});

describe("insideRoot", () => {
  it("accepts a real file under the root", async () => {
    expect(await insideRoot(join(root, "inside.ts"), root)).toBe(true);
  });

  it("refuses a symlink pointing out of the root", async () => {
    expect(await insideRoot(join(root, "escape.ts"), root)).toBe(false);
  });

  it("refuses a path that does not exist", async () => {
    expect(await insideRoot(join(root, "missing.ts"), root)).toBe(false);
  });

  it("refuses a sibling directory sharing the root's name prefix", async () => {
    expect(await insideRoot(`${root}-other`, root)).toBe(false);
  });
});

describe("expand", () => {
  it("returns files under the root and drops the escaping symlink", async () => {
    const found = await expand(["*.ts"], root);
    expect(found).toEqual([join(root, "inside.ts")]);
  });

  it("redacts the escaping path in its stderr warning instead of leaking it", async () => {
    // doctor.ts goes to lengths to redact absolute paths out of every
    // message it builds; this warning used to print the real resolved path
    // of whatever the symlink pointed to unredacted, right next to that
    // effort.
    const stderrWrite = vi.spyOn(process.stderr, "write")
                          .mockImplementation(() => true);
    try {
      await expand(["*.ts"], root);
      const written = stderrWrite.mock.calls.map(([chunk]) => String(chunk))
                                            .join("");
      expect(written).toContain("refusing path outside the project root");
      expect(written).not.toContain(outside);
      expect(written).not.toContain(root);
    } finally {
      stderrWrite.mockRestore();
    }
  });
});
