import path from "node:path";
import * as vscode from "vscode";
import type { Tour } from "@made-i-t/hdtw-protocol";
import {
  currentStep,
  hasNext,
  hasPrevious,
  nextStep,
  previousStep,
  progressLabel,
  startWalk,
  type WalkState,
} from "./walkState.js";

export class WalkController implements vscode.Disposable {
  private state: WalkState | undefined;
  private readonly commentController: vscode.CommentController;
  private thread: vscode.CommentThread | undefined;
  private readonly decoration: vscode.TextEditorDecorationType;
  private readonly statusBarItem: vscode.StatusBarItem;
  private decoratedEditor: vscode.TextEditor | undefined;

  constructor(private readonly workspaceRoot: string) {
    this.commentController = vscode.comments.createCommentController(
      "hdtw-tour",
      "HDTW Tour Guide"
    );
    this.decoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
    });
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  }

  async start(tour: Tour): Promise<void> {
    this.state = startWalk(tour);
    await this.renderCurrentStep();
  }

  async next(): Promise<void> {
    if (this.state && hasNext(this.state)) {
      this.state = nextStep(this.state);
      await this.renderCurrentStep();
    }
  }

  async previous(): Promise<void> {
    if (this.state && hasPrevious(this.state)) {
      this.state = previousStep(this.state);
      await this.renderCurrentStep();
    }
  }

  exit(): void {
    this.state = undefined;
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
    if (!this.state) {
      return;
    }
    this.clearStepArtifacts();
    const step = currentStep(this.state);
    const fileUri = vscode.Uri.file(
      path.join(this.workspaceRoot, ...step.anchor.file.split("/"))
    );

    let document: vscode.TextDocument | undefined;
    try {
      document = await vscode.workspace.openTextDocument(fileUri);
    } catch {
      document = undefined;
    }

    if (!document) {
      // Anchor file is gone: warn, keep the walk alive (spec: never hard-fail mid-walk).
      void vscode.window.showWarningMessage(
        `HDTW step "${step.title}": anchor file ${step.anchor.file} is missing — code may have changed since this tour was authored.`
      );
      this.updateStatusBar();
      return;
    }

    const drifted = step.anchor.endLine > document.lineCount;
    const startLine = Math.min(step.anchor.startLine, document.lineCount) - 1;
    const endLine = Math.min(step.anchor.endLine, document.lineCount) - 1;
    const range = new vscode.Range(
      startLine,
      0,
      endLine,
      document.lineAt(endLine).text.length
    );

    const editor = await vscode.window.showTextDocument(document, { preserveFocus: false });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

    if (!drifted) {
      editor.setDecorations(this.decoration, [range]);
      this.decoratedEditor = editor;
    }

    const narration = new vscode.MarkdownString(
      (drifted
        ? "⚠️ _This step's anchor has drifted — code may have changed since authoring._\n\n"
        : "") + step.narration
    );
    const comments: vscode.Comment[] = [
      {
        body: narration,
        mode: vscode.CommentMode.Preview,
        author: { name: `🧭 HDTW Guide — ${step.title} (${progressLabel(this.state)})` },
      },
    ];
    this.thread = this.commentController.createCommentThread(fileUri, range, comments);
    this.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.thread.canReply = false;
    this.thread.label = this.state.tour.title;

    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    if (!this.state) {
      return;
    }
    this.statusBarItem.text = `🧭 ${this.state.tour.title} · ${progressLabel(this.state)}`;
    this.statusBarItem.show();
  }

  private clearStepArtifacts(): void {
    this.thread?.dispose();
    this.thread = undefined;
    this.decoratedEditor?.setDecorations(this.decoration, []);
    this.decoratedEditor = undefined;
  }
}
