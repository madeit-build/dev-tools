import type { ProjectContext, ProjectResolution, RefKind } from "./facts.ts";

const REF_PHRASE: Record<RefKind, string> = { branch: "on branch", tag: "at tag", commit: "at commit" };

function withRef(name: string, ref: string | null, refKind: RefKind | null): string {
  return ref !== null && refKind !== null ? `${name} ${REF_PHRASE[refKind]} ${ref}` : name;
}

function contextClause(context: ProjectContext): string {
  if (context.source === "origin") return `, while inside a clone of ${withRef(context.project, context.ref, context.refKind)}`;
  if (context.source === "git-common-dir") return `, while inside ${context.project}, a local repo with no remote`;
  return `, while inside the folder ${context.project}`;
}

// What named the pick decides the caveat, so a fallback can never read like an answer.
function caveat(resolution: Omit<ProjectResolution, "display">): string {
  const namedBy = resolution.source === "session" ? resolution.sessionSource : resolution.source;
  if (resolution.ours === false) return " (not one of ours)";
  if (namedBy === "git-common-dir") return " (a local repo with no remote)";
  if (namedBy === "folder") return " (a folder, not a git repo)";
  return "";
}

export function displayLine(resolution: Omit<ProjectResolution, "display">): string {
  const pick = withRef(resolution.project, resolution.ref, resolution.refKind) + caveat(resolution);
  return resolution.context ? pick + contextClause(resolution.context) : pick;
}
