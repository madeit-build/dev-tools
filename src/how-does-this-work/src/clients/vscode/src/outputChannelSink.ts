import type * as vscode from "vscode";
import type { ObservabilityRecord, ObservabilitySink } from "@made-i-t/hdtw-observability";

/** Renders observability records into a native VS Code LogOutputChannel. */
export class OutputChannelSink implements ObservabilitySink {
  constructor(private readonly channel: vscode.LogOutputChannel) {}

  record(record: ObservabilityRecord): void {
    try {
      if (record.kind === "metric") {
        this.channel.debug(`metric ${record.name}=${record.value}${formatFields(record.fields)}`);
        return;
      }
      const line = `${record.event}${formatFields(record.fields)}`;
      switch (record.level) {
        case "trace":
          this.channel.trace(line);
          break;
        case "debug":
          this.channel.debug(line);
          break;
        case "info":
          this.channel.info(line);
          break;
        case "warn":
          this.channel.warn(line);
          break;
        case "error":
          this.channel.error(line);
          break;
      }
    } catch {
      // Never let rendering break the producer.
    }
  }

  /** A non-record stderr line from the engine (raw SDK output, stack trace). */
  appendRaw(line: string): void {
    try {
      this.channel.appendLine(line);
    } catch {
      // ignore
    }
  }
}

function formatFields(fields: Record<string, unknown> | undefined): string {
  if (!fields || Object.keys(fields).length === 0) {
    return "";
  }
  return " " + JSON.stringify(fields);
}
