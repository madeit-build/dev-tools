export const PROTOCOL_VERSION = "0.0.1";

/** JSON-RPC method name for the client→engine handshake. */
export const PING_METHOD = "hdtw/ping";

export interface PingParams {
  clientName: string;
  protocolVersion: string;
}

export interface PingResult {
  engineName: string;
  engineVersion: string;
  protocolVersion: string;
}

export * from "./tours.js";
export * from "./generation.js";
export * from "./drift.js";
