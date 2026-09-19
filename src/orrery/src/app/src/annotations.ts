// The annotation layer: human notes and tags attached to graph nodes by
// stable id, which is the attachment stable ids were designed to make cheap.
//
// Two layers, merged at load. The committed layer ships as annotations.json
// beside graph.json and lives in git, because annotations are AUTHORED data
// (graph.json is generated and gitignored; this is the opposite kind of
// artifact). The draft layer is localStorage, where in-app edits land
// immediately. Export produces the merged document for a human to commit;
// the app never writes to disk, so the git history stays theirs.

export interface Annotation {
  note: string;
  tags: string[];
  updated_at: string;
}

export type AnnotationMap = Record<string, Annotation>;

const DRAFT_KEY = "orrery-annotations-draft";

const isEmpty = (a: Annotation): boolean =>
  a.note.trim() === "" && a.tags.length === 0;

// Draft wins per node. A draft emptied of both note and tags reads as "delete
// the committed entry": clearing a note in the UI must be expressible, and a
// tombstone value would leak into exports.
export function mergeAnnotations(
  committed: AnnotationMap,
  drafts: AnnotationMap,
): AnnotationMap {
  const merged: AnnotationMap = { ...committed };
  for (const [id, ann] of Object.entries(drafts)) {
    if (isEmpty(ann)) {
      delete merged[id];
    } else {
      merged[id] = ann;
    }
  }
  return merged;
}

export function loadDrafts(): AnnotationMap {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as AnnotationMap) : {};
  } catch {
    // Corrupted storage starts the draft layer empty. The committed layer is
    // untouched by definition, so nothing authored-and-committed is at risk.
    return {};
  }
}

export function saveDraft(id: string, annotation: Annotation): void {
  const drafts = loadDrafts();
  drafts[id] = annotation;
  localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts));
}

export function clearDraft(id: string): void {
  const drafts = loadDrafts();
  delete drafts[id];
  localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts));
}

// Sorted keys and pretty printing so the committed file diffs line by line.
// Orphans (nodes no longer in the graph) are included on purpose: an
// annotation outliving its node is signal, and export must never be the step
// that silently loses it.
export function exportAnnotations(merged: AnnotationMap): string {
  const sorted = Object.fromEntries(
    Object.keys(merged).sort().map((k) => [k, merged[k]]),
  );
  return JSON.stringify(sorted, null, 2) + "\n";
}

export function orphanedIds(
  merged: AnnotationMap,
  liveIds: ReadonlySet<string>,
): string[] {
  return Object.keys(merged).filter((id) => !liveIds.has(id)).sort();
}
