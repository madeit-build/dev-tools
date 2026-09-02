#!/usr/bin/env node
import { readFile, realpath, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { hangAlign } from "@made-i-t/hang-core";
import { createAdapter } from "@made-i-t/hang-prettier";
import * as prettier from "prettier";
import { formatDecisions, resolveHangOptions } from "./explain.js";
import { expand } from "./paths.js";
import { runDoctor } from "./doctor.js";

const USAGE = `hang <command> [paths...]

  --write <paths...>    format in place, hanging what fits
  --explain <paths...>  report every candidate and why it was kept or skipped
  doctor                check the environment in likely-failure order
`;

async function optionsFor(file: string): Promise<prettier.Options> {
  const config = await prettier.resolveConfig(file);
  return { ...config, filepath: file };
}

async function write(files: string[]): Promise<number> {
  let changed = 0;
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const formatted = await prettier.format(source, await optionsFor(file));
    if (formatted === source) continue;
    await writeFile(file, formatted, "utf8");
    process.stdout.write(`${file}\n`);
    changed += 1;
  }
  return changed;
}

async function explain(files: string[]): Promise<void> {
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const options = await optionsFor(file);
    // Deliberately without the plugin: this reproduces the exact text the
    // plugin hands to hangAlign, so the decisions describe the real run.
    const plain = await prettier.format(source, { ...options, plugins: [] });
    const { decisions } = hangAlign(
      plain,
      createAdapter(file),
      resolveHangOptions(options),
    );
    process.stdout.write(`${formatDecisions(file, decisions)}\n`);
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { write: { type: "boolean" }, explain: { type: "boolean" } },
  });

  if (positionals[0] === "doctor") return runDoctor(process.cwd());

  if (values.write && values.explain) {
    process.stderr.write(
      "hang: --write and --explain are mutually exclusive\n",
    );
    return 2;
  }

  if (positionals.length === 0) {
    process.stderr.write(USAGE);
    return 2;
  }

  const root = await realpath(process.cwd());
  const files = await expand(positionals, root);
  if (files.length === 0) {
    process.stderr.write("hang: no files matched\n");
    return 1;
  }

  if (values.explain) {
    await explain(files);
    return 0;
  }
  if (values.write) {
    const changed = await write(files);
    process.stdout.write(
      `hang: ${changed} file${changed === 1 ? "" : "s"} changed\n`,
    );
    return 0;
  }

  process.stderr.write(USAGE);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `hang: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  },
);
