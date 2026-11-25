import fs from "node:fs";
import type { DirectoryFacts, ProjectResolution } from "../facts.ts";

export type Case = {
  name: string;
  org: string;
  cwd: DirectoryFacts;
  session: DirectoryFacts | null;
  expect: Omit<ProjectResolution, "schema" | "layers">;
};

export const cases: Case[] = JSON.parse(
  fs.readFileSync(new URL("../../../schema/project-cases.json", import.meta.url), "utf8"),
);
