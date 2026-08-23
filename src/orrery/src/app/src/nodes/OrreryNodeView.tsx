import type { JSX } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { OrreryNode } from "@made-i-t/orrery-model";
import { nodeClass } from "./nodeClass";

export interface OrreryNodeData extends Record<string, unknown> {
  node: OrreryNode;
  selected: boolean;
}

// The meta line answers "what is this" in the fewest characters that are still
// true, and differs by type because the useful fact differs by type.
function meta(node: OrreryNode): string {
  if (node.type === "service") return String(node.attrs.user ?? node.attrs.lifecycle ?? "");
  if (node.type === "host") return String(node.attrs.kind ?? "");
  if (node.type === "module") return "module";
  if (node.type === "option") return `${node.attrs.definitions ?? 0} definitions`;
  return node.type;
}

export function OrreryNodeView({ data }: NodeProps): JSX.Element {
  const { node, selected } = data as OrreryNodeData;
  return (
    <div className={nodeClass(node, selected)} title={node.id}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div className="orrery-node__label">{node.label}</div>
      <div className="orrery-node__meta">{meta(node)}</div>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}
