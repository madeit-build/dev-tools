import * as vscode from "vscode";
import {
  GENERATION_AUTH_REQUIRED_ERROR_CODE,
  GENERATION_BUDGET_EXCEEDED_ERROR_CODE,
} from "@made-i-t/hdtw-protocol";
import {
  createObserver,
  parseLogLevel,
  type Observer,
} from "@made-i-t/hdtw-observability";
import { EngineClient } from "./engineClient.js";
import { OutputChannelSink } from "./outputChannelSink.js";
import { TourTreeProvider } from "./tourTree.js";
import { WalkController } from "./walkController.js";
import { createSaveState } from "./saveState.js";

const ANTHROPIC_API_KEY_SECRET = "hdtw.anthropicApiKey";
const OPENAI_API_KEY_SECRET = "hdtw.openaiApiKey";
const REQUEST_CANCELLED_ERROR_CODE = -32800;

let client: EngineClient | undefined;
let walk: WalkController | undefined;
let tree: TourTreeProvider | undefined;
let generating = false;
let channel: vscode.LogOutputChannel | undefined;
let sink: OutputChannelSink | undefined;
let observer: Observer | undefined;
let tourTitles = new Map<string, string>();
const driftCounts = new Map<string, number>();
const saveState = createSaveState();
let saveStatusItem: vscode.StatusBarItem | undefined;

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function refreshTourTitles(root: string): Promise<void> {
  if (!client) {
    return;
  }
  try {
    const { tours } = await client.listTours(root);
    tourTitles = new Map(
      tours.filter((tour) => tour.error === undefined)
           .map((tour) => [tour.id, tour.title]),
    );
  } catch {
    // Leave the previous snapshot in place.
  }
}

function refreshSaveAffordance(): void {
  if (saveState.unsavedTour()) {
    saveStatusItem?.show();
  } else {
    saveStatusItem?.hide();
  }
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const logLevel = vscode.workspace.getConfiguration("hdtw")
                                   .get<string>("logLevel", "info");
  if (!channel) {
    channel = vscode.window.createOutputChannel("HDTW", { log: true });
    context.subscriptions.push(channel);
  }
  sink = sink ?? new OutputChannelSink(channel);
  observer = observer
             ?? createObserver({ sink, minLevel: parseLogLevel(logLevel, "info") });

  if (client) {
    return;
  }
  client = new EngineClient(sink);
  try {
    const anthropicApiKey = await context.secrets.get(ANTHROPIC_API_KEY_SECRET);
    const openaiApiKey = await context.secrets.get(OPENAI_API_KEY_SECRET);
    const env: Record<string, string> = { HDTW_LOG_LEVEL: logLevel };
    if (anthropicApiKey) {
      env.ANTHROPIC_API_KEY = anthropicApiKey;
    }
    if (openaiApiKey) {
      env.OPENAI_API_KEY = openaiApiKey;
    }
    const result = await client.connect(env);
    observer.logger.info("engine.connected", {
      engine: result.engineName,
      version: result.engineVersion,
    });
    void vscode.window.showInformationMessage(
      `HDTW engine connected (${result.engineName} v${result.engineVersion}, protocol v${result.protocolVersion})`,
    );
  } catch (error) {
    client.dispose();
    client = undefined;
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(
      `HDTW engine failed to start: ${message}`,
    );
    return;
  }

  tree = new TourTreeProvider(client, workspaceRoot, (id) =>
    driftCounts.get(id),
  );

  saveStatusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    99,
  );
  saveStatusItem.command = "hdtw.saveWalk";
  saveStatusItem.text = "$(save) Save tour";
  saveStatusItem.tooltip = "Save this walk to .hdtw/tours/";
  context.subscriptions.push(saveStatusItem);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("hdtwTours", tree),
    vscode.commands.registerCommand("hdtw.refreshTours", () => tree?.refresh()),
    vscode.commands.registerCommand("hdtw.startTour", (tourId: string) =>
      startTour(tourId),
    ),
    vscode.commands.registerCommand("hdtw.tourNext", () => walk?.next()),
    vscode.commands.registerCommand("hdtw.tourPrevious", () =>
      walk?.previous(),
    ),
    vscode.commands.registerCommand("hdtw.tourExit", () => {
      walk?.exit();
      saveState.setSaved();
      refreshSaveAffordance();
    }),
    vscode.commands.registerCommand("hdtw.followRelated", (tourId: string) =>
      followRelated(tourId),
    ),
    vscode.commands.registerCommand(
      "hdtw.reanchorStep",
      (tourId: string, stepIndex: number) => reanchorStep(tourId, stepIndex),
    ),
    vscode.commands.registerCommand("hdtw.generateTour", () => generateTour()),
    vscode.commands.registerCommand("hdtw.setApiKey", () => setApiKey(context)),
    vscode.commands.registerCommand("hdtw.ask", () => askWalk()),
    vscode.commands.registerCommand("hdtw.saveWalk", () => saveWalk()),
    vscode.commands.registerCommand(
      "hdtw.askWhy",
      (reply: vscode.CommentReply) => askWhy(reply),
    ),
    vscode.commands.registerCommand(
      "hdtw.checkTourDrift",
      async (item?: { id?: string }) => {
        const root = workspaceRoot();
        const tourId = typeof item?.id === "string" ? item.id : undefined;
        if (!root || !client || !tourId) {
          return;
        }
        try {
          const { statuses } = await client.checkTourDrift(root, tourId);
          driftCounts.set(
            tourId,
            statuses.filter((s) => s.status !== "fresh").length,
          );
          tree?.refresh();
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          void vscode.window.showErrorMessage(
            `HDTW: drift check failed: ${message}`,
          );
        }
      },
    ),
  );
}

