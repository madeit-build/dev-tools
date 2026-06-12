import * as vscode from "vscode";
import { EngineClient } from "./engineClient.js";
import { TourTreeProvider } from "./tourTree.js";
import { WalkController } from "./walkController.js";

let client: EngineClient | undefined;
let walk: WalkController | undefined;

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
    vscode.commands.registerCommand("hdtw.refreshTours", () => tree.refresh()),
    vscode.commands.registerCommand("hdtw.startTour", (tourId: string) => startTour(tourId)),
    vscode.commands.registerCommand("hdtw.tourNext", () => walk?.next()),
    vscode.commands.registerCommand("hdtw.tourPrevious", () => walk?.previous()),
    vscode.commands.registerCommand("hdtw.tourExit", () => walk?.exit())
  );
}

async function startTour(tourId: string): Promise<void> {
  const root = workspaceRoot();
  if (!root || !client) {
    void vscode.window.showErrorMessage("HDTW: open a folder to walk its tours.");
    return;
  }
  try {
    const { tour } = await client.getTour(root, tourId);
    walk?.dispose();
    walk = new WalkController(root);
    await walk.start(tour);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`HDTW: could not start tour: ${message}`);
  }
}

export function deactivate(): void {
  walk?.dispose();
  walk = undefined;
  client?.dispose();
  client = undefined;
}
