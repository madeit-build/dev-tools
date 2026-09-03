import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as prettier from "prettier";
import * as hangPlugin from "@made-i-t/hang-prettier";
import { resolveFormatOptions } from "./format.js";

const CHAIN =
  "const taken = regions.filter((region) => !region.growing)"
  + ".reduce((sum, region) => sum + regionRows(region, rowsOf), 0);\n";

describe("resolveFormatOptions", () => {
  let base = "";
  let unconfigured = "";

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "hang-format-")));
    unconfigured = join(base, "unconfigured");
    await mkdir(unconfigured);
    // Regression: a project whose .prettierrc.json never lists the plugin
    // used to get plain Prettier output from --write while --explain (which
    // always calls hangAlign directly) claimed a hang on the same file --
    // two commands, same input, contradictory answers, both exit 0.
    await writeFile(
      join(unconfigured, ".prettierrc.json"),
      JSON.stringify({
        printWidth: 90,
        hangWidth: 100,
        experimentalOperatorPosition: "start",
      }),
    );
  });

  afterAll(async () => {
    if (base) await rm(base, { recursive: true, force: true });
  });

  it("hangs a chain even when the project's config never lists the plugin", async () => {
    const file = join(unconfigured, "input.ts");
    const options = await resolveFormatOptions(file);
    const out = await prettier.format(CHAIN, {
      ...options,
      parser: "typescript",
    });
    expect(out).toBe(
      "const taken = regions.filter((region) => !region.growing)\n"
        + "                     .reduce((sum, region) => sum + regionRows(region, rowsOf), 0);\n",
    );
  });

  it("does not duplicate the plugin when the project's config already lists it", async () => {
    // Runs against this repo's own root .prettierrc.json, which lists
    // "@made-i-t/hang-prettier" as a string specifier.
    const file = join(process.cwd(), "index.ts");
    const options = await resolveFormatOptions(file);
    const plugins = options.plugins ?? [];
    const matches = plugins.filter(
      (entry) => entry === hangPlugin || entry === "@made-i-t/hang-prettier",
    );
    expect(matches).toHaveLength(1);
  });
});
