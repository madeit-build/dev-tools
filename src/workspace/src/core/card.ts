import { SCHEMA_ID, type ProjectContext, type ProjectResolution } from "./facts.ts";

export type CardProject = Omit<ProjectResolution, "layers" | "display">;

export const CARD_LINE_MAX = 2048;

const PREFIX = `<!-- ${SCHEMA_ID} `;
const SUFFIX = " -->";
const CARD_LINE = new RegExp(`${PREFIX}(\\{[^\\n]*?\\})${SUFFIX}`);

const SOURCES = ["origin", "git-common-dir", "folder", "session"];
const DIRECTORY_SOURCES = ["origin", "git-common-dir", "folder"];
const SESSION_SOURCES = ["origin", "git-common-dir"];
const REF_KINDS = ["branch", "tag", "commit"];
const TEXT_MAX = 255;
const CONTROL = /[\u0000-\u001f]/;

// A ref is free text, so it is escaped until nothing in the JSON can open or close an HTML comment.
function commentSafe(json: string): string {
  return json.replaceAll("--", "-\\u002d").replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

export function toCardLine(resolution: ProjectResolution): string {
  const compact: CardProject = {
    schema: resolution.schema,
    project: resolution.project,
    source: resolution.source,
    sessionSource: resolution.sessionSource,
    ours: resolution.ours,
    ref: resolution.ref,
    refKind: resolution.refKind,
    context: resolution.context,
  };
  return `${PREFIX}${commentSafe(JSON.stringify(compact))}${SUFFIX}`;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && [...value].length <= TEXT_MAX && !CONTROL.test(value);
}

const isOneOf = (options: readonly string[], value: unknown): boolean => typeof value === "string" && options.includes(value);
const isNullOr = (check: (value: unknown) => boolean, value: unknown): boolean => value === null || check(value);

function hasExactly(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function isContext(value: unknown): value is ProjectContext {
  return (
    hasExactly(value, ["project", "source", "ref", "refKind"]) &&
    isText(value.project) &&
    isOneOf(DIRECTORY_SOURCES, value.source) &&
    isNullOr(isText, value.ref) &&
    isNullOr((kind) => isOneOf(REF_KINDS, kind), value.refKind)
  );
}

// Mirrors schema/madeit-workspace-card-v1.json by hand, so reading a card needs no validator dependency.
function isCardProject(value: unknown): value is CardProject {
  if (!hasExactly(value, ["schema", "project", "source", "sessionSource", "ours", "ref", "refKind", "context"])) return false;
  const sessionSourceFits =
    value.source === "session" ? isOneOf(SESSION_SOURCES, value.sessionSource) : value.sessionSource === null;
  return (
    value.schema === SCHEMA_ID &&
    isText(value.project) &&
    isOneOf(SOURCES, value.source) &&
    sessionSourceFits &&
    isNullOr((ours) => typeof ours === "boolean", value.ours) &&
    isNullOr(isText, value.ref) &&
    isNullOr((kind) => isOneOf(REF_KINDS, kind), value.refKind) &&
    isNullOr(isContext, value.context)
  );
}

// Everything on a card is untrusted when it is read back: anything that does not validate is no card line at all.
export function fromCardLine(text: string): CardProject | null {
  if (typeof text !== "string") return null;
  const match = CARD_LINE.exec(text);
  if (!match || match[0].length > CARD_LINE_MAX) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    return isCardProject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
