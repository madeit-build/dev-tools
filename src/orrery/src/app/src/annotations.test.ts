import { describe, it, expect, beforeEach } from "vitest";
import {
  mergeAnnotations, loadDrafts, saveDraft, clearDraft,
  exportAnnotations, orphanedIds,
  type AnnotationMap,
} from "./annotations";

// vitest's node environment has no localStorage; a 15-line fake is less
// magic than a jsdom dependency for one Map-shaped API.
class FakeStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

const note = (text: string, tags: string[] = []) => ({
  note: text, tags, updated_at: "2026-08-23T00:00:00.000Z",
});

beforeEach(() => {
  (globalThis as Record<string, unknown>).localStorage = new FakeStorage();
});

describe("mergeAnnotations", () => {
  it("returns committed annotations when there are no drafts", () => {
    const committed: AnnotationMap = { "service:box/caddy": note("front door") };
    expect(mergeAnnotations(committed, {})).toEqual(committed);
  });

  it("lets a draft win over the committed layer for the same node", () => {
    const committed: AnnotationMap = { "service:box/caddy": note("old") };
    const drafts: AnnotationMap = { "service:box/caddy": note("new") };
    expect(mergeAnnotations(committed, drafts)["service:box/caddy"].note).toBe("new");
  });

  it("keeps committed nodes the draft layer never touched", () => {
    const committed: AnnotationMap = { "service:box/ollama": note("gpu") };
    const drafts: AnnotationMap = { "service:box/caddy": note("edge") };
    const merged = mergeAnnotations(committed, drafts);
    expect(Object.keys(merged).sort()).toEqual([
      "service:box/caddy", "service:box/ollama",
    ]);
  });

  it("treats an empty-note draft as a deletion of the committed entry", () => {
    const committed: AnnotationMap = { "service:box/caddy": note("stale") };
    const drafts: AnnotationMap = { "service:box/caddy": note("", []) };
    expect(mergeAnnotations(committed, drafts)["service:box/caddy"]).toBeUndefined();
  });

  it("keeps an empty-note draft that carries tags, since tags alone are an annotation", () => {
    const drafts: AnnotationMap = { "service:box/caddy": note("", ["load-bearing"]) };
    expect(mergeAnnotations({}, drafts)["service:box/caddy"].tags).toEqual(["load-bearing"]);
  });
});

describe("draft persistence", () => {
  it("round-trips a draft through storage", () => {
    saveDraft("service:box/caddy", note("edge proxy"));
    expect(loadDrafts()["service:box/caddy"].note).toBe("edge proxy");
  });

  it("clearDraft removes one node and leaves the rest", () => {
    saveDraft("service:box/caddy", note("a"));
    saveDraft("service:box/ollama", note("b"));
    clearDraft("service:box/caddy");
    expect(Object.keys(loadDrafts())).toEqual(["service:box/ollama"]);
  });

  it("survives corrupted storage by starting empty rather than crashing", () => {
    localStorage.setItem("orrery-annotations-draft", "{not json");
    expect(loadDrafts()).toEqual({});
  });
});

describe("exportAnnotations", () => {
  it("emits stable, sorted, pretty JSON so diffs stay reviewable", () => {
    const merged: AnnotationMap = {
      "service:box/ollama": note("gpu"),
      "service:box/caddy": note("edge"),
    };
    const out = exportAnnotations(merged);
    expect(JSON.parse(out)).toEqual(merged);
    expect(out.indexOf("caddy")).toBeLessThan(out.indexOf("ollama"));
    expect(out).toContain("\n");
  });

  it("includes annotations whose nodes are gone, never silently dropping them", () => {
    const merged: AnnotationMap = { "service:box/retired-thing": note("was flaky") };
    expect(JSON.parse(exportAnnotations(merged))["service:box/retired-thing"]).toBeDefined();
  });
});

describe("orphanedIds", () => {
  it("names annotations whose node id is absent from the graph", () => {
    const merged: AnnotationMap = {
      "service:box/caddy": note("here"),
      "service:box/retired": note("gone"),
    };
    expect(orphanedIds(merged, new Set(["service:box/caddy"]))).toEqual([
      "service:box/retired",
    ]);
  });

  it("is empty when every annotation still has its node", () => {
    const merged: AnnotationMap = { "service:box/caddy": note("here") };
    expect(orphanedIds(merged, new Set(["service:box/caddy"]))).toEqual([]);
  });
});
