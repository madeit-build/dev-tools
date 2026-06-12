import * as vscode from "vscode";
import { EngineClient } from "./engineClient.js";

let client: EngineClient | undefined;

export async function activate(_context: vscode.ExtensionContext): Promise<void> {
  if (client) {
    return;
  }
  client = new EngineClient();
  try {
    const result = await client.connect();
    void vscode.window.showInformationMessage(
      `HDTW engine connected (${result.engineName} v${result.engineVersion}, protocol v${result.protocolVersion})`
    );
  } catch (error) {
    client.dispose();
    client = undefined;
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`HDTW engine failed to start: ${message}`);
  }
}

export function deactivate(): void {
  client?.dispose();
  client = undefined;
}
