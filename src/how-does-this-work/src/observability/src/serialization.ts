import type { ObservabilityRecord } from "./records.js";

export function serializeRecord(record: ObservabilityRecord): string {
  return JSON.stringify(record);
}

export function parseRecord(line: string): ObservabilityRecord | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.kind === "log"
      && typeof candidate.event === "string"
      && typeof candidate.ts === "number"
  ) {
    return parsed as ObservabilityRecord;
  }
  if (candidate.kind === "metric"
      && typeof candidate.name === "string"
      && typeof candidate.value === "number"
      && typeof candidate.ts === "number"
  ) {
    return parsed as ObservabilityRecord;
  }
  return null;
}
