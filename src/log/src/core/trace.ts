import { randomBytes } from "node:crypto";

/** The conventional variable for handing trace context to a child process. */
export const TRACEPARENT_ENV = "TRACEPARENT";

// version 00, sampled. W3C reserves all-zero ids as invalid.
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const ALL_ZERO_TRACE = "0".repeat(32);
const ALL_ZERO_SPAN = "0".repeat(16);

export function mintTraceparent(): string {
  return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}

export function parseTraceparent(
  value: string | undefined,
): { traceId: string; spanId: string } | null {
  const match = value === undefined ? null : TRACEPARENT.exec(value);
  if (match === null) return null;
  const [, traceId, spanId] = match;
  if (traceId === ALL_ZERO_TRACE || spanId === ALL_ZERO_SPAN) return null;
  return { traceId: traceId as string, spanId: spanId as string };
}
