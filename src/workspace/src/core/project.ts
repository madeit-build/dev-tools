import { decide } from "./decide.ts";
import { displayLine } from "./display.ts";
import {
  DEFAULT_HOSTS,
  DEFAULT_ORG,
  SCHEMA_ID,
  type ProjectResolution,
} from "./facts.ts";
import { probeDirectory, runGit, type GitRun } from "./probe.ts";

export { DEFAULT_HOSTS, DEFAULT_ORG } from "./facts.ts";
export type {
  DirectorySource,
  Layer,
  ProjectContext,
  ProjectResolution,
  RefKind,
  Source,
} from "./facts.ts";
export type { GitRun } from "./probe.ts";

export type ResolveInput = {
  cwd: string;
  sessionDir?: string | null;
  org?: string;
  hosts?: readonly string[];
};

// The last resort when the input itself is unusable. It is labeled a folder so it cannot read as an answer.
function unusable(): ProjectResolution {
  const project = "unknown";
  const detail =
    "the working directory was not a usable path; pass --cwd or run from a directory that exists";
  return {
    schema: SCHEMA_ID,
    project,
    source: "folder",
    sessionSource: null,
    ours: null,
    ref: null,
    refKind: null,
    context: null,
    layers: [
      {
        where: "cwd",
        source: "git-common-dir",
        outcome: "failed",
        value: null,
        detail,
      },
      {
        where: "cwd",
        source: "folder",
        outcome: "used",
        value: project,
        detail: "a placeholder, because no directory name was available",
      },
    ],
    display: `${project} (a folder, not a git repo)`,
  };
}

export function resolveProject(
  input: ResolveInput,
  run: GitRun = runGit,
): ProjectResolution {
  try {
    const cwd = probeDirectory(input.cwd, run);
    const session = input.sessionDir
      ? probeDirectory(input.sessionDir, run)
      : null;
    const decided = decide({
      cwd,
      session,
      org: input.org || DEFAULT_ORG,
      hosts: input.hosts ?? DEFAULT_HOSTS,
    });
    return { ...decided, display: displayLine(decided) };
  } catch {
    return unusable();
  }
}

export {
  CARD_LINE_MAX,
  fromCardLine,
  toCardLine,
  type CardProject,
} from "./card.ts";
