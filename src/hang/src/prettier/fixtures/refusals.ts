/** Shapes the guard must refuse. Each would change meaning or comment text. */
export const REFUSALS: Record<string, string> = {
  multiLineTemplate: "const msg = `a\n    .b not a chain`;\n",
  templateInsideChain:
    "const q = builder.select(`a\n    .b`).from(table).where(clause).orderBy(column);\n",
  blockCommentInRun:
    "const c = things.filterOutDisabled((x) => x.on)\n  /* one\n     two */\n  .reduceToTotal((s, x) => s + x, 0);\n",
};