async function startTour(tourId: string): Promise<void> {
  const root = workspaceRoot();
  if (!root || !client) {
    void vscode.window.showErrorMessage(
      "HDTW: open a folder to walk its tours.",
    );
    return;
  }
  try {
    const { tour } = await client.getTour(root, tourId);
    observer?.logger.info("tour.started", { tourId });
    await refreshTourTitles(root);
    walk?.dispose();
    walk = new WalkController(root, (id) => tourTitles.get(id));
    walk.setReanchorContext(tourId);
    await walk.start(tour);
    saveState.setSaved();
    refreshSaveAffordance();
    await applyDrift(root, tourId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(
      `HDTW: could not start tour: ${message}`,
    );
  }
}

async function applyDrift(root: string, tourId: string): Promise<void> {
  if (!client || !walk) {
    return;
  }
  try {
    const { statuses } = await client.checkTourDrift(root, tourId);
    walk.setDrift(statuses);
    await walk.refresh();
    const drifted = statuses.filter((s) => s.status !== "fresh").length;
    observer?.logger.info("drift.checked", {
      tourId,
      drifted,
      total: statuses.length,
    });
    driftCounts.set(tourId, drifted);
    tree?.refresh();
  } catch {
    // Drift is best-effort; a failure leaves the walk usable without badges.
  }
}

async function reanchorStep(tourId: string, stepIndex: number): Promise<void> {
  const root = workspaceRoot();
  if (!root || !client || !walk) {
    return;
  }
  try {
    const result = await client.reanchorStep(root, tourId, stepIndex);
    observer?.logger.info("reanchor.result", {
      tourId,
      stepIndex,
      outcome: result.outcome,
    });
    if (result.outcome === "reanchored") {
      void vscode.window.showInformationMessage(
        `HDTW: re-anchored step ${stepIndex + 1} — review the change in your tour file.`,
      );
      await applyDrift(root, tourId);
      return;
    }
    const reason =
      result.outcome === "ambiguous"
        ? "the code appears more than once"
        : result.outcome === "file-missing"
          ? "the file is missing"
          : "the original code could not be found";
    void vscode.window.showWarningMessage(
      `HDTW: couldn't re-anchor step ${stepIndex + 1} — ${reason}. Edit the tour by hand.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`HDTW: re-anchor failed: ${message}`);
  }
}

async function askWhy(reply: vscode.CommentReply): Promise<void> {
  const root = workspaceRoot();
  const question = reply.text.trim();
  if (!root || !client || !walk || question.length === 0) {
    return;
  }
  observer?.logger.info("qa.asked", { question });
  const config = vscode.workspace.getConfiguration("hdtw.generation");
  const model = config.get<string>("model", "");
  const maxBudgetUsd = config.get<number>("maxBudgetUsd", 2);
  const provider = config.get<string>("provider", "anthropic");
  const baseUrl = config.get<string>("baseUrl", "");
  const usdPer1kInput = config.get<number>("usdPer1kInput", 0);
  const usdPer1kOutput = config.get<number>("usdPer1kOutput", 0);
  await walk.askWhy(question, (ctx) =>
    Promise.resolve(
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "HDTW: answering",
          cancellable: true,
        },
        async (progress, token) => {
          const { answer } = await client!.askAboutStep(
            {
              workspaceRoot: root,
              question,
              context: ctx,
              model: model || undefined,
              maxBudgetUsd,
              provider: provider === "openai" ? "openai" : undefined,
              baseUrl: provider === "openai" && baseUrl ? baseUrl : undefined,
              usdPer1kInput: provider === "openai" ? usdPer1kInput : undefined,
              usdPer1kOutput:
                provider === "openai" ? usdPer1kOutput : undefined,
            },
            (update) =>
              progress.report({
                message: `${update.message} (${Math.round((update.tokensIn + update.tokensOut) / 1000)}k tokens · ~$${update.estimatedCostUsd.toFixed(2)})`,
              }),
            token,
          );
          return answer;
        },
      ),
    ),
  );
}

async function followRelated(tourId: string): Promise<void> {
  const root = workspaceRoot();
  if (!root || !client || !walk) {
    return;
  }
  try {
    const { tour } = await client.getTour(root, tourId);
    observer?.logger.info("tour.followed", { tourId });
    await walk.pushTour(tour);
    saveState.setSaved();
    refreshSaveAffordance();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(
      `HDTW: could not open related tour "${tourId}": ${message}`,
    );
  }
}

async function generateTour(): Promise<void> {
  const root = workspaceRoot();
  if (!root || !client) {
    void vscode.window.showErrorMessage(
      "HDTW: open a folder to generate a tour.",
    );
    return;
  }
  if (generating) {
    void vscode.window.showWarningMessage(
      "HDTW: a tour is already being generated.",
    );
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
  const provider = config.get<string>("provider", "anthropic");
  const baseUrl = config.get<string>("baseUrl", "");
  const usdPer1kInput = config.get<number>("usdPer1kInput", 0);
  const usdPer1kOutput = config.get<number>("usdPer1kOutput", 0);

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
          {
            workspaceRoot: root,
            topic,
            model: model || undefined,
            maxBudgetUsd,
            provider: provider === "openai" ? "openai" : undefined,
            baseUrl: provider === "openai" && baseUrl ? baseUrl : undefined,
            usdPer1kInput: provider === "openai" ? usdPer1kInput : undefined,
            usdPer1kOutput: provider === "openai" ? usdPer1kOutput : undefined,
          },
          (update) =>
            progress.report({
              message: `${update.message} (${Math.round((update.tokensIn + update.tokensOut) / 1000)}k tokens · ~$${update.estimatedCostUsd.toFixed(2)})`,
            }),
          token,
        ),
    );
    tree?.refresh();
    void vscode.window.showInformationMessage(
      `HDTW: tour saved to ${result.savedPath}`,
    );
    await refreshTourTitles(root);
    walk?.dispose();
    walk = new WalkController(root, (id) => tourTitles.get(id));
    walk.setReanchorContext(result.tour.id);
    await walk.start(result.tour);
    saveState.setSaved();
    refreshSaveAffordance();
    await applyDrift(root, result.tour.id);
  } catch (error) {
    handleGenerationError(error);
  } finally {
    generating = false;
  }
}

async function askWalk(): Promise<void> {
  const root = workspaceRoot();
  if (!root || !client) {
    void vscode.window.showErrorMessage(
      "HDTW: open a folder to ask about its code.",
    );
    return;
  }
  if (generating) {
    void vscode.window.showWarningMessage(
      "HDTW: a tour is already being generated.",
    );
    return;
  }
  const question = await vscode.window.showInputBox({
    title: "Ask HDTW",
    prompt: "What do you want to understand?",
    placeHolder: "e.g. how does drift detection work?",
  });
  if (!question) {
    return;
  }
  observer?.logger.info("ask.requested", { question });
  const config = vscode.workspace.getConfiguration("hdtw.generation");
  const model = config.get<string>("model", "");
  const maxBudgetUsd = config.get<number>("maxBudgetUsd", 2);
  const provider = config.get<string>("provider", "anthropic");
  const baseUrl = config.get<string>("baseUrl", "");
  const usdPer1kInput = config.get<number>("usdPer1kInput", 0);
  const usdPer1kOutput = config.get<number>("usdPer1kOutput", 0);
  generating = true;
  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "HDTW: exploring",
        cancellable: true,
      },
      (progress, token) =>
        client!.generateTour(
          {
            workspaceRoot: root,
            topic: question,
            model: model || undefined,
            maxBudgetUsd,
            save: false,
            provider: provider === "openai" ? "openai" : undefined,
            baseUrl: provider === "openai" && baseUrl ? baseUrl : undefined,
            usdPer1kInput: provider === "openai" ? usdPer1kInput : undefined,
            usdPer1kOutput: provider === "openai" ? usdPer1kOutput : undefined,
          },
          (update) =>
            progress.report({
              message: `${update.message} (${Math.round((update.tokensIn + update.tokensOut) / 1000)}k tokens · ~$${update.estimatedCostUsd.toFixed(2)})`,
            }),
          token,
        ),
    );
    observer?.logger.info("ask.generated", { id: result.tour.id });
    await refreshTourTitles(root);
    walk?.dispose();
    walk = new WalkController(root, (id) => tourTitles.get(id));
    walk.setReanchorContext(result.tour.id);
    await walk.start(result.tour);
    // An ephemeral Ask walk isn't on disk, and it was just generated against
    // current code, so it's fresh by construction — skip the drift check.
    saveState.setUnsaved(result.tour);
    refreshSaveAffordance();
  } catch (error) {
    handleGenerationError(error);
  } finally {
    generating = false;
  }
}

async function saveWalk(): Promise<void> {
  const root = workspaceRoot();
  const tour = saveState.unsavedTour();
  if (!root || !client || !tour) {
    return;
  }
  try {
    const { savedPath } = await client.saveTour(root, tour);
    observer?.logger.info("tour.saved", { savedPath });
    saveState.setSaved();
    refreshSaveAffordance();
    tree?.refresh();
    void vscode.window.showInformationMessage(`HDTW: saved to ${savedPath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(
      `HDTW: could not save tour: ${message}`,
    );
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
      `HDTW: ${message} Raise hdtw.generation.maxBudgetUsd to allow more.`,
    );
    return;
  }
  void vscode.window.showErrorMessage(
    `HDTW: tour generation failed: ${message}`,
  );
}

async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
  const providerConfig = vscode.workspace
    .getConfiguration("hdtw.generation")
    .get<string>("provider", "anthropic");
  const isOpenAi = providerConfig === "openai";
  const secretKey = isOpenAi ? OPENAI_API_KEY_SECRET : ANTHROPIC_API_KEY_SECRET;
  const providerLabel = isOpenAi ? "OpenAI-compatible" : "Anthropic";

  const key = await vscode.window.showInputBox({
    title: `Set ${providerLabel} API Key`,
    prompt:
      "Stored in VS Code SecretStorage; passed to the engine on next start.",
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) {
    return;
  }
  if (key === "") {
    await context.secrets.delete(secretKey);
    void vscode.window.showInformationMessage(
      "HDTW: API key cleared. Reload to apply.",
    );
  } else {
    await context.secrets.store(secretKey, key);
    void vscode.window.showInformationMessage(
      "HDTW: API key saved. Reload to apply.",
    );
  }
  const action = await vscode.window.showInformationMessage(
    "Reload window to restart the engine with the new credentials?",
    "Reload",
  );
  if (action === "Reload") {
    void vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

export function deactivate(): void {
  walk?.dispose();
  walk = undefined;
  client?.dispose();
  client = undefined;
  tree = undefined;
}
