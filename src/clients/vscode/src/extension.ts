import * as vscode from "vscode";
import {
  GENERATION_AUTH_REQUIRED_ERROR_CODE,
  GENERATION_BUDGET_EXCEEDED_ERROR_CODE,
} from "@made-i-t/hdtw-protocol";
import {
  createObserver,
  type Observer,
} from "@made-i-t/hdtw-observability";
import { EngineClient } from "./engineClient.js";
import { OutputChannelSink } from "./outputChannelSink.js";
import { TourTreeProvider } from "./tourTree.js";
import { WalkController } from "./walkController.js";

const API_KEY_SECRET = "hdtw.anthropicApiKey";
const REQUEST_CANCELLED_ERROR_CODE = -32800;

let client: EngineClient | undefined;
let walk: WalkController | undefined;
let tree: TourTreeProvider | undefined;
let generating = false;
let channel: vscode.LogOutputChannel | undefined;
let sink: OutputChannelSink | undefined;
let observer: Observer | undefined;

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logLevel = vscode.workspace.getConfiguration("hdtw").get<string>("logLevel", "info");
  if (!channel) {
    channel = vscode.window.createOutputChannel("HDTW", { log: true });
    context.subscriptions.push(channel);
  }
  sink = sink ?? new OutputChannelSink(channel);
  observer = observer ?? createObserver({ sink, minLevel: normalizeLevel(logLevel) });

  if (client) {
    return;
  }
  client = new EngineClient(sink);
  try {
    const apiKey = await context.secrets.get(API_KEY_SECRET);
    const env: Record<string, string> = { HDTW_LOG_LEVEL: logLevel };
    if (apiKey) {
      env.ANTHROPIC_API_KEY = apiKey;
    }
    const result = await client.connect(env);
    observer.logger.info("engine.connected", {
      engine: result.engineName,
      version: result.engineVersion,
    });
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

  tree = new TourTreeProvider(client, workspaceRoot);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("hdtwTours", tree),
    vscode.commands.registerCommand("hdtw.refreshTours", () => tree?.refresh()),
    vscode.commands.registerCommand("hdtw.startTour", (tourId: string) => startTour(tourId)),
    vscode.commands.registerCommand("hdtw.tourNext", () => walk?.next()),
    vscode.commands.registerCommand("hdtw.tourPrevious", () => walk?.previous()),
    vscode.commands.registerCommand("hdtw.tourExit", () => walk?.exit()),
    vscode.commands.registerCommand("hdtw.generateTour", () => generateTour()),
    vscode.commands.registerCommand("hdtw.setApiKey", () => setApiKey(context))
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
    observer?.logger.info("tour.started", { tourId });
    walk?.dispose();
    walk = new WalkController(root);
    await walk.start(tour);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`HDTW: could not start tour: ${message}`);
  }
}

async function generateTour(): Promise<void> {
  const root = workspaceRoot();
  if (!root || !client) {
    void vscode.window.showErrorMessage("HDTW: open a folder to generate a tour.");
    return;
  }
  if (generating) {
    void vscode.window.showWarningMessage("HDTW: a tour is already being generated.");
    return;
  }
  const topic = await vscode.window.showInputBox({
    title: "Generate Tour",
    prompt: "What should the tour explain?",
    placeHolder: "e.g. How does a tour get from disk to the editor?",
  });
  if (!topic) {
    return;
  }
  observer?.logger.info("generate.requested", { topic });

  const config = vscode.workspace.getConfiguration("hdtw.generation");
  const model = config.get<string>("model", "");
  const maxBudgetUsd = config.get<number>("maxBudgetUsd", 2);

  generating = true;
  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "HDTW: generating tour",
        cancellable: true,
      },
      (progress, token) =>
        client!.generateTour(
          { workspaceRoot: root, topic, model: model || undefined, maxBudgetUsd },
          (update) =>
            progress.report({
              message: `${update.message} (${Math.round((update.tokensIn + update.tokensOut) / 1000)}k tokens · ~$${update.estimatedCostUsd.toFixed(2)})`,
            }),
          token
        )
    );
    tree?.refresh();
    void vscode.window.showInformationMessage(`HDTW: tour saved to ${result.savedPath}`);
    walk?.dispose();
    walk = new WalkController(root);
    await walk.start(result.tour);
  } catch (error) {
    handleGenerationError(error);
  } finally {
    generating = false;
  }
}

function handleGenerationError(error: unknown): void {
  const code = (error as { code?: number }).code;
  const message = error instanceof Error ? error.message : String(error);
  observer?.logger.error("generate.error", { code, message });
  if (code === REQUEST_CANCELLED_ERROR_CODE) {
    return; // user cancelled — silent
  }
  if (code === GENERATION_AUTH_REQUIRED_ERROR_CODE) {
    void vscode.window
      .showErrorMessage(`HDTW: ${message}`, "Set API Key")
      .then((action) => {
        if (action === "Set API Key") {
          void vscode.commands.executeCommand("hdtw.setApiKey");
        }
      });
    return;
  }
  if (code === GENERATION_BUDGET_EXCEEDED_ERROR_CODE) {
    void vscode.window.showErrorMessage(
      `HDTW: ${message} Raise hdtw.generation.maxBudgetUsd to allow more.`
    );
    return;
  }
  void vscode.window.showErrorMessage(`HDTW: tour generation failed: ${message}`);
}

async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
  const key = await vscode.window.showInputBox({
    title: "Set Anthropic API Key",
    prompt: "Stored in VS Code SecretStorage; passed to the engine on next start.",
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) {
    return;
  }
  if (key === "") {
    await context.secrets.delete(API_KEY_SECRET);
    void vscode.window.showInformationMessage("HDTW: API key cleared. Reload to apply.");
  } else {
    await context.secrets.store(API_KEY_SECRET, key);
    void vscode.window.showInformationMessage("HDTW: API key saved. Reload to apply.");
  }
  const action = await vscode.window.showInformationMessage(
    "Reload window to restart the engine with the new credentials?",
    "Reload"
  );
  if (action === "Reload") {
    void vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

function normalizeLevel(value: string): "error" | "warn" | "info" | "debug" | "trace" {
  switch (value) {
    case "error":
    case "warn":
    case "info":
    case "debug":
    case "trace":
      return value;
    default:
      return "info";
  }
}

export function deactivate(): void {
  walk?.dispose();
  walk = undefined;
  client?.dispose();
  client = undefined;
  tree = undefined;
}
