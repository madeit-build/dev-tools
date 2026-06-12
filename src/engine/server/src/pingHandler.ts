import { getEngineInfo } from "@made-i-t/hdtw-engine-core";
import { PROTOCOL_VERSION, type PingParams, type PingResult } from "@made-i-t/hdtw-protocol";

export function handlePing(_params: PingParams): PingResult {
  const engineInfo = getEngineInfo();
  return {
    engineName: engineInfo.name,
    engineVersion: engineInfo.version,
    protocolVersion: PROTOCOL_VERSION,
  };
}
