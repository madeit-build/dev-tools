import type { OrreryNode } from "@made-i-t/orrery-model";

// Shape, fill, and weight carry node type. Hue is not available: the brand is
// monochrome by direction, and the one remaining encoding is spent on edge
// confidence, which matters more than node taxonomy.
export function nodeClass(node: OrreryNode, selected: boolean): string {
  const parts = ["orrery-node", `orrery-node--${node.type}`];
  if (node.attrs.lifecycle === "oneshot") parts.push("orrery-node--job");
  if (selected) parts.push("orrery-node--selected");
  return parts.join(" ");
}
