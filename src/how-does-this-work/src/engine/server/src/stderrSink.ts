import { serializeRecord, type ObservabilityRecord, type ObservabilitySink } from "@made-i-t/hdtw-observability";

/** Writes each record as one NDJSON line to stderr (stdout is the JSON-RPC channel). */
export class StderrSink implements ObservabilitySink {
  record(record: ObservabilityRecord): void {
    process.stderr.write(serializeRecord(record) + "\n");
  }
}
