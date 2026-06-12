export interface EngineInfo {
  name: string;
  version: string;
}

export function getEngineInfo(): EngineInfo {
  return { name: "hdtw-engine", version: "0.0.1" };
}
