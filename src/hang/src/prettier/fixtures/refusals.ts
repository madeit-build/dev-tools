/** Shapes the guard must refuse. Each would change meaning or comment text. */
export const REFUSALS: Record<string, string> = {
  multiLineTemplate: "const msg = `a\n    .b not a chain`;\n",
  templateInsideChain:
    "const q = builder.select(`a\n    .b`).from(table).where(clause).orderBy(column);\n",
  blockCommentInRun:
    "const c = things.filterOutDisabled((x) => x.on)\n  /* one\n     two */\n  .reduceToTotal((s, x) => s + x, 0);\n",

  /**
   * Found during the Task 9 monorepo dogfood
   * (docs/plans/2026-09-02-hang.md), in
   * src/how-does-this-work/src/engine/server/tests/generationPipeline.test.ts.
   *
   * Root cause: join-and-shift moves every line of a run by one delta, which
   * is deliberately what carries a ternary's branches with it (see
   * docs/specs/2026-09-02-hang-design.md, "Join and shift"). The same
   * mechanism also carries along a chain link's own nested multi-line content
   * that isn't part of the chain at all -- here, the wrapped arguments
   * Prettier gives the long `.filter(...)` condition -- dragging it out to
   * the `.filter` anchor column instead of leaving it at the chain's own
   * indent. Meaning-preserving, but visually worse than Prettier alone, so
   * the nested-content check in hunks.ts refuses the whole run.
   */
  chainLinkWithWrappedArguments:
    "const dropped = observed\n" +
    '  .filter((r) => r.kind === "log" && (r as { event: string }).event === "verify.related_dropped")\n' +
    "  .map((r) => (r as { fields?: { tourId?: string } }).fields?.tourId);\n",

  /**
   * Found during the same dogfood, in src/orrery/src/app/src/Inspector.tsx.
   * Same root cause as chainLinkWithWrappedArguments, but the nested content
   * is a `.map` callback's own multi-line JSX return rather than wrapped call
   * arguments: hang used to shift the whole returned block out to the `.map`
   * anchor column, indenting the JSX far past any of its siblings.
   */
  chainLinkReturningMultilineJsx:
    "function View({ attrs }: { attrs: Record<string, unknown> }) {\n" +
    "  return (\n" +
    "    <div>\n" +
    "      {Object.entries(attrs)\n" +
    "        .filter(([, v]) => v !== null)\n" +
    "        .map(([k, v]) => (\n" +
    '          <div key={k} className="panel__row">\n' +
    '            <span className="panel__key">{k}: </span>\n' +
    "            <span>{String(v)}</span>\n" +
    "          </div>\n" +
    "        ))}\n" +
    "    </div>\n" +
    "  );\n" +
    "}\n",
};
