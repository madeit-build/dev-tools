import { useState, type JSX } from "react";
import type { Graph, OrreryNode } from "@made-i-t/orrery-model";
import type { Annotation } from "./annotations";
import type { View } from "./route";

export interface InspectorProps {
  node: OrreryNode;
  graph: Graph;
  view: View;
  onNavigate: (next: View) => void;
  annotation: Annotation | null;
  annotationsReady: boolean;
  onAnnotate: (id: string, annotation: Annotation) => void;
}

// Committed on blur, not on every keystroke: a draft that saves per character
// spams localStorage and makes the canvas marker flicker into existence
// mid-word. Local state carries the in-progress edit.
function AnnotationEditor({ id, annotation, onAnnotate }: {
  id: string;
  annotation: Annotation | null;
  onAnnotate: (id: string, annotation: Annotation) => void;
}): JSX.Element {
  // Initial state only: the parent remounts this editor (key={id}, gated on
  // annotationsReady) whenever the selected node changes, so mount is the
  // single hydration point and no sync effect exists to fight in-progress
  // typing. The first version hydrated in an effect keyed on [id] alone, and
  // the async annotations load arriving after mount left the textarea
  // permanently empty while the tag chips, rendered from the prop, showed
  // the same annotation fine.
  const [note, setNote] = useState(annotation?.note ?? "");
  const [tags, setTags] = useState((annotation?.tags ?? []).join(", "));

  const commit = () => {
    onAnnotate(id, {
      note,
      tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      updated_at: new Date().toISOString(),
    });
  };

  return (
    <>
      <div className="orrery-panel__section">annotation</div>
      <textarea
        className="orrery-annotation__textarea"
        placeholder="your note on this object"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={commit}
      />
      <input
        className="orrery-annotation__tags"
        placeholder="tags, comma-separated"
        value={tags}
        onChange={(e) => setTags(e.target.value)}
        onBlur={commit}
      />
    </>
  );
}

export function Inspector({ node, graph, view, onNavigate, annotation, annotationsReady, onAnnotate }: InspectorProps): JSX.Element {
  const declaredBy = graph.edges.filter((e) => e.type === "declared-by" && e.from === node.id);
  const modules = declaredBy
    .map((e) => graph.nodes.find((n) => n.id === e.to))
    .filter((n): n is OrreryNode => Boolean(n));

  const inferred = graph.edges.filter(
    (e) => e.source === "inferred" && (e.from === node.id || e.to === node.id),
  );

  return (
    <aside className="orrery-panel">
      <div className="orrery-panel__title">{node.label}</div>
      <div className="orrery-panel__type">{node.type}</div>

      {annotationsReady && (
        <AnnotationEditor key={node.id} id={node.id}
                          annotation={annotation} onAnnotate={onAnnotate} />
      )}
      {(annotation?.tags ?? []).length > 0 && (
        <div>
          {(annotation?.tags ?? []).map((t) => (
            <span key={t} className="orrery-tag">{t}</span>
          ))}
        </div>
      )}

      {Object.entries(node.attrs)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => (
          <div key={k} className="orrery-panel__row">
            <span className="orrery-panel__key">{k}: </span>
            <span>{String(v)}</span>
          </div>
        ))}

      {modules.length > 0 && (
        <>
          <div className="orrery-panel__section">
            declared by {modules.length === 1 ? "1 module" : `${modules.length} modules`}
          </div>
          {modules.map((m) => (
            <div key={m.id}>
              <button
                className="orrery-panel__link"
                onClick={() => onNavigate({ ...view, lens: "declaration", selected: m.id })}
              >
                {m.label}
              </button>
            </div>
          ))}
        </>
      )}

      {inferred.length > 0 && (
        <>
          <div className="orrery-panel__section">inferred, not declared</div>
          {inferred.map((e) => (
            // The evidence is shown, not hidden. A guess the reader can check
            // is a different thing from a guess presented as a fact.
            <div key={e.id} className="orrery-panel__evidence">{e.evidence}</div>
          ))}
        </>
      )}
    </aside>
  );
}
