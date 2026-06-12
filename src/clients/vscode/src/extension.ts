import * as vscode from "vscode";
import { EngineClient } from "./engineClient.js";
import { TourTreeProvider } from "./tourTree.js";

let client: EngineClient | undefined;

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
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
    return;
  }

  const tree = new TourTreeProvider(client, workspaceRoot);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("hdtwTours", tree),
    vscode.commands.registerCommand("hdtw.refreshTours", () => tree.refresh())
  );
}

export function deactivate(): void {
  client?.dispose();
  client = undefined;
}
