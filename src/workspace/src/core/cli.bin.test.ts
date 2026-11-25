import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeRepo, tempDir } from "./testing/repos.ts";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const dist = (file: string) => path.join(packageRoot, "dist", file);
let root: string;

beforeAll(() => {
  execFileSync("pnpm", ["run", "build"], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  root = tempDir();
}, 60_000);
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the built package", () => {
  it("dist/cli.js runs under node and prints a resolution", () => {
    const repo = makeRepo(root, "seaboard", {
      origin: "git@github.com:madeit-build/seaboard.git",
    });
    const result = spawnSync(
      process.execPath,
      [dist("cli.js"), "project", "--cwd", repo],
      { encoding: "utf8", env: { PATH: process.env.PATH } },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).display).toBe("seaboard on branch main");
  });

  it("exports ./project and ./session, and nothing else", async () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    );
    expect(Object.keys(manifest.exports)).toEqual(["./project", "./session"]);
    expect(manifest.sideEffects).toBe(false);
    expect(manifest.dependencies).toBeUndefined();
    const project = await import(pathToFileURL(dist("project.js")).href);
    const session = await import(pathToFileURL(dist("session.js")).href);
    expect(typeof project.resolveProject).toBe("function");
    expect(typeof project.toCardLine).toBe("function");
    expect(typeof project.fromCardLine).toBe("function");
    expect(typeof session.claudeCodeSessionDir).toBe("function");
    for (const entry of Object.values(manifest.exports) as {
      types: string;
      import: string;
    }[]) {
      expect(
        fs.existsSync(path.join(packageRoot, entry.types)),
        entry.types,
      ).toBe(true);
      expect(
        fs.existsSync(path.join(packageRoot, entry.import)),
        entry.import,
      ).toBe(true);
    }
  });

  it("ships no test helper", () => {
    expect(fs.existsSync(dist("testing"))).toBe(false);
    expect(
      fs.readdirSync(path.join(packageRoot, "dist"))
        .filter((file) => file.includes(".test.")),
    ).toEqual([]);
  });
});
