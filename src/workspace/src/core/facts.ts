export type RefKind = "branch" | "tag" | "commit";
export type DirectorySource = "origin" | "git-common-dir" | "folder";
export type Source = DirectorySource | "session";

export type Failure = { source: DirectorySource; detail: string };

export type DirectoryFacts = {
  path: string;
  exists: boolean;
  folder: string;
  commonDir: string | null;
  repoFolder: string | null;
  origin: { owner: string; name: string } | null;
  ref: string | null;
  refKind: RefKind | null;
  failures: Failure[];
};

export type Layer = {
  where: "cwd" | "session";
  source: DirectorySource;
  outcome: "used" | "available" | "absent" | "failed";
  value: string | null;
  detail: string;
};

export type ProjectContext = {
  project: string;
  source: DirectorySource;
  ref: string | null;
  refKind: RefKind | null;
};

export type ProjectResolution = {
  schema: "madeit-workspace-project-v1";
  project: string;
  source: Source;
  sessionSource: "origin" | "git-common-dir" | null;
  ours: boolean | null;
  ref: string | null;
  refKind: RefKind | null;
  context: ProjectContext | null;
  layers: Layer[];
  display: string;
};

export const SCHEMA_ID = "madeit-workspace-project-v1" as const;
export const DEFAULT_ORG = "madeit-build";
