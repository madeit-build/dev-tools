import fs from "node:fs";
import type { DirectoryFacts, ProjectResolution } from "../facts.ts";

export type Case = {
  name: string;
  org: string;
  cwd: DirectoryFacts;
  session: DirectoryFacts | null;
  expect: Omit<ProjectResolution, "schema" | "layers">;
};

export function without<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}

export const cases: Case[] = JSON.parse(
  fs.readFileSync(new URL("../../../schema/project-cases.json", import.meta.url), "utf8"),
);
