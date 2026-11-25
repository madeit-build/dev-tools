import {
  SCHEMA_ID,
  type DirectoryFacts,
  type DirectorySource,
  type Layer,
  type ProjectContext,
  type ProjectResolution,
} from "./facts.ts";

type Named = { name: string; source: DirectorySource; ours: boolean | null };

const SOURCES: readonly DirectorySource[] = ["origin", "git-common-dir", "folder"];

function isOurs(facts: DirectoryFacts, org: string): boolean | null {
  if (!facts.origin) return null;
  return facts.origin.owner.toLowerCase() === org.toLowerCase();
}

// A repo that is not ours keeps its owner, so it can never read like one of ours.
function originName(facts: DirectoryFacts, org: string): string | null {
  if (!facts.origin) return null;
  return isOurs(facts, org) ? facts.origin.name : `${facts.origin.owner}/${facts.origin.name}`;
}

function valueOf(facts: DirectoryFacts, source: DirectorySource, org: string): string | null {
  if (source === "origin") return originName(facts, org);
  if (source === "git-common-dir") return facts.repoFolder;
  return facts.folder;
}

function nameOf(facts: DirectoryFacts, org: string): Named {
  const source = SOURCES.find((each) => valueOf(facts, each, org) !== null) ?? "folder";
  return { name: valueOf(facts, source, org) ?? facts.folder, source, ours: isOurs(facts, org) };
}

function sameRepo(a: DirectoryFacts, b: DirectoryFacts): boolean {
  if (a.commonDir !== null && a.commonDir === b.commonDir) return true;
  if (!a.origin || !b.origin) return false;
  return a.origin.owner.toLowerCase() === b.origin.owner.toLowerCase() && a.origin.name === b.origin.name;
}

function describe(facts: DirectoryFacts, source: DirectorySource, org: string): string {
  const inRepo = facts.commonDir !== null;
  if (source === "origin") {
    if (!facts.origin) return inRepo ? "the repo has no origin remote" : "not a git repo";
    return isOurs(facts, org) ? `the origin remote is in ${org}` : `the origin remote belongs to ${facts.origin.owner}, not ${org}`;
  }
  if (source === "git-common-dir") return inRepo ? "the folder that holds the repo's git directory" : "not a git repo";
  return "the directory's own name";
}

function layersFor(where: Layer["where"], facts: DirectoryFacts, org: string, used: DirectorySource | null): Layer[] {
  return SOURCES.map((source) => {
    const failure = facts.failures.find((each) => each.source === source);
    if (failure) return { where, source, outcome: "failed", value: null, detail: failure.detail };
    const value = valueOf(facts, source, org);
    const outcome = value === null ? "absent" : source === used ? "used" : "available";
    return { where, source, outcome, value, detail: describe(facts, source, org) };
  });
}

export function decide(input: {
  cwd: DirectoryFacts;
  session: DirectoryFacts | null;
  org: string;
}): Omit<ProjectResolution, "display"> {
  const { cwd, session, org } = input;
  const cwdNamed = nameOf(cwd, org);
  // A session that started in a plain folder never wins: its name would be a fallback labeled as an answer.
  const sessionWins = cwdNamed.ours !== true && session !== null && session.commonDir !== null;

  if (!sessionWins) {
    return {
      schema: SCHEMA_ID,
      project: cwdNamed.name,
      source: cwdNamed.source,
      sessionSource: null,
      ours: cwdNamed.ours,
      ref: cwd.ref,
      refKind: cwd.refKind,
      context: null,
      layers: [...layersFor("cwd", cwd, org, cwdNamed.source), ...(session ? layersFor("session", session, org, null) : [])],
    };
  }

  const sessionNamed = nameOf(session, org);
  const context: ProjectContext | null = sameRepo(cwd, session)
    ? null
    : { project: cwdNamed.name, source: cwdNamed.source, ref: cwd.ref, refKind: cwd.refKind };
  return {
    schema: SCHEMA_ID,
    project: sessionNamed.name,
    source: "session",
    sessionSource: sessionNamed.source === "origin" ? "origin" : "git-common-dir",
    ours: sessionNamed.ours,
    ref: session.ref,
    refKind: session.refKind,
    context,
    layers: [...layersFor("cwd", cwd, org, null), ...layersFor("session", session, org, sessionNamed.source)],
  };
}
