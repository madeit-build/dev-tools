import * as vscode from "vscode";
import type { TourSummary } from "@made-i-t/hdtw-protocol";
import type { EngineClient } from "./engineClient.js";

export class TourTreeItem extends vscode.TreeItem {
  constructor(tour: TourSummary, driftCount?: number) {
    super(tour.title, vscode.TreeItemCollapsibleState.None);
    this.id = tour.id;
    if (tour.error) {
      this.description = "invalid";
      this.tooltip = tour.error;
      this.iconPath = new vscode.ThemeIcon("warning");
      this.contextValue = "hdtwTourInvalid";
    } else {
      this.description =
        driftCount && driftCount > 0
          ? `${tour.stepCount} steps · ⚠ ${driftCount} drifted`
          : `${tour.stepCount} steps`;
      this.tooltip = tour.summary;
      this.iconPath = new vscode.ThemeIcon("compass");
      this.contextValue = "hdtwTour";
      this.command = {
        command: "hdtw.startTour",
        title: "Start Tour",
        arguments: [tour.id],
      };
    }
  }
}

export class TourTreeProvider implements vscode.TreeDataProvider<TourTreeItem> {
  private readonly didChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.didChange.event;

  constructor(
    private readonly client: EngineClient,
    private readonly getWorkspaceRoot: () => string | undefined,
    private readonly driftCount: (tourId: string) => number | undefined,
  ) {}

  refresh(): void {
    this.didChange.fire();
  }

  getTreeItem(item: TourTreeItem): vscode.TreeItem {
    return item;
  }

  async getChildren(): Promise<TourTreeItem[]> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot || !this.client.isConnected) {
      return [];
    }
    const result = await this.client.listTours(workspaceRoot);
    return result.tours.map(
      (tour) => new TourTreeItem(tour, this.driftCount(tour.id)),
    );
  }
}
