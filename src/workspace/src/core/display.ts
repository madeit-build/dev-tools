import type { ProjectContext, ProjectResolution, RefKind } from "./facts.ts";

const REF_PHRASE: Record<RefKind, string> = {
  branch: "on branch",
  tag: "at tag",
  commit: "at commit",
};

// The line is dropped into prose and card bodies. A name must not be able to start a comment there,
// or it could pose as the card line that follows.
const UNSAFE_IN_PROSE = /[\u0000-\u001f\u007f<>]/g;
const plain = (text: string): string => text.replace(UNSAFE_IN_PROSE, "_");

function withRef(
  name: string,
  ref: string | null,
  refKind: RefKind | null,
): string {
  return ref !== null && refKind !== null
    ? `${plain(name)} ${REF_PHRASE[refKind]} ${plain(ref)}`
    : plain(name);
}

function contextClause(context: ProjectContext): string {
  if (context.source === "origin")
    return `, while inside a clone of ${withRef(context.project, context.ref, context.refKind)}`;
  if (context.source === "git-common-dir")
    return `, while inside ${plain(context.project)}, a local repo with no remote`;
  return `, while inside the folder ${plain(context.project)}`;
}

// A lookup that failed is not the same fact as a remote that is absent, and the line must not say it is.
function remoteWasUnreadable(
  resolution: Omit<ProjectResolution, "display">,
): boolean {
  const where = resolution.source === "session" ? "session" : "cwd";
  return resolution.layers.some(
    (layer) => layer.where === where
               && layer.source === "origin"
               && layer.outcome === "failed",
  );
}

// What named the pick decides the caveat, so a fallback can never read like an answer.
function caveat(resolution: Omit<ProjectResolution, "display">): string {
  const namedBy =
    resolution.source === "session"
      ? resolution.sessionSource
      : resolution.source;
  if (resolution.ours === false) return " (not one of ours)";
  if (namedBy === "folder") return " (a folder, not a git repo)";
  if (namedBy !== "git-common-dir") return "";
  return remoteWasUnreadable(resolution)
    ? " (a repo whose remote could not be read)"
    : " (a local repo with no remote)";
}

export function displayLine(
  resolution: Omit<ProjectResolution, "display">,
): string {
  const pick =
    withRef(resolution.project, resolution.ref, resolution.refKind)
    + caveat(resolution);
  return resolution.context ? pick + contextClause(resolution.context) : pick;
}
