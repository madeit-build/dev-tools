import path from "node:path";
import * as vscode from "vscode";
import type { StepDriftState, Tour } from "@made-i-t/hdtw-protocol";
import { currentStep, progressLabel, startWalk } from "./walkState.js";
import {
  activeWalk,
  advance,
  breadcrumbLabel,
  pushWalk,
  retreat,
  type WalkStack,
} from "./walkStack.js";
import { driftBadge, isReanchorable } from "./driftBadge.js";

export class WalkController implements vscode.Disposable {
  private stack: WalkStack = [];
  private readonly commentController: vscode.CommentController;
  private thread: vscode.CommentThread | undefined;
  private readonly decoration: vscode.TextEditorDecorationType;
  private readonly statusBarItem: vscode.StatusBarItem;
  private decoratedEditor: vscode.TextEditor | undefined;
  private driftByIndex = new Map<number, StepDriftState>();
  private reanchorContext: { tourId: string } | undefined;

  constructor(
    private readonly workspaceRoot: string,
    /** Returns the title of a tour id known to the workspace, or undefined when it does not exist. */
    private readonly lookupTourTitle: (tourId: string) => string | undefined
  ) {
    this.commentController = vscode.comments.createCommentController("hdtw-tour", "HDTW Tour Guide");
    this.decoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
    });
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  }

  async start(tour: Tour): Promise<void> {
    this.driftByIndex = new Map();
    this.stack = [startWalk(tour)];
    await this.renderCurrentStep();
  }

  /** Follow a related tour: push it onto the stack and walk it. */
  async pushTour(tour: Tour): Promise<void> {
    this.driftByIndex = new Map();
    if (this.stack.length === 0) {
      this.stack = [startWalk(tour)];
    } else {
      this.stack = pushWalk(this.stack, tour);
    }
    await this.renderCurrentStep();
  }

  setDrift(statuses: { index: number; status: StepDriftState }[]): void {
    this.driftByIndex = new Map(statuses.map((s) => [s.index, s.status]));
  }

  setReanchorContext(tourId: string): void {
    this.reanchorContext = { tourId };
  }

  async refresh(): Promise<void> {
    await this.renderCurrentStep();
  }

  async next(): Promise<void> {
    if (this.stack.length === 0) {
      return;
    }
    this.stack = advance(this.stack);
    await this.renderCurrentStep();
  }

  async previous(): Promise<void> {
    if (this.stack.length === 0) {
      return;
    }
    this.stack = retreat(this.stack);
    await this.renderCurrentStep();
  }

  exit(): void {
    this.stack = [];
    this.clearStepArtifacts();
    this.statusBarItem.hide();
  }

  dispose(): void {
    this.exit();
    this.commentController.dispose();
    this.decoration.dispose();
    this.statusBarItem.dispose();
  }

  private async renderCurrentStep(): Promise<void> {
    if (this.stack.length === 0) {
      return;
    }
    this.clearStepArtifacts();
    const active = activeWalk(this.stack);
    const step = currentStep(active);
    const fileUri = vscode.Uri.file(path.join(this.workspaceRoot, ...step.anchor.file.split("/")));

    let document: vscode.TextDocument | undefined;
    try {
      document = await vscode.workspace.openTextDocument(fileUri);
    } catch {
      document = undefined;
    }

    if (!document) {
      void vscode.window.showWarningMessage(
        `HDTW step "${step.title}": anchor file ${step.anchor.file} is missing — code may have changed since this tour was authored.`
      );
      this.updateStatusBar();
      return;
    }

    const status: StepDriftState = this.driftByIndex.get(activeWalk(this.stack).stepIndex) ?? "fresh";
    const drifted = status !== "fresh";
    const startLine = Math.min(step.anchor.startLine, document.lineCount) - 1;
    const endLine = Math.min(step.anchor.endLine, document.lineCount) - 1;
    const range = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);

    const editor = await vscode.window.showTextDocument(document, { preserveFocus: false });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

    if (!drifted) {
      editor.setDecorations(this.decoration, [range]);
      this.decoratedEditor = editor;
    }

    const badge = driftBadge(status);
    const reanchorLink =
      isReanchorable(status) && this.reanchorContext
        ? `\n\n[🔧 Re-anchor this step](command:hdtw.reanchorStep?${encodeURIComponent(
            JSON.stringify([this.reanchorContext.tourId, activeWalk(this.stack).stepIndex])
          )})`
        : "";
    const body =
      (badge ? badge + "\n\n" : "") +
      step.narration +
      reanchorLink +
      this.relatedSection(step.relatedTours);
    const narration = new vscode.MarkdownString(body);
    narration.isTrusted = { enabledCommands: ["hdtw.followRelated", "hdtw.reanchorStep"] };
    const comments: vscode.Comment[] = [
      {
        body: narration,
        mode: vscode.CommentMode.Preview,
        author: { name: `🧭 HDTW Guide — ${step.title} (${progressLabel(active)})` },
      },
    ];
    this.thread = this.commentController.createCommentThread(fileUri, range, comments);
    this.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.thread.canReply = false;
    this.thread.label = breadcrumbLabel(this.stack);

    this.updateStatusBar();
  }

  private relatedSection(related: Tour["steps"][number]["relatedTours"]): string {
    if (!related || related.length === 0) {
      return "";
    }
    const lines = related.map((link) => {
      const title = this.lookupTourTitle(link.tourId);
      const text = link.label ?? title ?? link.tourId;
      if (title === undefined) {
        return `- 🚫 ${text} _(tour not found)_`;
      }
      const args = encodeURIComponent(JSON.stringify([link.tourId]));
      return `- [🧭 ${text}](command:hdtw.followRelated?${args})`;
    });
    return `\n\n**Related tours**\n\n${lines.join("\n")}`;
  }

  private updateStatusBar(): void {
    if (this.stack.length === 0) {
      return;
    }
    this.statusBarItem.text = `🧠 ${breadcrumbLabel(this.stack)} · ${progressLabel(activeWalk(this.stack))}`;
    this.statusBarItem.show();
  }

  private clearStepArtifacts(): void {
    this.thread?.dispose();
    this.thread = undefined;
    this.decoratedEditor?.setDecorations(this.decoration, []);
    this.decoratedEditor = undefined;
  }
}
