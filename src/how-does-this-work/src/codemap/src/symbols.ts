import { Query } from "web-tree-sitter";
import { loadLanguage, newParser, type CodemapLanguage } from "./grammars.js";

export type SymbolKind =
  "function" | "method" | "class" | "interface" | "const" | "enum" | "type";

export interface CodeSymbol {
  name: string;
  /** Enclosing-scope-qualified, e.g. "ClassName.method" or top-level "name". */
  qualifiedName: string;
  kind: SymbolKind;
  startLine: number; // 1-based inclusive
  endLine: number;
}

const QUERY_SOURCE = `
(function_declaration name: (identifier) @function)
(class_declaration name: (type_identifier) @class)
(interface_declaration name: (type_identifier) @interface)
(enum_declaration name: (identifier) @enum)
(type_alias_declaration name: (type_identifier) @type)
(method_definition name: (property_identifier) @method)
(public_field_definition name: (property_identifier) @field)
(lexical_declaration (variable_declarator name: (identifier) @const))
`;

const CAPTURE_KIND: Record<string, SymbolKind> = {
  function: "function",
  class: "class",
  interface: "interface",
  enum: "enum",
  type: "type",
  method: "method",
  field: "method",
  const: "const",
};

interface TsNode {
  type: string;
  text: string;
  parent: TsNode | null;
  namedChildren: TsNode[];
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
}

export async function parseSymbols(
  content: string,
  language: CodemapLanguage,
): Promise<CodeSymbol[]> {
  const lang = await loadLanguage(language);
  const parser = await newParser(language);
  const tree = parser.parse(content);
  if (!tree) return []; // 0.25.x returns Tree | null
  const query = new Query(lang, QUERY_SOURCE);
  const symbols: CodeSymbol[] = [];
  for (const capture of query.captures(tree.rootNode)) {
    const kind = CAPTURE_KIND[capture.name];
    if (!kind) continue;
    const nameNode = capture.node as unknown as TsNode;
    const declaration =
      capture.name === "const"
        ? (nameNode.parent?.parent ?? nameNode.parent ?? undefined)
        : (nameNode.parent ?? undefined);
    if (!declaration) continue;
    const name = nameNode.text;
    symbols.push({
      name,
      qualifiedName: qualify(name, declaration),
      kind,
      startLine: declaration.startPosition.row + 1,
      endLine: declaration.endPosition.row + 1,
    });
  }
  return symbols;
}

function qualify(name: string, declaration: TsNode): string {
  let cursor: TsNode | null = declaration.parent ?? null;
  while (cursor) {
    if (cursor.type === "class_declaration"
        || cursor.type === "interface_declaration"
    ) {
      const owner = ownerName(cursor);
      if (owner) return `${owner}.${name}`;
      break;
    }
    cursor = cursor.parent ?? null;
  }
  return name;
}

function ownerName(classNode: TsNode): string | undefined {
  for (const child of classNode.namedChildren) {
    if (!child) continue;
    if (child.type === "type_identifier" || child.type === "identifier")
      return child.text;
  }
  return undefined;
}
