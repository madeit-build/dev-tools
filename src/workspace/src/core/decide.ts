import {
  DEFAULT_HOSTS,
  SCHEMA_ID,
  type DirectoryFacts,
  type DirectorySource,
  type Layer,
  type ProjectContext,
  type ProjectResolution,
} from "./facts.ts";

type Named = { name: string; source: DirectorySource; ours: boolean | null };

const SOURCES: readonly DirectorySource[] = [
  "origin",
  "git-common-dir",
  "folder",
];

// Who counts as us: an owner on a forge. The owner alone is not an identity, since anyone can
// create that owner name on a host of their own.
type Org = { name: string; hosts: readonly string[] };

function onKnownHost(facts: DirectoryFacts, org: Org): boolean {
  return (
    facts.origin !== null
    && org.hosts.some((host) => host.toLowerCase() === facts.origin!.host)
  );
}

function isOurs(facts: DirectoryFacts, org: Org): boolean | null {
  if (!facts.origin) return null;
  return (
    onKnownHost(facts, org)
    && facts.origin.owner.toLowerCase() === org.name.toLowerCase()
  );
}

// A repo that is not ours keeps its owner, and its host when that is not a forge we use,
// so it can never read like one of ours.
function originName(facts: DirectoryFacts, org: Org): string | null {
  if (!facts.origin) return null;
  if (isOurs(facts, org)) return facts.origin.name;
  const ownerAndName = `${facts.origin.owner}/${facts.origin.name}`;
  return onKnownHost(facts, org)
    ? ownerAndName
    : `${facts.origin.host}/${ownerAndName}`;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

// A folder can be named anything, a line break included. A project name is one line.
function oneLine(name: string | null): string | null {
  return name === null ? null : name.replace(CONTROL_CHARACTERS, "_");
}

function valueOf(
  facts: DirectoryFacts,
  source: DirectorySource,
  org: Org,
): string | null {
  if (source === "origin") return originName(facts, org);
  if (source === "git-common-dir") return oneLine(facts.repoFolder);
  return oneLine(facts.folder);
}

function nameOf(facts: DirectoryFacts, org: Org): Named {
  const source =
    SOURCES.find((each) => valueOf(facts, each, org) !== null) ?? "folder";
  return {
    name: valueOf(facts, source, org) ?? facts.folder,
    source,
    ours: isOurs(facts, org),
  };
}

function sameRepo(a: DirectoryFacts, b: DirectoryFacts): boolean {
  if (a.commonDir !== null && a.commonDir === b.commonDir) return true;
  if (!a.origin || !b.origin) return false;
  if (a.origin.host !== b.origin.host) return false;
  return (
    a.origin.owner.toLowerCase() === b.origin.owner.toLowerCase()
    && a.origin.name === b.origin.name
  );
}

function describe(
  facts: DirectoryFacts,
  source: DirectorySource,
  org: Org,
): string {
  const inRepo = facts.commonDir !== null;
  if (source === "origin") {
    if (!facts.origin)
      return inRepo ? "the repo has no origin remote" : "not a git repo";
    return isOurs(facts, org)
      ? `the origin remote is in ${org.name}`
      : `the origin remote is ${facts.origin.owner} on ${facts.origin.host}, which is not ${org.name} on ${org.hosts.join(" or ")}`;
  }
  if (source === "git-common-dir")
    return inRepo
      ? "the folder that holds the repo's git directory"
      : "not a git repo";
  return "the directory's own name";
}

function layersFor(
  where: Layer["where"],
  facts: DirectoryFacts,
  org: Org,
  used: DirectorySource | null,
): Layer[] {
  return SOURCES.map((source) => {
    const failure = facts.failures.find((each) => each.source === source);
    if (failure)
      return {
        where,
        source,
        outcome: "failed",
        value: null,
        detail: failure.detail,
      };
    const value = valueOf(facts, source, org);
    const outcome =
      value === null ? "absent" : source === used ? "used" : "available";
    return {
      where,
      source,
      outcome,
      value,
      detail: describe(facts, source, org),
    };
  });
}

export function decide(input: {
  cwd: DirectoryFacts;
  session: DirectoryFacts | null;
  org: string;
  hosts?: readonly string[];
}): Omit<ProjectResolution, "display"> {
  const { cwd, session } = input;
  const org: Org = { name: input.org, hosts: input.hosts ?? DEFAULT_HOSTS };
  const cwdNamed = nameOf(cwd, org);
  // A session that started in a plain folder never wins: its name would be a fallback labeled as an answer.
  const sessionWins =
    cwdNamed.ours !== true && session !== null && session.commonDir !== null;

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
      layers: [
        ...layersFor("cwd", cwd, org, cwdNamed.source),
        ...(session ? layersFor("session", session, org, null) : []),
      ],
    };
  }

  const sessionNamed = nameOf(session, org);
  const context: ProjectContext | null = sameRepo(cwd, session)
    ? null
    : {
        project: cwdNamed.name,
        source: cwdNamed.source,
        ref: cwd.ref,
        refKind: cwd.refKind,
      };
  return {
    schema: SCHEMA_ID,
    project: sessionNamed.name,
    source: "session",
    sessionSource:
      sessionNamed.source === "origin" ? "origin" : "git-common-dir",
    ours: sessionNamed.ours,
    ref: session.ref,
    refKind: session.refKind,
    context,
    layers: [
      ...layersFor("cwd", cwd, org, null),
      ...layersFor("session", session, org, sessionNamed.source),
    ],
  };
}
