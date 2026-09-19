import { NODE_TYPES, type NodeType } from "./types";

const SEP = ":";

const build = (type: NodeType, rest: string): string => `${type}${SEP}${rest}`;

export const fleetId = (): string => build("fleet", "fleet");
export const hostId = (host: string): string => build("host", host);
export const serviceId = (host: string, unit: string): string =>
  build("service", `${host}/${unit}`);
export const vhostId = (host: string, name: string): string =>
  build("vhost", `${host}/${name}`);
export const datastoreId = (host: string, name: string): string =>
  build("datastore", `${host}/${name}`);
export const portId = (host: string, port: number | string): string =>
  build("port", `${host}/${port}`);

// "Part" is the name of the fourth zoom level, not of a node type any rule
// currently emits: that level materializes as datastore and port nodes.
// This constructor exists for a leaf scalar that later earns its own node.
// Scalars like ExecStart and User stay attributes today, because the
// inspector renders them better than the canvas would.
export const partId = (
  host: string,
  unit: string,
  kind: string,
  value: string,
): string => build("part", `${host}/${unit}/${kind}/${value}`);

export const moduleId = (repoPath: string): string => build("module", repoPath);
export const optionId = (host: string, path: string): string =>
  build("option", `${host}/${path}`);
export const inputId = (name: string): string => build("input", name);
export const externalId = (name: string): string => build("external", name);

// Node types whose tail is not host-scoped. Everything else leads with a host
// segment, which is what lets one host's caddy stay distinct from another's.
const HOSTLESS = new Set<NodeType>(["fleet", "module", "input", "external"]);

export interface ParsedId {
  type: NodeType;
  host: string | null;
  rest: string;
}

export function parseId(id: string): ParsedId {
  const at = id.indexOf(SEP);
  if (at <= 0) throw new Error(`malformed id, no type prefix: ${id}`);

  const type = id.slice(0, at) as NodeType;
  if (!NODE_TYPES.includes(type)) throw new Error(`unknown node type: ${type}`);

  const tail = id.slice(at + 1);
  if (HOSTLESS.has(type)) return { type, host: null, rest: tail };

  const slash = tail.indexOf("/");
  if (slash < 0) return { type, host: tail, rest: "" };
  return { type, host: tail.slice(0, slash), rest: tail.slice(slash + 1) };
}
